//! Long-lived Claude Code processes, one per agent.
//!
//! Each agent is `claude -p --input-format stream-json`, which keeps running and
//! takes one user message per line, so a new prompt does not pay Claude Code's
//! start-up again. A turn ends at Claude's `result` event (or when the process
//! exits, e.g. when killed). Changing the model, tools or auto-compact restarts
//! the process and resumes the same session.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use crate::claims;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEvent {
    agent_id: String,
    line: String,
}

/// How a turn ended: Claude's result event, or the process going away.
enum TurnEnd {
    Result(serde_json::Value),
    Exited(Option<i32>),
}

struct Agent {
    /// Everything the process was started with; a turn asking for different
    /// settings gets a fresh process.
    config: String,
    pid: Option<u32>,
    stdin: ChildStdin,
    pending: Arc<Mutex<Option<oneshot::Sender<TurnEnd>>>>,
    /// Set once the process has exited, so a turn started just after still ends.
    exited: Arc<AtomicBool>,
    /// The latest session id Claude reported. A killed turn has no result
    /// event, and resuming after a question or approval needs this.
    session: Arc<std::sync::Mutex<Option<String>>>,
}

#[derive(Default)]
pub struct AgentManager {
    agents: Mutex<HashMap<String, Agent>>,
}

pub struct TurnRequest {
    pub agent_id: String,
    pub agent_label: String,
    pub prompt: String,
    pub cwd: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub allowed_tools: String,
    pub auto_compact: bool,
    /// Stop the process after this turn (commit runs, one-off parallel agents).
    pub one_shot: bool,
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}

impl AgentManager {
    async fn spawn<R: Runtime>(&self, app: &AppHandle<R>, req: &TurnRequest, config: String) -> Result<Agent, String> {
        let mut args = vec![
            "-p".to_string(),
            "--verbose".to_string(),
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--allowedTools".to_string(),
            req.allowed_tools.clone(),
        ];
        if let Some(model) = req.model.as_deref().filter(|m| !m.is_empty()) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        if let Some(session) = req.session_id.as_deref().filter(|s| !s.is_empty()) {
            args.push("--resume".to_string());
            args.push(session.to_string());
        }
        if let Some(settings) = claims::hook_settings(&req.agent_id, &req.agent_label) {
            args.push("--settings".to_string());
            args.push(settings);
        }

        let claude_bin = crate::resolve_claude_binary();
        let mut command = Command::new(&claude_bin);
        // DISABLE_AUTO_COMPACT stops only automatic compaction; /compact still works.
        if req.auto_compact {
            command.env_remove("DISABLE_AUTO_COMPACT");
        } else {
            command.env("DISABLE_AUTO_COMPACT", "1");
        }
        let mut child = command
            .args(&args)
            .current_dir(&req.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn claude (tried '{}'): {}", claude_bin, e))?;

        let pid = child.id();
        let stdin = child.stdin.take().ok_or("Claude has no stdin")?;
        let stdout = child.stdout.take().ok_or("Claude has no stdout")?;
        let pending: Arc<Mutex<Option<oneshot::Sender<TurnEnd>>>> = Arc::new(Mutex::new(None));

        let exited = Arc::new(AtomicBool::new(false));
        let session: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(req.session_id.clone()));

        // Stream every line to the UI, and end the pending turn at each result.
        let reader_pending = pending.clone();
        let reader_session = session.clone();
        let reader_app = app.clone();
        let agent_id = req.agent_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = reader_app.emit("agent-stream", StreamEvent { agent_id: agent_id.clone(), line: line.clone() });
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if let Some(id) = value.get("session_id").and_then(|v| v.as_str()) {
                    *reader_session.lock().unwrap() = Some(id.to_string());
                }
                if value.get("type").and_then(|t| t.as_str()) == Some("result") {
                    if let Some(tx) = reader_pending.lock().await.take() {
                        let _ = tx.send(TurnEnd::Result(value));
                    }
                }
            }
        });

        // The waiter owns the child: when it exits, whatever turn was waiting ends.
        let waiter_pending = pending.clone();
        let waiter_exited = exited.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            waiter_exited.store(true, Ordering::SeqCst);
            if let Some(tx) = waiter_pending.lock().await.take() {
                let _ = tx.send(TurnEnd::Exited(status.and_then(|s| s.code())));
            }
        });

        Ok(Agent { config, pid, stdin, pending, exited, session })
    }

    pub async fn run_turn<R: Runtime>(&self, app: &AppHandle<R>, req: TurnRequest) -> Result<serde_json::Value, String> {
        let start = std::time::Instant::now();
        let config = format!(
            "{}|{}|{}|{}",
            req.cwd,
            req.model.clone().unwrap_or_default(),
            req.allowed_tools,
            req.auto_compact
        );

        let (tx, rx) = oneshot::channel();
        let session;
        {
            let mut agents = self.agents.lock().await;
            let reusable = agents
                .get(&req.agent_id)
                .is_some_and(|a| a.config == config && !a.exited.load(Ordering::SeqCst));
            if !reusable {
                if let Some(old) = agents.remove(&req.agent_id) {
                    if let Some(pid) = old.pid {
                        kill_pid(pid);
                    }
                }
                let agent = self.spawn(app, &req, config).await?;
                agents.insert(req.agent_id.clone(), agent);
            }
            let agent = agents.get_mut(&req.agent_id).ok_or("Agent vanished")?;
            *agent.pending.lock().await = Some(tx);
            // Died before the turn was registered: end it now rather than wait forever.
            if agent.exited.load(Ordering::SeqCst) {
                if let Some(tx) = agent.pending.lock().await.take() {
                    let _ = tx.send(TurnEnd::Exited(None));
                }
            }
            session = agent.session.clone();

            let message = serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": req.prompt },
            });
            let written = agent.stdin.write_all(format!("{}\n", message).as_bytes()).await;
            if written.is_ok() {
                let _ = agent.stdin.flush().await;
            } else {
                // The process died between turns; drop it so the next turn respawns.
                agents.remove(&req.agent_id);
                return Err("Claude stopped unexpectedly. Send the message again.".to_string());
            }
        }

        let end = rx.await.unwrap_or(TurnEnd::Exited(None));
        let duration_ms = start.elapsed().as_millis() as u64;

        // A task's file claims end with it.
        claims::release(&req.agent_id);

        let value = match end {
            TurnEnd::Result(result) => {
                let usage = &result["usage"];
                serde_json::json!({
                    "stdout": result["result"].as_str().unwrap_or_default(),
                    "stderr": "",
                    "exitCode": if result["is_error"].as_bool().unwrap_or(false) { 1 } else { 0 },
                    "durationMs": duration_ms,
                    "sessionId": result["session_id"].as_str(),
                    "inputTokens": usage["input_tokens"].as_u64(),
                    "outputTokens": usage["output_tokens"].as_u64(),
                })
            }
            TurnEnd::Exited(code) => {
                // Killed (Stop, a question, an approval) or crashed: the process is gone.
                self.agents.lock().await.remove(&req.agent_id);
                serde_json::json!({
                    "stdout": "",
                    "stderr": "Claude stopped before finishing.",
                    "exitCode": code.unwrap_or(-1),
                    "durationMs": duration_ms,
                    "sessionId": session.lock().unwrap().clone(),
                    "inputTokens": serde_json::Value::Null,
                    "outputTokens": serde_json::Value::Null,
                })
            }
        };

        if req.one_shot {
            self.kill(&req.agent_id).await;
        }
        Ok(value)
    }

    pub async fn kill(&self, agent_id: &str) {
        if let Some(agent) = self.agents.lock().await.remove(agent_id) {
            if let Some(pid) = agent.pid {
                kill_pid(pid);
            }
        }
        claims::release(agent_id);
    }

    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.agents.lock().await.keys().cloned().collect();
        for id in ids {
            self.kill(&id).await;
        }
    }
}

#[cfg(test)]
mod live_tests {
    //! Real Claude CLI runs (Haiku), so they only run on request, after building
    //! the app binary that serves as the edit hook:
    //! `cargo build && CLAUDE_COMPONENTS_HOOK_EXE=<target>/debug/claude-components \
    //!   cargo test --lib agents -- --ignored --nocapture --test-threads=1`
    use super::*;

    fn request(agent_id: &str, cwd: &std::path::Path, prompt: &str) -> TurnRequest {
        TurnRequest {
            agent_id: agent_id.to_string(),
            agent_label: format!("Label {}", agent_id),
            prompt: prompt.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            model: Some("claude-haiku-4-5".to_string()),
            session_id: None,
            allowed_tools: "Read,Edit,Write".to_string(),
            auto_compact: true,
            one_shot: false,
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cc-agents-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    #[ignore]
    async fn keeps_one_process_across_turns() {
        crate::claims::reset();
        let app = tauri::test::mock_app();
        let manager = AgentManager::default();
        let dir = scratch("warm");

        let first = manager.run_turn(app.handle(), request("main", &dir, "Remember the number 42. Reply with just: ok")).await.unwrap();
        let pid = manager.agents.lock().await.get("main").and_then(|a| a.pid);
        let second = manager.run_turn(app.handle(), request("main", &dir, "What number did I ask you to remember? Reply with just the number.")).await.unwrap();
        let pid_after = manager.agents.lock().await.get("main").and_then(|a| a.pid);

        println!("turn 1 {}ms {:?} | turn 2 {}ms {:?} | pid {:?} -> {:?}", first["durationMs"], first["stdout"], second["durationMs"], second["stdout"], pid, pid_after);
        assert_eq!(first["exitCode"], 0);
        assert!(second["stdout"].as_str().unwrap().contains("42"));
        assert!(pid.is_some() && pid == pid_after, "the same process should answer both turns");
        manager.kill_all().await;
    }

    #[tokio::test]
    #[ignore]
    async fn kill_ends_the_turn_and_keeps_the_session() {
        crate::claims::reset();
        let app = tauri::test::mock_app();
        let manager = Arc::new(AgentManager::default());
        let dir = scratch("kill");

        let turn_manager = manager.clone();
        let handle = app.handle().clone();
        let turn = tokio::spawn(async move {
            turn_manager
                .run_turn(&handle, request("main", &dir, "Write a 600 word story about a lighthouse keeper."))
                .await
        });
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        manager.kill("main").await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), turn).await.expect("turn should end after kill").unwrap().unwrap();

        println!("killed turn: exit {:?} session {:?}", result["exitCode"], result["sessionId"]);
        assert_ne!(result["exitCode"], 0);
        assert!(result["sessionId"].as_str().is_some(), "a killed turn must still report its session");
    }

    #[tokio::test]
    #[ignore]
    async fn a_claimed_file_is_refused_to_other_agents() {
        assert!(std::env::var_os("CLAUDE_COMPONENTS_HOOK_EXE").is_some(), "set CLAUDE_COMPONENTS_HOOK_EXE");
        crate::claims::reset();
        let app = tauri::test::mock_app();
        let manager = AgentManager::default();
        let dir = scratch("claims");
        std::fs::write(dir.join("taken.txt"), "original").unwrap();
        std::fs::write(dir.join("free.txt"), "original").unwrap();

        // Another agent already holds taken.txt.
        let taken = dir.join("taken.txt").canonicalize().unwrap();
        let lock = crate::claims::claim_file(&crate::claims::claims_dir(), &taken.to_string_lossy());
        std::fs::write(&lock, format!("agent-9\nAgent 9\n{}", taken.display())).unwrap();

        let result = manager
            .run_turn(app.handle(), request("main", &dir, "Replace the word original with changed in taken.txt and in free.txt. Use absolute paths."))
            .await
            .unwrap();
        let taken_now = std::fs::read_to_string(dir.join("taken.txt")).unwrap();
        let free_now = std::fs::read_to_string(dir.join("free.txt")).unwrap();
        println!("claude said: {:?} | taken.txt={:?} free.txt={:?}", result["stdout"], taken_now, free_now);
        assert_eq!(taken_now.trim(), "original", "the claimed file must not change");
        assert_eq!(free_now.trim(), "changed");
        manager.kill_all().await;
    }
}

//! File claims between agents working in the same folder.
//!
//! Every agent's Claude runs with a PreToolUse hook on edits. The hook is this
//! app's own binary started with `--claim-hook`, so there is nothing to install.
//! The first agent to edit a file claims it; any other agent that tries is
//! refused with a message naming the owner, which Claude reads and works around.
//! Claims live in a directory unique to this app process and are released when
//! the owning agent's task ends.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const HOOK_FLAG: &str = "--claim-hook";

/// Where this run of the app keeps its claims.
pub fn claims_dir() -> PathBuf {
    std::env::temp_dir().join(format!("claude-components-claims-{}", std::process::id()))
}

/// Clears claims left behind by earlier runs of the app (a crash, say).
pub fn reset() {
    let tmp = std::env::temp_dir();
    if let Ok(entries) = fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("claude-components-claims-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let _ = fs::create_dir_all(claims_dir());
}

pub(crate) fn claim_file(dir: &Path, file_path: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    dir.join(format!("{:016x}", hasher.finish()))
}

/// Releases everything one agent holds.
pub fn release(agent_id: &str) {
    let dir = claims_dir();
    let Ok(entries) = fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if content.lines().next() == Some(agent_id) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// The settings JSON that installs the hook for one agent.
pub fn hook_settings(agent_id: &str, agent_label: &str) -> Option<String> {
    // Tests run inside the test harness, which is not the app, so they point here.
    let exe = match std::env::var_os("CLAUDE_COMPONENTS_HOOK_EXE") {
        Some(path) => PathBuf::from(path),
        None => std::env::current_exe().ok()?,
    };
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    let command = format!(
        "{} {} {} {} {}",
        quote(&exe.to_string_lossy()),
        HOOK_FLAG,
        quote(agent_id),
        quote(agent_label),
        quote(&claims_dir().to_string_lossy()),
    );
    let settings = serde_json::json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": "Edit|Write|MultiEdit|NotebookEdit",
                "hooks": [{ "type": "command", "command": command }]
            }]
        }
    });
    Some(settings.to_string())
}

enum Decision {
    Allow,
    Deny(String),
}

fn decide(dir: &Path, agent_id: &str, agent_label: &str, file_path: &str) -> Decision {
    let _ = fs::create_dir_all(dir);
    let lock = claim_file(dir, file_path);
    match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
        Ok(mut file) => {
            let _ = write!(file, "{}\n{}\n{}", agent_id, agent_label, file_path);
            Decision::Allow
        }
        Err(_) => {
            let content = fs::read_to_string(&lock).unwrap_or_default();
            let mut lines = content.lines();
            let owner = lines.next().unwrap_or("");
            let owner_label = lines.next().unwrap_or("another agent");
            if owner == agent_id || owner.is_empty() {
                Decision::Allow
            } else {
                Decision::Deny(format!(
                    "{} is being edited by {} right now. Do not edit it and do not wait for it. \
                     Finish the rest of your task, then say this file still needs your change.",
                    file_path, owner_label
                ))
            }
        }
    }
}

/// When the app was started as the hook, handles it and returns the exit code.
/// Exit code 2 is how a PreToolUse hook blocks the tool; stderr goes to Claude.
pub fn run_hook_from_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(HOOK_FLAG) || args.len() < 5 {
        return None;
    }
    let (agent_id, agent_label, dir) = (&args[2], &args[3], PathBuf::from(&args[4]));

    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return Some(0);
    }
    let Ok(event) = serde_json::from_str::<serde_json::Value>(&input) else { return Some(0) };
    let tool_input = &event["tool_input"];
    let Some(raw_path) = tool_input["file_path"].as_str().or_else(|| tool_input["notebook_path"].as_str()) else {
        return Some(0);
    };
    let cwd = event["cwd"].as_str().unwrap_or("");
    let path = if Path::new(raw_path).is_absolute() || cwd.is_empty() {
        PathBuf::from(raw_path)
    } else {
        Path::new(cwd).join(raw_path)
    };

    // One file can have several spellings (symlinks, /var vs /private/var);
    // claims must agree on one. A file about to be created has none yet.
    let path = path.canonicalize().unwrap_or(path);
    match decide(&dir, agent_id, agent_label, &path.to_string_lossy()) {
        Decision::Allow => Some(0),
        Decision::Deny(message) => {
            eprintln!("{}", message);
            Some(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_agent_claims_and_others_are_refused() {
        let dir = std::env::temp_dir().join(format!("cc-claims-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        assert!(matches!(decide(&dir, "main", "Main", "/repo/a.tsx"), Decision::Allow));
        // The owner may keep editing its own file.
        assert!(matches!(decide(&dir, "main", "Main", "/repo/a.tsx"), Decision::Allow));
        match decide(&dir, "agent-2", "Agent 2", "/repo/a.tsx") {
            Decision::Deny(msg) => assert!(msg.contains("Main") && msg.contains("/repo/a.tsx")),
            Decision::Allow => panic!("second agent should be refused"),
        }
        // A different file is free.
        assert!(matches!(decide(&dir, "agent-2", "Agent 2", "/repo/b.tsx"), Decision::Allow));

        let _ = fs::remove_dir_all(&dir);
    }
}

mod agents;
mod claims;
mod proxy;
mod route;
mod shell_guard;
mod usage;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Resolve the full path to the `claude` binary.
/// macOS GUI apps inherit a minimal PATH, so we check common install locations.
fn resolve_claude_binary() -> String {
    let candidates = [
        dirs::home_dir().map(|h| h.join(".local/bin/claude")),
        dirs::home_dir().map(|h| h.join(".npm-global/bin/claude")),
        Some(PathBuf::from("/usr/local/bin/claude")),
        Some(PathBuf::from("/opt/homebrew/bin/claude")),
    ];
    for candidate in candidates.iter().flatten() {
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    // Fall back to bare name and hope PATH works
    "claude".to_string()
}

#[derive(Serialize)]
pub struct FileEntry {
    path: String,
    relative_path: String,
}

#[derive(Serialize)]
pub struct FileSnapshot {
    path: String,
    content: String,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "target",
    ".turbo",
    "coverage",
    ".cache",
];

#[tauri::command]
fn read_directory_recursive(root: String, extensions: Vec<String>) -> Result<Vec<FileEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {}", root));
    }

    let mut entries = Vec::new();

    for entry in WalkDir::new(&root_path)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !SKIP_DIRS.contains(&name.as_ref());
            }
            true
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if extensions.iter().any(|e| e.to_lowercase() == ext_str) {
                    let relative = path
                        .strip_prefix(&root_path)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string();
                    entries.push(FileEntry {
                        path: path.to_string_lossy().to_string(),
                        relative_path: relative,
                    });
                }
            }
        }
    }

    Ok(entries)
}

#[tauri::command]
fn read_file_contents(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn snapshot_files(paths: Vec<String>) -> Result<Vec<FileSnapshot>, String> {
    let mut snapshots = Vec::new();
    for path in paths {
        match fs::read_to_string(&path) {
            Ok(content) => snapshots.push(FileSnapshot {
                path: path.clone(),
                content,
            }),
            Err(e) => {
                // Skip files that can't be read (binary, permissions, etc.)
                eprintln!("Warning: could not read {}: {}", path, e);
            }
        }
    }
    Ok(snapshots)
}

#[tauri::command]
fn write_file_contents(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dirs: {}", e))?;
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path, e))
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let file_path = Path::new(&path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dirs: {}", e))?;
    }
    fs::write(&path, &data).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
async fn git_has_changes(cwd: String) -> Result<bool, String> {
    use tokio::process::Command;
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git status: {}", e))?;
    Ok(!output.stdout.is_empty())
}

#[tauri::command]
async fn git_unpushed_count(cwd: String) -> Result<u32, String> {
    use tokio::process::Command;
    // Check if there's an upstream branch
    let upstream = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "@{u}"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to check upstream: {}", e))?;
    if !upstream.status.success() {
        return Ok(0);
    }
    let count_output = Command::new("git")
        .args(["rev-list", "--count", "@{u}..HEAD"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to count unpushed: {}", e))?;
    let count_str = String::from_utf8_lossy(&count_output.stdout).trim().to_string();
    count_str.parse::<u32>().map_err(|e| format!("Failed to parse count: {}", e))
}

async fn git_output(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    tokio::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))
}

#[tauri::command]
async fn git_current_branch(cwd: String) -> Result<String, String> {
    let output = git_output(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // A detached HEAD reads as "HEAD", so show the commit instead.
    if branch == "HEAD" {
        let sha = git_output(&cwd, &["rev-parse", "--short", "HEAD"]).await?;
        return Ok(format!("detached at {}", String::from_utf8_lossy(&sha.stdout).trim()));
    }
    Ok(branch)
}

#[tauri::command]
async fn git_list_branches(cwd: String) -> Result<Vec<String>, String> {
    let output = git_output(&cwd, &["branch", "--format=%(refname:short)"]).await?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// Switches to a local branch, or creates it from the current one. Git refuses
/// when uncommitted changes would be overwritten, and that message is passed on.
#[tauri::command]
async fn git_switch_branch(cwd: String, branch: String, create: bool) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') {
        return Err("Enter a branch name.".to_string());
    }
    let args: Vec<&str> = if create { vec!["switch", "-c", branch] } else { vec!["switch", branch] };
    let output = git_output(&cwd, &args).await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// One turn on a long-lived agent process; see agents.rs.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn agent_run_turn(
    app: tauri::AppHandle,
    manager: tauri::State<'_, agents::AgentManager>,
    agent_id: String,
    agent_label: String,
    prompt: String,
    cwd: String,
    model: Option<String>,
    session_id: Option<String>,
    allowed_tools: String,
    auto_compact: bool,
    one_shot: bool,
) -> Result<serde_json::Value, String> {
    manager
        .run_turn(
            &app,
            agents::TurnRequest {
                agent_id,
                agent_label,
                prompt,
                cwd,
                model,
                session_id,
                allowed_tools,
                auto_compact,
                one_shot,
            },
        )
        .await
}

#[tauri::command]
async fn agent_kill(manager: tauri::State<'_, agents::AgentManager>, agent_id: String) -> Result<(), String> {
    manager.kill(&agent_id).await;
    Ok(())
}

#[tauri::command]
async fn agent_kill_all(manager: tauri::State<'_, agents::AgentManager>) -> Result<(), String> {
    manager.kill_all().await;
    Ok(())
}

#[tauri::command]
async fn typesafe_key_status() -> Result<bool, String> {
    Ok(route::read_key().await.is_some())
}

#[tauri::command]
async fn typesafe_set_key(key: String) -> Result<(), String> {
    route::write_key(&key).await
}

#[tauri::command]
async fn route_message(
    running_request: String,
    files_changed: Vec<String>,
    new_message: String,
) -> Result<route::Route, String> {
    route::route(&running_request, &files_changed, &new_message).await
}

#[tauri::command]
async fn claude_plan_usage() -> Result<usage::PlanUsage, String> {
    usage::plan_usage().await
}

#[derive(Serialize)]
pub struct GitPushResult {
    success: bool,
    message: String,
}

#[tauri::command]
async fn git_push(cwd: String) -> Result<GitPushResult, String> {
    use tokio::process::Command;
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to get branch: {}", e))?;
    let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to push: {}", e))?;
    if push_output.status.success() {
        Ok(GitPushResult {
            success: true,
            message: format!("Pushed to origin/{}", branch),
        })
    } else {
        let stderr = String::from_utf8_lossy(&push_output.stderr).to_string();
        Ok(GitPushResult {
            success: false,
            message: stderr,
        })
    }
}

#[tauri::command]
fn check_claude_cli() -> Result<bool, String> {
    let bin = resolve_claude_binary();
    Ok(std::path::Path::new(&bin).exists())
}

#[tauri::command]
async fn start_inspector_proxy(dev_server_url: String) -> Result<u16, String> {
    proxy::start_proxy(dev_server_url).await
}

#[tauri::command]
async fn stop_inspector_proxy() -> Result<(), String> {
    proxy::stop_proxy().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// WebKit applies the system's smart quotes, dash and text substitutions to
/// editable fields, and rewrites the typed text behind the editor's back. That
/// made quotes lag and the task editor's cursor drift. These keys are WebKit's
/// per-app switches, set before any webview exists.
#[cfg(target_os = "macos")]
fn disable_text_substitutions() {
    use objc2_foundation::{NSString, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    for key in [
        "WebAutomaticQuoteSubstitutionEnabled",
        "WebAutomaticDashSubstitutionEnabled",
        "WebAutomaticTextReplacementEnabled",
        "WebAutomaticSpellingCorrectionEnabled",
        "NSAutomaticQuoteSubstitutionEnabled",
        "NSAutomaticDashSubstitutionEnabled",
        "NSAutomaticTextReplacementEnabled",
        "NSAutomaticSpellingCorrectionEnabled",
        "NSAutomaticInlinePredictionEnabled",
    ] {
        defaults.setBool_forKey(false, &NSString::from_str(key));
    }
}

pub fn run() {
    // Started by Claude Code as an agent's edit hook: answer and exit, no window.
    if let Some(code) = claims::run_hook_from_args() {
        std::process::exit(code);
    }
    claims::reset();

    #[cfg(target_os = "macos")]
    disable_text_substitutions();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(agents::AgentManager::default())
        .invoke_handler(tauri::generate_handler![
            read_directory_recursive,
            read_file_contents,
            snapshot_files,
            write_file_contents,
            write_binary_file,
            delete_file,
            check_claude_cli,
            git_has_changes,
            git_unpushed_count,
            git_push,
            git_current_branch,
            git_list_branches,
            git_switch_branch,
            claude_plan_usage,
            agent_run_turn,
            agent_kill,
            agent_kill_all,
            typesafe_key_status,
            typesafe_set_key,
            route_message,
            start_inspector_proxy,
            stop_inspector_proxy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

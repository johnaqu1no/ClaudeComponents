//! Decides where a message sent mid-task should go, using TypeSafe's Jev.
//!
//! One Choice question: is the new message part of the running task, separate
//! work that can start now, or work that must wait for the running task? The
//! caller only starts a parallel agent on a confident "independent"; anything
//! else is queued, which is what happens with no API key at all.
//!
//! The key lives in the login keychain, never in the app or its settings file,
//! and never reaches the web view.

use serde::Serialize;

const KEYCHAIN_SERVICE: &str = "claude-components-typesafe";
const KEYCHAIN_ACCOUNT: &str = "api-key";

async fn security(args: &[&str]) -> Result<std::process::Output, String> {
    tokio::process::Command::new("/usr/bin/security")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Could not reach the keychain: {}", e))
}

pub async fn read_key() -> Option<String> {
    let output = security(&["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"])
        .await
        .ok()?;
    let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !key.is_empty()).then_some(key)
}

/// Saves the key, or removes it when empty.
pub async fn write_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        // Deleting a missing item is fine: the end state is the same.
        let _ = security(&["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]).await;
        return Ok(());
    }
    let output = security(&["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key]).await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    /// "same_task", "independent" or "after_running".
    pub choice: String,
    pub confidence: f64,
}

pub async fn route(running_request: &str, files_changed: &[String], new_message: &str) -> Result<Route, String> {
    let key = read_key().await.ok_or("No TypeSafe API key is set.")?;
    let body = serde_json::json!({
        "model": "jev-latest",
        "state": {
            "running_task": { "request": running_request, "files_changed_so_far": files_changed },
            "new_message": new_message,
        },
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "A coding agent is working on `running_task`. The user just sent `new_message`. Decide who should handle the new message.",
                "criteria": {
                    "same_task": "The new message adds to, corrects, redirects, or asks about the running task: the same feature or change, a tweak to it, or a question about it.",
                    "independent": "The new message is a separate piece of work that can be done right now without the running task's result and does not change what the running task is doing.",
                    "after_running": "The new message is separate work that needs the running task to finish first: it builds on, reviews, tests, commits, or undoes what the running task is changing."
                }
            }
        }
    });

    let response = reqwest::Client::new()
        .post("https://api.typesafe.ai/v1/systemone")
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("Could not reach TypeSafe: {}", e))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("TypeSafe returned HTTP {}", status.as_u16()));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let answer = &value["answers"]["route"];
    Ok(Route {
        choice: answer["choice"].as_str().ok_or("TypeSafe gave no routing answer")?.to_string(),
        confidence: answer["confidence"].as_f64().unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    /// Uses the real key and API, so it only runs on request:
    /// `cargo test --lib route -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn routes_live() {
        let files = vec!["client/pages/LoginPage.tsx".to_string()];
        let same = super::route("Change the sign in heading", &files, "make it bold too").await.unwrap();
        let other = super::route("Change the sign in heading", &files, "add a footer link to the privacy policy").await.unwrap();
        println!("same_task? {} {:.2} | independent? {} {:.2}", same.choice, same.confidence, other.choice, other.confidence);
        assert_eq!(same.choice, "same_task");
        assert_eq!(other.choice, "independent");
    }
}

//! Claude plan usage (the 5 hour session and weekly limits), read the same way
//! Claude Code's `/usage` does. The endpoint is not a published API, so every
//! failure is reported as a plain message and the UI simply shows no numbers.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub session: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
}

/// Claude Code's access token from the login keychain. It is only read, never
/// refreshed: refreshing rotates the refresh token and would sign Claude Code out.
async fn access_token() -> Result<String, String> {
    let output = tokio::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .await
        .map_err(|e| format!("Could not read the keychain: {}", e))?;
    if !output.status.success() {
        return Err("Claude Code is not signed in on this Mac.".to_string());
    }
    let credentials: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Claude Code's saved credentials are unreadable.".to_string())?;
    credentials["claudeAiOauth"]["accessToken"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Claude Code has no subscription login.".to_string())
}

fn window(value: &serde_json::Value) -> Option<UsageWindow> {
    Some(UsageWindow {
        percent: value.get("utilization")?.as_f64()?,
        resets_at: value.get("resets_at").and_then(|v| v.as_str()).map(str::to_string),
    })
}

pub async fn plan_usage() -> Result<PlanUsage, String> {
    let token = access_token().await?;
    let response = reqwest::Client::new()
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Could not reach Anthropic: {}", e))?;

    match response.status().as_u16() {
        200 => {}
        // An expired token comes back fresh the next time Claude Code runs.
        401 => return Err("Claude Code's login has expired. Run a task to refresh it.".to_string()),
        status => return Err(format!("Usage request failed with HTTP {}", status)),
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read the usage response: {}", e))?;
    let body: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Unexpected usage response: {}", e))?;
    Ok(PlanUsage {
        session: window(&body["five_hour"]),
        weekly: window(&body["seven_day"]),
    })
}

#[cfg(test)]
mod tests {
    /// Hits the network with the real login, so it only runs on request:
    /// `cargo test --lib usage -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn reads_live_plan_usage() {
        let usage = super::plan_usage().await.expect("usage");
        let session = usage.session.expect("session window");
        let weekly = usage.weekly.expect("weekly window");
        println!("session {}% resets {:?}", session.percent, session.resets_at);
        println!("weekly {}% resets {:?}", weekly.percent, weekly.resets_at);
    }
}

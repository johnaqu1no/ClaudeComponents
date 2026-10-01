//! Refuses shell commands that kill processes by name or port.
//!
//! Agents start throwaway dev servers to check their work and then clean up
//! with things like `pkill -f vite`, which also stops the user's own servers
//! and anything else matching. Killing by PID stays allowed, so an agent can
//! still stop what it started.

pub const BROAD_KILL_MESSAGE: &str = "Broad process kills are blocked in Claude Components: they also stop the user's own \
     dev servers and other apps. Stop only the process you started, by its PID: save `$!` right after starting it \
     in the background, then `kill <pid>`. If a port is already taken, use another port instead of freeing it.";

/// The words of a command, with paths reduced to their last part, so `/usr/bin/pkill` reads as `pkill`.
fn words(command: &str) -> Vec<String> {
    command
        .split(|c: char| c.is_whitespace() || ";|&()`'\"<>{}".contains(c))
        .filter(|w| !w.is_empty())
        .map(|w| w.rsplit('/').next().unwrap_or(w).to_lowercase())
        .collect()
}

/// Returns why the command is refused, or None when it may run.
pub fn check(command: &str) -> Option<&'static str> {
    let words = words(command);
    let has = |w: &str| words.iter().any(|x| x == w);

    if has("pkill") || has("killall") {
        return Some(BROAD_KILL_MESSAGE);
    }
    // `fuser -k 3000/tcp` kills whatever holds the port.
    if has("fuser") && words.iter().any(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('k')) {
        return Some(BROAD_KILL_MESSAGE);
    }
    // `kill $(lsof -ti:3000)`, `pgrep node | xargs kill` and the like look PIDs up by name or port.
    let looks_up_pids = ["lsof", "pgrep", "pidof", "ps"].iter().any(|w| has(w));
    let feeds_kill = command.contains("$(") || command.contains('`') || has("xargs");
    if has("kill") && looks_up_pids && feeds_kill {
        return Some(BROAD_KILL_MESSAGE);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn refuses_kills_by_name_or_port() {
        for command in [
            "pkill -f vite",
            "cd web; npx vite build; pkill -f \"vite\"",
            "/usr/bin/pkill node",
            "killall node",
            "kill $(lsof -ti:3000)",
            "kill -9 `lsof -t -i tcp:5173`",
            "lsof -ti:3000 | xargs kill -9",
            "pgrep -f vite | xargs kill",
            "kill $(ps aux | grep vite | awk '{print $2}')",
            "fuser -k 3000/tcp",
        ] {
            assert!(check(command).is_some(), "should refuse: {}", command);
        }
    }

    #[test]
    fn allows_kills_by_pid_and_lookups_alone() {
        for command in [
            "kill 12345",
            "kill -9 12345",
            "npx vite > /tmp/log 2>&1 & echo $! > /tmp/vite.pid",
            "kill $(cat /tmp/vite.pid)",
            "kill $PID",
            "kill %1",
            "lsof -nP -iTCP:3000 -sTCP:LISTEN",
            "ps aux | grep vite",
            "npm run build",
        ] {
            assert!(check(command).is_none(), "should allow: {}", command);
        }
    }
}

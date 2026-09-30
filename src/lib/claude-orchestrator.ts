import { invoke } from "@tauri-apps/api/core";

export async function checkClaudeAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("check_claude_cli");
  } catch {
    return false;
  }
}

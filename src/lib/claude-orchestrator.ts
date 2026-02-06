import { Command } from "@tauri-apps/plugin-shell";
import type { ClaudeExecutionResult } from "../types";

export async function checkClaudeAvailable(): Promise<boolean> {
  try {
    const cmd = Command.create("claude-cli", ["--version"]);
    const output = await cmd.execute();
    return output.code === 0;
  } catch {
    return false;
  }
}

export async function executeClaudeCode(
  prompt: string,
  cwd: string
): Promise<ClaudeExecutionResult> {
  const startTime = Date.now();

  const args = [
    "-p",
    "--output-format",
    "json",
    "--allowedTools",
    "Read,Edit,Write",
    prompt,
  ];

  const cmd = Command.create("claude-cli", args, { cwd });
  const output = await cmd.execute();

  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.code ?? -1,
    durationMs: Date.now() - startTime,
  };
}

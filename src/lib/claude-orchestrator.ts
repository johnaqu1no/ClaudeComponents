import { invoke } from "@tauri-apps/api/core";
import type { ClaudeExecutionResult } from "../types";

export async function checkClaudeAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("check_claude_cli");
  } catch {
    return false;
  }
}

export async function executeClaudeCode(
  prompt: string,
  cwd: string,
  sessionId?: string
): Promise<ClaudeExecutionResult> {
  const result = await invoke<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    sessionId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }>("execute_claude", {
    prompt,
    cwd,
    sessionId: sessionId ?? null,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    sessionId: result.sessionId ?? undefined,
    inputTokens: result.inputTokens ?? undefined,
    outputTokens: result.outputTokens ?? undefined,
  };
}

export async function executeClaudeCodeInteractive(
  prompt: string,
  cwd: string,
  sessionId?: string,
  allowedTools?: string
): Promise<ClaudeExecutionResult> {
  const result = await invoke<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    sessionId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }>("execute_claude_interactive", {
    prompt,
    cwd,
    sessionId: sessionId ?? null,
    allowedTools: allowedTools ?? null,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    sessionId: result.sessionId ?? undefined,
    inputTokens: result.inputTokens ?? undefined,
    outputTokens: result.outputTokens ?? undefined,
  };
}

export async function killClaudeProcess(): Promise<void> {
  await invoke("kill_claude_process");
}

import { invoke } from "@tauri-apps/api/core";
import type { ActivityItem } from "./activity";
import type { ClaudeExecutionResult } from "../types";

/** The chat's own agent, whose process stays warm between messages. */
export const MAIN_AGENT = "main";
/** Commit runs in a fresh session of its own, so it never touches the chat's context. */
export const COMMIT_AGENT = "commit";
/** Parallel agents at once, on top of the main one. */
export const MAX_PARALLEL_AGENTS = 3;
export const MAIN_TOOLS = "Read,Edit,Write,Bash,AskUserQuestion";

export interface AgentTurn {
  agentId: string;
  agentLabel: string;
  prompt: string;
  cwd: string;
  model: string;
  sessionId?: string;
  tools: string;
  autoCompact: boolean;
  /** Stop the process once this turn ends. */
  oneShot?: boolean;
}

export interface AgentStreamEvent {
  agentId: string;
  line: string;
}

export async function runAgentTurn(turn: AgentTurn): Promise<ClaudeExecutionResult> {
  const result = await invoke<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    sessionId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }>("agent_run_turn", {
    agentId: turn.agentId,
    agentLabel: turn.agentLabel,
    prompt: turn.prompt,
    cwd: turn.cwd,
    model: turn.model,
    sessionId: turn.sessionId ?? null,
    allowedTools: turn.tools,
    autoCompact: turn.autoCompact,
    oneShot: turn.oneShot ?? false,
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

export async function killAgent(agentId: string): Promise<void> {
  await invoke("agent_kill", { agentId });
}

export async function killAllAgents(): Promise<void> {
  await invoke("agent_kill_all");
}

/** Absolute paths an agent wrote to, from its own tool calls. */
export function filesEditedBy(items: ActivityItem[]): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(item.name)) continue;
    const path = item.input.file_path ?? item.input.notebook_path;
    if (typeof path === "string" && path) paths.add(path);
  }
  return [...paths];
}

export interface RouteDecision {
  choice: "same_task" | "independent" | "after_running";
  confidence: number;
}

/** Below this, an "independent" verdict is not trusted to start a new agent. */
export const ROUTE_MIN_CONFIDENCE = 0.6;

export async function routeMessage(runningRequest: string, filesChanged: string[], newMessage: string): Promise<RouteDecision> {
  return invoke<RouteDecision>("route_message", { runningRequest, filesChanged, newMessage });
}

export async function typesafeKeyStatus(): Promise<boolean> {
  return invoke<boolean>("typesafe_key_status");
}

/** Saves the key to the keychain; an empty string removes it. */
export async function setTypesafeKey(key: string): Promise<void> {
  await invoke("typesafe_set_key", { key });
}

import { invoke } from "@tauri-apps/api/core";

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

/** The Claude plan's rolling limits, as Claude Code's /usage reports them. */
export interface PlanUsage {
  session: UsageWindow | null;
  weekly: UsageWindow | null;
}

export async function fetchPlanUsage(): Promise<PlanUsage> {
  return invoke<PlanUsage>("claude_plan_usage");
}

/** "2h 14m", "3d 4h": time left until a window resets. */
export function timeUntil(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

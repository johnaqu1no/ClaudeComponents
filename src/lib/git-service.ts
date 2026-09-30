import { invoke } from "@tauri-apps/api/core";

export async function gitHasChanges(cwd: string): Promise<boolean> {
  return invoke<boolean>("git_has_changes", { cwd });
}

export async function getUnpushedCount(cwd: string): Promise<number> {
  return invoke<number>("git_unpushed_count", { cwd });
}

export async function gitPush(cwd: string): Promise<{ success: boolean; message: string }> {
  return invoke<{ success: boolean; message: string }>("git_push", { cwd });
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return invoke<string>("git_current_branch", { cwd });
}

export async function listBranches(cwd: string): Promise<string[]> {
  return invoke<string[]>("git_list_branches", { cwd });
}

/** Rejects with git's own message, e.g. when uncommitted changes are in the way. */
export async function switchBranch(cwd: string, branch: string, create: boolean): Promise<void> {
  await invoke("git_switch_branch", { cwd, branch, create });
}

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

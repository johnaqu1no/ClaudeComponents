import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import type { TaskHistoryEntry } from "../types";

export interface PersistedSettings {
  repoPath: string | null;
  devServerUrl: string | null;
}

const SETTINGS_FILE = "settings.json";
const HISTORY_FILE = "history.json";

let cachedDir: string | null = null;

async function getDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  cachedDir = await appDataDir();
  return cachedDir;
}

async function getSettingsPath(): Promise<string> {
  return `${await getDir()}${SETTINGS_FILE}`;
}

async function getHistoryPath(): Promise<string> {
  return `${await getDir()}${HISTORY_FILE}`;
}

export async function loadSettings(): Promise<PersistedSettings> {
  try {
    const path = await getSettingsPath();
    const content: string = await invoke("read_file_contents", { path });
    return JSON.parse(content) as PersistedSettings;
  } catch {
    return { repoPath: null, devServerUrl: null };
  }
}

export async function saveSettings(settings: PersistedSettings): Promise<void> {
  try {
    const path = await getSettingsPath();
    await invoke("write_file_contents", {
      path,
      content: JSON.stringify(settings, null, 2),
    });
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}

const MAX_OUTPUT_LEN = 2000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
}

export async function loadHistory(): Promise<TaskHistoryEntry[]> {
  try {
    const path = await getHistoryPath();
    const content: string = await invoke("read_file_contents", { path });
    const entries = JSON.parse(content) as TaskHistoryEntry[];
    // Ensure diffs is always an array for restored entries
    return entries.map((e) => ({ ...e, diffs: e.diffs ?? [] }));
  } catch {
    return [];
  }
}

export async function saveHistory(entries: TaskHistoryEntry[]): Promise<void> {
  try {
    const path = await getHistoryPath();
    const trimmed = entries.map((e) => ({
      ...e,
      diffCount: e.diffs.length || e.diffCount || 0,
      diffs: [],
      result: e.result
        ? {
            ...e.result,
            stdout: truncate(e.result.stdout, MAX_OUTPUT_LEN),
            stderr: truncate(e.result.stderr, MAX_OUTPUT_LEN),
          }
        : null,
    }));
    await invoke("write_file_contents", {
      path,
      content: JSON.stringify(trimmed, null, 2),
    });
  } catch (err) {
    console.error("Failed to save history:", err);
  }
}

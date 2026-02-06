import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";

export interface PersistedSettings {
  repoPath: string | null;
  devServerUrl: string | null;
}

const SETTINGS_FILE = "settings.json";

let settingsPath: string | null = null;

async function getSettingsPath(): Promise<string> {
  if (settingsPath) return settingsPath;
  const dir = await appDataDir();
  settingsPath = `${dir}${SETTINGS_FILE}`;
  return settingsPath;
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

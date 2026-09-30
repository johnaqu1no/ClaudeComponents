import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppState, useAppDispatch } from "../stores/app-store";
import { CLAUDE_MODELS } from "../lib/models";

export function SettingsPanel() {
  const { settingsOpen, repoPath, devServerUrl, model } = useAppState();
  const dispatch = useAppDispatch();

  const [urlInput, setUrlInput] = useState(devServerUrl || "");

  if (!settingsOpen) return null;

  const handleSelectRepo = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      dispatch({ type: "SET_REPO", path: selected as string });
    }
  };

  const handleSaveUrl = () => {
    const trimmed = urlInput.trim();
    if (trimmed) {
      dispatch({ type: "SET_DEV_SERVER_URL", url: trimmed });
    }
  };

  return (
    <div className="settings-backdrop" onClick={() => dispatch({ type: "SET_SETTINGS_OPEN", open: false })}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button
            className="settings-close"
            onClick={() => dispatch({ type: "SET_SETTINGS_OPEN", open: false })}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="settings-section">
          <label className="settings-label">Repository / Component Folder</label>
          <p className="settings-description">
            The folder containing the React components to scan.
          </p>
          <div className="settings-row">
            <span className="settings-path">
              {repoPath || "No folder selected"}
            </span>
            <button className="btn-secondary btn-sm" onClick={handleSelectRepo}>
              Browse
            </button>
          </div>
        </div>

        <div className="settings-section">
          <label className="settings-label">Claude Model</label>
          <p className="settings-description">
            The model Claude Code runs tasks with. The context bar follows its window.
          </p>
          <div className="settings-row">
            <select
              className="settings-input"
              value={model}
              onChange={(e) => dispatch({ type: "SET_MODEL", model: e.target.value })}
            >
              {CLAUDE_MODELS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} ({option.contextWindow >= 1_000_000
                    ? `${option.contextWindow / 1_000_000}M`
                    : `${option.contextWindow / 1000}K`} context)
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-section">
          <label className="settings-label">Dev Server URL</label>
          <p className="settings-description">
            The URL of your running dev server (e.g. http://localhost:3000).
          </p>
          <div className="settings-row">
            <input
              type="text"
              className="settings-input"
              placeholder="http://localhost:3000"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveUrl();
              }}
            />
            <button className="btn-primary btn-sm" onClick={handleSaveUrl}>
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

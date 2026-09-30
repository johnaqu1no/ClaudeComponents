import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppState, useAppDispatch } from "../stores/app-store";
import { CLAUDE_MODELS } from "../lib/models";
import { listBranches, switchBranch } from "../lib/git-service";

export function SettingsPanel() {
  const { settingsOpen, repoPath, devServerUrl, model, recentProjects, branch, phase } = useAppState();
  const dispatch = useAppDispatch();

  const [urlInput, setUrlInput] = useState(devServerUrl || "");

  const [branches, setBranches] = useState<string[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!settingsOpen || !repoPath) return;
    listBranches(repoPath)
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [settingsOpen, repoPath, branch]);

  const changeBranch = async (name: string, create: boolean) => {
    if (!repoPath || !name.trim()) return;
    setSwitching(true);
    setBranchError(null);
    try {
      await switchBranch(repoPath, name, create);
      dispatch({ type: "SET_BRANCH", branch: name.trim() });
      setNewBranch("");
      // The files on disk just changed, so rescan (which also reloads the preview).
      dispatch({ type: "SET_REPO", path: repoPath });
    } catch (err) {
      setBranchError(String(err));
    } finally {
      setSwitching(false);
    }
  };
  const branchLocked = switching || phase === "executing";

  // Switching projects swaps the URL too, so the box has to follow it.
  useEffect(() => {
    setUrlInput(devServerUrl || "");
  }, [devServerUrl]);

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
          {recentProjects.length > 0 && (
            <div className="settings-row settings-row-spaced">
              <select
                className="settings-input"
                value={repoPath ?? ""}
                onChange={(e) => {
                  const project = recentProjects.find((entry) => entry.repoPath === e.target.value);
                  if (project) {
                    dispatch({
                      type: "OPEN_PROJECT",
                      repoPath: project.repoPath,
                      devServerUrl: project.devServerUrl,
                    });
                  }
                }}
              >
                {!repoPath && <option value="">Recent projects</option>}
                {recentProjects.map((project) => (
                  <option key={project.repoPath} value={project.repoPath} title={project.repoPath}>
                    {projectLabel(project.repoPath, project.devServerUrl)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="settings-row">
            <span className="settings-path">
              {repoPath || "No folder selected"}
            </span>
            <button className="btn-secondary btn-sm" onClick={handleSelectRepo}>
              Browse
            </button>
          </div>
        </div>

        {repoPath && branch && (
          <div className="settings-section">
            <label className="settings-label">Branch</label>
            <p className="settings-description">
              Switch the open folder's git branch, or start a new one from it.
            </p>
            <div className="settings-row settings-row-spaced">
              <select
                className="settings-input"
                value={branch}
                disabled={branchLocked}
                onChange={(e) => changeBranch(e.target.value, false)}
              >
                {!branches.includes(branch) && <option value={branch}>{branch}</option>}
                {branches.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <input
                type="text"
                className="settings-input"
                placeholder="new-branch-name"
                value={newBranch}
                disabled={branchLocked}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") changeBranch(newBranch, true);
                }}
              />
              <button
                className="btn-primary btn-sm"
                disabled={branchLocked || !newBranch.trim()}
                onClick={() => changeBranch(newBranch, true)}
              >
                Create
              </button>
            </div>
            {phase === "executing" && (
              <p className="settings-hint">Claude is working. Switch once the task finishes.</p>
            )}
            {branchError && <p className="settings-error">{branchError}</p>}
          </div>
        )}

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

/**
 * "MCPROS/Web  ·  127.0.0.1:5173". The parent folder is kept because so many
 * projects are just "web" or "client" on their own.
 */
function projectLabel(repoPath: string, devServerUrl: string | null): string {
  const name = repoPath.split("/").filter(Boolean).slice(-2).join("/") || repoPath;
  if (!devServerUrl) return `${name}  ·  no dev server`;
  try {
    return `${name}  ·  ${new URL(devServerUrl).host}`;
  } catch {
    return `${name}  ·  ${devServerUrl}`;
  }
}

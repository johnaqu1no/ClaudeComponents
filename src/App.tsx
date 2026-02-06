import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AppStateContext,
  AppDispatchContext,
  appReducer,
  initialState,
} from "./stores/app-store";
import { TaskEditor, type TaskEditorRef } from "./components/TaskEditor";
import { DiffViewer } from "./components/DiffViewer";
import { WebviewPanel } from "./components/WebviewPanel";
import { InspectorToggle } from "./components/InspectorToggle";
import { SourcePreview } from "./components/SourcePreview";
import { TaskHistory } from "./components/TaskHistory";
import { SettingsPanel } from "./components/SettingsPanel";
import { scanRepository } from "./lib/scanner";
import { resolvePrompt } from "./lib/prompt-resolver";
import {
  checkClaudeAvailable,
  executeClaudeCode,
} from "./lib/claude-orchestrator";
import { createSnapshot, computeDiffs } from "./lib/diff-engine";
import { loadSettings, saveSettings } from "./lib/settings";
import type { JSONContent } from "@tiptap/react";
import type { ComponentInfo, FileSnapshot } from "./types";
import "./App.css";

function AppInner() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const editorRef = useRef<TaskEditorRef>(null);
  const snapshotRef = useRef<Map<string, FileSnapshot>>(new Map());
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(false);

  // Panel resize handlers
  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!resizingRef.current) return;
      const newWidth = window.innerWidth - e.clientX;
      setRightPanelWidth(Math.max(280, Math.min(800, newWidth)));
    }
    function handleMouseUp() {
      if (resizingRef.current) {
        resizingRef.current = false;
        setIsResizing(false);
      }
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
  }, []);

  const componentMap = useMemo(() => {
    const map = new Map<string, ComponentInfo>();
    for (const comp of state.components) {
      map.set(comp.name, comp);
    }
    return map;
  }, [state.components]);

  // Load saved settings + check Claude CLI on mount
  useEffect(() => {
    checkClaudeAvailable().then((available) => {
      dispatch({ type: "SET_CLAUDE_AVAILABLE", available });
    });
    loadSettings().then((settings) => {
      if (settings.repoPath || settings.devServerUrl) {
        dispatch({
          type: "LOAD_SETTINGS",
          repoPath: settings.repoPath,
          devServerUrl: settings.devServerUrl,
        });
      }
    });
  }, []);

  // Persist settings when repoPath or devServerUrl change
  const prevRepoRef = useRef(state.repoPath);
  const prevUrlRef = useRef(state.devServerUrl);
  useEffect(() => {
    if (
      state.repoPath !== prevRepoRef.current ||
      state.devServerUrl !== prevUrlRef.current
    ) {
      prevRepoRef.current = state.repoPath;
      prevUrlRef.current = state.devServerUrl;
      saveSettings({
        repoPath: state.repoPath,
        devServerUrl: state.devServerUrl,
      });
    }
  }, [state.repoPath, state.devServerUrl]);

  // Scan repo when selected
  useEffect(() => {
    if (state.phase !== "scanning" || !state.repoPath) return;

    let cancelled = false;

    scanRepository(state.repoPath)
      .then((components) => {
        if (!cancelled) {
          dispatch({ type: "SET_COMPONENTS", components });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          dispatch({
            type: "SET_ERROR",
            error: `Scan failed: ${err}`,
          });
          dispatch({ type: "SET_PHASE", phase: "idle" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [state.phase, state.repoPath]);

  const handleSubmit = useCallback(
    async (doc: JSONContent) => {
      if (!state.repoPath || state.phase !== "ready") return;

      const prompt = resolvePrompt(doc, componentMap);
      if (!prompt) return;

      const taskId = crypto.randomUUID();
      const taskText =
        prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;

      dispatch({
        type: "ADD_TASK_HISTORY",
        entry: {
          id: taskId,
          taskText,
          timestamp: Date.now(),
          status: "running",
          result: null,
          diffs: [],
        },
      });

      dispatch({ type: "SET_PHASE", phase: "executing" });

      try {
        snapshotRef.current = await createSnapshot(state.repoPath);
        const result = await executeClaudeCode(prompt, state.repoPath);
        dispatch({ type: "SET_EXECUTION_RESULT", result });

        const diffs = await computeDiffs(state.repoPath, snapshotRef.current);
        dispatch({ type: "SET_DIFFS", diffs });

        dispatch({
          type: "UPDATE_TASK_HISTORY",
          id: taskId,
          updates: { status: "success", result, diffs },
        });
      } catch (err) {
        dispatch({
          type: "SET_ERROR",
          error: `Execution failed: ${err}`,
        });
        dispatch({ type: "SET_PHASE", phase: "ready" });
        dispatch({
          type: "UPDATE_TASK_HISTORY",
          id: taskId,
          updates: { status: "failed" },
        });
      }
    },
    [state.repoPath, state.phase, componentMap]
  );

  const handleNewTask = useCallback(() => {
    dispatch({ type: "SET_PHASE", phase: "ready" });
    setTimeout(() => editorRef.current?.focus(), 100);
  }, []);

  const handleInsertMention = useCallback((name: string) => {
    editorRef.current?.insertMention(name);
  }, []);

  const showDiffPanel = state.phase === "reviewing" && state.diffs.length > 0;

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        <div className="app">
          {/* Toolbar */}
          <header className="app-toolbar">
            <div className="toolbar-left">
              <h1 className="toolbar-title">Claude Components</h1>
              {state.repoPath && (
                <span className="toolbar-repo" title={state.repoPath}>
                  {state.repoPath.split("/").slice(-2).join("/")}
                </span>
              )}
            </div>
            <div className="toolbar-right">
              <button
                className="toolbar-icon-btn"
                onClick={() => window.dispatchEvent(new Event("reload-webview"))}
                title="Refresh page"
                disabled={!state.proxyPort}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
              </button>
              <InspectorToggle />
              {state.components.length > 0 && (
                <span className="toolbar-badge">
                  {state.components.length} components
                </span>
              )}
            </div>
          </header>

          {/* Error / status banners */}
          {state.claudeAvailable === false && (
            <div className="error-banner">
              Claude Code CLI not found. Please install it and ensure{" "}
              <code>claude</code> is in your PATH.
            </div>
          )}

          {state.error && (
            <div className="error-banner">
              {state.error}
              <button
                className="error-dismiss"
                onClick={() => dispatch({ type: "SET_ERROR", error: null })}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Main content area */}
          <div className={`app-body${isResizing ? " resizing" : ""}`}>
            {/* Left: Webview */}
            <div className="panel-left">
              {state.phase === "scanning" ? (
                <div className="scanning-message">
                  <div className="spinner" />
                  <p>Scanning for React components...</p>
                </div>
              ) : (
                <WebviewPanel />
              )}
            </div>

            {/* Resize handle */}
            <div className="resize-handle" onMouseDown={handleResizeStart} />

            {/* Right: Source preview + editor + history */}
            <div className="panel-right" style={{ width: rightPanelWidth }}>
              <SourcePreview onInsertMention={handleInsertMention} />

              {(state.phase === "ready" || state.phase === "executing") && (
                <div className="editor-section">
                  <TaskEditor
                    ref={editorRef}
                    components={state.components}
                    onSubmit={handleSubmit}
                    disabled={state.phase === "executing"}
                  />
                  <div className="editor-actions">
                    <button
                      className="btn-primary"
                      onClick={() => {
                        const json = editorRef.current?.getJSON();
                        if (json) handleSubmit(json);
                      }}
                      disabled={
                        state.phase === "executing" ||
                        state.claudeAvailable === false
                      }
                    >
                      {state.phase === "executing" ? (
                        <>
                          <span className="spinner-small" />
                          Running...
                        </>
                      ) : (
                        "Run with Claude"
                      )}
                    </button>
                    <span className="shortcut-hint">
                      {navigator.platform?.includes("Mac")
                        ? "\u2318"
                        : "Ctrl+"}
                      Enter
                    </span>
                    <button
                      className="toolbar-icon-btn"
                      style={{ marginLeft: "auto" }}
                      onClick={() =>
                        dispatch({ type: "SET_SETTINGS_OPEN", open: true })
                      }
                      title="Settings"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {state.phase === "idle" && !state.repoPath && (
                <div className="panel-empty-state">
                  <p>Open settings to select a project folder and dev server.</p>
                </div>
              )}

              <div className="task-history-section">
                <div className="section-label">History</div>
                <TaskHistory />
              </div>
            </div>
          </div>

          {/* Bottom: Diff viewer */}
          {showDiffPanel && (
            <div className="panel-bottom">
              <div className="diff-panel-header">
                <span className="section-label">Changes</span>
                <button className="btn-secondary btn-sm" onClick={handleNewTask}>
                  New Task
                </button>
              </div>
              <DiffViewer />
            </div>
          )}

          {/* Settings modal */}
          <SettingsPanel />
        </div>
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export default function App() {
  return <AppInner />;
}

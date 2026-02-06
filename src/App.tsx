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
import { listen } from "@tauri-apps/api/event";
import type { JSONContent } from "@tiptap/react";
import type { ComponentInfo, FileSnapshot } from "./types";
import "./App.css";

function parseStreamLine(line: string): string | null {
  try {
    const data = JSON.parse(line);
    if (data.type === "assistant" && data.message?.content) {
      for (const block of data.message.content) {
        if (block.type === "text" && block.text) return block.text;
        if (block.type === "tool_use") {
          const input = block.input;
          if (block.name === "Read" && input?.file_path)
            return `Reading ${input.file_path}...`;
          if (block.name === "Edit" && input?.file_path)
            return `Editing ${input.file_path}...`;
          if (block.name === "Write" && input?.file_path)
            return `Writing ${input.file_path}...`;
          return `Using ${block.name}...`;
        }
      }
    }
    if (data.type === "result" && data.result) {
      return data.result.length > 200 ? data.result.slice(0, 200) + "..." : data.result;
    }
  } catch {
    // not JSON, skip
  }
  return null;
}

function AppInner() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const editorRef = useRef<TaskEditorRef>(null);
  const snapshotRef = useRef<Map<string, FileSnapshot>>(new Map());
  const sessionIdRef = useRef<string | undefined>(undefined);
  const promptHistoryRef = useRef<JSONContent[]>([]);
  const historyIndexRef = useRef(-1);
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const autoAcceptRef = useRef(false);

  // Hover popover for mention chips
  const [hoveredComponent, setHoveredComponent] = useState<ComponentInfo | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ top: number; left: number } | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  // Listen for Claude streaming events
  useEffect(() => {
    const unlistenPromise = listen<string>("claude-stream", (event) => {
      const parsed = parseStreamLine(event.payload);
      if (parsed) {
        dispatch({ type: "APPEND_STREAM_LINE", line: parsed });
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

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
      if (!state.repoPath || (state.phase !== "ready" && state.phase !== "reviewing")) return;

      let prompt = resolvePrompt(doc, componentMap);
      if (!prompt) return;

      // Save to prompt history and clear editor
      promptHistoryRef.current.unshift(doc);
      historyIndexRef.current = -1;
      editorRef.current?.clear();

      // Include selected component and element context
      if (
        state.selectedComponent &&
        !prompt.includes(`Component: ${state.selectedComponent.name}\n`)
      ) {
        prompt += `\n\nSelected Component:\n\nComponent: ${state.selectedComponent.name}\nFile: ${state.selectedComponent.relativePath}\n\`\`\`tsx\n${state.selectedComponent.sourceText}\n\`\`\`\n`;
      }

      if (state.selectedElement) {
        const el = state.selectedElement;
        let elementDesc = `<${el.tag || "unknown"}`;
        if (el.id) elementDesc += ` id="${el.id}"`;
        if (el.className) elementDesc += ` class="${el.className}"`;
        elementDesc += ">";
        prompt += `\nThe user is referring to this specific element: ${elementDesc}`;
        if (el.textContent) {
          prompt += `\nElement text content: "${el.textContent}"`;
        }
        prompt += "\n";
      }

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
      dispatch({ type: "CLEAR_STREAM" });

      try {
        snapshotRef.current = await createSnapshot(state.repoPath);
        const result = await executeClaudeCode(prompt, state.repoPath, sessionIdRef.current);
        if (result.sessionId) {
          sessionIdRef.current = result.sessionId;
        }
        dispatch({ type: "SET_EXECUTION_RESULT", result });

        const diffs = await computeDiffs(state.repoPath, snapshotRef.current);
        dispatch({ type: "SET_DIFFS", diffs });
        dispatch({ type: "SET_PHASE", phase: "ready" });
        dispatch({ type: "CLEAR_STREAM" });

        if (autoAcceptRef.current && diffs.length > 0) {
          dispatch({ type: "ACCEPT_ALL" });
        }

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
        dispatch({ type: "CLEAR_STREAM" });
        dispatch({
          type: "UPDATE_TASK_HISTORY",
          id: taskId,
          updates: { status: "failed" },
        });
      }
    },
    [state.repoPath, state.phase, componentMap, state.selectedComponent, state.selectedElement]
  );

  // Up/Down arrow prompt history
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp" && promptHistoryRef.current.length > 0) {
        const text = editorRef.current?.getText() ?? "";
        // Only navigate history if editor is empty or already browsing history
        if (!text.trim() || historyIndexRef.current >= 0) {
          e.preventDefault();
          const nextIndex = Math.min(
            historyIndexRef.current + 1,
            promptHistoryRef.current.length - 1
          );
          historyIndexRef.current = nextIndex;
          editorRef.current?.setContent(promptHistoryRef.current[nextIndex]);
        }
      } else if (e.key === "ArrowDown" && historyIndexRef.current >= 0) {
        e.preventDefault();
        const nextIndex = historyIndexRef.current - 1;
        historyIndexRef.current = nextIndex;
        if (nextIndex < 0) {
          editorRef.current?.clear();
        } else {
          editorRef.current?.setContent(promptHistoryRef.current[nextIndex]);
        }
      }
    },
    []
  );

  const handleNewTask = useCallback(() => {
    dispatch({ type: "SET_DIFFS", diffs: [] });
    setTimeout(() => editorRef.current?.focus(), 100);
  }, []);

  // Auto-insert @mention with element selector when component selected via inspector
  useEffect(() => {
    if (state.selectedComponent) {
      const selector = state.selectedElement?.selector;
      editorRef.current?.insertMention(state.selectedComponent.name, selector);
    }
  }, [state.selectedComponent, state.selectedElement]);

  // Hover popover for mention chips
  const handleEditorMouseOver = useCallback(
    (e: React.MouseEvent) => {
      const chip = (e.target as HTMLElement).closest(".mention-chip") as HTMLElement | null;
      if (chip) {
        clearTimeout(hoverTimeoutRef.current);
        const name = chip.getAttribute("data-id");
        if (name) {
          const comp = componentMap.get(name);
          if (comp) {
            const rect = chip.getBoundingClientRect();
            setHoveredComponent(comp);
            setHoverPosition({ top: rect.bottom + 4, left: rect.left });
          }
        }
      }
    },
    [componentMap]
  );

  const handleEditorMouseOut = useCallback((e: React.MouseEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related?.closest(".mention-chip") || related?.closest(".source-popover")) {
      return;
    }
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredComponent(null);
      setHoverPosition(null);
    }, 200);
  }, []);

  const showDiffPanel = state.diffs.length > 0;

  // Auto-scroll streaming output
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [state.streamingLines]);

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

            {/* Right: editor + streaming + history */}
            <div className="panel-right" style={{ width: rightPanelWidth }}>

              {(state.phase === "ready" || state.phase === "executing" || state.phase === "reviewing") && (
                <div
                  className="editor-section"
                  onMouseOver={handleEditorMouseOver}
                  onMouseOut={handleEditorMouseOut}
                  onKeyDown={handleEditorKeyDown}
                >
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
                    <span className="shortcut-hint">Enter</span>
                    <label className="auto-accept-toggle" title="Automatically accept all changes without review">
                      <input
                        type="checkbox"
                        checked={autoAccept}
                        onChange={(e) => {
                          setAutoAccept(e.target.checked);
                          autoAcceptRef.current = e.target.checked;
                        }}
                      />
                      <span>Auto-accept</span>
                    </label>
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

              {/* Streaming output during execution */}
              {state.phase === "executing" && state.streamingLines.length > 0 && (
                <div className="streaming-output" ref={streamRef}>
                  {state.streamingLines.map((line, i) => (
                    <div key={i} className="stream-line">{line}</div>
                  ))}
                </div>
              )}

              {state.phase === "idle" && !state.repoPath && (
                <div className="panel-empty-state">
                  <p>Open settings to select a project folder and dev server.</p>
                </div>
              )}

              <div className="task-history-section">
                <div className="task-history-header">
                  <span className="section-label">History</span>
                  <div className="task-history-actions">
                    {state.taskHistory.length > 0 && (
                      <button
                        className="btn-ghost"
                        onClick={() => {
                          sessionIdRef.current = undefined;
                          dispatch({ type: "CLEAR_TASK_HISTORY" });
                        }}
                        title="Clear conversation context and history"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
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
                  Dismiss
                </button>
              </div>
              <DiffViewer />
            </div>
          )}

          {/* Hover popover for mention source preview */}
          {hoveredComponent && hoverPosition && (
            <div
              className="source-popover"
              style={{
                position: "fixed",
                top: hoverPosition.top,
                left: hoverPosition.left,
              }}
              onMouseEnter={() => clearTimeout(hoverTimeoutRef.current)}
              onMouseLeave={() => {
                setHoveredComponent(null);
                setHoverPosition(null);
              }}
            >
              <div className="source-popover-header">
                <span className="source-preview-name">{hoveredComponent.name}</span>
                <span className="source-preview-path">
                  {hoveredComponent.relativePath}:{hoveredComponent.startLine}
                </span>
              </div>
              <pre className="source-preview-code">
                {hoveredComponent.sourceText.split("\n").map((line, i) => (
                  <div key={i} className="source-line">
                    <span className="source-line-number">
                      {hoveredComponent.startLine + i}
                    </span>
                    <span className="source-line-content">{line}</span>
                  </div>
                ))}
              </pre>
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

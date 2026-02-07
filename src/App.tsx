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
import type { ComponentInfo, FileSnapshot, QueuedMessage } from "./types";
import "./App.css";

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

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
  const [contextTokens, setContextTokens] = useState<number | null>(null);

  // Message queue
  const [queue, setQueue] = useState<QueuedMessage[]>([]);

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

  // Build the fully resolved prompt from a doc + current context
  const buildPrompt = useCallback(
    (doc: JSONContent): string | null => {
      let prompt = resolvePrompt(doc, componentMap);
      if (!prompt) return null;

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

      return prompt;
    },
    [componentMap, state.selectedComponent, state.selectedElement]
  );

  // Core execution logic — runs a fully resolved prompt
  const executeTask = useCallback(
    async (prompt: string) => {
      if (!state.repoPath) return;

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
        let result = await executeClaudeCode(prompt, state.repoPath, sessionIdRef.current);
        if (result.sessionId) {
          sessionIdRef.current = result.sessionId;
        }
        dispatch({ type: "SET_EXECUTION_RESULT", result });
        const turnTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
        if (turnTokens > 0) {
          setContextTokens((prev) => (prev ?? 0) + turnTokens);
        }

        let diffs = await computeDiffs(state.repoPath, snapshotRef.current);

        // Auto-continue: if Claude planned but made no changes, retry once
        if (
          result.exitCode === 0 &&
          diffs.length === 0 &&
          sessionIdRef.current
        ) {
          dispatch({
            type: "APPEND_STREAM_LINE",
            line: "No changes detected — continuing with implementation...",
          });

          snapshotRef.current = await createSnapshot(state.repoPath);
          const retryResult = await executeClaudeCode(
            "Do not plan or ask questions. Implement the changes now.",
            state.repoPath,
            sessionIdRef.current
          );
          if (retryResult.sessionId) {
            sessionIdRef.current = retryResult.sessionId;
          }
          result = retryResult;
          dispatch({ type: "SET_EXECUTION_RESULT", result: retryResult });
          const retryTokens =
            (retryResult.inputTokens ?? 0) + (retryResult.outputTokens ?? 0);
          if (retryTokens > 0) {
            setContextTokens((prev) => (prev ?? 0) + retryTokens);
          }
          diffs = await computeDiffs(state.repoPath, snapshotRef.current);
        }

        dispatch({ type: "SET_DIFFS", diffs });
        dispatch({ type: "SET_PHASE", phase: "ready" });
        dispatch({ type: "CLEAR_STREAM" });

        if (autoAcceptRef.current && diffs.length > 0) {
          dispatch({ type: "ACCEPT_ALL" });
          window.dispatchEvent(new Event("reload-webview"));
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
    [state.repoPath]
  );

  const handleSubmit = useCallback(
    async (doc: JSONContent) => {
      if (!state.repoPath) return;

      const prompt = buildPrompt(doc);
      if (!prompt) return;

      // Save to prompt history and clear editor
      promptHistoryRef.current.unshift(doc);
      historyIndexRef.current = -1;
      editorRef.current?.clear();

      // If currently executing, queue the message instead
      if (state.phase === "executing") {
        const promptText = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
        setQueue((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            doc,
            prompt,
            promptText,
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (state.phase !== "ready" && state.phase !== "reviewing") return;

      await executeTask(prompt);
    },
    [state.repoPath, state.phase, buildPrompt, executeTask]
  );

  // Queue drain: when phase becomes ready and queue is non-empty, pop and execute
  useEffect(() => {
    if (state.phase === "ready" && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      executeTask(next.prompt);
    }
  }, [state.phase, queue, executeTask]);

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

  // Sync URL bar with iframe navigation
  useEffect(() => {
    function handleLocation(e: Event) {
      const path = (e as CustomEvent).detail as string;
      const input = document.getElementById("toolbar-url") as HTMLInputElement | null;
      if (input && document.activeElement !== input) {
        input.value = path;
      }
    }
    window.addEventListener("webview-location", handleLocation);
    return () => window.removeEventListener("webview-location", handleLocation);
  }, []);

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
            {state.proxyPort && (
              <div className="toolbar-url-group">
                <button
                  className="toolbar-icon-btn"
                  onClick={() => window.dispatchEvent(new Event("reload-webview"))}
                  title="Refresh page"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                    <path d="M21 3v5h-5" />
                  </svg>
                </button>
                <form
                  className="toolbar-url-bar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.querySelector("input") as HTMLInputElement;
                    let path = input.value.trim();
                    if (!path) return;
                    if (!path.startsWith("/")) path = "/" + path;
                    window.dispatchEvent(new CustomEvent("navigate-webview", { detail: path }));
                    input.blur();
                  }}
                >
                  <input
                    id="toolbar-url"
                    type="text"
                    className="toolbar-url-input"
                    placeholder="/"
                    defaultValue="/"
                  />
                </form>
                <InspectorToggle />
              </div>
            )}
            <div className="toolbar-right">
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
                  />
                  <div className="editor-actions">
                    <button
                      className="btn-primary"
                      onClick={() => {
                        const json = editorRef.current?.getJSON();
                        if (json) handleSubmit(json);
                      }}
                      disabled={state.claudeAvailable === false}
                    >
                      {state.phase === "executing" ? (
                        <>
                          <span className="spinner-small" />
                          Queue
                        </>
                      ) : (
                        "Run with Claude"
                      )}
                    </button>
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

              {/* Context usage bar */}
              {contextTokens !== null && (() => {
                const usagePct = (contextTokens / 200000) * 100;
                return (
                  <div className="context-usage">
                    <div className="context-usage-label">
                      <span>Context</span>
                      <span>{formatTokens(contextTokens)} / 200K</span>
                    </div>
                    <div className="context-usage-bar">
                      <div
                        className={`context-usage-fill${usagePct > 80 ? " warning" : ""}`}
                        style={{ width: `${Math.min(usagePct, 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })()}

              {/* Message queue */}
              {queue.length > 0 && (
                <div className="message-queue">
                  <div className="queue-header">
                    <span className="section-label">Queue ({queue.length})</span>
                    <button
                      className="btn-ghost"
                      onClick={() => setQueue([])}
                    >
                      Clear All
                    </button>
                  </div>
                  <div className="queue-items">
                    {queue.map((item, i) => (
                      <div
                        key={item.id}
                        className="queue-item"
                        onDoubleClick={() => {
                          // Remove from queue and put back in editor for editing
                          setQueue((prev) => prev.filter((q) => q.id !== item.id));
                          editorRef.current?.setContent(item.doc);
                          editorRef.current?.focus();
                        }}
                      >
                        <span className="queue-item-number">{i + 1}</span>
                        <span className="queue-item-text" title={item.promptText}>
                          {item.promptText}
                        </span>
                        <button
                          className="queue-item-cancel"
                          onClick={() =>
                            setQueue((prev) => prev.filter((q) => q.id !== item.id))
                          }
                          title="Remove from queue"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
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
                          setContextTokens(null);
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

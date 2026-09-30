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
import {
  applyStreamLine,
  compactActivity,
  contextFromStreamLine,
  imagesInStreamLine,
  noteItem,
  toolLabel,
  type ActivityItem,
} from "./lib/activity";
import { ScreenshotToasts, type ScreenshotToast } from "./components/ScreenshotToasts";
import { StatsStrip } from "./components/StatsStrip";
import { fetchPlanUsage, type PlanUsage } from "./lib/usage";
import { getCurrentBranch } from "./lib/git-service";
import { docToText } from "./lib/doc-text";
import { ChatThread } from "./components/ChatThread";
import { TaskHistory } from "./components/TaskHistory";
import { SettingsPanel } from "./components/SettingsPanel";
import { AskUserModal } from "./components/AskUserModal";
import { ToolApprovalModal } from "./components/ToolApprovalModal";
import { scanRepository } from "./lib/scanner";
import { resolvePrompt } from "./lib/prompt-resolver";
import {
  checkClaudeAvailable,
  executeClaudeCodeInteractive,
  killClaudeProcess,
} from "./lib/claude-orchestrator";
import { createSnapshot, computeDiffs } from "./lib/diff-engine";
import { gitHasChanges, getUnpushedCount, gitPush } from "./lib/git-service";
import { loadSettings, saveSettings, loadHistory, saveHistory } from "./lib/settings";
import { modelById } from "./lib/models";
import { listen } from "@tauri-apps/api/event";
import type { JSONContent } from "@tiptap/react";
import type { ComponentInfo, FileSnapshot, QueuedMessage, UserQuestion, ToolApproval } from "./types";
import "./App.css";

function detectUserQuestion(line: string): UserQuestion | null {
  try {
    const data = JSON.parse(line);
    if (data.type === "assistant" && data.message?.content) {
      for (const block of data.message.content) {
        if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          const input = block.input;
          if (input?.questions && Array.isArray(input.questions) && input.questions.length > 0) {
            const q = input.questions[0];
            return {
              question: q.question ?? "Claude has a question",
              options: (q.options ?? []).map((o: { label: string; description?: string }) => ({
                label: o.label,
                description: o.description ?? "",
              })),
            };
          }
        }
      }
    }
  } catch {
    // not JSON
  }
  return null;
}

function detectToolApproval(line: string): ToolApproval | null {
  try {
    const data = JSON.parse(line);
    if (data.type === "assistant" && data.message?.content) {
      for (const block of data.message.content) {
        if (block.type === "tool_use" && block.name === "Bash") {
          const input = block.input;
          if (input?.command) {
            return {
              toolName: "Bash",
              command: input.command,
              description: input.description ?? undefined,
            };
          }
        }
      }
    }
  } catch {
    // not JSON
  }
  return null;
}

function AppInner() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const editorRef = useRef<TaskEditorRef>(null);
  const snapshotRef = useRef<Map<string, FileSnapshot>>(new Map());
  const sessionIdRef = useRef<string | undefined>(undefined);
  const sentComponentsRef = useRef<Set<string>>(new Set());
  const promptHistoryRef = useRef<JSONContent[]>([]);
  const historyIndexRef = useRef(-1);
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const [queueModalItem, setQueueModalItem] = useState<QueuedMessage | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const autoAcceptRef = useRef(false);
  const [contextTokens, setContextTokens] = useState<number | null>(null);
  const [planUsage, setPlanUsage] = useState<PlanUsage | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const userQuestionRef = useRef<UserQuestion | null>(null);
  const toolApprovalRef = useRef<ToolApproval | null>(null);
  const [autoApproveTools, setAutoApproveTools] = useState(false);
  const autoApproveToolsRef = useRef(false);
  // Read when a run starts, so a ref keeps every call site current without
  // re-creating the callbacks that start runs.
  const [autoCompact, setAutoCompact] = useState(true);
  const autoCompactRef = useRef(true);
  const commitFlowRef = useRef(false);
  const currentTaskIdRef = useRef<string | null>(null);
  const taskActivityRef = useRef<ActivityItem[]>([]);
  const addActivityNote = useCallback((text: string) => {
    dispatch({ type: "ADD_ACTIVITY_NOTE", text });
    taskActivityRef.current = [...taskActivityRef.current, noteItem(text, taskActivityRef.current)];
  }, []);
  // The chat shows tasks from here on; New Chat moves it forward.
  const [chatStartedAt, setChatStartedAt] = useState(() => Date.now());
  const [rightTab, setRightTab] = useState<"chat" | "history">("chat");
  const [screenshots, setScreenshots] = useState<ScreenshotToast[]>([]);
  const dismissScreenshot = useCallback((id: string) => {
    setScreenshots((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Message queue
  const [queue, setQueue] = useState<QueuedMessage[]>([]);

  // Hover popover for mention chips
  const [hoveredComponent, setHoveredComponent] = useState<ComponentInfo | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ top: number; left: number } | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Panel resize handlers
  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (resizingRef.current) {
        const newWidth = window.innerWidth - e.clientX;
        const maxWidth = Math.floor(window.innerWidth * 0.9);
        setRightPanelWidth(Math.max(280, Math.min(maxWidth, newWidth)));
      }
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
      dispatch({ type: "APPLY_STREAM_EVENT", line: event.payload });
      taskActivityRef.current = applyStreamLine(taskActivityRef.current, event.payload);

      // Each assistant message reports how full the context is at that point.
      const context = contextFromStreamLine(event.payload);
      if (context !== null) setContextTokens(context);

      // Any image a tool hands back is a screenshot Claude took or looked at.
      const images = imagesInStreamLine(event.payload);
      if (images.length > 0) {
        const added = images.map(({ toolUseId, src }, index) => {
          const tool = taskActivityRef.current.find(
            (item): item is Extract<ActivityItem, { kind: "tool" }> => item.kind === "tool" && item.id === toolUseId
          );
          const label = tool ? toolLabel(tool.name, tool.input) : null;
          return {
            id: `${toolUseId}:${index}:${Date.now()}`,
            src,
            caption: label ? `${label.done}${label.detail ? ` ${label.detail}` : ""}` : "Screenshot",
          };
        });
        setScreenshots((prev) => [...prev, ...added]);
      }

      // Detect AskUserQuestion tool_use in stream
      const question = detectUserQuestion(event.payload);
      if (question) {
        userQuestionRef.current = question;
        dispatch({ type: "SET_USER_QUESTION", question });
        killClaudeProcess().catch(() => {});
        return;
      }

      // Detect Bash tool_use in stream (unless auto-approve or commit flow)
      if (!autoApproveToolsRef.current && !commitFlowRef.current) {
        const approval = detectToolApproval(event.payload);
        if (approval) {
          toolApprovalRef.current = approval;
          dispatch({ type: "SET_TOOL_APPROVAL", approval });
          killClaudeProcess().catch(() => {});
        }
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
      if (settings.repoPath || settings.devServerUrl || settings.model || settings.recentProjects?.length) {
        dispatch({
          type: "LOAD_SETTINGS",
          repoPath: settings.repoPath,
          devServerUrl: settings.devServerUrl,
          model: settings.model ?? null,
          recentProjects: settings.recentProjects ?? [],
        });
      }
      if (settings.autoCompact === false) {
        setAutoCompact(false);
        autoCompactRef.current = false;
      }
    });
    loadHistory().then((entries) => {
      if (entries.length > 0) {
        dispatch({ type: "LOAD_HISTORY", entries });
      }
    });
  }, []);

  // Persist settings when repoPath, devServerUrl or model change
  const prevRepoRef = useRef(state.repoPath);
  const prevUrlRef = useRef(state.devServerUrl);
  const prevModelRef = useRef(state.model);
  const prevRecentRef = useRef(state.recentProjects);
  const prevAutoCompactRef = useRef(autoCompact);
  useEffect(() => {
    if (
      state.repoPath !== prevRepoRef.current ||
      state.devServerUrl !== prevUrlRef.current ||
      state.model !== prevModelRef.current ||
      state.recentProjects !== prevRecentRef.current ||
      autoCompact !== prevAutoCompactRef.current
    ) {
      prevAutoCompactRef.current = autoCompact;
      prevRepoRef.current = state.repoPath;
      prevUrlRef.current = state.devServerUrl;
      prevModelRef.current = state.model;
      prevRecentRef.current = state.recentProjects;
      saveSettings({
        repoPath: state.repoPath,
        devServerUrl: state.devServerUrl,
        model: state.model,
        recentProjects: state.recentProjects,
        autoCompact,
      });
    }
  }, [state.repoPath, state.devServerUrl, state.model, state.recentProjects, autoCompact]);

  // Persist task history to disk
  const historyInitRef = useRef(true);
  useEffect(() => {
    if (historyInitRef.current) {
      historyInitRef.current = false;
      return;
    }
    saveHistory(state.taskHistory);
  }, [state.taskHistory]);

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
      const knownNames = sessionIdRef.current ? sentComponentsRef.current : undefined;
      const resolved = resolvePrompt(doc, componentMap, knownNames);
      if (!resolved) return null;

      let { prompt, referencedNames } = resolved;

      if (
        state.selectedComponent &&
        !referencedNames.includes(state.selectedComponent.name)
      ) {
        const isKnown = knownNames?.has(state.selectedComponent.name);
        if (isKnown) {
          prompt += `\n\nSelected Component:\n\nComponent: ${state.selectedComponent.name}\nFile: ${state.selectedComponent.relativePath}\n(source already provided earlier in this session)\n`;
        } else {
          prompt += `\n\nSelected Component:\n\nComponent: ${state.selectedComponent.name}\nFile: ${state.selectedComponent.relativePath}\n\`\`\`tsx\n${state.selectedComponent.sourceText}\n\`\`\`\n`;
          referencedNames.push(state.selectedComponent.name);
        }
      }

      // Track newly sent component names so future turns skip re-embedding source
      for (const name of referencedNames) {
        sentComponentsRef.current.add(name);
      }

      if (state.selectedElement) {
        const el = state.selectedElement;
        let elementDesc = `<${el.tag || "unknown"}`;
        if (el.id) elementDesc += ` id="${el.id}"`;
        if (el.className) elementDesc += ` class="${el.className}"`;
        if (el.attributes) {
          for (const [attr, val] of Object.entries(el.attributes)) {
            elementDesc += ` ${attr}="${val}"`;
          }
        }
        elementDesc += ">";
        prompt += `\nThe user is referring to this specific element: ${elementDesc}`;
        if (el.textContent) {
          prompt += `\nElement text content: "${el.textContent}"`;
        }
        if (el.siblingIndex !== undefined && el.siblingIndex !== null) {
          prompt += `\nThis is element #${el.siblingIndex + 1} (1-based) among its same-tag siblings in the parent`;
        }
        if (el.boundingRect) {
          prompt += `\nElement position on screen: top=${el.boundingRect.top}px, left=${el.boundingRect.left}px, size=${el.boundingRect.width}x${el.boundingRect.height}px`;
        }
        prompt += "\n";
      }

      return prompt;
    },
    [componentMap, state.selectedComponent, state.selectedElement]
  );

  // Core execution logic — runs a fully resolved prompt
  const executeTask = useCallback(
    async (prompt: string, displayText?: string) => {
      if (!state.repoPath) return;

      // If resuming from a user question, reuse the existing task ID
      const isResume = currentTaskIdRef.current !== null;
      const taskId = currentTaskIdRef.current ?? crypto.randomUUID();
      currentTaskIdRef.current = taskId;
      userQuestionRef.current = null;
      toolApprovalRef.current = null;
      // Reset the activity only for fresh tasks, not resumes
      if (!isResume) taskActivityRef.current = [];

      const taskText =
        prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;

      // Only add a new history entry if this isn't a resume
      if (!state.taskHistory.some((t) => t.id === taskId)) {
        dispatch({
          type: "ADD_TASK_HISTORY",
          entry: {
            id: taskId,
            taskText,
            promptText: displayText ?? prompt,
            timestamp: Date.now(),
            status: "running",
            result: null,
            diffs: [],
          },
        });
      }

      dispatch({ type: "SET_PHASE", phase: "executing" });
      // A resume (answer, approval) continues the same turn in the chat.
      if (!isResume) dispatch({ type: "CLEAR_STREAM" });

      try {
        snapshotRef.current = await createSnapshot(state.repoPath);
        let result = await executeClaudeCodeInteractive(prompt, state.repoPath, state.model, sessionIdRef.current, "Read,Edit,Write,Bash,AskUserQuestion", autoCompactRef.current);

        // If a user question or tool approval was detected, the process was killed.
        // Keep the task "running" and return early — the modal handles resumption.
        if (userQuestionRef.current || toolApprovalRef.current) {
          if (result.sessionId) {
            sessionIdRef.current = result.sessionId;
          }
          return;
        }

        if (result.sessionId) {
          sessionIdRef.current = result.sessionId;
        }
        dispatch({ type: "SET_EXECUTION_RESULT", result });

        let diffs = await computeDiffs(state.repoPath, snapshotRef.current);

        // Auto-continue: if Claude planned but made no changes, retry once.
        // Only do this on the initial task run, not on resumes from question/approval,
        // to avoid wasting tokens when Claude is mid-conversation.
        if (
          !isResume &&
          result.exitCode === 0 &&
          diffs.length === 0 &&
          sessionIdRef.current
        ) {
          addActivityNote("No changes detected, continuing with the implementation…");

          snapshotRef.current = await createSnapshot(state.repoPath);
          const retryResult = await executeClaudeCodeInteractive(
            "Do not plan or ask questions. Implement the changes now.",
            state.repoPath,
            state.model,
            sessionIdRef.current,
            "Read,Edit,Write,Bash,AskUserQuestion",
            autoCompactRef.current
          );

          // Check again for user question or tool approval after retry
          if (userQuestionRef.current || toolApprovalRef.current) {
            if (retryResult.sessionId) {
              sessionIdRef.current = retryResult.sessionId;
            }
            return;
          }

          if (retryResult.sessionId) {
            sessionIdRef.current = retryResult.sessionId;
          }
          result = retryResult;
          dispatch({ type: "SET_EXECUTION_RESULT", result: retryResult });
          diffs = await computeDiffs(state.repoPath, snapshotRef.current);
        }

        dispatch({ type: "SET_DIFFS", diffs });
        dispatch({ type: "SET_PHASE", phase: "ready" });
        dispatch({ type: "CLEAR_STREAM" });
        currentTaskIdRef.current = null;

        if (autoAcceptRef.current && diffs.length > 0) {
          dispatch({ type: "ACCEPT_ALL" });
          window.dispatchEvent(new Event("reload-webview"));
        }

        dispatch({
          type: "UPDATE_TASK_HISTORY",
          id: taskId,
          updates: { status: "success", result, diffs, activity: compactActivity(taskActivityRef.current) },
        });
      } catch (err) {
        // Don't treat killed-for-question/approval as a real error
        if (userQuestionRef.current || toolApprovalRef.current) return;

        dispatch({
          type: "SET_ERROR",
          error: `Execution failed: ${err}`,
        });
        dispatch({ type: "SET_PHASE", phase: "ready" });
        dispatch({ type: "CLEAR_STREAM" });
        currentTaskIdRef.current = null;
        dispatch({
          type: "UPDATE_TASK_HISTORY",
          id: taskId,
          updates: { status: "failed" },
        });
      }
    },
    [state.repoPath, state.taskHistory, state.model]
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

      if (state.phase !== "ready" && state.phase !== "reviewing" && state.phase !== "idle") return;

      await executeTask(prompt, docToText(doc));
    },
    [state.repoPath, state.phase, buildPrompt, executeTask]
  );

  // Handle user answering the AskUserQuestion modal
  const handleAnswerQuestion = useCallback(
    (answer: string) => {
      const question = state.userQuestion?.question ?? "your question";
      dispatch({ type: "CLEAR_USER_QUESTION" });
      userQuestionRef.current = null;
      // Wrap the answer so Claude treats it as a response, not a new instruction
      const wrappedAnswer = `You asked: "${question}"\nMy answer: ${answer}\nPlease proceed based on this answer.`;
      addActivityNote(`You answered: ${answer}`);
      executeTask(wrappedAnswer);
    },
    [executeTask, state.userQuestion]
  );

  // Handle dismissing the question modal (cancel the task)
  const handleDismissQuestion = useCallback(() => {
    dispatch({ type: "CLEAR_USER_QUESTION" });
    dispatch({ type: "SET_PHASE", phase: "ready" });
    dispatch({ type: "CLEAR_STREAM" });
    userQuestionRef.current = null;
    if (currentTaskIdRef.current) {
      dispatch({
        type: "UPDATE_TASK_HISTORY",
        id: currentTaskIdRef.current,
        updates: { status: "failed", activity: compactActivity(taskActivityRef.current) },
      });
      currentTaskIdRef.current = null;
    }
    killClaudeProcess().catch(() => {});
  }, []);

  // Handle tool approval (approve/deny)
  const handleApproveToolUse = useCallback(
    (approved: boolean) => {
      const tool = state.toolApproval;
      dispatch({ type: "CLEAR_TOOL_APPROVAL" });
      toolApprovalRef.current = null;
      const message = approved
        ? `I approved running the command: ${tool?.command ?? "the command"}. Please proceed and execute it.`
        : `I denied the command: ${tool?.command ?? "the command"}. Please find an alternative approach that does not use this command.`;
      addActivityNote(`${approved ? "Approved" : "Denied"}: ${tool?.command ?? "the command"}`);
      executeTask(message);
    },
    [executeTask, state.toolApproval]
  );

  // Handle dismissing the tool approval modal (cancel the task)
  const handleDismissToolApproval = useCallback(() => {
    dispatch({ type: "CLEAR_TOOL_APPROVAL" });
    dispatch({ type: "SET_PHASE", phase: "ready" });
    dispatch({ type: "CLEAR_STREAM" });
    toolApprovalRef.current = null;
    if (currentTaskIdRef.current) {
      dispatch({
        type: "UPDATE_TASK_HISTORY",
        id: currentTaskIdRef.current,
        updates: { status: "failed", activity: compactActivity(taskActivityRef.current) },
      });
      currentTaskIdRef.current = null;
    }
    killClaudeProcess().catch(() => {});
  }, []);

  // Refresh unpushed commit count
  const refreshUnpushedCount = useCallback(async () => {
    if (!state.repoPath) return;
    try {
      const count = await getUnpushedCount(state.repoPath);
      dispatch({ type: "SET_UNPUSHED_COUNT", count });
    } catch {
      // Not a git repo or no remote — ignore
    }
  }, [state.repoPath]);

  // Refresh count when phase transitions to ready (catches post-execution)
  useEffect(() => {
    if (state.phase === "ready") {
      refreshUnpushedCount();
    }
  }, [state.phase, refreshUnpushedCount]);

  /**
   * Runs Claude for something other than a user prompt (commit, compact) as a
   * turn in the chat, so its progress shows live and is kept afterwards.
   */
  const runSideTask = useCallback(
    async ({ label, prompt, tools, resume }: { label: string; prompt: string; tools: string; resume: boolean }) => {
      if (!state.repoPath) return;
      const taskId = crypto.randomUUID();
      currentTaskIdRef.current = taskId;
      taskActivityRef.current = [];
      dispatch({
        type: "ADD_TASK_HISTORY",
        entry: { id: taskId, taskText: label, promptText: label, timestamp: Date.now(), status: "running", result: null, diffs: [] },
      });
      dispatch({ type: "SET_PHASE", phase: "executing" });
      dispatch({ type: "CLEAR_STREAM" });

      try {
        const result = await executeClaudeCodeInteractive(
          prompt,
          state.repoPath,
          state.model,
          resume ? sessionIdRef.current : undefined,
          tools,
          autoCompactRef.current
        );
        if (resume && result.sessionId) sessionIdRef.current = result.sessionId;
        dispatch({ type: "SET_EXECUTION_RESULT", result });
        // Stop already marked it and moved on; don't overwrite that.
        if (currentTaskIdRef.current === taskId) {
          dispatch({
            type: "UPDATE_TASK_HISTORY",
            id: taskId,
            updates: {
              status: result.exitCode === 0 ? "success" : "failed",
              result,
              activity: compactActivity(taskActivityRef.current),
            },
          });
        }
      } catch (err) {
        dispatch({ type: "SET_ERROR", error: `${label} failed: ${err}` });
        dispatch({
          type: "UPDATE_TASK_HISTORY",
          id: taskId,
          updates: { status: "failed", activity: compactActivity(taskActivityRef.current) },
        });
      } finally {
        if (currentTaskIdRef.current === taskId) currentTaskIdRef.current = null;
        dispatch({ type: "SET_PHASE", phase: "ready" });
        dispatch({ type: "CLEAR_STREAM" });
      }
    },
    [state.repoPath, state.model]
  );

  // Summarises the chat's session so it keeps going with a smaller context.
  const handleCompact = useCallback(async () => {
    if (!sessionIdRef.current) {
      dispatch({ type: "SET_ERROR", error: "Nothing to compact yet. Send a message first." });
      return;
    }
    await runSideTask({ label: "Compact conversation", prompt: "/compact", tools: "Read", resume: true });
  }, [runSideTask]);

  // Handle commit via Claude
  const handleCommit = useCallback(async () => {
    if (!state.repoPath) return;
    try {
      const hasChanges = await gitHasChanges(state.repoPath);
      if (!hasChanges) {
        dispatch({ type: "SET_ERROR", error: "No uncommitted changes to commit." });
        return;
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: `Git check failed: ${err}` });
      return;
    }

    const commitPrompt = `You are a git commit assistant. Review the current uncommitted changes and create well-scoped git commits with clear commit messages.

Rules:
- Use \`git add\` and \`git commit\` via the Bash tool
- Create one commit per logical group of changes
- Write clear, concise commit messages describing what changed and why
- Do NOT amend, squash, or merge any existing commits
- Do NOT push to any remote
- Do NOT edit, create, or modify any source files
- Only use Read to understand changes and Bash for git commands`;

    commitFlowRef.current = true;
    try {
      // A fresh session: committing should not see, or add to, the chat's context.
      await runSideTask({ label: "Commit changes", prompt: commitPrompt, tools: "Read,Bash", resume: false });
    } finally {
      commitFlowRef.current = false;
    }
  }, [state.repoPath, runSideTask]);

  // Handle sync (push)
  const handleSync = useCallback(async () => {
    if (!state.repoPath || state.isSyncing) return;
    dispatch({ type: "SET_SYNCING", syncing: true });
    try {
      const result = await gitPush(state.repoPath);
      if (!result.success) {
        dispatch({ type: "SET_ERROR", error: `Push failed: ${result.message}` });
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: `Push failed: ${err}` });
    } finally {
      dispatch({ type: "SET_SYNCING", syncing: false });
      refreshUnpushedCount();
    }
  }, [state.repoPath, state.isSyncing, refreshUnpushedCount]);

  // Queue drain: when phase becomes ready and queue is non-empty, pop and execute
  useEffect(() => {
    if (state.phase === "ready" && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      executeTask(next.prompt, docToText(next.doc));
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

  // Plan usage moves with every request, so refresh it on a timer and after each task.
  const refreshPlanUsage = useCallback(() => {
    fetchPlanUsage()
      .then((usage) => {
        setPlanUsage(usage);
        setPlanError(null);
      })
      .catch((err) => setPlanError(String(err)));
  }, []);
  useEffect(() => {
    refreshPlanUsage();
    const timer = setInterval(refreshPlanUsage, 60_000);
    return () => clearInterval(timer);
  }, [refreshPlanUsage]);
  useEffect(() => {
    if (state.phase === "ready") refreshPlanUsage();
  }, [state.phase, refreshPlanUsage]);

  // The branch can change outside the app too (a terminal, Claude itself), so poll it.
  useEffect(() => {
    const repo = state.repoPath;
    if (!repo) {
      dispatch({ type: "SET_BRANCH", branch: null });
      return;
    }
    const check = () =>
      getCurrentBranch(repo)
        .then((branch) => dispatch({ type: "SET_BRANCH", branch }))
        .catch(() => dispatch({ type: "SET_BRANCH", branch: null }));
    check();
    const timer = setInterval(check, 15_000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [state.repoPath, state.phase]);

  // A failed scan leaves the phase idle, but Claude can still work on the folder.
  const canRun = !!state.repoPath && state.phase !== "scanning";

  const chatEntries = useMemo(
    () => state.taskHistory.filter((entry) => entry.timestamp >= chatStartedAt).reverse(),
    [state.taskHistory, chatStartedAt]
  );

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        <ScreenshotToasts toasts={screenshots} onDismiss={dismissScreenshot} />
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
              {state.repoPath && (
                <button
                  className="toolbar-commit-btn"
                  onClick={handleCommit}
                  disabled={state.phase === "executing" || state.isSyncing}
                  title="Commit changes with Claude"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="4" />
                    <line x1="1.05" y1="12" x2="7" y2="12" />
                    <line x1="17.01" y1="12" x2="22.96" y2="12" />
                  </svg>
                  Commit
                </button>
              )}
              {state.unpushedCount > 0 && (
                <button
                  className="toolbar-sync-btn toolbar-icon-btn"
                  onClick={handleSync}
                  disabled={state.isSyncing}
                  title={`Push ${state.unpushedCount} commit${state.unpushedCount !== 1 ? "s" : ""} to remote`}
                >
                  {state.isSyncing ? (
                    <span className="spinner-small" style={{ margin: 0 }} />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 0 1-9 9m0 0a9 9 0 0 1-9-9m9 9V3m0 0l3 3m-3-3l-3 3" />
                    </svg>
                  )}
                  <span className="sync-badge">{state.unpushedCount}</span>
                </button>
              )}
              {state.components.length > 0 && (
                <span className="toolbar-badge">
                  {state.components.length} components
                </span>
              )}
              <button
                className="toolbar-icon-btn"
                onClick={() => setChatCollapsed((c) => !c)}
                title={chatCollapsed ? "Show chat panel" : "Hide chat panel"}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {chatCollapsed ? (
                    <>
                      <path d="M15 18l-6-6 6-6" />
                    </>
                  ) : (
                    <>
                      <path d="M9 18l6-6-6-6" />
                    </>
                  )}
                </svg>
              </button>
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
            {!chatCollapsed && (
              <div className="resize-handle" onMouseDown={handleResizeStart} />
            )}

            {/* Right: editor + streaming + history */}
            <div className="panel-right" style={{ width: chatCollapsed ? 0 : rightPanelWidth, display: chatCollapsed ? "none" : undefined }}>

              <StatsStrip
                contextTokens={contextTokens}
                contextWindow={modelById(state.model).contextWindow}
                planUsage={planUsage}
                planError={planError}
                branch={state.branch}
                onBranchClick={() => dispatch({ type: "SET_SETTINGS_OPEN", open: true })}
              />

              <div className="chat-tabs">
                <button
                  className={`chat-tab${rightTab === "chat" ? " active" : ""}`}
                  onClick={() => setRightTab("chat")}
                >
                  Chat
                </button>
                <button
                  className={`chat-tab${rightTab === "history" ? " active" : ""}`}
                  onClick={() => setRightTab("history")}
                >
                  History
                </button>
                <div className="task-history-actions">
                    <button
                      className="btn-ghost"
                      onClick={() => {
                        sessionIdRef.current = undefined;
                        sentComponentsRef.current.clear();
                        setContextTokens(null);
                        setChatStartedAt(Date.now());
                        setRightTab("chat");
                        editorRef.current?.clear();
                        editorRef.current?.focus();
                      }}
                      title="Start a new chat (keeps history)"
                      disabled={state.phase === "executing"}
                    >
                      New Chat
                    </button>
                    <button
                      className="btn-ghost"
                      onClick={handleCompact}
                      title="Summarise this chat so it uses less context (Claude Code's /compact)"
                      disabled={state.phase === "executing" || chatEntries.length === 0}
                    >
                      Compact
                    </button>
                    {state.taskHistory.length > 0 && (
                      <button
                        className="btn-ghost"
                        onClick={() => {
                          sessionIdRef.current = undefined;
                          sentComponentsRef.current.clear();
                          setContextTokens(null);
                          setChatStartedAt(Date.now());
                          dispatch({ type: "CLEAR_TASK_HISTORY" });
                        }}
                        title="Clear conversation context and history"
                      >
                        Clear
                      </button>
                    )}
                  </div>
              </div>

              <div className="chat-body">
              {state.phase === "idle" && !state.repoPath && (
                <div className="panel-empty-state">
                  <p>Open settings to select a project folder and dev server.</p>
                  <button
                    className="btn-primary"
                    onClick={() => dispatch({ type: "SET_SETTINGS_OPEN", open: true })}
                  >
                    Open Settings
                  </button>
                </div>
              )}

                {rightTab === "chat" ? (
                  <ChatThread
                    entries={chatEntries}
                    liveTaskId={
                      state.phase === "executing" || state.phase === "asking_user" || state.phase === "approving_tool"
                        ? currentTaskIdRef.current
                        : null
                    }
                    liveActivity={state.activity}
                  />
                ) : (
                  <TaskHistory />
                )}
              </div>

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
                        onClick={() => setQueueModalItem(item)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          // Remove from queue and put back in editor for editing
                          setQueue((prev) => prev.filter((q) => q.id !== item.id));
                          setQueueModalItem(null);
                          editorRef.current?.setContent(item.doc);
                          editorRef.current?.focus();
                        }}
                        title="Click to expand · Double-click to edit"
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

              {/* Always shown: hiding it while scanning (or after a failed scan) left
                  the panel with no way to type. Run explains when it can't go. */}
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
                    <div className="editor-toggles">
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
                      <label className="auto-accept-toggle" title="Automatically approve tool commands without confirmation">
                        <input
                          type="checkbox"
                          checked={autoApproveTools}
                          onChange={(e) => {
                            setAutoApproveTools(e.target.checked);
                            autoApproveToolsRef.current = e.target.checked;
                          }}
                        />
                        <span>Auto-approve tools</span>
                      </label>
                      <label
                        className="auto-accept-toggle"
                        title="Let Claude Code summarise the conversation on its own when the context gets full. Compact still works either way."
                      >
                        <input
                          type="checkbox"
                          checked={autoCompact}
                          onChange={(e) => {
                            setAutoCompact(e.target.checked);
                            autoCompactRef.current = e.target.checked;
                          }}
                        />
                        <span>Auto-compact enabled</span>
                      </label>
                    </div>
                    <div className="editor-actions-right">
                      <button
                        className="toolbar-icon-btn"
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
                      {state.phase === "executing" && (
                        <button
                          className="btn-stop"
                          onClick={() => {
                            killClaudeProcess().catch(() => {});
                            setQueue([]);
                            if (currentTaskIdRef.current) {
                              dispatch({
                                type: "UPDATE_TASK_HISTORY",
                                id: currentTaskIdRef.current,
                                updates: { status: "failed", activity: compactActivity(taskActivityRef.current) },
                              });
                              currentTaskIdRef.current = null;
                            }
                            dispatch({ type: "SET_PHASE", phase: "ready" });
                            dispatch({ type: "CLEAR_STREAM" });
                          }}
                          title="Stop current Claude process"
                        >
                          Stop
                        </button>
                      )}
                      <button
                        className="btn-primary"
                        onClick={() => {
                          const json = editorRef.current?.getJSON();
                          if (json) handleSubmit(json);
                        }}
                        disabled={state.claudeAvailable === false || !canRun}
                        title={
                          !state.repoPath
                            ? "Pick a project folder in settings first"
                            : state.phase === "scanning"
                              ? "Still scanning the project"
                              : undefined
                        }
                      >
                        {!state.repoPath ? (
                          "Pick a folder first"
                        ) : state.phase === "scanning" ? (
                          <>
                            <span className="spinner-small" />
                            Scanning…
                          </>
                        ) : state.phase === "executing" ? (
                          <>
                            <span className="spinner-small" />
                            Queue
                          </>
                        ) : (
                          "Send"
                        )}
                      </button>
                    </div>
                  </div>
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

          {/* Ask User Question modal */}
          {state.userQuestion && (
            <AskUserModal
              question={state.userQuestion}
              onAnswer={handleAnswerQuestion}
              onDismiss={handleDismissQuestion}
            />
          )}

          {/* Tool Approval modal */}
          {state.toolApproval && (
            <ToolApprovalModal
              approval={state.toolApproval}
              onApprove={() => handleApproveToolUse(true)}
              onDeny={() => handleApproveToolUse(false)}
              onCancel={handleDismissToolApproval}
            />
          )}

          {/* Queue item expand modal */}
          {queueModalItem && (
            <div className="modal-backdrop" onClick={() => setQueueModalItem(null)}>
              <div className="modal-box task-chat-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">Queued Task</span>
                  <button className="modal-close" onClick={() => setQueueModalItem(null)}>✕</button>
                </div>
                <div className="task-chat-body">
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{queueModalItem.prompt}</pre>
                </div>
                <div className="modal-footer" style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setQueue((prev) => prev.filter((q) => q.id !== queueModalItem.id));
                      editorRef.current?.setContent(queueModalItem.doc);
                      editorRef.current?.focus();
                      setQueueModalItem(null);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="btn-secondary btn-sm"
                    style={{ marginLeft: "auto" }}
                    onClick={() => {
                      setQueue((prev) => prev.filter((q) => q.id !== queueModalItem.id));
                      setQueueModalItem(null);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export default function App() {
  return <AppInner />;
}

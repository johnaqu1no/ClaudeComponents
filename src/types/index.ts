export interface ComponentInfo {
  name: string;
  filePath: string;
  relativePath: string;
  exportType: "named" | "default";
  startLine: number;
  endLine: number;
  sourceText: string;
}

export interface FileDiff {
  filePath: string;
  relativePath: string;
  status: "modified" | "created" | "deleted";
  oldContent: string;
  newContent: string;
  patch: string;
  accepted: boolean | null; // null = pending
}

export type AppPhase =
  | "idle"
  | "scanning"
  | "ready"
  | "executing"
  | "reviewing"
  | "asking_user"
  | "approving_tool";

export interface ClaudeExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FileSnapshot {
  path: string;
  content: string;
}

export interface FileEntry {
  path: string;
  relative_path: string;
}

export interface UserQuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  options: UserQuestionOption[];
}

export interface ToolApproval {
  toolName: string;
  command: string;
  description?: string;
}

export interface ElementContext {
  tag: string | null;
  className: string | null;
  id: string | null;
  textContent: string | null;
  selector: string;
  attributes?: Record<string, string>;
  boundingRect?: { top: number; left: number; width: number; height: number } | null;
  siblingIndex?: number | null;
}

export interface DetectedComponent {
  componentName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  element?: ElementContext | null;
  /** Set by the inspector when the click landed on nothing it could map. */
  error?: string;
}

export interface QueuedMessage {
  id: string;
  doc: import("@tiptap/react").JSONContent;
  prompt: string;
  promptText: string;
  timestamp: number;
}

export interface TaskHistoryEntry {
  id: string;
  taskText: string;
  /** What the user typed, shown in the chat. Missing on older entries. */
  promptText?: string;
  timestamp: number;
  status: "running" | "success" | "failed";
  result: ClaudeExecutionResult | null;
  diffs: FileDiff[];
  durationMs?: number;
  diffCount?: number;
  /** Plain lines saved before the activity timeline existed. */
  chatLines?: string[];
  activity?: import("../lib/activity").ActivityItem[];
}

/** A folder opened before, and the dev server it was previewed on. */
export interface RecentProject {
  repoPath: string;
  devServerUrl: string | null;
  lastUsedAt: number;
}

export interface AppState {
  phase: AppPhase;
  repoPath: string | null;
  components: ComponentInfo[];
  diffs: FileDiff[];
  executionResult: ClaudeExecutionResult | null;
  error: string | null;
  claudeAvailable: boolean | null;
  inspectorActive: boolean;
  proxyPort: number | null;
  devServerUrl: string | null;
  /** Claude model id passed to the CLI. */
  model: string;
  /** Most recently used first. */
  recentProjects: RecentProject[];
  /** Checked-out git branch of the open folder, when it is a repository. */
  branch: string | null;
  selectedComponent: ComponentInfo | null;
  selectedElement: ElementContext | null;
  taskHistory: TaskHistoryEntry[];
  /** What Claude is doing in the current run. */
  activity: import("../lib/activity").ActivityItem[];
  settingsOpen: boolean;
  userQuestion: UserQuestion | null;
  toolApproval: ToolApproval | null;
  unpushedCount: number;
  isSyncing: boolean;
}

export type AppAction =
  | { type: "SET_PHASE"; phase: AppPhase }
  | { type: "SET_REPO"; path: string }
  | { type: "SET_COMPONENTS"; components: ComponentInfo[] }
  | { type: "SET_DIFFS"; diffs: FileDiff[] }
  | { type: "SET_EXECUTION_RESULT"; result: ClaudeExecutionResult }
  | { type: "UPDATE_DIFF"; filePath: string; accepted: boolean }
  | { type: "ACCEPT_ALL" }
  | { type: "REJECT_ALL" }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SET_CLAUDE_AVAILABLE"; available: boolean }
  | { type: "SET_INSPECTOR_ACTIVE"; active: boolean }
  | { type: "SET_PROXY_PORT"; port: number | null }
  | { type: "SET_DEV_SERVER_URL"; url: string | null }
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_BRANCH"; branch: string | null }
  | { type: "OPEN_PROJECT"; repoPath: string; devServerUrl: string | null }
  | { type: "SELECT_COMPONENT"; component: ComponentInfo | null; element?: ElementContext | null }
  | { type: "CLEAR_SELECTED_COMPONENT" }
  | { type: "ADD_TASK_HISTORY"; entry: TaskHistoryEntry }
  | { type: "UPDATE_TASK_HISTORY"; id: string; updates: Partial<TaskHistoryEntry> }
  | { type: "CLEAR_TASK_HISTORY" }
  | { type: "LOAD_HISTORY"; entries: TaskHistoryEntry[] }
  | { type: "APPLY_STREAM_EVENT"; line: string }
  | { type: "ADD_ACTIVITY_NOTE"; text: string }
  | { type: "CLEAR_STREAM" }
  | { type: "SET_SETTINGS_OPEN"; open: boolean }
  | {
      type: "LOAD_SETTINGS";
      repoPath: string | null;
      devServerUrl: string | null;
      model: string | null;
      recentProjects: RecentProject[];
    }
  | { type: "SET_USER_QUESTION"; question: UserQuestion }
  | { type: "CLEAR_USER_QUESTION" }
  | { type: "SET_TOOL_APPROVAL"; approval: ToolApproval }
  | { type: "CLEAR_TOOL_APPROVAL" }
  | { type: "SET_UNPUSHED_COUNT"; count: number }
  | { type: "SET_SYNCING"; syncing: boolean }
  | { type: "RESET" };

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
  | "asking_user";

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

export interface ElementContext {
  tag: string | null;
  className: string | null;
  id: string | null;
  textContent: string | null;
  selector: string;
}

export interface DetectedComponent {
  componentName: string;
  fileName: string | null;
  lineNumber: number | null;
  element?: ElementContext | null;
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
  timestamp: number;
  status: "running" | "success" | "failed";
  result: ClaudeExecutionResult | null;
  diffs: FileDiff[];
  durationMs?: number;
  diffCount?: number;
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
  selectedComponent: ComponentInfo | null;
  selectedElement: ElementContext | null;
  taskHistory: TaskHistoryEntry[];
  streamingLines: string[];
  settingsOpen: boolean;
  userQuestion: UserQuestion | null;
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
  | { type: "SELECT_COMPONENT"; component: ComponentInfo | null; element?: ElementContext | null }
  | { type: "CLEAR_SELECTED_COMPONENT" }
  | { type: "ADD_TASK_HISTORY"; entry: TaskHistoryEntry }
  | { type: "UPDATE_TASK_HISTORY"; id: string; updates: Partial<TaskHistoryEntry> }
  | { type: "CLEAR_TASK_HISTORY" }
  | { type: "LOAD_HISTORY"; entries: TaskHistoryEntry[] }
  | { type: "APPEND_STREAM_LINE"; line: string }
  | { type: "CLEAR_STREAM" }
  | { type: "SET_SETTINGS_OPEN"; open: boolean }
  | { type: "LOAD_SETTINGS"; repoPath: string | null; devServerUrl: string | null }
  | { type: "SET_USER_QUESTION"; question: UserQuestion }
  | { type: "CLEAR_USER_QUESTION" }
  | { type: "RESET" };

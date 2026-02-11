import { createContext, useContext, type Dispatch } from "react";
import type { AppState, AppAction } from "../types";

export const initialState: AppState = {
  phase: "idle",
  repoPath: null,
  components: [],
  diffs: [],
  executionResult: null,
  error: null,
  claudeAvailable: null,
  inspectorActive: false,
  proxyPort: null,
  devServerUrl: null,
  selectedComponent: null,
  selectedElement: null,
  taskHistory: [],
  streamingLines: [],
  settingsOpen: false,
  userQuestion: null,
  toolApproval: null,
  unpushedCount: 0,
  isSyncing: false,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_PHASE":
      return { ...state, phase: action.phase, error: null };
    case "SET_REPO":
      return { ...state, repoPath: action.path, phase: "scanning" };
    case "SET_COMPONENTS":
      return { ...state, components: action.components, phase: "ready" };
    case "SET_DIFFS":
      return { ...state, diffs: action.diffs };
    case "SET_EXECUTION_RESULT":
      return { ...state, executionResult: action.result };
    case "UPDATE_DIFF":
      return {
        ...state,
        diffs: state.diffs.map((d) =>
          d.filePath === action.filePath ? { ...d, accepted: action.accepted } : d
        ),
      };
    case "ACCEPT_ALL":
      return { ...state, diffs: [] };
    case "REJECT_ALL":
      return { ...state, diffs: [] };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_CLAUDE_AVAILABLE":
      return { ...state, claudeAvailable: action.available };
    case "SET_INSPECTOR_ACTIVE":
      return { ...state, inspectorActive: action.active };
    case "SET_PROXY_PORT":
      return { ...state, proxyPort: action.port };
    case "SET_DEV_SERVER_URL":
      return { ...state, devServerUrl: action.url };
    case "SELECT_COMPONENT":
      return { ...state, selectedComponent: action.component, selectedElement: action.element ?? null };
    case "CLEAR_SELECTED_COMPONENT":
      return { ...state, selectedComponent: null, selectedElement: null };
    case "ADD_TASK_HISTORY":
      return { ...state, taskHistory: [action.entry, ...state.taskHistory] };
    case "UPDATE_TASK_HISTORY":
      return {
        ...state,
        taskHistory: state.taskHistory.map((e) =>
          e.id === action.id ? { ...e, ...action.updates } : e
        ),
      };
    case "CLEAR_TASK_HISTORY":
      return { ...state, taskHistory: [] };
    case "LOAD_HISTORY":
      return { ...state, taskHistory: action.entries };
    case "APPEND_STREAM_LINE":
      return { ...state, streamingLines: [...state.streamingLines, action.line] };
    case "CLEAR_STREAM":
      return { ...state, streamingLines: [] };
    case "SET_SETTINGS_OPEN":
      return { ...state, settingsOpen: action.open };
    case "LOAD_SETTINGS": {
      const next: AppState = {
        ...state,
        devServerUrl: action.devServerUrl,
      };
      if (action.repoPath) {
        next.repoPath = action.repoPath;
        next.phase = "scanning";
      }
      return next;
    }
    case "SET_USER_QUESTION":
      return { ...state, userQuestion: action.question, phase: "asking_user" };
    case "CLEAR_USER_QUESTION":
      return { ...state, userQuestion: null };
    case "SET_TOOL_APPROVAL":
      return { ...state, toolApproval: action.approval, phase: "approving_tool" };
    case "CLEAR_TOOL_APPROVAL":
      return { ...state, toolApproval: null };
    case "SET_UNPUSHED_COUNT":
      return { ...state, unpushedCount: action.count };
    case "SET_SYNCING":
      return { ...state, isSyncing: action.syncing };
    case "RESET":
      return {
        ...initialState,
        claudeAvailable: state.claudeAvailable,
        devServerUrl: state.devServerUrl,
        proxyPort: state.proxyPort,
      };
    default:
      return state;
  }
}

export const AppStateContext = createContext<AppState>(initialState);
export const AppDispatchContext = createContext<Dispatch<AppAction>>(() => {});

export function useAppState() {
  return useContext(AppStateContext);
}

export function useAppDispatch() {
  return useContext(AppDispatchContext);
}

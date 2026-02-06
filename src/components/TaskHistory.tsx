import { useAppState } from "../stores/app-store";
import type { TaskHistoryEntry } from "../types";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusIcon({ status }: { status: TaskHistoryEntry["status"] }) {
  switch (status) {
    case "running":
      return <span className="spinner-small task-spinner" />;
    case "success":
      return <span className="task-status-icon success">&#10003;</span>;
    case "failed":
      return <span className="task-status-icon failed">&#10007;</span>;
  }
}

export function TaskHistory() {
  const { taskHistory } = useAppState();

  if (taskHistory.length === 0) {
    return (
      <div className="task-history-empty">
        <p>No tasks yet</p>
      </div>
    );
  }

  return (
    <div className="task-history">
      {taskHistory.map((entry) => (
        <div key={entry.id} className={`task-history-item ${entry.status}`}>
          <StatusIcon status={entry.status} />
          <div className="task-history-content">
            <span className="task-history-text">{entry.taskText}</span>
            <span className="task-history-meta">
              {formatTime(entry.timestamp)}
              {entry.result?.durationMs &&
                ` \u00b7 ${(entry.result.durationMs / 1000).toFixed(1)}s`}
              {entry.diffs.length > 0 &&
                ` \u00b7 ${entry.diffs.length} file${entry.diffs.length !== 1 ? "s" : ""}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

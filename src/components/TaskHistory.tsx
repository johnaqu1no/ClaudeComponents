import { useEffect, useState } from "react";
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Auto-expand the latest entry when it finishes
  useEffect(() => {
    if (taskHistory.length === 0) return;
    const latest = taskHistory[0];
    if (latest.result) {
      setExpandedId(latest.id);
    }
  }, [taskHistory]);

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
        <div
          key={entry.id}
          className={`task-history-item ${entry.status}${expandedId === entry.id ? " expanded" : ""}`}
          onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
        >
          <StatusIcon status={entry.status} />
          <div className="task-history-content">
            <span className="task-history-text">{entry.taskText}</span>
            <span className="task-history-meta">
              {formatTime(entry.timestamp)}
              {entry.result?.durationMs &&
                ` \u00b7 ${(entry.result.durationMs / 1000).toFixed(1)}s`}
              {(entry.diffs.length || entry.diffCount || 0) > 0 &&
                ` \u00b7 ${entry.diffs.length || entry.diffCount} file${(entry.diffs.length || entry.diffCount || 0) !== 1 ? "s" : ""}`}
            </span>
            {expandedId === entry.id && entry.result && (
              <div className="task-history-output">
                <pre>{entry.result.stdout || entry.result.stderr || "No output"}</pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

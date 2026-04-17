import { useEffect, useRef, useState } from "react";
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

function ChatModal({ entry, onClose }: { entry: TaskHistoryEntry; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, []);

  const lines = entry.chatLines?.length
    ? entry.chatLines
    : entry.result?.stdout
    ? [entry.result.stdout]
    : [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box task-chat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{entry.taskText}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="task-chat-body" ref={scrollRef}>
          {lines.length === 0 ? (
            <div className="task-chat-empty">No output recorded.</div>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="task-chat-line">{line}</div>
            ))
          )}
        </div>
        <div className="modal-footer">
          <span className="task-chat-meta">
            {formatTime(entry.timestamp)}
            {entry.result?.durationMs && ` · ${(entry.result.durationMs / 1000).toFixed(1)}s`}
            {(entry.diffs.length || entry.diffCount || 0) > 0 &&
              ` · ${entry.diffs.length || entry.diffCount} file(s) changed`}
            {entry.result?.inputTokens != null &&
              ` · ${entry.result.inputTokens.toLocaleString()} in / ${(entry.result.outputTokens ?? 0).toLocaleString()} out tokens`}
          </span>
        </div>
      </div>
    </div>
  );
}

export function TaskHistory() {
  const { taskHistory } = useAppState();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [chatEntry, setChatEntry] = useState<TaskHistoryEntry | null>(null);

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
    <>
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
              {expandedId === entry.id && (
                <div className="task-history-output">
                  {entry.status === "running" ? (
                    <div className="task-history-running">Running…</div>
                  ) : (
                    <button
                      className="task-chat-open-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setChatEntry(entry);
                      }}
                      title="View full chat history"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      View chat history
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {chatEntry && (
        <ChatModal entry={chatEntry} onClose={() => setChatEntry(null)} />
      )}
    </>
  );
}

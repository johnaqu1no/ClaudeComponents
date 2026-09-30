import { useLayoutEffect, useRef } from "react";
import { ActivityFeed } from "./ActivityFeed";
import type { ActivityItem } from "../lib/activity";
import type { TaskHistoryEntry } from "../types";

interface ChatThreadProps {
  /** The current chat's tasks, oldest first. */
  entries: TaskHistoryEntry[];
  /** The task Claude is working on, whose activity is still streaming in. */
  liveTaskId: string | null;
  liveActivity: ActivityItem[];
}

/** Within this many pixels of the bottom counts as "following" the chat. */
const STICK_THRESHOLD = 80;

function EntryMeta({ entry }: { entry: TaskHistoryEntry }) {
  const files = entry.diffs.length || entry.diffCount || 0;
  const parts = [
    entry.result?.durationMs ? `${(entry.result.durationMs / 1000).toFixed(1)}s` : null,
    files > 0 ? `${files} file${files === 1 ? "" : "s"} changed` : null,
  ].filter(Boolean);
  if (entry.status !== "failed" && parts.length === 0) return null;
  return (
    <div className={`chat-meta${entry.status === "failed" ? " failed" : ""}`}>
      {entry.status === "failed" ? ["Stopped", ...parts].join(" · ") : parts.join(" · ")}
    </div>
  );
}

export function ChatThread({ entries, liveTaskId, liveActivity }: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  // Follow new output only while the reader is already at the bottom, so
  // scrolling up to read something is never yanked away.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, liveActivity]);

  if (entries.length === 0) {
    return (
      <div className="chat-thread chat-thread-empty">
        <p>Describe a change below, or pick a component in the preview with the eye.</p>
      </div>
    );
  }

  return (
    <div
      className="chat-thread"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        followingRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
      }}
    >
      {entries.map((entry) => {
        const live = entry.id === liveTaskId && entry.status === "running";
        const items = live ? liveActivity : entry.activity ?? [];
        return (
          <div key={entry.id} className="chat-turn">
            <div className="chat-user">{entry.promptText ?? entry.taskText}</div>
            {items.length > 0 ? (
              <ActivityFeed items={items} finished={!live} />
            ) : live ? (
              <div className="chat-waiting">
                <span className="spinner-small" />
                Claude is starting…
              </div>
            ) : entry.chatLines?.length ? (
              <div className="chat-legacy">{entry.chatLines.join("\n")}</div>
            ) : null}
            <EntryMeta entry={entry} />
          </div>
        );
      })}
    </div>
  );
}

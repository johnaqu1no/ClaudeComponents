import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import type { ComponentInfo } from "../types";

interface MentionListProps {
  items: ComponentInfo[];
  command: (attrs: { id: string; label: string }) => void;
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((prev) =>
            prev <= 0 ? items.length - 1 : prev - 1
          );
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) =>
            prev >= items.length - 1 ? 0 : prev + 1
          );
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selectedIndex];
          if (item) {
            command({ id: item.name, label: item.name });
          }
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return <div className="mention-list-empty">No components found</div>;
    }

    return (
      <div className="mention-list">
        {items.map((item, index) => (
          <button
            key={item.name + item.filePath}
            className={`mention-list-item ${index === selectedIndex ? "selected" : ""}`}
            onClick={() => command({ id: item.name, label: item.name })}
          >
            <span className="mention-name">{item.name}</span>
            <span className="mention-path">{item.relativePath}</span>
          </button>
        ))}
      </div>
    );
  }
);

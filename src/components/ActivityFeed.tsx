import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  groupSummary,
  toolLabel,
  toolStatus,
  type ActivityItem,
  type ToolStatus,
} from "../lib/activity";

type ToolItem = Extract<ActivityItem, { kind: "tool" }>;

/** Runs this long collapse into one summary line. */
const GROUP_THRESHOLD = 3;
const MAX_BODY_LINES = 60;

function clipLines(text: string): string {
  const lines = text.split("\n");
  return lines.length > MAX_BODY_LINES
    ? lines.slice(0, MAX_BODY_LINES).join("\n") + `\n… ${lines.length - MAX_BODY_LINES} more lines`
    : text;
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running") return <span className="spinner-small activity-status" />;
  return (
    <span className={`activity-status ${status}`}>{status === "failed" ? "✗" : "✓"}</span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return <span className={`activity-chevron${open ? " open" : ""}`}>{"›"}</span>;
}

function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <pre className="activity-pre activity-diff">
      {clipLines(oldText)
        .split("\n")
        .map((line, i) => (
          <div key={`o${i}`} className="diff-del">- {line}</div>
        ))}
      {clipLines(newText)
        .split("\n")
        .map((line, i) => (
          <div key={`n${i}`} className="diff-add">+ {line}</div>
        ))}
    </pre>
  );
}

function ToolBody({ tool }: { tool: ToolItem }) {
  const input = tool.input;
  const output = tool.result?.text ?? "";
  const outputBlock = output ? (
    <pre className={`activity-pre${tool.result?.isError ? " error" : ""}`}>{clipLines(output)}</pre>
  ) : null;

  switch (tool.name) {
    case "Bash":
      return (
        <>
          <pre className="activity-pre activity-command">$ {String(input.command ?? "")}</pre>
          {outputBlock}
        </>
      );
    case "Edit":
      return (
        <>
          <div className="activity-path">{String(input.file_path ?? "")}</div>
          <DiffBlock oldText={String(input.old_string ?? "")} newText={String(input.new_string ?? "")} />
          {tool.result?.isError && outputBlock}
        </>
      );
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
      return (
        <>
          <div className="activity-path">{String(input.file_path ?? "")}</div>
          {edits.map((edit, i) => (
            <DiffBlock key={i} oldText={String(edit.old_string ?? "")} newText={String(edit.new_string ?? "")} />
          ))}
          {tool.result?.isError && outputBlock}
        </>
      );
    }
    case "Write":
      return (
        <>
          <div className="activity-path">{String(input.file_path ?? "")}</div>
          <pre className="activity-pre">{clipLines(String(input.content ?? ""))}</pre>
          {tool.result?.isError && outputBlock}
        </>
      );
    case "Read":
      // The file itself is long and already on disk, so only the path is useful here.
      return (
        <>
          <div className="activity-path">{String(input.file_path ?? "")}</div>
          {tool.result?.isError && outputBlock}
        </>
      );
    default:
      return (
        <>
          <pre className="activity-pre">{JSON.stringify(input, null, 2)}</pre>
          {outputBlock}
        </>
      );
  }
}

function ToolRow({ tool, finished }: { tool: ToolItem; finished: boolean }) {
  const [open, setOpen] = useState(false);
  const status = toolStatus(tool, finished);
  const label = toolLabel(tool.name, tool.input);
  const verb = status === "running" ? label.running : status === "failed" ? label.failed : label.done;

  return (
    <div className={`activity-tool ${status}`}>
      <button className="activity-tool-header" onClick={() => setOpen(!open)}>
        <StatusIcon status={status} />
        <span className="activity-verb">{verb}</span>
        {label.detail &&
          (label.detailIsCode ? (
            <code className="activity-detail">{label.detail}</code>
          ) : (
            <span className="activity-detail">{label.detail}</span>
          ))}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="activity-tool-body">
          <ToolBody tool={tool} />
          {tool.result?.images?.map((src, i) => (
            <img key={i} className="activity-image" src={src} alt="Tool result" />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ tools, finished }: { tools: ToolItem[]; finished: boolean }) {
  const [open, setOpen] = useState(false);
  const statuses = tools.map((tool) => toolStatus(tool, finished));
  const running = statuses.includes("running");
  const failed = statuses.filter((status) => status === "failed").length;
  const current = running ? tools[statuses.lastIndexOf("running")] : null;
  const currentLabel = current ? toolLabel(current.name, current.input) : null;

  return (
    <div className="activity-group">
      <button className="activity-tool-header" onClick={() => setOpen(!open)}>
        <StatusIcon status={running ? "running" : failed === tools.length ? "failed" : "done"} />
        <span className="activity-verb">
          {currentLabel
            ? `${currentLabel.running}${currentLabel.detail ? ` ${currentLabel.detail}` : ""}`
            : groupSummary(tools)}
          {failed > 0 && !running && <span className="activity-failed-count"> ({failed} failed)</span>}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="activity-group-body">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} finished={finished} />
          ))}
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity-thinking">
      <button className="activity-tool-header" onClick={() => setOpen(!open)}>
        <span className="activity-verb">Thinking</span>
        <Chevron open={open} />
      </button>
      {open && <div className="activity-thinking-text">{text}</div>}
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="activity-text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // A plain link would navigate the app window itself, so hand it to the browser.
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:/.test(href)) openUrl(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

interface ActivityFeedProps {
  items: ActivityItem[];
  /** The run is over, so tools with no result are no longer "running". */
  finished: boolean;
}

export function ActivityFeed({ items, finished }: ActivityFeedProps) {
  const rendered: ReactNode[] = [];
  let run: ToolItem[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length >= GROUP_THRESHOLD) {
      rendered.push(<ToolGroup key={`group:${run[0].id}`} tools={run} finished={finished} />);
    } else {
      for (const tool of run) rendered.push(<ToolRow key={tool.id} tool={tool} finished={finished} />);
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === "tool") {
      run.push(item);
      continue;
    }
    flushRun();
    if (item.kind === "text") rendered.push(<MarkdownText key={item.id} text={item.text} />);
    else if (item.kind === "thinking") rendered.push(<Thinking key={item.id} text={item.text} />);
    else rendered.push(<div key={item.id} className="activity-note">{item.text}</div>);
  }
  flushRun();

  return <div className="activity-feed">{rendered}</div>;
}

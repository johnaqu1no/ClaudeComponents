/**
 * Turns Claude Code's stream-json events into a timeline: what Claude said,
 * and each tool it used paired with that tool's result.
 */

export interface ToolResult {
  text: string;
  isError: boolean;
  /** Images the tool returned (a screenshot Claude took or read), as data URLs. */
  images?: string[];
}

export type ActivityItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result?: ToolResult }
  | { kind: "note"; id: string; text: string };

interface ContentBlock {
  type?: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function resultImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const source = part?.type === "image" ? part.source : null;
    if (source?.type === "base64" && typeof source.data === "string") {
      return [`data:${source.media_type ?? "image/png"};base64,${source.data}`];
    }
    return [];
  });
}

/** Every image in a stream line's tool results, with the tool call it came from. */
export function imagesInStreamLine(line: string): Array<{ toolUseId: string; src: string }> {
  try {
    const data = JSON.parse(line);
    if (data.type !== "user" || !Array.isArray(data.message?.content)) return [];
    return (data.message.content as ContentBlock[])
      .filter((block) => block.type === "tool_result")
      .flatMap((block) => resultImages(block.content).map((src) => ({ toolUseId: block.tool_use_id ?? "", src })));
  } catch {
    return [];
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Applies one raw stream line. Lines that are not events leave the list as is. */
export function applyStreamLine(items: ActivityItem[], line: string): ActivityItem[] {
  let data: {
    type?: string;
    parent_tool_use_id?: string | null;
    message?: { id?: string; content?: ContentBlock[] | string };
    is_error?: boolean;
    result?: string;
    uuid?: string;
  };
  try {
    data = JSON.parse(line);
  } catch {
    return items;
  }

  // A subagent's own steps would bury the main run. Its outcome still arrives
  // as the result of the Task/Agent tool that started it.
  if (data.parent_tool_use_id) return items;

  if (data.type === "assistant" && Array.isArray(data.message?.content)) {
    const next = [...items];
    const messageId = data.message?.id ?? data.uuid ?? String(items.length);
    data.message.content.forEach((block, index) => {
      const id = `${messageId}:${index}`;
      if (block.type === "text" && block.text?.trim()) {
        next.push({ kind: "text", id, text: block.text });
      } else if (block.type === "thinking" && block.thinking?.trim()) {
        next.push({ kind: "thinking", id, text: block.thinking });
      } else if (block.type === "tool_use" && block.id && block.name) {
        next.push({ kind: "tool", id: block.id, name: block.name, input: block.input ?? {} });
      }
    });
    return next;
  }

  if (data.type === "user" && Array.isArray(data.message?.content)) {
    const results = data.message.content.filter((block) => block.type === "tool_result");
    if (results.length === 0) return items;
    return items.map((item) => {
      if (item.kind !== "tool") return item;
      const match = results.find((block) => block.tool_use_id === item.id);
      if (!match) return item;
      const images = resultImages(match.content);
      return {
        ...item,
        result: {
          text: resultText(match.content),
          isError: !!match.is_error,
          ...(images.length > 0 ? { images } : {}),
        },
      };
    });
  }

  // The final result repeats Claude's last message, so only a failure adds anything.
  if (data.type === "result" && data.is_error) {
    return [...items, { kind: "note", id: `result:${items.length}`, text: data.result || "Claude stopped with an error." }];
  }

  return items;
}

/**
 * How full the context window is after this event, from the usage Claude Code
 * reports on each main-thread assistant message. Null for any other event.
 */
export function contextFromStreamLine(line: string): number | null {
  try {
    const data = JSON.parse(line);
    if (data.type !== "assistant" || data.parent_tool_use_id) return null;
    const usage = data.message?.usage;
    if (!usage) return null;
    const total =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

export function noteItem(text: string, items: ActivityItem[]): ActivityItem {
  return { kind: "note", id: `note:${items.length}:${text.length}`, text };
}

const MAX_SAVED_CHARS = 2000;

function clip(value: string): string {
  return value.length > MAX_SAVED_CHARS ? value.slice(0, MAX_SAVED_CHARS) + "\n…(truncated)" : value;
}

/** Keeps saved history small: long tool inputs and outputs are cut down. */
export function compactActivity(items: ActivityItem[]): ActivityItem[] {
  return items.map((item) => {
    if (item.kind !== "tool") return item;
    const input = Object.fromEntries(
      Object.entries(item.input).map(([key, value]) => [key, typeof value === "string" ? clip(value) : value])
    );
    return {
      ...item,
      input,
      // Images are dropped: a few screenshots would bloat history.json by megabytes.
      result: item.result ? { text: clip(item.result.text), isError: item.result.isError } : undefined,
    };
  });
}

export type ToolStatus = "running" | "done" | "failed";

export function toolStatus(item: Extract<ActivityItem, { kind: "tool" }>, finished: boolean): ToolStatus {
  if (item.result) return item.result.isError ? "failed" : "done";
  // A finished run that never answered a tool (killed, or waiting on approval) is not still running.
  return finished ? "done" : "running";
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const basename = (path: unknown): string | undefined => str(path)?.split("/").filter(Boolean).pop();

/** The first few plain words of a command, e.g. "npm run build". */
function commandPreview(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const words = command.trim().split(/\s+/);
  const safe: string[] = [];
  for (const word of words.slice(0, 4)) {
    if (!/^[\w./:@=+-]+$/.test(word)) break;
    safe.push(word);
  }
  if (safe.length === 0) return command.length > 40 ? command.slice(0, 40) + " …" : command;
  return safe.join(" ") + (safe.length < words.length ? " …" : "");
}

export interface ToolLabel {
  running: string;
  done: string;
  failed: string;
  /** Shown after the verb: a file name, pattern or command. */
  detail?: string;
  detailIsCode?: boolean;
}

export function toolLabel(name: string, input: Record<string, unknown>): ToolLabel {
  const verbs = (running: string, done: string, failed: string, detail?: string, detailIsCode = false): ToolLabel => ({
    running,
    done,
    failed,
    detail,
    detailIsCode,
  });

  switch (name) {
    case "Bash": {
      // Claude's own description reads better than the raw command when it gave one.
      const description = str(input.description);
      if (description) return verbs(description, description, `Failed: ${description}`);
      return verbs("Running", "Ran", "Failed to run", commandPreview(str(input.command)) ?? "a command", true);
    }
    case "Read":
      return verbs("Reading", "Read", "Failed to read", basename(input.file_path));
    case "Write":
      return verbs("Writing", "Wrote", "Failed to write", basename(input.file_path));
    case "Edit":
    case "MultiEdit":
      return verbs("Editing", "Edited", "Failed to edit", basename(input.file_path));
    case "Grep":
    case "Glob":
      return verbs("Searching", "Searched", "Failed to search", str(input.pattern), true);
    case "LS":
      return verbs("Listing", "Listed", "Failed to list", str(input.path));
    case "WebFetch":
      return verbs("Fetching", "Fetched", "Failed to fetch", str(input.url));
    case "WebSearch":
      return verbs("Searching the web for", "Searched the web for", "Failed to search the web for", str(input.query));
    case "Task":
    case "Agent":
      return verbs("Running agent", "Ran agent", "Agent failed", str(input.description));
    case "TodoWrite":
      return verbs("Updating todos", "Updated todos", "Failed to update todos");
    case "AskUserQuestion":
      return verbs("Asking", "Asked", "Failed to ask", "a question");
    default:
      return verbs("Using", "Used", "Failed to use", name);
  }
}

interface Category {
  key: string;
  verb: string;
  one: string;
  many: (count: number) => string;
}

function category(name: string): Category {
  const make = (key: string, verb: string, one: string, many: (count: number) => string): Category => ({
    key,
    verb,
    one,
    many,
  });
  switch (name) {
    case "Read":
      return make("read", "read", "a file", (n) => `${n} files`);
    case "Write":
      return make("write", "wrote", "a file", (n) => `${n} files`);
    case "Edit":
    case "MultiEdit":
      return make("edit", "edited", "a file", (n) => `${n} files`);
    case "Bash":
      return make("bash", "ran", "a command", (n) => `${n} commands`);
    case "Grep":
    case "Glob":
      return make("search", "searched", "code", () => "code");
    case "WebFetch":
    case "WebSearch":
      return make("web", "browsed", "the web", () => "the web");
    default:
      return make("other", "used", "a tool", (n) => `${n} tools`);
  }
}

/** "Ran 3 commands, read 2 files". */
export function groupSummary(tools: Array<Extract<ActivityItem, { kind: "tool" }>>): string {
  const parts: Array<{ cat: Category; count: number }> = [];
  for (const tool of tools) {
    const cat = category(tool.name);
    const existing = parts.find((part) => part.cat.key === cat.key);
    if (existing) existing.count++;
    else parts.push({ cat, count: 1 });
  }
  const text = parts
    .map(({ cat, count }) => `${cat.verb} ${count === 1 ? cat.one : cat.many(count)}`)
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

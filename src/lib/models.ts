/** A Claude model the CLI can run, and how much context it holds. */
export interface ClaudeModel {
  id: string;
  label: string;
  contextWindow: number;
}

/** Passed to `claude --model`. Newest first within each family. */
export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", contextWindow: 1_000_000 },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 1_000_000 },
  { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000 },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 1_000_000 },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000 },
];

export const DEFAULT_MODEL_ID = "claude-opus-5-5";

/** Unknown ids (an older saved setting, say) fall back to the default. */
export function modelById(id: string | null | undefined): ClaudeModel {
  return (
    CLAUDE_MODELS.find((model) => model.id === id) ??
    CLAUDE_MODELS.find((model) => model.id === DEFAULT_MODEL_ID)!
  );
}

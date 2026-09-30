import type { JSONContent } from "@tiptap/react";

/** What the user typed, as they'd read it back: mentions as @Name, images as [image]. */
export function docToText(doc: JSONContent): string {
  const walk = (node: JSONContent): string => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "mention") return `@${node.attrs?.label ?? node.attrs?.id ?? ""}`;
    if (node.type === "pastedImage") return "[image]";
    if (node.type === "hardBreak") return "\n";
    const inner = (node.content ?? []).map(walk).join("");
    return node.type === "paragraph" ? inner + "\n" : inner;
  };
  return walk(doc).trim();
}

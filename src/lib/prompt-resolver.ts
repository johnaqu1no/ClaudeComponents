import type { JSONContent } from "@tiptap/react";
import type { ComponentInfo } from "../types";

function extractFromNode(
  node: JSONContent,
  textParts: string[],
  mentionIds: Set<string>
) {
  if (node.type === "mention" && node.attrs?.id) {
    textParts.push(`@${node.attrs.id}`);
    mentionIds.add(node.attrs.id);
    return;
  }

  if (node.type === "text" && node.text) {
    textParts.push(node.text);
    return;
  }

  if (node.type === "paragraph") {
    if (node.content) {
      for (const child of node.content) {
        extractFromNode(child, textParts, mentionIds);
      }
    }
    textParts.push("\n");
    return;
  }

  if (node.type === "hardBreak") {
    textParts.push("\n");
    return;
  }

  if (node.content) {
    for (const child of node.content) {
      extractFromNode(child, textParts, mentionIds);
    }
  }
}

export function resolvePrompt(
  doc: JSONContent,
  componentMap: Map<string, ComponentInfo>
): string {
  const textParts: string[] = [];
  const mentionIds = new Set<string>();

  if (doc.content) {
    for (const child of doc.content) {
      extractFromNode(child, textParts, mentionIds);
    }
  }

  const taskText = textParts.join("").trim();
  if (!taskText) return "";

  const referencedComponents: ComponentInfo[] = [];
  for (const id of mentionIds) {
    const comp = componentMap.get(id);
    if (comp) referencedComponents.push(comp);
  }

  let prompt = `Task:\n${taskText}`;

  if (referencedComponents.length > 0) {
    prompt += "\n\nReferenced Components:\n";
    for (const comp of referencedComponents) {
      prompt += `\nComponent: ${comp.name}\nFile: ${comp.relativePath}\n\`\`\`tsx\n${comp.sourceText}\n\`\`\`\n`;
    }
  }

  return prompt;
}

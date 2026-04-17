import type { JSONContent } from "@tiptap/react";
import type { ComponentInfo } from "../types";

function extractFromNode(
  node: JSONContent,
  textParts: string[],
  mentionIds: Set<string>,
  imagePaths: string[]
) {
  if (node.type === "pastedImage" && node.attrs?.filePath) {
    imagePaths.push(node.attrs.filePath);
    return;
  }

  if (node.type === "mention" && node.attrs?.id) {
    textParts.push(`@${node.attrs.label || node.attrs.id}`);
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
        extractFromNode(child, textParts, mentionIds, imagePaths);
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
      extractFromNode(child, textParts, mentionIds, imagePaths);
    }
  }
}

export function resolvePrompt(
  doc: JSONContent,
  componentMap: Map<string, ComponentInfo>,
  knownComponentNames?: Set<string>
): { prompt: string; referencedNames: string[] } | null {
  const textParts: string[] = [];
  const mentionIds = new Set<string>();
  const imagePaths: string[] = [];

  if (doc.content) {
    for (const child of doc.content) {
      extractFromNode(child, textParts, mentionIds, imagePaths);
    }
  }

  const taskText = textParts.join("").trim();
  if (!taskText && imagePaths.length === 0) return null;

  const referencedComponents: ComponentInfo[] = [];
  const referencedNames: string[] = [];
  for (const id of mentionIds) {
    const comp = componentMap.get(id);
    if (comp) {
      referencedComponents.push(comp);
      referencedNames.push(comp.name);
    }
  }

  let prompt = `Task:\n${taskText || "(see attached images)"}`;

  if (referencedComponents.length > 0) {
    prompt += "\n\nReferenced Components:\n";
    for (const comp of referencedComponents) {
      if (knownComponentNames?.has(comp.name)) {
        prompt += `\nComponent: ${comp.name}\nFile: ${comp.relativePath}\n(source already provided earlier in this session)\n`;
      } else {
        prompt += `\nComponent: ${comp.name}\nFile: ${comp.relativePath}\n\`\`\`tsx\n${comp.sourceText}\n\`\`\`\n`;
      }
    }
  }

  if (imagePaths.length > 0) {
    prompt += "\n\nAttached Images (use Read tool to view):";
    for (const p of imagePaths) {
      prompt += `\n- ${p}`;
    }
    prompt +=
      "\n\nRead the attached images using the Read tool and implement the changes directly. Do not plan or ask for clarification.";
  }

  return { prompt, referencedNames };
}

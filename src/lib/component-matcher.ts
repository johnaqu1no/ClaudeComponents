import type { ComponentInfo, DetectedComponent } from "../types";

export function matchComponent(
  detected: DetectedComponent,
  components: ComponentInfo[]
): ComponentInfo | null {
  if (!detected.componentName) return null;

  // 1. Exact match: name + file path ending
  if (detected.fileName) {
    const exactMatch = components.find(
      (c) =>
        c.name === detected.componentName &&
        c.filePath.endsWith(detected.fileName!)
    );
    if (exactMatch) return exactMatch;
  }

  // 2. Name + line number within range
  if (detected.fileName && detected.lineNumber) {
    const lineMatch = components.find(
      (c) =>
        c.name === detected.componentName &&
        c.filePath.endsWith(detected.fileName!) &&
        detected.lineNumber! >= c.startLine &&
        detected.lineNumber! <= c.endLine
    );
    if (lineMatch) return lineMatch;
  }

  // 3. Name-only fallback
  const nameMatch = components.find(
    (c) => c.name === detected.componentName
  );
  return nameMatch || null;
}

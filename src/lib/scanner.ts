import ts from "typescript";
import { invoke } from "@tauri-apps/api/core";
import type { ComponentInfo, FileEntry } from "../types";

function hasJsxDescendant(node: ts.Node): boolean {
  if (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node)
  ) {
    return true;
  }
  return ts.forEachChild(node, hasJsxDescendant) ?? false;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function extractComponentName(node: ts.Node): string | null {
  // export function Button() {}
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }

  // export const Button = () => {} or export const Button = React.memo(...)
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) {
      return decl.name.text;
    }
  }

  // export default function Button() {}
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }

  return null;
}

function getExportType(
  node: ts.Node
): "named" | "default" | null {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return null;

  let hasExport = false;
  let hasDefault = false;
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.ExportKeyword) hasExport = true;
    if (mod.kind === ts.SyntaxKind.DefaultKeyword) hasDefault = true;
  }

  if (!hasExport) return null;
  return hasDefault ? "default" : "named";
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  // Unwrap React.memo(...), React.forwardRef(...), memo(...), forwardRef(...)
  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    let isWrapper = false;

    if (ts.isIdentifier(expr)) {
      isWrapper = expr.text === "memo" || expr.text === "forwardRef";
    } else if (ts.isPropertyAccessExpression(expr)) {
      isWrapper =
        expr.name.text === "memo" || expr.name.text === "forwardRef";
    }

    if (isWrapper && node.arguments.length > 0) {
      return unwrapExpression(node.arguments[0]);
    }
  }

  // Unwrap parenthesized expressions
  if (ts.isParenthesizedExpression(node)) {
    return unwrapExpression(node.expression);
  }

  return node;
}

function findComponents(
  sourceFile: ts.SourceFile,
  filePath: string,
  relativePath: string
): ComponentInfo[] {
  const components: ComponentInfo[] = [];

  for (const statement of sourceFile.statements) {
    const exportType = getExportType(statement);
    if (!exportType) continue;

    const name = extractComponentName(statement);
    if (!name || !isPascalCase(name)) continue;

    // Check if the statement contains JSX
    let containsJsx = false;

    if (ts.isFunctionDeclaration(statement)) {
      containsJsx = hasJsxDescendant(statement);
    } else if (ts.isVariableStatement(statement)) {
      const decl = statement.declarationList.declarations[0];
      if (decl?.initializer) {
        const unwrapped = unwrapExpression(decl.initializer);
        containsJsx =
          ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)
            ? hasJsxDescendant(unwrapped)
            : false;
      }
    }

    if (!containsJsx) continue;

    const startLine =
      sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    const endLine =
      sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1;
    const sourceText = statement.getText(sourceFile);

    components.push({
      name,
      filePath,
      relativePath,
      exportType,
      startLine,
      endLine,
      sourceText,
    });
  }

  return components;
}

function extractVueScriptBlock(content: string): { source: string; startLine: number; endLine: number } | null {
  // Match <script setup> or <script> opening tag (with optional attributes)
  const openRegex = /<script\b[^>]*>/i;
  const closeTag = "</script>";

  const openMatch = openRegex.exec(content);
  if (!openMatch) return null;

  const scriptStart = openMatch.index + openMatch[0].length;
  const closeIndex = content.indexOf(closeTag, scriptStart);
  if (closeIndex === -1) return null;

  const source = content.slice(scriptStart, closeIndex);

  // Count lines up to the script content start
  const startLine = content.slice(0, scriptStart).split("\n").length;
  const endLine = startLine + source.split("\n").length - 1;

  return { source, startLine, endLine };
}

function componentNameFromFilename(relativePath: string): string | null {
  const filename = relativePath.split("/").pop();
  if (!filename) return null;
  const name = filename.replace(/\.vue$/, "");
  // Vue SFC names should be PascalCase (or at least start uppercase)
  if (/^[A-Z]/.test(name)) return name;
  // Convert kebab-case to PascalCase (e.g. app-header → AppHeader)
  const pascal = name.replace(/(^|-)([a-z])/g, (_m, _sep, ch) => ch.toUpperCase());
  return /^[A-Z]/.test(pascal) ? pascal : null;
}

function parseVueFile(
  content: string,
  filePath: string,
  relativePath: string
): ComponentInfo[] {
  const name = componentNameFromFilename(relativePath);
  if (!name) return [];

  const scriptBlock = extractVueScriptBlock(content);

  return [{
    name,
    filePath,
    relativePath,
    exportType: "default",
    startLine: scriptBlock ? scriptBlock.startLine : 1,
    endLine: scriptBlock ? scriptBlock.endLine : content.split("\n").length,
    sourceText: scriptBlock ? scriptBlock.source : content,
  }];
}

export async function scanRepository(
  repoPath: string
): Promise<ComponentInfo[]> {
  const entries: FileEntry[] = await invoke("read_directory_recursive", {
    root: repoPath,
    extensions: ["tsx", "jsx", "ts", "js", "vue"],
  });

  const allComponents: ComponentInfo[] = [];

  // Process files in batches to avoid blocking the UI
  const batchSize = 50;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          const content: string = await invoke("read_file_contents", {
            path: entry.path,
          });

          // Vue SFC: derive component from filename + extract script block
          if (entry.relative_path.endsWith(".vue")) {
            return parseVueFile(content, entry.path, entry.relative_path);
          }

          const sourceFile = ts.createSourceFile(
            entry.relative_path,
            content,
            ts.ScriptTarget.Latest,
            true,
            entry.relative_path.endsWith(".tsx") || entry.relative_path.endsWith(".jsx")
              ? ts.ScriptKind.TSX
              : ts.ScriptKind.TS
          );

          return findComponents(sourceFile, entry.path, entry.relative_path);
        } catch {
          return [];
        }
      })
    );

    allComponents.push(...results.flat());
  }

  return allComponents.sort((a, b) => a.name.localeCompare(b.name));
}

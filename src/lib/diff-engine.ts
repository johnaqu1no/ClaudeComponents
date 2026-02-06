import { invoke } from "@tauri-apps/api/core";
import { structuredPatch } from "diff";
import type { FileEntry, FileDiff, FileSnapshot } from "../types";

export async function createSnapshot(
  repoPath: string
): Promise<Map<string, FileSnapshot>> {
  const entries: FileEntry[] = await invoke("read_directory_recursive", {
    root: repoPath,
    extensions: ["tsx", "jsx", "ts", "js", "css", "json", "html", "md"],
  });

  const paths = entries.map((e) => e.path);
  const snapshots: FileSnapshot[] = await invoke("snapshot_files", { paths });

  const map = new Map<string, FileSnapshot>();
  for (const snap of snapshots) {
    map.set(snap.path, snap);
  }
  return map;
}

export async function computeDiffs(
  repoPath: string,
  before: Map<string, FileSnapshot>
): Promise<FileDiff[]> {
  const entries: FileEntry[] = await invoke("read_directory_recursive", {
    root: repoPath,
    extensions: ["tsx", "jsx", "ts", "js", "css", "json", "html", "md"],
  });

  const diffs: FileDiff[] = [];

  // Check for modified and created files
  for (const entry of entries) {
    try {
      const newContent: string = await invoke("read_file_contents", {
        path: entry.path,
      });

      const oldSnapshot = before.get(entry.path);

      if (!oldSnapshot) {
        // New file
        const patch = structuredPatch(
          entry.relative_path,
          entry.relative_path,
          "",
          newContent,
          "",
          ""
        );
        const patchStr = formatPatch(patch);
        if (patchStr.trim()) {
          diffs.push({
            filePath: entry.path,
            relativePath: entry.relative_path,
            status: "created",
            oldContent: "",
            newContent,
            patch: patchStr,
            accepted: null,
          });
        }
      } else if (oldSnapshot.content !== newContent) {
        // Modified file
        const patch = structuredPatch(
          entry.relative_path,
          entry.relative_path,
          oldSnapshot.content,
          newContent,
          "",
          ""
        );
        const patchStr = formatPatch(patch);
        if (patchStr.trim()) {
          diffs.push({
            filePath: entry.path,
            relativePath: entry.relative_path,
            status: "modified",
            oldContent: oldSnapshot.content,
            newContent,
            patch: patchStr,
            accepted: null,
          });
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Check for deleted files
  const currentPaths = new Set(entries.map((e) => e.path));
  for (const [path, snapshot] of before) {
    if (!currentPaths.has(path)) {
      const relativePath = path.startsWith(repoPath)
        ? path.slice(repoPath.length + 1)
        : path;
      const patch = structuredPatch(
        relativePath,
        relativePath,
        snapshot.content,
        "",
        "",
        ""
      );
      diffs.push({
        filePath: path,
        relativePath,
        status: "deleted",
        oldContent: snapshot.content,
        newContent: "",
        patch: formatPatch(patch),
        accepted: null,
      });
    }
  }

  return diffs;
}

function formatPatch(patch: ReturnType<typeof structuredPatch>): string {
  const lines: string[] = [];

  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    );
    for (const line of hunk.lines) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

export async function revertFile(
  filePath: string,
  oldContent: string,
  status: "modified" | "created" | "deleted"
): Promise<void> {
  if (status === "created") {
    // File was created by Claude — delete it
    await invoke("delete_file", { path: filePath });
  } else if (status === "deleted") {
    // File was deleted by Claude — restore it
    await invoke("write_file_contents", { path: filePath, content: oldContent });
  } else {
    // File was modified — restore original
    await invoke("write_file_contents", { path: filePath, content: oldContent });
  }
}

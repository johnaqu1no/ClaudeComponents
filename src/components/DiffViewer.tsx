import { useAppState, useAppDispatch } from "../stores/app-store";
import { DiffFileCard } from "./DiffFileCard";
import { revertFile } from "../lib/diff-engine";
import { useCallback } from "react";

export function DiffViewer() {
  const { diffs, executionResult } = useAppState();
  const dispatch = useAppDispatch();

  const handleAcceptAll = useCallback(() => {
    dispatch({ type: "ACCEPT_ALL" });
  }, [dispatch]);

  const handleRejectAll = useCallback(async () => {
    dispatch({ type: "REJECT_ALL" });
    for (const diff of diffs) {
      if (diff.accepted !== false) {
        try {
          await revertFile(diff.filePath, diff.oldContent, diff.status);
        } catch (err) {
          console.error(`Failed to revert ${diff.filePath}:`, err);
        }
      }
    }
  }, [dispatch, diffs]);

  const handleAccept = useCallback(
    (filePath: string) => {
      dispatch({ type: "UPDATE_DIFF", filePath, accepted: true });
    },
    [dispatch]
  );

  const handleReject = useCallback(
    async (filePath: string) => {
      const diff = diffs.find((d) => d.filePath === filePath);
      if (diff) {
        try {
          await revertFile(diff.filePath, diff.oldContent, diff.status);
          dispatch({ type: "UPDATE_DIFF", filePath, accepted: false });
        } catch (err) {
          console.error(`Failed to revert ${filePath}:`, err);
        }
      }
    },
    [dispatch, diffs]
  );

  if (diffs.length === 0) {
    return (
      <div className="diff-viewer-empty">
        <p>No changes detected.</p>
        {executionResult && (
          <div className="execution-summary">
            <p>
              Exit code: {executionResult.exitCode} | Duration:{" "}
              {(executionResult.durationMs / 1000).toFixed(1)}s
            </p>
          </div>
        )}
      </div>
    );
  }

  const pending = diffs.filter((d) => d.accepted === null).length;

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        <span className="diff-count">
          {diffs.length} file{diffs.length !== 1 ? "s" : ""} changed
          {pending > 0 && ` (${pending} pending)`}
        </span>
        {executionResult && (
          <span className="execution-time">
            {(executionResult.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <div className="diff-viewer-bulk-actions">
          <button className="btn-accept" onClick={handleAcceptAll}>
            Accept All
          </button>
          <button className="btn-reject" onClick={handleRejectAll}>
            Reject All
          </button>
        </div>
      </div>
      <div className="diff-list">
        {diffs.map((diff) => (
          <DiffFileCard
            key={diff.filePath}
            diff={diff}
            onAccept={() => handleAccept(diff.filePath)}
            onReject={() => handleReject(diff.filePath)}
          />
        ))}
      </div>
    </div>
  );
}

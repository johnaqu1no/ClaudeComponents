import type { FileDiff } from "../types";

interface DiffFileCardProps {
  diff: FileDiff;
  onAccept: () => void;
  onReject: () => void;
}

function StatusBadge({ status }: { status: FileDiff["status"] }) {
  const labels = { modified: "Modified", created: "Created", deleted: "Deleted" };
  return <span className={`status-badge status-${status}`}>{labels[status]}</span>;
}

export function DiffFileCard({ diff, onAccept, onReject }: DiffFileCardProps) {
  const lines = diff.patch.split("\n");

  return (
    <div
      className={`diff-card ${diff.accepted === true ? "accepted" : diff.accepted === false ? "rejected" : ""}`}
    >
      <div className="diff-card-header">
        <div className="diff-card-title">
          <StatusBadge status={diff.status} />
          <span className="diff-card-path">{diff.relativePath}</span>
        </div>
        <div className="diff-card-actions">
          {diff.accepted === null ? (
            <>
              <button className="btn-accept" onClick={onAccept}>
                Accept
              </button>
              <button className="btn-reject" onClick={onReject}>
                Reject
              </button>
            </>
          ) : (
            <span className={diff.accepted ? "label-accepted" : "label-rejected"}>
              {diff.accepted ? "Accepted" : "Rejected"}
            </span>
          )}
        </div>
      </div>
      <pre className="diff-content">
        {lines.map((line, i) => {
          let className = "diff-line";
          if (line.startsWith("+")) className += " diff-add";
          else if (line.startsWith("-")) className += " diff-remove";
          else if (line.startsWith("@@")) className += " diff-hunk";

          return (
            <div key={i} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

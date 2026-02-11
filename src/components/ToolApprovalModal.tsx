import type { ToolApproval } from "../types";

interface ToolApprovalModalProps {
  approval: ToolApproval;
  onApprove: () => void;
  onDeny: () => void;
  onCancel: () => void;
}

export function ToolApprovalModal({ approval, onApprove, onDeny, onCancel }: ToolApprovalModalProps) {
  return (
    <div className="settings-backdrop" onClick={onCancel}>
      <div className="tool-approval-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tool-approval-header">
          <h2>Tool Approval Required</h2>
          <button className="settings-close" onClick={onCancel}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="ask-user-body">
          <p className="ask-user-question">
            Claude wants to run a <strong>{approval.toolName}</strong> command:
          </p>

          {approval.description && (
            <p className="tool-approval-description">{approval.description}</p>
          )}

          <div className="tool-approval-command">
            <code>{approval.command}</code>
          </div>

          <div className="tool-approval-actions">
            <button className="btn-primary" onClick={onApprove}>
              Approve
            </button>
            <button className="btn-secondary" onClick={onDeny}>
              Deny
            </button>
            <button className="btn-ghost" onClick={onCancel}>
              Cancel Task
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

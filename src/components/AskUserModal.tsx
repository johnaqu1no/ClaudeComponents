import { useState } from "react";
import type { UserQuestion } from "../types";

interface AskUserModalProps {
  question: UserQuestion;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}

export function AskUserModal({ question, onAnswer, onDismiss }: AskUserModalProps) {
  const [otherText, setOtherText] = useState("");
  const [showOther, setShowOther] = useState(false);

  return (
    <div className="settings-backdrop" onClick={onDismiss}>
      <div className="ask-user-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ask-user-header">
          <h2>Claude needs your input</h2>
          <button className="settings-close" onClick={onDismiss}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="ask-user-body">
          <p className="ask-user-question">{question.question}</p>

          <div className="ask-user-options">
            {question.options.map((opt, i) => (
              <button
                key={i}
                className="ask-user-option-btn"
                onClick={() => onAnswer(opt.label)}
              >
                <span className="ask-user-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="ask-user-option-desc">{opt.description}</span>
                )}
              </button>
            ))}

            {!showOther ? (
              <button
                className="ask-user-option-btn ask-user-other-toggle"
                onClick={() => setShowOther(true)}
              >
                <span className="ask-user-option-label">Other...</span>
                <span className="ask-user-option-desc">Provide a custom response</span>
              </button>
            ) : (
              <div className="ask-user-other-input-group">
                <input
                  type="text"
                  className="settings-input"
                  placeholder="Type your response..."
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && otherText.trim()) {
                      onAnswer(otherText.trim());
                    }
                  }}
                  autoFocus
                />
                <button
                  className="btn-primary btn-sm"
                  disabled={!otherText.trim()}
                  onClick={() => {
                    if (otherText.trim()) onAnswer(otherText.trim());
                  }}
                >
                  Send
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

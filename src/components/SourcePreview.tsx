import { useAppState, useAppDispatch } from "../stores/app-store";

interface SourcePreviewProps {
  onInsertMention: (name: string) => void;
}

export function SourcePreview({ onInsertMention }: SourcePreviewProps) {
  const { selectedComponent } = useAppState();
  const dispatch = useAppDispatch();

  if (!selectedComponent) return null;

  const lines = selectedComponent.sourceText.split("\n");

  return (
    <div className="source-preview">
      <div className="source-preview-header">
        <div className="source-preview-title">
          <span className="source-preview-name">{selectedComponent.name}</span>
          <span className="source-preview-path">
            {selectedComponent.relativePath}:{selectedComponent.startLine}
          </span>
        </div>
        <div className="source-preview-actions">
          <button
            className="btn-sm btn-primary"
            onClick={() => onInsertMention(selectedComponent.name)}
          >
            Insert @mention
          </button>
          <button
            className="btn-sm btn-ghost"
            onClick={() => dispatch({ type: "CLEAR_SELECTED_COMPONENT" })}
          >
            Clear
          </button>
        </div>
      </div>
      <pre className="source-preview-code">
        {lines.map((line, i) => (
          <div key={i} className="source-line">
            <span className="source-line-number">
              {selectedComponent.startLine + i}
            </span>
            <span className="source-line-content">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

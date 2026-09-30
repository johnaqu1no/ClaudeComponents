import { timeUntil, type PlanUsage, type UsageWindow } from "../lib/usage";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function Meter({ label, percent, value, title }: { label: string; percent: number | null; value: string; title?: string }) {
  const level = percent === null ? "" : percent >= 90 ? " danger" : percent >= 75 ? " warning" : "";
  return (
    <div className="stats-meter" title={title}>
      <div className="stats-meter-label">
        <span>{label}</span>
        <span className="stats-meter-value">{value}</span>
      </div>
      <div className="stats-meter-bar">
        <div className={`stats-meter-fill${level}`} style={{ width: `${Math.min(percent ?? 0, 100)}%` }} />
      </div>
    </div>
  );
}

function PlanMeter({ label, window, error }: { label: string; window: UsageWindow | null | undefined; error: string | null }) {
  if (!window) return <Meter label={label} percent={null} value="—" title={error ?? undefined} />;
  const resets = timeUntil(window.resetsAt);
  return (
    <Meter
      label={label}
      percent={window.percent}
      value={`${Math.round(window.percent)}%`}
      title={resets ? `Resets in ${resets}` : undefined}
    />
  );
}

interface StatsStripProps {
  contextTokens: number | null;
  contextWindow: number;
  planUsage: PlanUsage | null;
  planError: string | null;
  branch: string | null;
  onBranchClick: () => void;
}

export function StatsStrip({ contextTokens, contextWindow, planUsage, planError, branch, onBranchClick }: StatsStripProps) {
  const contextPercent = contextTokens === null ? null : (contextTokens / contextWindow) * 100;
  return (
    <div className="stats-strip">
      <Meter
        label="Ctx"
        percent={contextPercent}
        value={`${contextTokens === null ? "—" : formatTokens(contextTokens)}/${formatTokens(contextWindow)}`}
        title={contextTokens === null ? "Context fills in once Claude replies" : `${contextTokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens`}
      />
      <PlanMeter label="Session" window={planUsage?.session} error={planError} />
      <PlanMeter label="Weekly" window={planUsage?.weekly} error={planError} />
      {branch && (
        <button className="stats-branch" onClick={onBranchClick} title="Change branch in settings">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M6 9v6M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span>{branch}</span>
        </button>
      )}
    </div>
  );
}

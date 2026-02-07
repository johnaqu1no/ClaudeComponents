import { useAppState, useAppDispatch } from "../stores/app-store";

export function InspectorToggle() {
  const { inspectorActive, proxyPort } = useAppState();
  const dispatch = useAppDispatch();

  const disabled = !proxyPort;

  return (
    <button
      className={`toolbar-icon-btn${inspectorActive ? " inspector-active" : ""}`}
      onClick={() =>
        dispatch({ type: "SET_INSPECTOR_ACTIVE", active: !inspectorActive })
      }
      disabled={disabled}
      title={
        disabled
          ? "Start a dev server preview first"
          : inspectorActive
            ? "Disable component inspector"
            : "Select a component from the page"
      }
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

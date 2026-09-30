import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ScreenshotToast {
  id: string;
  src: string;
  caption: string;
}

const DISMISS_AFTER_MS = 120_000;
const FADE_MS = 300;

function Toast({
  toast,
  fading,
  onDismiss,
}: {
  toast: ScreenshotToast;
  fading: boolean;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div className={`screenshot-toast${fading ? " fading" : ""}`} data-toast-id={toast.id}>
      <div className="screenshot-toast-header">
        <span className="screenshot-toast-caption" title={toast.caption}>
          {toast.caption}
        </span>
        <button className="screenshot-toast-close" onClick={() => onDismiss(toast.id)} title="Dismiss">
          {"✕"}
        </button>
      </div>
      <img className="screenshot-toast-image" src={toast.src} alt={toast.caption} />
    </div>
  );
}

/**
 * Screenshots Claude takes, stacked bottom-left. The newest sits at the bottom
 * and pushes older ones up; one pushed past the top of the stack fades out.
 */
export function ScreenshotToasts({
  toasts,
  onDismiss,
}: {
  toasts: ScreenshotToast[];
  onDismiss: (id: string) => void;
}) {
  const stackRef = useRef<HTMLDivElement>(null);
  const [fading, setFading] = useState<Set<string>>(new Set());
  // Not state: a removal already scheduled must survive the re-render fading causes.
  const leavingRef = useRef<Set<string>>(new Set());

  // After each change, anything whose top has left the stack's area is on its way out.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const limit = stack.getBoundingClientRect().top;
    const overflowing = [...stack.querySelectorAll<HTMLElement>("[data-toast-id]")]
      .filter((el) => el.getBoundingClientRect().top < limit)
      .map((el) => el.dataset.toastId!)
      .filter((id) => !leavingRef.current.has(id));
    if (overflowing.length === 0) return;

    overflowing.forEach((id) => leavingRef.current.add(id));
    setFading((prev) => new Set([...prev, ...overflowing]));
    setTimeout(() => {
      overflowing.forEach((id) => {
        leavingRef.current.delete(id);
        onDismiss(id);
      });
    }, FADE_MS);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="screenshot-toasts" ref={stackRef}>
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} fading={fading.has(toast.id)} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

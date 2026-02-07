import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppState, useAppDispatch } from "../stores/app-store";
import { matchComponent } from "../lib/component-matcher";
import type { DetectedComponent } from "../types";

export function WebviewPanel() {
  const { proxyPort, devServerUrl, inspectorActive, components } = useAppState();
  const dispatch = useAppDispatch();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const lastLocationRef = useRef<{ path: string; scrollX: number; scrollY: number } | null>(null);
  const pendingReloadRef = useRef(false);

  const reloadIframe = useCallback(() => {
    if (!iframeRef.current) return;

    // Ask the iframe for its current location before reloading
    pendingReloadRef.current = true;
    iframeRef.current.contentWindow?.postMessage({ type: "get-location" }, "*");

    // Fallback: if iframe doesn't respond within 200ms, reload anyway
    setTimeout(() => {
      if (pendingReloadRef.current) {
        pendingReloadRef.current = false;
        setReloadKey((k) => k + 1);
      }
    }, 200);
  }, []);

  // Ctrl+R / Cmd+R to reload the webview
  // Backtick to toggle inspector (ignored when typing in editor)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "r") {
        e.preventDefault();
        reloadIframe();
      }
      if (e.key === "`" && proxyPort) {
        const target = e.target as HTMLElement;
        if (target.closest(".tiptap") || target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        dispatch({ type: "SET_INSPECTOR_ACTIVE", active: !inspectorActive });
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reloadIframe, inspectorActive, proxyPort, dispatch]);

  // Listen for reload event from toolbar refresh button
  useEffect(() => {
    function handleReloadEvent() {
      reloadIframe();
    }
    window.addEventListener("reload-webview", handleReloadEvent);
    return () => window.removeEventListener("reload-webview", handleReloadEvent);
  }, [reloadIframe]);

  // Listen for navigate event from URL bar
  useEffect(() => {
    function handleNavigate(e: Event) {
      const path = (e as CustomEvent).detail as string;
      lastLocationRef.current = { path, scrollX: 0, scrollY: 0 };
      setReloadKey((k) => k + 1);
    }
    window.addEventListener("navigate-webview", handleNavigate);
    return () => window.removeEventListener("navigate-webview", handleNavigate);
  }, []);

  // Start proxy when devServerUrl changes
  useEffect(() => {
    if (!devServerUrl) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    invoke<number>("start_inspector_proxy", { devServerUrl })
      .then((port) => {
        if (!cancelled) {
          dispatch({ type: "SET_PROXY_PORT", port });
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(`Failed to start proxy: ${err}`);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [devServerUrl, dispatch]);

  // Toggle inspector in iframe
  useEffect(() => {
    if (!iframeRef.current?.contentWindow || !proxyPort) return;
    iframeRef.current.contentWindow.postMessage(
      { type: inspectorActive ? "enable-inspector" : "disable-inspector" },
      "*"
    );
  }, [inspectorActive, proxyPort]);

  // Listen for current-location response from iframe (navigation preservation + URL bar sync)
  useEffect(() => {
    function handleLocationMessage(e: MessageEvent) {
      if (e.data?.type === "current-location") {
        const path = e.data.path || "/";
        lastLocationRef.current = {
          path,
          scrollX: e.data.scrollX || 0,
          scrollY: e.data.scrollY || 0,
        };
        window.dispatchEvent(new CustomEvent("webview-location", { detail: path }));
        if (pendingReloadRef.current) {
          pendingReloadRef.current = false;
          setReloadKey((k) => k + 1);
        }
      }
    }
    window.addEventListener("message", handleLocationMessage);
    return () => window.removeEventListener("message", handleLocationMessage);
  }, []);

  // Restore scroll position and re-send inspector state after iframe loads
  const handleIframeLoad = useCallback(() => {
    if (!iframeRef.current) return;

    // Re-send inspector state to the fresh iframe
    if (inspectorActive) {
      iframeRef.current.contentWindow?.postMessage(
        { type: "enable-inspector" },
        "*"
      );
    }

    if (!lastLocationRef.current) return;
    const { scrollX, scrollY } = lastLocationRef.current;
    if (scrollX || scrollY) {
      // Small delay to let the page render before scrolling
      setTimeout(() => {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "restore-scroll", scrollX, scrollY },
          "*"
        );
      }, 100);
    }
  }, [inspectorActive]);

  // Listen for component selection from iframe
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "component-selected") {
        const detected: DetectedComponent = e.data.payload;
        if (detected.componentName) {
          const matched = matchComponent(detected, components) ?? {
            name: detected.componentName,
            filePath: detected.fileName || "",
            relativePath: detected.fileName
              ? detected.fileName.split("/").slice(-2).join("/")
              : "",
            exportType: "named" as const,
            startLine: detected.lineNumber || 0,
            endLine: detected.lineNumber || 0,
            sourceText: "",
          };
          dispatch({ type: "SELECT_COMPONENT", component: matched, element: detected.element ?? null });
        } else {
          dispatch({
            type: "SET_ERROR",
            error: "No React component found. Make sure you are running in development mode.",
          });
        }
      } else if (e.data?.type === "inspector-deactivated") {
        dispatch({ type: "SET_INSPECTOR_ACTIVE", active: false });
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [components, dispatch]);

  if (!devServerUrl) {
    return (
      <div className="webview-empty">
        <div className="webview-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        </div>
        <p>Set a dev server URL to preview your app</p>
        <p className="webview-empty-hint">
          Open settings to configure the dev server URL
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="webview-loading">
        <div className="spinner" />
        <p>Starting proxy...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="webview-error">
        <p>{error}</p>
        <button
          className="btn-secondary"
          onClick={() => {
            setError(null);
            dispatch({ type: "SET_DEV_SERVER_URL", url: devServerUrl });
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="webview-container">
      {proxyPort && (
        <iframe
          key={reloadKey}
          ref={iframeRef}
          src={`http://localhost:${proxyPort}${lastLocationRef.current?.path || ""}`}
          className="webview-iframe"
          title="App Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          onLoad={handleIframeLoad}
        />
      )}
    </div>
  );
}

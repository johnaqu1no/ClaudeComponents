use axum::{
    body::Body,
    extract::State,
    http::{header, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

const INSPECTOR_SCRIPT: &str = include_str!("../inspector/inspector.js");

struct ProxyState {
    dev_server_url: String,
    client: reqwest::Client,
}

static PROXY_HANDLE: std::sync::OnceLock<Mutex<Option<tokio::task::JoinHandle<()>>>> =
    std::sync::OnceLock::new();

fn get_proxy_handle() -> &'static Mutex<Option<tokio::task::JoinHandle<()>>> {
    PROXY_HANDLE.get_or_init(|| Mutex::new(None))
}

static PROXY_PORT: std::sync::OnceLock<Mutex<Option<u16>>> = std::sync::OnceLock::new();

fn get_proxy_port() -> &'static Mutex<Option<u16>> {
    PROXY_PORT.get_or_init(|| Mutex::new(None))
}

pub async fn start_proxy(dev_server_url: String) -> Result<u16, String> {
    // Stop existing proxy if running
    stop_proxy().await?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let state = Arc::new(ProxyState {
        dev_server_url: dev_server_url.trim_end_matches('/').to_string(),
        client,
    });

    let app = Router::new()
        .route("/{*path}", any(proxy_handler))
        .route("/", any(proxy_handler))
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get addr: {}", e))?
        .port();

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("Proxy server error: {}", e);
        }
    });

    *get_proxy_handle().lock().await = Some(handle);
    *get_proxy_port().lock().await = Some(port);

    Ok(port)
}

pub async fn stop_proxy() -> Result<(), String> {
    let mut handle_lock = get_proxy_handle().lock().await;
    if let Some(handle) = handle_lock.take() {
        handle.abort();
    }
    *get_proxy_port().lock().await = None;
    Ok(())
}

/// No-op replacement for /@vite/client — prevents HMR WebSocket reconnect loop
const VITE_CLIENT_NOOP: &str = r#"
const noop = () => {};
const hot = { accept:noop, dispose:noop, prune:noop, decline:noop, invalidate:noop, on:noop, send:noop, data:{} };
export function createHotContext() { return hot; }
export function updateStyle(id, css) {
  let el = document.querySelector(`[data-vite-dev-id="${id}"]`);
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(el);
  }
  el.textContent = css;
}
export function removeStyle(id) {
  const el = document.querySelector(`[data-vite-dev-id="${id}"]`);
  if (el) el.remove();
}
export function injectQuery(u) { return u; }
export function __hmr_import(url) { return import(url); }
export default {};
"#;

/// No-op replacement for /@react-refresh — every method Vite's React plugin
/// may call, including __hmr_import for dynamic-import wrapping.
const REACT_REFRESH_NOOP: &str = r#"
const noop = () => {};
const identity = (t) => t;

const RefreshRuntime = {
  injectIntoGlobalHook: noop,
  isLikelyComponentType: () => false,
  getFamilyByType: () => undefined,
  getFamilyByID: () => undefined,
  register: noop,
  setSignature: noop,
  collectCustomHooksForSignature: noop,
  createSignatureFunctionForTransform: () => identity,
  performReactRefresh: noop,
  hasUnrecoveredErrors: () => false,
  getRefreshReg: () => noop,
  getRefreshSig: () => () => identity,
  __hmr_import: (url) => import(url),
};

window.$RefreshReg$ = noop;
window.$RefreshSig$ = () => identity;
window.__vite_plugin_react_preamble_installed__ = true;

export default RefreshRuntime;
export const injectIntoGlobalHook = noop;
export const isLikelyComponentType = () => false;
export const getFamilyByType = () => undefined;
export const getFamilyByID = () => undefined;
export const register = noop;
export const setSignature = noop;
export const collectCustomHooksForSignature = noop;
export const createSignatureFunctionForTransform = () => identity;
export const performReactRefresh = noop;
export const hasUnrecoveredErrors = () => false;
export const getRefreshReg = () => noop;
export const getRefreshSig = () => () => identity;
export function __hmr_import(url) { return import(url); }
"#;

async fn proxy_handler(
    State(state): State<Arc<ProxyState>>,
    req: Request<Body>,
) -> impl IntoResponse {
    let path = req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/");

    // Intercept Vite internal modules that establish WebSocket/HMR connections
    let path_only = path.split('?').next().unwrap_or(path);
    if path_only == "/@vite/client" || path_only.starts_with("/@vite/client") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/javascript")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(VITE_CLIENT_NOOP))
            .unwrap();
    }
    if path_only == "/@react-refresh" || path_only.starts_with("/@react-refresh") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/javascript")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(REACT_REFRESH_NOOP))
            .unwrap();
    }

    let target_url = format!("{}{}", state.dev_server_url, path);

    let method = req.method().clone();
    let headers = req.headers().clone();

    let mut proxy_req = state.client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &target_url,
    );

    // Forward relevant headers (skip Accept-Encoding — reqwest handles its own decompression)
    for (name, value) in headers.iter() {
        if name == header::HOST || name == header::ACCEPT_ENCODING {
            continue;
        }
        if let Ok(v) = value.to_str() {
            proxy_req = proxy_req.header(name.as_str(), v);
        }
    }

    // Forward request body for non-GET methods
    if method != Method::GET && method != Method::HEAD {
        let body_bytes = match axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024).await {
            Ok(b) => b,
            Err(e) => {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Body::from(format!("Failed to read request body: {}", e)))
                    .unwrap();
            }
        };
        proxy_req = proxy_req.body(body_bytes);
    }

    let resp = match proxy_req.send().await {
        Ok(r) => r,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Proxy error: {}", e)))
                .unwrap();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::OK);
    let resp_headers = resp.headers().clone();

    let content_type = resp_headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let is_html = content_type.contains("text/html");

    let body_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Failed to read response body: {}", e)))
                .unwrap();
        }
    };

    let final_body = if is_html {
        let mut html = String::from_utf8_lossy(&body_bytes).into_owned();

        // Strip inline Vite React Refresh preamble (the <script type="module"> block
        // injected by Vite that sets up RefreshRuntime and causes errors without HMR)
        if let Some(start) = html.find("<script type=\"module\">") {
            let search_region = &html[start..];
            if search_region.contains("RefreshRuntime") || search_region.contains("__vite_plugin_react") {
                if let Some(end_offset) = search_region.find("</script>") {
                    let end = start + end_offset + "</script>".len();
                    html.replace_range(start..end, "<!-- vite refresh stripped -->");
                }
            }
        }

        let script_tag = format!("<script>{}</script>", INSPECTOR_SCRIPT);
        if html.contains("</body>") {
            html.replace("</body>", &format!("{}</body>", script_tag)).into_bytes()
        } else if html.contains("</html>") {
            html.replace("</html>", &format!("{}</html>", script_tag)).into_bytes()
        } else {
            html.push_str(&script_tag);
            html.into_bytes()
        }
    } else {
        body_bytes.to_vec()
    };

    let mut response = Response::builder().status(status);

    // Forward response headers (skip headers that no longer apply after reqwest decoding)
    for (name, value) in resp_headers.iter() {
        if name == header::CONTENT_LENGTH
            || name == header::TRANSFER_ENCODING
            || name == header::CONTENT_ENCODING
        {
            continue;
        }
        response = response.header(name, value);
    }

    // Add CORS headers
    response = response
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, PUT, DELETE, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*");

    response.body(Body::from(final_body)).unwrap()
}

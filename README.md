# Claude Components
A desktop app for visually editing React components with AI. Point it at a running React dev server, inspect and select components directly in a live preview, then describe changes in natural language — Claude Code executes the modifications and presents diffs for you to review, accept, or reject.

__This is a free concept program made with Claude and pure thinking. There are no plans to monetize this project and you are free to follow the MIT license!__

## How It Works

1. **Live Preview** — A built-in proxy loads your React dev server in an embedded webview and injects an inspector overlay.
2. **Component Inspector** — Toggle the inspector to hover over UI elements and identify their React component, source file, and line number. Clicking an element selects it as context for your next task.
3. **Natural Language Tasks** — Describe what you want changed using a rich text editor. Use `@` mentions to reference scanned components and attach their source code as context.
4. **Claude Code Execution** — Tasks are sent to the Claude Code CLI, which reads and edits your project files. Streaming output is displayed in real time.
5. **Diff Review** — After execution, file diffs are shown in a review panel. Accept or reject changes per-file, or use auto-accept to skip review.
6. **Message Queue** — Queue multiple prompts while Claude is working. Queued items execute sequentially and can be edited or cancelled before they run.
7. **Session Continuity** — Conversations persist across tasks within a session so Claude retains context from previous edits.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — the `claude` command must be on your PATH

## Setup

```bash
# Clone the repository
git clone https://github.com/your-username/claude-components.git
cd claude-components

# Install frontend dependencies
npm install

# Run in development mode (launches the Tauri window)
npm run tauri dev

# Build for production
npm run tauri build
```

On first run, open **Settings** to configure:
- **Project folder** — path to your React project's root (used for component scanning and file diffing)
- **Dev server URL** — e.g. `http://localhost:5173` (the running Vite/Next/CRA server)

## Dependencies

### Frontend
| Package | Purpose |
|---|---|
| React 19 + ReactDOM | UI framework |
| Vite 7 | Dev server and bundler |
| TypeScript 5.8 | Type checking |
| TipTap (react, starter-kit, mention, placeholder, suggestion) | Rich text editor with `@` mention support |
| tippy.js | Tooltip/popover positioning for mention dropdown |
| diff | Computing file diffs between snapshots |
| @tauri-apps/api, plugin-dialog, plugin-fs, plugin-shell, plugin-opener | Tauri IPC, file system access, shell commands, native dialogs |

### Backend (Rust / Tauri)
| Crate | Purpose |
|---|---|
| tauri 2 | Desktop application framework |
| axum | HTTP proxy server for the inspector-injected webview |
| reqwest | Forwarding requests to the upstream dev server |
| tokio | Async runtime |
| walkdir | Recursive directory scanning for components |
| serde / serde_json | Serialization |

## Project Structure

```
src/                    # React frontend
  components/           # UI components (TaskEditor, WebviewPanel, DiffViewer, etc.)
  lib/                  # Core logic (scanner, prompt resolver, diff engine, Claude orchestrator)
  stores/               # App state (reducer + context)
  types/                # TypeScript interfaces
src-tauri/              # Rust backend
  src/                  # Tauri commands and proxy server
  inspector/            # JavaScript injected into the webview for component inspection
```

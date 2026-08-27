# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Web is a web-based interface for terminal-based AI coding CLIs — Claude Code, Codex, and a generic Agent (cursor-agent) — giving them browser-based access with multi-session support and real-time streaming. It renders a real terminal via xterm.js and streams a PTY over WebSocket. Node.js, CommonJS, **no build step**: `src/` runs directly. The frontend is dependency-free — xterm and fonts are vendored under `src/public/vendor/`.

## Common Commands

```bash
# Install dependencies (Node >= 16)
npm install

# Start dev server (extra logging) — dev instance runs on port 32353 by convention
npm run dev -- --port 32353

# Start production/stable server — defaults to port 32352
npm start

# Auth / HTTPS
npm start -- --auth your-token
npm start -- --https --cert cert.pem --key key.pem

# Run the test suite (Mocha + node:assert)
npm test

# Run a single test file
npx mocha test/session-store.test.js

# Run a single test by name
npx mocha test/*.test.js --grep "persistence"
```

Default port is **32352**. Local convention: the **stable** instance runs on **32352** (a live user session — don't edit/restart it) and the **dev** instance on **32353** (edit here). Full flag list lives in `bin/cc-web.js` (`--plan`, `--claude-alias`/`--codex-alias`/`--agent-alias`, `--ngrok-auth-token`/`--ngrok-domain`, `--plans-dir`, `--disable-auth`).

## Architecture

Request flow: browser (`src/public/app.js`) ⇄ WebSocket ⇄ `src/server.js` ⇄ one of three bridges ⇄ node-pty child process running the AI CLI. Terminal bytes flow through untouched in both directions; the server multiplexes many browsers onto shared server-side sessions.

### Server (`src/server.js`)
Single `ClaudeCodeWebServer` class. Owns the Express app (REST under `/api/*`), the `ws` WebSocket server, session lifecycle, folder-mode working-directory selection, auth middleware + rate limiting, and image upload (`/api/upload-image`). Sessions persist via `SessionStore` to `~/.claude-code-web/sessions.json` and auto-save every 30s, so they survive server restarts and are reachable from multiple devices simultaneously.

### Agent bridges — one abstraction, three CLIs
`claude-bridge.js`, `codex-bridge.js`, and `agent-bridge.js` share the same shape: discover the CLI binary across standard paths (falling back to a bare command name on PATH), spawn it under node-pty, and manage start/stop/resize plus an output buffer for reconnect. When adding behavior to one, check whether the other two need the parallel change. The WebSocket `start_claude` / `start_codex` / `start_agent` messages pick which bridge a session uses.

### Usage analytics (`usage-reader.js` + `usage-analytics.js`)
`usage-reader.js` scans Claude transcript JSONL files under `~/.claude/projects/` to compute token/session usage. **This is expensive** — it re-reads many files per scan. The `get_usage` WebSocket message is polled by every connected browser, so `server.js` funnels all callers through a single shared snapshot cache (`_usageSnapshot`, ~15s TTL, with `_usageSnapshotInflight` de-duping concurrent scans) rather than scanning per-client. Preserve this coalescing when touching usage code: naive per-poll full scans pin CPU and leak file descriptors under load.

### Client (`src/public/`, plain ES, no framework)
- `app.js` — main controller: terminal setup, WebSocket, input handling
- `session-manager.js` — session tab UI, notifications, multi-session switching
- `splits.js` — split-pane / multi-terminal layout
- `file-explorer.js` — read-only file/folder explorer (`window.fileExplorer`), opened by the toolbar folder button (replaced the old Settings gear; Settings stays in the hamburger menu)
- Plan mode approval UI — the modal is driven by structured Claude Code hook events (see below), not by scraping terminal output
- `auth.js` — client-side auth
- `service-worker.js` + `manifest.json` — PWA/offline support
- `icons.js` / `icon-generator.js` — runtime-generated app icons

### WebSocket protocol
Session control: `create_session`, `join_session`, `leave_session`, `close_session`, `stop`. CLI launch: `start_claude`, `start_codex`, `start_agent`. I/O: `input`, `resize`, `pause`/`resume` (flow control), `ping`, `get_usage`. Server→client: `output`, `exit`, `error`, `hook_event`, `usage_update`, … See the `switch (data.type)` dispatch in `src/server.js` (~line 746).

### Plan mode via Claude Code hooks
Claude presents a plan by calling the `ExitPlanMode` tool, which fires a `PreToolUse` hook carrying the full plan in `tool_input.plan`. `claude-bridge.js` injects that hook into the spawned CLI via `--settings` (`buildInjectedSettings`), pointing its command at `bin/cc-hook.js`. That relay reads the event JSON on stdin and POSTs it to `POST /api/hooks/:sessionId` (authenticated with a per-session `hookToken`, loopback-only, registered *before* the global auth middleware). The server rebroadcasts it to the session's browsers as a `hook_event`, and `app.js` opens the plan modal. This replaced the old brittle terminal-scraping `plan-detector.js`, which had silently stopped detecting plans on current Claude versions (markdown is rendered to styled ANSI, so the raw `##`/`###` markers no longer appear in the byte stream). The relay is best-effort: any failure exits 0 so a hook never blocks Claude.

## Conventions

- **Style**: 2-space indent, semicolons, single quotes. kebab-case filenames, PascalCase classes, camelCase functions/vars. No linter/formatter configured — match surrounding code and keep diffs minimal.
- **Tests**: Mocha with `node:assert` in `test/*.test.js`. Keep them fast and isolated — mock process spawns, use temp dirs (see `session-store.test.js`), no network or real CLI calls.
- **Commits/releases**: Conventional Commits (`feat:`, `fix:`, `chore(release): vX.Y.Z`). Releases bump the version in `package.json` + `CHANGELOG.md`, tag, and open a PR — see `scripts/release-pr.sh` (`npm run release:pr`) and `.cursor/commands/commit-push.md`.
- **Docs**: `DESIGN.md` (design rationale), `CHANGELOG.md`, `docs/` (analytics + terminal-parity upgrade notes). Update README/docs when flags, routes, or defaults change.

## Key implementation details

- Claude CLI discovery tries multiple paths including `~/.claude/local/claude`; each bridge falls back to a bare command name on PATH.
- Output buffer keeps the last ~1000 lines per session for reconnection replay.
- Terminal is `xterm-256color` with full ANSI + WebGL/canvas rendering addons.
- Folder browser restricts access to the base directory and its subdirectories only (path-traversal guarded); auth is on by default with per-IP rate limiting. REST routes authenticate via the `Authorization` header only (no query token — it would leak into logs/history); the WebSocket still authenticates with a query token because browsers can't set headers on a WS.
- `GET /api/plan` serves a development-plan markdown file so the terminal's plan links (`registerPlanLinks` in `splits.js`) can open it in a new tab. It's the same browser-navigation exception as the WebSocket, so it authenticates with a token in the URL (not a header). Two URL forms hit the same `servePlanFile`:
  - **Path form** (what the client builds): `/api/plan/<token>/<percent-encoded-path>` — the plan path is one segment (slashes as `%2F`) so the URL *ends in `.md`* with no query string. Browser Markdown extensions (Markdown Reader etc.) trigger on URLs ending in `.md`, so this makes them render the plan. `-` is a placeholder token in no-auth mode.
  - **Query form** (backward-compatible): `/api/plan?path=&token=`.

  The response is `Content-Type: text/plain` (not `text/markdown`: Chrome has no native markdown viewer and would *download* `text/markdown` instead of rendering a page the extension can transform). The resolved real path is strictly allow-listed and always realpath'd (so symlinks/`..` can't escape) and capped at 2 MB `.md`. Which directories are allowed depends on config:
  The allow-list is the **union (additive)** of two sets:
  - **Auto roots** (always on): a `.md` under a `.claude/plans/` directory inside the base folder or an active session's working dir — so the current project's plans open automatically as you switch projects.
  - **Configured plan dirs**: any `.md` under an explicitly configured directory (the `.claude/plans/` segment is **not** required — the user opted these in). This lets plans live outside any active session — e.g. a meta-repo's `.claude/plans/`. Seeded from `--plans-dir <paths>` (comma-separated) / env `CCW_PLANS_DIR`, but **editable at runtime** via `GET/POST /api/plan-dirs` (normal header auth; POST validates each entry is a real existing directory, dedupes, and persists to `<dataDir>/plan-dirs.json` — the persisted list wins over the flag seed on the next start). The Settings modal edits this list live (no restart). `POST` only registers directories to the allow-list; reads still go through `servePlanFile`'s realpath check, so no arbitrary-path read is introduced.

  Non-ASCII (e.g. Chinese) plan names use an RFC 5987 `filename*` header — a raw non-latin1 header value throws.
- **File explorer** (`file-explorer.js` + `GET /api/fs/list` / `GET /api/fs/file`). `listDirectory` (`/api/fs/list?path=&hidden=`) returns files *and* folders (folders first, with size) for a read-only Explorer-style browser; normal header auth. It caps the listing at 2000 entries (`truncated: true` when clipped) and stats size only for that capped slice, so a huge directory can't freeze the shared single-threaded server with 10k+ sync stat calls. `serveFile` (`/api/fs/file/:token/:file`) serves a file's bytes so the explorer can open it in a new tab — a browser-nav token exception like `/api/plan`, registered before the global auth middleware, path form so the URL ends in the real extension. Content-Type is picked by extension (`contentTypeForFile`); **`.svg`/`.html` are served as `text/plain`** on purpose — rendered as their real type in a top-level navigation they could run script on this origin and read the token from `sessionStorage`. Files must be a regular file ≤ 10 MB; the realpath is resolved so symlinks are followed to their target. Both plan/file responses go through `sendInlineFile` (nosniff + `Referrer-Policy: no-referrer` so the in-URL token never leaks via Referer + `Cache-Control: no-cache` + RFC 5987 filename). Scope matches the folder browser (`isPathWithinBase` allows any resolvable path — this is a local single-user tool), not a base-subtree jail.

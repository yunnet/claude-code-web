# Changelog

## [Unreleased]

## [4.1.3] - 2026-09-03

### Fixed
- **Creating a session did nothing while the "Start Claude" overlay was up.**
  On a phone: log in, tap `+`, pick a directory — and the screen just sat there
  showing the overlay. Every retry behaved the same, and the server never
  received a single `POST /api/sessions/create`. `#newSessionModal`
  (`.session-modal`) is z-index 2000 and the overlay is 5000, so the Create New
  Session dialog opened *underneath* it: a ghost outline behind a 95%-opaque
  scrim, with every tap landing on `.overlay-content`. Both modals that the
  overlay state can reach are now lifted above it (5004).
  - This was the leftover half of the 4.1.1 fix. That release lifted the two
    paths that *reach* a modal — the tab bar (5001) and the mobile menu (5002),
    plus the folder browser (5003) — but not the modal each path ends in. The
    defect only became reachable once 4.1.1 made the `+` clickable again; before
    that, the overlay swallowed the tab bar and nobody got this far.
  - `.settings-modal` (z-index 1000) was dead the same way: reachable from the
    lifted mobile menu, opening under the overlay. Lifted too.
  - `overlay-stacking.test.js` asserted the stacking contract for the tab bar,
    the mobile menu and the folder browser, and passed the whole time — it never
    named the modals. It does now, for both.

## [4.1.2] - 2026-09-02

Review of 4.1.0-4.1.1. Nine findings, all fixed.

### Fixed
- **One GET could kill the whole server.** `GET /api/git/branches?path=a&path=b`
  ended the process: a repeated query parameter arrives as an Array, `path.resolve`
  throws on it, and `listBranches` was the only `async` handler touching user
  input — Express 4 does not catch a rejected async handler, so it became an
  unhandledRejection and Node 22 exited, taking every live PTY with it. (The
  synchronous `/api/fs/list`, given the same input, answers 500 and lives.) The
  parameter shape is now rejected with a 400, and every async route goes through
  an `asyncRoute` wrapper so a throw ends as a 500. `/api/sessions/persistence`,
  which had the same unguarded shape, is wrapped too.
- **The directory-entry cap silently ate repositories.** 600 plain directories
  ahead of one repo reported `0 repos, truncated 101` — the repo was never
  examined, and 101 counted plain directories that were never candidates. The
  counts are now distinct (`truncated` = repositories dropped, `unexamined` =
  directories never looked at), the cap rose from 500 to 2000 to match
  `listDirectory`'s existing `MAX_ITEMS` (measured 40ms for 2001 entries), and
  the panel now says when a scan was partial instead of looking complete.
- **A slow branch response could repaint over a newer one.** Start a "Check
  changes" on one project, switch tabs, reopen: the fast scan rendered, then the
  slow one landed and drew the old project's branches under the new heading.
  Each load now carries a ticket and only the newest may render.
- **Renaming a tab now persists.** It used to write only into one browser's
  in-memory session map — the tab state in localStorage keeps ids and nothing
  else, so a reload dropped the rename, and it never reached `sessions.json`
  (which has had a `name` field all along) or any other device. New
  `PATCH /api/sessions/:sessionId {name}`, validated and written through.
- **Repeated status scans no longer pile up.** `status=1` forks a git process per
  repository; concurrent requests multiplied that across the shared
  single-threaded server. Scans are now serialised, and a failing scan no longer
  wedges the ones behind it.
- Branch group colours no longer wrap past six, which had handed two different
  branches the same colour — the exact misreading the colouring exists to prevent.
- Removed a dead `checking` field, and documented that `resolveGitDir` follows
  git's `gitdir:` pointer to an absolute path by design.

## [4.1.1] - 2026-09-02

### Fixed
- **The start overlay no longer swallows the whole tab bar.** `#overlay`
  (`.terminal-overlay`) is fixed, covers the full viewport, and sits at
  `z-index: 5000`; the tab bar sat below it. So any time a session was idle and
  the "Start Claude" prompt was up, every tab-bar control was dead: switching
  tabs, double-click rename, new tab, close tab, and all three toolbar buttons.
  `document.elementFromPoint` on the tab name returned `DIV#overlay`. The tab bar
  is app chrome and has nothing to do with what the overlay is gating, so it is
  now lifted above the overlay while the overlay is open.
  - The lift is scoped to `body.overlay-open`. Raising the tab bar
    unconditionally would invert two other stacks — the mobile side menu (3000)
    and the centered folder browser (2000) would fall behind it — so inside the
    scope those two come along above the bar, and outside it the normal stacking
    order is untouched.
  - This also completes a half-finished fix: `#fileExplorerModal` had already
    been lifted to 6000 "so it stays usable before a session is started", but the
    button that opens it was left under the overlay. The drawer was usable and
    unreachable.
- **Renaming a tab no longer throws.** `saveNewName` was bound to both `blur` and
  `keydown`, and replacing the focused input took it out of the DOM, which fired
  `blur`, which ran `replaceWith` again on a node that was no longer there —
  `NotFoundError`, once per rename. It now commits exactly once. Pre-existing;
  the overlay had been blocking the path that reaches it.

## [4.1.0] - 2026-09-02

### Added
- **Branch panel.** A new toolbar button next to the file explorer lists the
  current git branch of every sub-project under the tab's working directory —
  the "one big directory holding a dozen independent repos" layout, where the
  question "did every repo move to the task branch?" comes up constantly and
  the answer used to cost a shell command every time. Repos sharing a branch are
  coloured alike, so the one still sitting on `dev` stands out.
  - Branch names are read straight out of `.git/HEAD`, no `git` process at all:
    11 repos in ~13ms. Worktrees and submodules (whose `.git` is a *file*
    holding `gitdir:`) and detached HEADs are handled.
  - Working-tree state (uncommitted count, ahead/behind) costs a `git` process
    per repo — ~18x more — so it sits behind an explicit **Check changes**
    button and runs with bounded concurrency. Nothing polls on a timer.
  - New read-only endpoint `GET /api/git/branches?path=<dir>[&status=1]`, behind
    the same header auth and the same path policy as `/api/fs/list`.
  - Desktop only, hidden on mobile by the same media query as the file explorer.

## [4.0.0] - 2026-08-31

### Removed (breaking)
- **Codex and cursor-agent support is gone.** 3.20.4 removed their buttons but left
  the whole subsystem wired up and reachable over the WebSocket. `cli-bridge.js`,
  the `start_codex` / `start_agent` messages and their started/stopped events, and
  the `--codex-alias` / `--agent-alias` flags are all removed. This is a
  Claude-only tool now. **Passing `--codex-alias` or `--agent-alias` is now an
  error, not a no-op.**
- **Token-usage analytics removed.** `usage-reader.js` and `usage-analytics.js`
  (~1400 lines) were dead: their only consumer was a display function that
  returned immediately behind ~190 lines of unreachable code. With them go the
  `get_usage` / `usage_update` messages, the per-session usage counters, the
  "Show Token Stats" setting, `docs/ADVANCED_ANALYTICS.md`, and the `--plan` flag
  plus the `CLAUDE_PLAN` / `CLAUDE_COST_LIMIT` / `CLAUDE_SESSION_HOURS` env vars.
  **Passing `--plan` is now an error.** Side benefit: the browser no longer polls
  `get_usage` every 30s, so the server stops re-scanning `~/.claude` transcripts.

### Security
- **The auth token no longer rides a URL that a rendered page can read.** 3.20.5
  started rendering `.html`/`.svg` from the file explorer, but the explorer's URL
  carries the full auth token in its path — so a malicious file could read its own
  `location` and post the token anywhere, and that token grants a PTY on the host.
  Rendering now requires a single-use ticket (`POST /api/fs/ticket`): bound to one
  realpath, 30s TTL, spent on first read. A token URL serves `.html`/`.svg` as
  source, as it did before 3.20.5. Rendered files are additionally sandboxed into
  an opaque origin with `default-src 'none'` and no `allow-popups`; SVG gets no
  `allow-scripts` at all.

### Added
- **Refresh reconciles sessions instead of auto-adopting/creating.** The client now
  persists its tab set (ordered session-ids + active, + dismissed ids) in
  `localStorage['cc-web-tabs']`. On refresh it reconciles against the server: an
  exact match restores the tabs 1:1 (seamless, no prompt, never a stray new
  session); a mismatch (a tab's session is gone, or a session the user hasn't seen
  appeared) opens a picker to choose which sessions to open / delete / start new.
  Dismissed sessions are remembered so they don't re-prompt. Fixes refresh-time
  "new session created / tab shows the wrong content".

### Fixed
- **A failed session-list fetch no longer erases your tabs.** Reconcile treated a
  network error, a 401, or a malformed body as "the server has no sessions" and
  persisted an empty tab set, destroying the tab selection and order for good. It
  now reports the list as unavailable and leaves stored state untouched; a 401
  raises the login prompt like every other request.
- **Start no longer races the session join.** The client sent `join_session` and
  `start_claude` in the same tick, but the server does not serialize its async
  message handler, so the start could overtake the join and come back "No session
  joined". Starts now wait for the join acknowledgement.
- **The start circuit breaker no longer crashes the server on respawn.** The
  phantom-session retry and the resume fallback both call `spawn` from inside a
  PTY event handler, outside the enclosing try — a spawn failure surfaced as an
  uncaughtException. Both are guarded now.
- Session ids are validated as UUIDs before the bridge deletes a transcript or
  recursively removes a `session-env` directory under the user's home.
- Deleting a session from the reconcile picker asked for confirmation twice.
- `Cmd/Ctrl+1` / `Cmd/Ctrl+2` focus the first/second pane by position; after
  swapping panes they used to be backwards. Split state also saves in visual order.
- The file-explorer drawer resizes with pointer events, so it works on touch.

### Changed
- All UI strings are English; the reconcile picker, image-paste toasts and folder
  browser were partly Chinese.

## [3.20.7] - 2026-08-29

### Fixed
- **Stuck sessions self-heal.** A session whose id got registered but empty (an
  interrupted start) used to loop on start/exit or hit the circuit breaker; the
  bridge now clears that empty transcript and retries fresh so the session starts.

## [3.20.6] - 2026-08-29

### Fixed
- **No more start→exit→restart loop on a stuck session.** A session id that can
  neither `--resume` nor be claimed with `--session-id` (a phantom from an
  interrupted start) made Claude exit immediately and the UI kept retrying. A
  server-side circuit breaker now stops after 3 rapid post-start exits and shows a
  clear error (create a new session) instead of looping.

## [3.20.5] - 2026-08-29

### Added
- **Explorer renders HTML/SVG** (sandboxed) instead of showing source, so diagram
  pages open as the rendered page/graphic.

### Fixed
- **Plan links with a `~` path** now resolve (the leading ~ is expanded to home).
- **Split panes match the tab bar order** on entry, so tab labels line up with the
  left/right content.

## [3.20.4] - 2026-08-29

### Changed
- **Swap split panes by reordering tabs** instead of a menu item. Dragging a tab
  now swaps the panes to match the tab order; the redundant 交换左右/交换上下 layout-menu
  item is removed.

## [3.20.3] - 2026-08-28

### Added
- **Swap split panes.** While split, the layout menu offers 交换左右 / 交换上下 to
  swap the two panes' sides. It reorders the DOM nodes (no reconnect) and keeps
  the divider ratio, so content swaps sides while widths stay put.

## [3.20.2] - 2026-08-28

### Added
- **Resizable file explorer.** Drag the left edge of the file drawer to make it
  wider or narrower (clamped 300px..95vw); the chosen width persists.

### Fixed
- **Snappier file rows.** The explorer's rows used `transition: all 0.2s`, so the
  hover highlight faded over 200ms and trailed the cursor, feeling laggy. Now an
  80ms colour-only transition tracks the pointer.

## [3.20.1] - 2026-08-28

### Fixed
- **Clicking a tab while split no longer blanks the panes.** In split mode the
  tab bar routed through the hidden main terminal's `joinSession`; the hidden
  terminal collapses to ~10x5, so joining it resized the shared PTY to 10
  columns and the CLI redrew as garbage. A tab click now routes straight to the
  panes (focus the pane already showing that session, else load it into the
  active pane) and never re-attaches the hidden main terminal.

## [3.20.0] - 2026-08-28

### Added
- **Split-view orientation (left/right + top/bottom).** The split view is now a
  CSS grid whose orientation can be flipped between side-by-side (columns) and
  stacked (rows). A new **Split layout** button in the tab bar opens a
  单屏 / 左右 / 上下 menu; `Ctrl+\` enters a split; drag a tab to the terminal's
  **right** edge for a left/right split or the **bottom** edge for a top/bottom
  split; the divider drags along either axis; the orientation preference persists
  in `localStorage`.

### Fixed
- **Split panes now fill the pane.** The div passed to `terminal.open()` was
  `flex:0 1 auto` and collapsed to the xterm's content height (24 rows), so the
  CLI left the lower half of each pane blank. It now fills the pane height, and
  after any split/resize the pane re-fits and pushes the new `cols/rows` to the
  PTY so the CLI (a full-screen TUI) reflows to fill.
- Entering a split no longer double-attaches the current session (main terminal +
  pane) with two sizes fighting over the PTY resize; closing a split reliably
  rejoins the focused pane's session.
- The Split-layout button icon now matches the other tab-bar action icons in size.

## [3.19.0] - 2026-08-28

### Added
- **Per-session configuration.** Each session (tab) has its own config. Visual settings (font size, theme, Show Token Stats, scroll animation) are stored per session in `localStorage` (a new session inherits the latest default) and applied live when you switch tabs — theme now switches **without a page reload**. Plan directories are per session too (`session.planDirs`, persisted with the session), edited live from Settings via `GET/POST /api/plan-dirs?sessionId=`; the plan link URL carries the session (`/api/plan/<token>/<session>/<path>`) so the allow-list uses that session's working dir + its own plan dirs (plus the global `--plans-dir` base). This supersedes the previous global plan-dirs editing.
- **Plan directories are additive and runtime-editable.** `/api/plan` now serves plans from the union of auto-discovered roots (the current project's `.claude/plans`, always on) **and** configured plan dirs — so a plan link opens whether it's in the project you're working in or an extra directory you registered. The configured list is editable live from Settings (no restart) via `GET/POST /api/plan-dirs` (header auth; POST validates each is a real directory, dedupes, persists to `<dataDir>/plan-dirs.json`; the persisted list wins over the `--plans-dir` seed). Previously `--plans-dir` *replaced* auto-discovery (override), which hid plans from other active projects.
- **Configurable scroll animation.** Settings gains a "Scroll animation" slider (0–200 ms; `0` = instant, no damping) for the desktop terminal, persisted client-side and live-applied to the main terminal and all splits. Mobile stays instant (its touch-momentum handler owns scrolling).
- **File/folder explorer.** The toolbar's Settings gear is replaced by a folder button that opens a read-only, Windows-Explorer-style browser (`file-explorer.js`): navigate folders, and click a file to open it in a new tab. Two endpoints back it — `GET /api/fs/list` (files + folders with sizes; header auth) and `GET /api/fs/file/:token/:file` (serves a file's bytes; browser-nav token exception like `/api/plan`, Content-Type by extension, `.svg`/`.html` served as `text/plain` to avoid same-origin script execution, regular file ≤ 10 MB, realpath-resolved). Settings stays reachable from the hamburger menu.
- **Clickable plan links in the terminal.** Development-plan paths (`…/.claude/plans/*.md`) in terminal output are now clickable and open the markdown in a new browser tab via `GET /api/plan` (e.g. for a browser markdown extension). The endpoint authenticates with a query token (a new-tab navigation can't send a header, like the WebSocket) and strictly allow-lists the resolved real path to a `.md` under a `.claude/plans/` directory inside the base folder or an active session's working dir. Non-ASCII plan filenames use an RFC 5987 `filename*` Content-Disposition.
- **Plan links now render in browser Markdown extensions.** Plan links open at a URL that *ends in `.md`* (`/api/plan/<token>/<encoded-path>` — path as one segment, token in the path, no query string) and the response is served as `text/plain`. Extensions like Markdown Reader trigger on `.md` URLs and can only transform a rendered text page, so the old `/api/plan?path=…&token=…` (URL ended in the token; `text/markdown` got downloaded by Chrome) never activated them. The query form still works for backward compatibility.
- **Configurable plan directory for `/api/plan`.** New `--plans-dir <paths>` flag (comma-separated) and `CCW_PLANS_DIR` env var. When set they *override* the default project `.claude/plans` auto-discovery: only files under the configured directories are served and the `.claude/plans/` path segment is no longer required (so plans can live outside the served project, e.g. in a meta-repo). Path safety is unchanged — realpath containment still blocks `..`/symlink escapes, files must be `.md` ≤ 2 MB, and the query token is still required.

### Fixed
- **Plan links no longer swallow a label prefix.** The `registerPlanLinks` regex began with `[^\s"'`()]*`, so a label glued to the path with no space — e.g. `路径：/…/​.claude/plans/x.md` or `path:/…/plans/x.md` — was captured into the link, making `/api/plan?path=…` a non-existent relative path and 404-ing. The leading segment is now restricted to path-legal ASCII (`[A-Za-z0-9._~/-]`); the tail stays permissive so non-ASCII (Chinese) plan filenames still match.
- **Plan mode approval now works on current Claude versions.** The plan modal was driven by `plan-detector.js`, which scraped terminal output for markers like `## Plan:`/`###`. Current Claude renders plan markdown to styled ANSI, so those markers never appear in the byte stream and the modal silently stopped firing (verified 0/9 markers matched on Claude Code 2.1.218).
- **Plan modal markdown rendering.** The modal's ad-hoc regex mangled fenced code blocks (`` ``` ``) and didn't render `#` headings; plan text was also injected as HTML without escaping. Replaced with `renderPlanMarkdown()` which escapes HTML first, renders fenced code blocks as `<pre><code>` (protected from the inline bold/italic passes), and handles `#`/`##`/`###` headings, inline code, bold, and italics.
- **Rejecting a plan no longer approves it.** The modal sent `y\n`/`n\n`, but current Claude presents plan approval as a menu (❯1. Yes … / 2 / 3) where neither key does anything and the trailing newline selected the default "Yes" — so *both* Accept and Reject approved the plan. Accept now sends Enter (`\r`); Reject sends Escape (`\x1b`), which backs out and stays in plan mode.
- **Test run no longer hangs.** The server constructor registered a `beforeExit` listener that did async I/O and re-armed the event loop forever (plus leaked SIGINT/SIGTERM/beforeExit listeners per instance). Added `ClaudeCodeWebServer.dispose()` to release the auto-save timer and those listeners; tests call it in `afterEach`, and `npm test` now runs with `--exit` as a backstop.

### Security
- **Auth token is no longer accepted in the query string for REST routes.** It leaked into access logs, browser history, and the Referer header. All browser API calls already send the `Authorization` header; the WebSocket keeps its query token (browsers can't set headers on a WS). A `?token=…` in the page URL is now adopted into `sessionStorage` and immediately stripped via `history.replaceState`.
- **Hook relay token moved from argv to the environment.** `bin/cc-hook.js` reads `CCWEB_HOOK_TOKEN` instead of a `--token` flag, so the secret is no longer exposed through world-readable `/proc/<pid>/cmdline`.

### Changed
- Plan detection now uses Claude Code's native hooks. `claude-bridge.js` injects a `PreToolUse(ExitPlanMode)` hook via `--settings`; `bin/cc-hook.js` relays the event (with the full `tool_input.plan`) to the new `POST /api/hooks/:sessionId` endpoint, which broadcasts it to the browser as a `hook_event`. The endpoint authenticates with a per-session token and only accepts loopback callers.

### Removed
- `src/public/plan-detector.js` (185 lines of terminal-scraping regex) and its `index.html` / `service-worker.js` references.

## [3.4.0] - 2025-10-23

### Added
- **VS Code-Style Split View**: New working split view system that actually works!
  - Drag any tab to the right edge of the terminal to create a side-by-side split
  - Each split has its own independent terminal instance and WebSocket connection
  - Resizable divider between splits (drag to adjust width)
  - Keyboard shortcuts: `Ctrl+1`/`Ctrl+2` to focus splits, `Ctrl+\` to close split
  - Close button (X) in top-right of right split
  - Automatic session switching per split
  - Clean state management with localStorage persistence

### Removed
- **Broken panes.js system** (1018 lines of buggy code)
  - Removed complex grid-based tiling that had fundamental design flaws
  - Removed all pane manager code from app.js and session-manager.js
  - Removed tile HTML and CSS (~200 lines)
  - Removed "Add Pane" button from tab bar

### Fixed
- Sessions no longer get lost during split operations
- Panels can now be closed reliably
- Drag and drop now works correctly
- No more orphaned terminal instances
- No more WebSocket connection leaks
- Proper cleanup when closing splits

### Changed
- Simplified from complex N×M grid to simple 2-pane horizontal split
- Each split maintains its own terminal and connection (true independence)
- Split view is opt-in: create by dragging tabs, not auto-enabled
- Cleaner codebase: 400 lines of working code vs 1000+ lines of broken code

### Notes
- This is a complete rewrite of the split/pane system
- Much more reliable and matches VS Code behavior exactly
- All existing functionality (tabs, sessions, single-pane mode) unchanged
- Test suite: 12/12 passing

## [3.3.0] - 2025-10-23

### Fixed
- **Critical**: Fixed syntax error in `server.js` close() method causing improper indentation in agent session cleanup
- **Critical**: Fixed memory leaks in all three bridge files (claude-bridge.js, codex-bridge.js, agent-bridge.js) by properly tracking and clearing kill timeouts
- Fixed race condition in `session-store.js` where atomic rename could fail if directory was deleted between write and rename operations
- Fixed duplicate signal handlers in `server.js` that could cause double-shutdown attempts
- Removed call to undefined method `clearProcessedEntriesCache()` in `usage-reader.js`
- Removed unused `sessionCache` Map variable from `usage-reader.js`
- Added missing test coverage for agent alias in server alias tests
- Fixed test cleanup warnings by ensuring storage directory exists before save operations

### Changed
- Removed token usage top bar from UI - no longer displays real-time token statistics in the header
- Updated `applySettings()` to reflect removal of token stats visibility toggle
- Disabled `updateUsageDisplay()` and `startSessionTimerUpdate()` functions as UI elements no longer exist

### Notes
- All bug fixes are backward-compatible
- Usage statistics backend code still runs but is no longer displayed in the UI
- Test suite passing: 12/12 tests

## [3.2.2] - 2025-10-23

### Fixed
- Fixed loading spinner overlay remaining visible when showing folder browser
- Added proper overlay hiding before showing folder browser in all locations
- Resolves issue where users couldn't interact with folder browser due to stuck spinner

## [3.2.1] - 2025-10-23

### Fixed
- Corrected agent command from `claude-agent` to `cursor-agent` in AgentBridge
- Updated command search paths to use `~/.cursor/` instead of `~/.agent/`

## [3.2.0] - 2025-10-23

### Added
- Cursor Agent (`cursor-agent`) support as a third CLI option alongside Claude and Codex
- New CLI flag: `--agent-alias <name>` to customize the display name for Cursor Agent (default: "Cursor")
- New environment variable: `AGENT_ALIAS` for setting the agent alias
- "Start Cursor" button in assistant selection UI (main overlay and per-pane overlays)
- Full WebSocket message handling for `start_agent`, `agent_started`, and `agent_stopped` events
- Agent session management in `AgentBridge` with automatic command detection

### Changed
- Updated startup logs to display all three assistant aliases (Claude, Codex, Agent)
- Enhanced `/api/config` endpoint to include agent alias
- Extended session management to support three concurrent agent types per session

### Notes
- Backwards-compatible feature addition; existing Claude and Codex functionality unchanged
- Agent bridge searches for `cursor-agent` in standard paths (~/.cursor/local/cursor-agent, ~/.local/bin/cursor-agent, etc.)
- No special CLI flags required for agent (unlike Claude's `--dangerously-skip-permissions` or Codex's bypass flag)

## [3.1.0] - 2025-09-15

### Added
- Middle-click tab closing, inline rename styling, and automatic scroll-into-view for the active session tab to mirror VS Code ergonomics.

### Changed
- Session tabs now maintain explicit order and MRU history, improving Ctrl/Cmd+Tab navigation, drag reordering, and pane targeting parity with VS Code.
- Mobile overflow counters and menus refresh automatically on resize or drag, keeping hidden sessions reachable across devices.

### Fixed
- Tabs now disappear immediately when the backend deletes a session, preventing stale entries and redundant DELETE calls.

## [3.0.3] - 2025-09-14

### Fixed
- Single-pane and no-session states now use the full viewport width. Moved the global overlay out of the terminal container and made it `position: fixed` to prevent it from reserving layout space; ensured `.tile-grid` flexes to fill available width. This resolves the issue where, with zero tabs or a single pane, the pane did not span the full width.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.0] - 2025-09-13

### Added
- Tiled View (MVP): view two sessions side‑by‑side with independent terminals and sockets.
- Resizable splitter between panes with persistent split position.
- Per‑pane session picker and close controls; layout and assignments persist in localStorage.

### Changed
- Settings font size now applies to all visible panes in tiled view.

### Notes
- Client‑side only; no server/CLI changes required. Default remains single‑pane; toggle via new tile button in the top bar.

## [2.9.0] - 2025-09-13

### Added
- Theme toggle in Settings with persistence (Dark/Light).
- Early theme application to avoid flash of incorrect theme on load.

### Changed
- Default theme set to Dark; Light can be selected in Settings.

### Notes
- UI-only change; no server/CLI APIs modified.

## [2.8.0] - 2025-09-13

### Added
- Inline SVG icon system across the UI to replace emojis for a premium, minimalist look.
- New icon helper at `src/public/icons.js` for consistent, dependency‑free icons.
- Subtle status indicators using CSS dots (active/idle/error) in place of emoji glyphs.

### Changed
- Refined visual design: cohesive light palette by default, improved spacing and rhythm, and cleaner typography (Inter for UI, JetBrains Mono for terminal/stats).
- Usage rate display now uses an icon + text rather than emoji; improved readability on mobile/desktop.
- Plan modal header and action buttons now include icons; tooltips and labels simplified.
- Notifications and headings no longer use emojis; copy updated for a professional tone.
- Auth prompt UI aligned with the new palette and iconography.

### Fixed
- Prevented potential null‑element errors in plan mode indicator updates.

### Notes
- No API or CLI changes. Dark theme variables remain; switch by removing `data-theme="light"` or adding a toggle.

## [2.5.0] - 2025-08-22

### Added
- ngrok tunnel integration with `--ngrok-auth-token` and `--ngrok-domain` CLI options
- Public tunnel support for remote access to Claude Code Web interface
- Enhanced shutdown handling to properly close ngrok tunnels
- Input validation to ensure both ngrok flags are provided together

### Changed
- Improved auto-open behavior to use ngrok public URL when tunnel is active
- Enhanced error handling for ngrok tunnel establishment

### Dependencies
- Added `@ngrok/ngrok` package for tunnel functionality

## [2.4.0] - 2025-08-22

### Added
- Custom command modal for multi-line message input via "Custom..." option in commands dropdown
- Keyboard shortcut (Ctrl/Cmd + Enter) to run custom commands from the modal
- Enhanced commands dropdown interface with better user experience

### Changed
- Commands menu button repositioned from floating to anchored within terminal container
- Improved commands menu positioning and z-index handling for better integration

## [2.3.0] - 2025-08-22

### Added
- Commands menu with floating "/" button in top-right corner
- Commands API for listing and serving markdown files from ~/.claude-code-web/commands directory
- Interactive dropdown interface for browsing and executing commands
- Support for nested command directories with automatic label generation
- Command content execution directly to active Claude/Codex session

### Changed
- Enhanced user interface with new commands functionality
- Improved accessibility with dedicated commands directory structure

## [2.2.2] - 2025-08-20

### Changed
- Updated Claude Code CLI flag from `--dangerously-skip-permissions` to `--dangerously-bypass-approvals-and-sandbox`
- Updated UI text and tooltips to reflect new flag name
- Updated loading messages to match new CLI flag terminology

## [2.2.1] - 2025-08-20

### Changed
- Improved start button layout and responsive design
- Simplified button styling for better mobile experience
- Increased dialog max-width from 400px to 520px for better button layout

### Fixed
- Mobile responsiveness issues with assistant selection buttons

## [2.2.0] - 2025-08-20

### Added
- Basic test infrastructure with Mocha and unit tests

### Fixed
- Command injection vulnerability in commandExists method
- Documentation discrepancy - added missing auth.js file to README structure

### Security
- Fixed command injection vulnerability that could potentially allow malicious command execution

## [2.5.1] - 2025-08-22

### Added
- CONTRIBUTING guide with setup, testing, and PR workflow
- MIT LICENSE file

### Changed
- Enhanced README with requirements, local dev/testing instructions, and links to CONTRIBUTING and LICENSE

## [2.5.2] - 2025-08-22

### Added
- GitHub Pages single-page marketing site under `/docs` (hero, features, quick start, security, FAQ)

### Notes
- No runtime or API changes; documentation/website only

## [2.5.3] - 2025-08-22

### Changed
- Docs site: replaced HTTPS guidance with accurate ngrok options

### Fixed
- Docs site: improved mobile responsiveness and removed horizontal scrolling

## [2.1.3] - Previous Release
- Previous version baseline
## [2.6.1] - 2025-08-29

### Added
- Assistant alias support across CLI, server, and UI.
  - New CLI flags: `--claude-alias <name>` and `--codex-alias <name>`.
  - New env vars: `CLAUDE_ALIAS`, `CODEX_ALIAS`.
  - `/api/config` now returns `aliases` for the frontend.
- UI now displays configured aliases in buttons, prompts, and messages.
- Tests: added `test/server-alias.test.js` to validate server alias configuration.

### Changed
- Startup logs show configured aliases.
- README updated with alias usage examples.
## [2.11.0] - 2025-09-13

### Added
- Up to 4 panes in Tiled View with an “Add Pane” control.
- Drag a tab onto any pane to attach that session to the pane.

### Changed
- Tiled layout now distributes widths dynamically across multiple panes; resizers adjust neighboring pane widths.

### Notes
- Client-side only; no server/CLI changes. Defaults to single‑pane; toggle and expand via the top‑bar grid/plus controls.
## [2.12.0] - 2025-09-13

### Added
- Per‑split tab bars (VS Code–style): each pane now has its own tab strip.
- Add tab per split (+ button) and attach existing sessions to a split by clicking global tabs while a pane is focused.
- Drag a global tab into a split to add/activate that session in the target pane.

### Changed
- Tiled view routing: in tiled mode, global tab clicks target the focused split; single‑pane behavior unchanged when tiles are off.

### Notes
- Client‑side feature; no API/CLI changes. State (pane tabs, active tab, widths) persists locally.

## [2.13.0] - 2025-09-13

### Added
- Close Pane control: remove a split entirely (sockets cleaned up, layout reflows); clears when only one pane remains.

### Changed
- Removed focused‑pane border highlight for a cleaner look.
- In tiled mode, the global top tab bar is hidden; manage tabs per split only.
- Pane removal re-normalizes widths and rebuilds grid for consistent resizing; state persists.

### Notes
- UI‑only changes; no server/CLI surface changes.
## [2.14.0] - 2025-09-13

### Changed
- Always-on multi‑pane mode: the tiled view is now the default and only mode.
- Global top tab bar is hidden in multi‑pane; manage tabs per split.
- Removed tile view toggle button.

### Fixed
- Pane “+” button now opens a reliable session picker menu and works in every pane.

### Notes
- UI/UX change only; no server/CLI API changes.
## [2.15.0] - 2025-09-13

### Added
- Drag a pane tab to the grid’s right edge to create a new split and move the tab (VS Code‑like “drag to split”).

### Changed
- Pane tab items are now draggable between splits; dropping on another split moves the tab there.
- Pane Add Tab button opens a session picker menu consistently across panes.

### Notes
- UI‑only; no server/CLI changes.
## [2.15.1] - 2025-09-13

### Fixed
- Start‑prompt (Claude/Codex) overlay now appears in multi‑pane mode: terminal container is kept available for overlays even when panes are active.
## [2.16.0] - 2025-09-13

### Added
- Per‑pane start prompt overlay: when a session is attached to a pane and hasn’t produced output yet, the pane shows a local dialog to pick the assistant (Claude/Codex), including dangerous variants.

### Changed
- Overlays no longer rely on the single‑pane terminal; the per‑pane overlay sits within each split.

### Notes
- UI‑only; no server/CLI changes.
## [2.17.0] - 2025-09-13

### Changed
- Closing a pane tab now fully closes the session (server DELETE), removes it from all panes, and cleans up sockets/terminals.
- Pane “+” button opens the folder picker directly to create a new session; session dropdown removed.
- Session deletion events now remove the session from all pane tab strips automatically.

### Notes
- UI/behavior change only; no server/CLI API changes.

## [2.18.0] - 2025-09-13

### Added
- Tab context menus for both global tabs and per‑pane tabs:
  - Close Others
  - Split Right
  - Move to Split (choose destination split)
- Drag‑to‑split in all directions (left/right/top/bottom) with visual drop hints.
- Ctrl/Cmd‑drag to copy a tab to another split; default drag moves the tab.

### Changed
- Vertical splits supported (up to 2 rows) with a horizontal resizer; sizes persist.
- Edge‑of‑grid drops create splits on that edge; drag cursor reflects copy vs move.
- Layout persistence now includes rows, cols, and heights in `cc-web-tiles`.

### Notes
- UI‑only features; no server/CLI API changes.

## [3.0.0] - 2025-09-13

### Removed
- Custom prompts dropdown UI ("/" button, commands list, and "Custom…" modal).
- Server endpoints `GET /api/commands/list` and `GET /api/commands/content`.

### Breaking Changes
- The commands dropdown system and its APIs are no longer available. Any external automation calling `/api/commands/*` must be migrated to send content directly to the active session via WebSocket input.

### Migration Notes
- To send predefined prompts, store them in your own UI or scripts and paste/send directly to the terminal. The app will forward input to the active session as before.

## [3.0.1] - 2025-09-13

### Fixed
- Remove an empty left column gap in tiled mode by hiding the single-pane container when tiles are enabled.
- Restore per-pane assistant chooser overlay by not treating 'idle' sessions as already running.

## [3.0.2] - 2025-09-13

### Fixed
- Stabilize tiled splitting: correct index math and use insertion helpers for columns/rows.
- Reattach active sessions to terminals after grid rebuilds so sessions no longer appear to vanish.
- Honor copy vs move when dragging tabs between splits and avoid removing from the wrong source pane.
- Improve edge-of-grid splits to consistently place the tab into the intended new split.
## [3.0.4] - 2025-09-14

### Fixed
- Restore VS Code-style tab workflow: global tabs are visible in both single and tiled modes; selecting a tab targets the active pane.
- Make tiled panes optional again (no auto-enable on load); preserve pane layout and assignments across refresh via localStorage.
- Pane “+” opens a reliable session picker (Shift+click opens folder browser to create a new one).
- When attaching an existing session to a split, replay recent output buffer so tabs don’t look like “new” empty sessions.
- Remove CSS that hid tabs in tiled mode; panes fill width without interfering with the tab bar.

# Changelog

## [Unreleased]

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

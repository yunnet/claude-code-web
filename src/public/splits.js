/**
 * SplitContainer - Simple VS Code-style split view
 * Manages up to 2 terminal panes side-by-side with independent terminals
 */

// xterm terminal theme, chosen from the active app theme (`data-theme`), which
// is set synchronously in <head> before this script runs. The terminal renders
// its own background via this JS theme (not CSS), so without this the terminal
// stayed dark in light mode. The light palette is tuned to read on white
// (GitHub-Light-style ANSI colors); the dark palette matches the previous one.
function getTerminalTheme() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
        // GitHub-Light-style palette: solid white bg with dark, high-contrast
        // ANSI colors that read on white. (A transparent bg renders opaque dark
        // under the canvas renderer, so light mode must set a solid background.)
        return {
            background: '#ffffff',
            foreground: '#1f2328',
            cursor: '#0969da',
            cursorAccent: '#ffffff',
            selectionBackground: 'rgba(9, 105, 218, 0.20)',
            selectionForeground: '#ffffff',
            black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700',
            blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
            brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
            brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f'
        };
    }
    // Dark palette — identical to the original main-terminal theme (solid bg).
    return {
        background: '#0d1117',
        foreground: '#f0f6fc',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88, 166, 255, 0.35)',
        selectionForeground: '#0d1117',
        black: '#484f58', red: '#ff7b72', green: '#7ee787', yellow: '#ffa657',
        blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#a5f3fc', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#ffdf5d',
        brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#a5f3fc', brightWhite: '#f0f6fc'
    };
}

// Make development-plan paths (…/.claude/plans/*.md) in terminal output clickable.
// Clicking opens the plan markdown in a new browser tab via GET /api/plan, so the
// user can review it (e.g. with a browser markdown extension). Shared by the main
// terminal (app.js) and split terminals. Read-only: it inspects buffer text to
// place links and never writes to the PTY stream.
function registerPlanLinks(term, getSessionId) {
    if (!term || typeof term.registerLinkProvider !== 'function') return;
    // Paths containing `.claude/plans/` and ending in `.md` (relative or absolute).
    // The leading segment is restricted to path-legal ASCII so a label glued to
    // the path (e.g. `路径：/…/plans/x.md` or `path:/…/plans/x.md`) doesn't get
    // swallowed into the match; the tail stays permissive so non-ASCII (Chinese)
    // plan filenames still match.
    const RE = /[A-Za-z0-9._~/-]*\.claude\/plans\/[^\s"'`()]+\.md/g;
    term.registerLinkProvider({
        provideLinks(lineNumber, callback) {
            const line = term.buffer.active.getLine(lineNumber - 1);
            if (!line) { callback(undefined); return; }
            const text = line.translateToString(true);
            const links = [];
            let m;
            RE.lastIndex = 0;
            while ((m = RE.exec(text)) !== null) {
                const matched = m[0];
                const startX = m.index + 1; // xterm columns are 1-based
                links.push({
                    range: {
                        start: { x: startX, y: lineNumber },
                        end: { x: startX + matched.length - 1, y: lineNumber }
                    },
                    text: matched,
                    activate() {
                        try {
                            const sid = (typeof getSessionId === 'function') ? getSessionId() : null;
                            const url = (window.authManager && window.authManager.getPlanUrl)
                                ? window.authManager.getPlanUrl(matched, sid)
                                : `/api/plan/-/${sid ? encodeURIComponent(sid) : '-'}/${encodeURIComponent(matched)}`;
                            window.open(url, '_blank', 'noopener');
                        } catch (_) { /* ignore */ }
                    }
                });
            }
            callback(links.length ? links : undefined);
        }
    });
}

class Split {
    constructor(container, index, app) {
        this.container = container;
        this.index = index;
        this.app = app;
        this.sessionId = null;
        this.isActive = false;
        
        // Create independent terminal instance for this split
        this.terminal = null;
        this.fitAddon = null;
        this.webLinksAddon = null;
        this.socket = null;
        
        this.createTerminal();
    }

    createTerminal() {
        // Create terminal wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'split-terminal-wrapper';
        
        const terminalDiv = document.createElement('div');
        terminalDiv.id = `split-terminal-${this.index}`;
        wrapper.appendChild(terminalDiv);
        
        this.container.appendChild(wrapper);
        
        // Initialize xterm.js terminal
        this.terminal = new Terminal({
            fontFamily: this.app?.terminal?.options?.fontFamily || 'JetBrains Mono, monospace',
            fontSize: this.app?.terminal?.options?.fontSize || 14,
            cursorBlink: true,
            convertEol: true,
            allowProposedApi: true,
            // Match the main terminal: Option/Alt as Meta for Claude Code shortcuts.
            macOptionIsMeta: true,
            // Match the main terminal's scrollback (default is only 1000).
            scrollback: 10000,
            // Match the main terminal's scroll feel (user-configurable via
            // Settings; instant on mobile). Falls back to 100 if unavailable.
            smoothScrollDuration: (this.app && this.app.isMobile)
                ? 0
                : (this.app?.loadSettings?.().smoothScrollDuration ?? 100),
            fastScrollModifier: 'shift',
            fastScrollSensitivity: 5,
            theme: this.app?.terminal?.options?.theme || getTerminalTheme()
        });
        
        this.fitAddon = new FitAddon.FitAddon();
        this.webLinksAddon = new WebLinksAddon.WebLinksAddon();
        
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.webLinksAddon);

        // Unicode v11 widths so emoji / box-drawing align (matches main terminal).
        try {
            if (window.Unicode11Addon) {
                this.terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
                this.terminal.unicode.activeVersion = '11';
            }
        } catch (e) {
            console.warn('Unicode11 addon unavailable (split):', e);
        }

        this.terminal.open(terminalDiv);

        // Make plan-file paths in output clickable (open the .md in a new tab).
        registerPlanLinks(this.terminal, () => this.sessionId);

        // Canvas renderer (match main terminal), with DOM fallback.
        try {
            if (window.CanvasAddon) {
                this.terminal.loadAddon(new CanvasAddon.CanvasAddon());
            }
        } catch (e) {
            console.warn('Canvas renderer unavailable (split), using DOM:', e);
        }

        // Copy selection with Ctrl/Cmd+C (falls through to SIGINT when nothing
        // is selected). Reuses the app's clipboard helper, with a local fallback.
        this.terminal.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;

            // Shift+Enter / Option(Alt)+Enter → newline (not submit). See app.js
            // for the full rationale: xterm can't distinguish these from Enter, so
            // we send LF (\n == Ctrl+J), which Claude Code treats as a newline.
            if (e.key === 'Enter' && (e.shiftKey || e.altKey) && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'input', data: '\n' }));
                }
                return false;
            }

            const key = (e.key || '').toLowerCase();
            if (key === 'c' && (e.ctrlKey || e.metaKey)) {
                const selection = this.terminal.getSelection();
                if (selection) {
                    if (this.app && typeof this.app.copyToClipboard === 'function') {
                        this.app.copyToClipboard(selection);
                    } else if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(selection).catch(() => {});
                    }
                    this.terminal.clearSelection();
                    return false;
                }
            }
            return true;
        });

        // OSC 52 clipboard writes from programs in the terminal (e.g. Claude Code).
        this.terminal.parser.registerOscHandler(52, (payload) => {
            if (this.app && typeof this.app.handleOsc52 === 'function') {
                return this.app.handleOsc52(payload);
            }
            return true;
        });

        // Setup terminal input handler
        this.terminal.onData((data) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'input', data }));
            }
        });
        
        // Setup resize handler
        this.terminal.onResize(({ cols, rows }) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        });
        
        this.fit();
    }

    async setSession(sessionId) {
        if (this.sessionId === sessionId) return;
        
        // Disconnect from old session
        if (this.socket) {
            this.disconnect();
        }
        
        this.sessionId = sessionId;
        
        // Connect to new session
        if (sessionId) {
            await this.connect(sessionId);
        }
        
        // Update active state
        this.updateActiveState();
    }

    async connect(sessionId) {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${location.host}?sessionId=${encodeURIComponent(sessionId)}`;
        
        // Add auth token if needed
        if (window.authManager) {
            wsUrl = window.authManager.getWebSocketUrl(wsUrl);
        }
        
        this.socket = new WebSocket(wsUrl);
        
        this.socket.onopen = () => {
            console.log(`[Split ${this.index}] Connected to session ${sessionId}`);
            // Send initial resize
            const { cols, rows } = this.terminal;
            this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
        };
        
        this.socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.handleMessage(msg);
            } catch (error) {
                console.error(`[Split ${this.index}] Error handling message:`, error);
            }
        };
        
        this.socket.onclose = () => {
            console.log(`[Split ${this.index}] Disconnected from session ${sessionId}`);
        };
        
        this.socket.onerror = (error) => {
            console.error(`[Split ${this.index}] WebSocket error:`, error);
        };
    }

    handleMessage(msg) {
        switch (msg.type) {
            case 'output':
                this.terminal.write(msg.data);
                break;
                
            case 'session_joined':
                // Replay output buffer
                if (msg.outputBuffer && msg.outputBuffer.length > 0) {
                    const joined = msg.outputBuffer.join('');
                    this.terminal.write(joined);
                }
                break;
                
            case 'claude_started':
            case 'codex_started':
            case 'agent_started':
                console.log(`[Split ${this.index}] Agent started`);
                break;
                
            case 'exit':
                this.terminal.write('\r\n[Process exited]\r\n');
                break;
                
            case 'error':
                this.terminal.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
                break;
        }
    }

    disconnect() {
        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) {
                // Ignore errors
            }
            this.socket = null;
        }
    }

    fit() {
        try {
            if (this.fitAddon) {
                this.fitAddon.fit();
            }
        } catch (error) {
            // Ignore fit errors
        }
    }

    // Fit to the current cell size AND push the new dimensions to the PTY, so the
    // CLI (a full-screen TUI) reflows to fill the pane after a split/resize. fit()
    // alone only resizes the local xterm; without this the PTY keeps its old size
    // (often the default 80x24 from being opened while the pane was hidden) and the
    // CLI never redraws to the pane width.
    syncSize() {
        this.fit();
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const { cols, rows } = this.terminal;
            this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
    }

    updateActiveState() {
        if (this.container) {
            if (this.isActive) {
                this.container.classList.add('split-active');
            } else {
                this.container.classList.remove('split-active');
            }
        }
    }

    clear() {
        this.disconnect();
        this.sessionId = null;
        this.isActive = false;
        if (this.terminal) {
            this.terminal.clear();
        }
        this.updateActiveState();
    }

    destroy() {
        this.disconnect();
        if (this.terminal) {
            this.terminal.dispose();
        }
    }
}

class SplitContainer {
    constructor(app) {
        this.app = app;
        this.enabled = false;
        this.splits = [];
        this.activeSplitIndex = 0;
        this.dividerPosition = 50; // percentage (shared by both orientations)
        this.orientation = 'horizontal'; // 'horizontal' = left/right, 'vertical' = top/bottom
        
        // Create split container elements
        this.createSplitElements();
        
        // Restore state from localStorage
        this.restoreState();
        
        // Setup keyboard shortcuts
        this.setupKeyboardShortcuts();
    }

    createSplitElements() {
        const main = document.querySelector('.main');
        if (!main) return;

        // Create split container (initially hidden)
        this.splitContainerEl = document.createElement('div');
        this.splitContainerEl.className = 'split-container';
        this.splitContainerEl.style.display = 'none';

        // Create left split
        const leftSplit = document.createElement('div');
        leftSplit.className = 'split-pane split-left';
        leftSplit.dataset.splitIndex = '0';

        // Create divider
        this.divider = document.createElement('div');
        this.divider.className = 'split-divider';
        this.setupDividerDrag();

        // Create right split
        const rightSplit = document.createElement('div');
        rightSplit.className = 'split-pane split-right';
        rightSplit.dataset.splitIndex = '1';

        // Add close button to right split
        const closeBtn = document.createElement('button');
        closeBtn.className = 'split-close';
        closeBtn.title = 'Close Split (Ctrl+\\)';
        closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>`;
        closeBtn.addEventListener('click', () => this.closeSplit());
        rightSplit.appendChild(closeBtn);

        this.splitContainerEl.appendChild(leftSplit);
        this.splitContainerEl.appendChild(this.divider);
        this.splitContainerEl.appendChild(rightSplit);

        main.appendChild(this.splitContainerEl);

        // Apply the initial grid layout (columns vs rows) for the current orientation
        this.applyLayout();

        // Create Split instances with their own terminals
        this.splits.push(new Split(leftSplit, 0, this.app));
        this.splits.push(new Split(rightSplit, 1, this.app));
        
        // Mark left as active by default
        this.splits[0].isActive = true;
        this.splits[0].updateActiveState();

        // Click handlers to focus splits
        leftSplit.addEventListener('click', () => this.focusSplit(0));
        rightSplit.addEventListener('click', () => this.focusSplit(1));
    }

    setupDividerDrag() {
        let isDragging = false;
        let startCoord = 0;
        let startPosition = 50;

        this.divider.addEventListener('mousedown', (e) => {
            isDragging = true;
            const vertical = this.orientation === 'vertical';
            startCoord = vertical ? e.clientY : e.clientX;
            startPosition = this.dividerPosition;
            document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const vertical = this.orientation === 'vertical';
            const container = this.splitContainerEl.getBoundingClientRect();
            const delta = vertical ? (e.clientY - startCoord) : (e.clientX - startCoord);
            const extent = vertical ? container.height : container.width;
            const deltaPercent = (delta / extent) * 100;

            this.dividerPosition = Math.max(20, Math.min(80, startPosition + deltaPercent));
            this.updateDividerPosition();
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = '';
                this.saveState();
            }
        });
    }

    applyLayout() {
        if (!this.splitContainerEl) return;
        const a = this.dividerPosition;
        const b = 100 - this.dividerPosition;
        const paneTracks = `minmax(0, ${a}fr) 6px minmax(0, ${b}fr)`;
        if (this.orientation === 'vertical') {
            this.splitContainerEl.classList.add('vertical');
            this.splitContainerEl.style.gridTemplateColumns = 'minmax(0, 1fr)';
            this.splitContainerEl.style.gridTemplateRows = paneTracks;
        } else {
            this.splitContainerEl.classList.remove('vertical');
            this.splitContainerEl.style.gridTemplateRows = 'minmax(0, 1fr)';
            this.splitContainerEl.style.gridTemplateColumns = paneTracks;
        }
    }

    // Re-fit + resize each pane's PTY after the grid layout and renderer settle.
    scheduleRefit() {
        const run = () => this.splits.forEach(s => s.syncSize());
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(run));
        } else {
            setTimeout(run, 50);
        }
    }

    updateDividerPosition() {
        this.applyLayout();
        this.scheduleRefit();
    }

    setOrientation(orientation) {
        if (orientation !== 'horizontal' && orientation !== 'vertical') return;
        if (this.orientation === orientation) return;
        this.orientation = orientation;
        this.applyLayout();
        this.scheduleRefit();
        this.saveState();
    }

    async applyPreset(orientation) {
        if (this.enabled) {
            this.setOrientation(orientation);
            return;
        }
        let second = null;
        const stm = this.app && this.app.sessionTabManager;
        if (stm && typeof stm.getOrderedTabIds === 'function') {
            const ids = stm.getOrderedTabIds();
            second = ids.find(id => id !== this.app.currentClaudeSessionId) || null;
        }
        await this.createSplit(second, orientation);
    }

    openLayoutMenu(anchorEl) {
        document.querySelectorAll('.pane-session-menu').forEach(m => m.remove());
        const menu = document.createElement('div');
        menu.className = 'pane-session-menu';
        const addItem = (label, fn, active) => {
            const el = document.createElement('div');
            el.className = 'pane-session-item' + (active ? ' used' : '');
            el.textContent = (active ? '\u2713 ' : '') + label;
            el.onclick = () => { try { fn(); } finally { menu.remove(); } };
            menu.appendChild(el);
        };
        addItem('\u5355\u5c4f', () => this.closeSplit(), !this.enabled);
        addItem('\u5de6\u53f3\u5206\u5c4f', () => this.applyPreset('horizontal'), this.enabled && this.orientation === 'horizontal');
        addItem('\u4e0a\u4e0b\u5206\u5c4f', () => this.applyPreset('vertical'), this.enabled && this.orientation === 'vertical');
        document.body.appendChild(menu);
        const rect = anchorEl ? anchorEl.getBoundingClientRect() : { bottom: 60, left: 60 };
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${Math.max(8, rect.left - 80)}px`;
        const close = (ev) => {
            if (!menu.contains(ev.target) && ev.target !== anchorEl) {
                menu.remove();
                document.removeEventListener('mousedown', close, true);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    }

    // Swap the two panes' sides (left<->right, or top<->bottom) by reordering
    // their DOM nodes. The terminals + sockets move with their elements (no
    // reconnect), the divider position is preserved, and the splits array /
    // click handlers stay index-correct because they map by element, not side.
    swapPanes() {
        if (!this.enabled || !this.splitContainerEl) return;
        const panes = [...this.splitContainerEl.querySelectorAll('.split-pane')];
        if (panes.length < 2) return;
        const [first, second] = panes;
        // Reorder to [second, divider, first].
        this.splitContainerEl.insertBefore(second, first);
        this.splitContainerEl.insertBefore(this.divider, first);
        this.applyLayout();
        this.scheduleRefit();
        this.saveState();
    }

    // Make the panes' left/right (or top/bottom) order follow the tab bar order.
    // Called after the user drags a tab to reorder it: if the two paned sessions'
    // relative order in the tab bar flipped, swap the panes to match.
    syncPaneOrderToTabs(tabOrder) {
        if (!this.enabled || !Array.isArray(tabOrder) || !this.splitContainerEl) return;
        const paneEls = [...this.splitContainerEl.querySelectorAll('.split-pane')];
        const paneSessions = paneEls.map(el => {
            const sp = this.splits.find(s => s.container === el);
            return sp ? sp.sessionId : null;
        });
        if (paneSessions.length < 2 || !paneSessions[0] || !paneSessions[1]) return;
        const iFirst = tabOrder.indexOf(paneSessions[0]);
        const iSecond = tabOrder.indexOf(paneSessions[1]);
        if (iFirst === -1 || iSecond === -1) return;
        if (iFirst > iSecond) this.swapPanes();
    }

    async createSplit(sessionId, orientation) {
        if (this.enabled) return; // Already split

        this.enabled = true;
        if (orientation === 'horizontal' || orientation === 'vertical') {
            this.orientation = orientation;
        }
        
        // Hide single terminal container
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) {
            terminalContainer.style.display = 'none';
        }

        // Show split container (grid layout; applyLayout sets the tracks)
        this.splitContainerEl.style.display = 'grid';
        this.applyLayout();

        // Update divider position
        this.updateDividerPosition();

        // Set sessions - left gets current session, right gets the dragged session
        const currentSessionId = this.app.currentClaudeSessionId;
        // F1: detach the main terminal from its session first, so the current
        // session isn't double-attached (main socket + left pane) — two clients
        // of different sizes would otherwise fight over the PTY resize.
        if (typeof this.app.leaveSession === 'function') {
            this.app.leaveSession();
        }
        await this.splits[0].setSession(currentSessionId);
        await this.splits[1].setSession(sessionId);

        // Push correct pane dimensions to both PTYs once layout + sockets settle.
        this.scheduleRefit();

        // Keep the panes' left/right order consistent with the tab bar order, so
        // the tab labels always match the pane on that side (createSplit puts the
        // *current* session on the left, which may be the 2nd tab).
        const stm = this.app && this.app.sessionTabManager;
        if (stm && typeof stm.getOrderedTabIds === 'function') {
            this.syncPaneOrderToTabs(stm.getOrderedTabIds());
        }

        // Focus right split (newly created)
        this.focusSplit(1);

        // Save state
        this.saveState();

        console.log(`[SplitContainer] Created split with sessions: ${currentSessionId} | ${sessionId}`);
    }

    closeSplit() {
        if (!this.enabled) return;

        this.enabled = false;

        // Capture which session the main terminal should rejoin BEFORE we clear
        // the panes' sessionIds. currentClaudeSessionId can be null here (entering
        // split leaveSession's the main socket, whose async ack nulls it), so fall
        // back to the focused pane's session — that is what the user was looking at.
        const activePane = this.splits[this.activeSplitIndex];
        const rejoinId = this.app.currentClaudeSessionId
            || (activePane && activePane.sessionId)
            || (this.splits[0] && this.splits[0].sessionId)
            || null;

        // Disconnect both splits
        this.splits.forEach(split => split.disconnect());

        // Show single terminal container
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) {
            terminalContainer.style.display = 'flex';
        }

        // Hide split container
        this.splitContainerEl.style.display = 'none';

        // Clear splits but don't destroy terminals (we'll reuse them)
        this.splits.forEach((split, i) => {
            split.sessionId = null;
            split.isActive = (i === 0);
            split.updateActiveState();
            if (split.terminal) {
                split.terminal.clear();
            }
        });
        
        this.activeSplitIndex = 0;

        // Reconnect main terminal to the captured session. The main socket
        // stayed open (we only leaveSession'd on enter), so rejoin it rather
        // than opening a new socket.
        if (rejoinId) {
            this.app.currentClaudeSessionId = rejoinId;
            setTimeout(() => {
                if (typeof this.app.joinSession === 'function') {
                    this.app.joinSession(rejoinId);
                } else {
                    this.app.connect();
                }
            }, 100);
        }

        // Save state
        this.saveState();

        console.log('[SplitContainer] Closed split, back to single pane');
    }

    focusSplit(index) {
        if (index < 0 || index >= this.splits.length) return;
        if (this.activeSplitIndex === index) return;

        // Update active state
        this.splits.forEach((split, i) => {
            split.isActive = (i === index);
            split.updateActiveState();
        });

        this.activeSplitIndex = index;

        // Focus the terminal in this split
        const split = this.splits[index];
        if (split.terminal) {
            split.terminal.focus();
        }

        // Update app's current session to match this split
        if (split.sessionId && this.app) {
            this.app.currentClaudeSessionId = split.sessionId;
            
            // Update tab selection
            if (this.app.sessionTabManager) {
                const tab = this.app.sessionTabManager.tabs.get(split.sessionId);
                if (tab) {
                    // Update visual state of tabs
                    this.app.sessionTabManager.tabs.forEach((t, id) => {
                        if (id === split.sessionId) {
                            t.classList.add('active');
                        } else {
                            t.classList.remove('active');
                        }
                    });
                    this.app.sessionTabManager.activeTabId = split.sessionId;
                }
            }
        }

        console.log(`[SplitContainer] Focused split ${index}, session: ${split.sessionId}`);
    }

    // Called when a tab is switched - update the active split's session
    async onTabSwitch(sessionId) {
        if (!this.enabled) return;

        // If the session is already shown in a pane, just focus that pane —
        // don't load it a second time (that would double-attach the same PTY).
        const existing = this.splits.findIndex(s => s.sessionId === sessionId);
        if (existing !== -1) {
            if (existing !== this.activeSplitIndex) {
                this.focusSplit(existing);
            } else if (this.app) {
                this.app.currentClaudeSessionId = sessionId;
            }
            return;
        }

        // Otherwise load it into the active pane.
        const activeSplit = this.splits[this.activeSplitIndex];
        if (activeSplit) {
            await activeSplit.setSession(sessionId);
            if (this.app) this.app.currentClaudeSessionId = sessionId;
            this.scheduleRefit();
            this.saveState();
        }
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Cmd/Ctrl + \ to toggle split
            if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
                e.preventDefault();
                if (this.enabled) {
                    this.closeSplit();
                } else {
                    this.applyPreset('horizontal');
                }
            }
            
            // Cmd/Ctrl + 1/2 to focus splits
            if ((e.metaKey || e.ctrlKey) && this.enabled) {
                if (e.key === '1') {
                    e.preventDefault();
                    this.focusSplit(0);
                } else if (e.key === '2') {
                    e.preventDefault();
                    this.focusSplit(1);
                }
            }
        });
    }

    saveState() {
        try {
            const state = {
                enabled: this.enabled,
                orientation: this.orientation,
                dividerPosition: this.dividerPosition,
                activeSplitIndex: this.activeSplitIndex,
                sessions: this.splits.map(s => s.sessionId)
            };
            localStorage.setItem('cc-web-splits', JSON.stringify(state));
        } catch (error) {
            console.error('Failed to save split state:', error);
        }
    }

    restoreState() {
        try {
            const saved = localStorage.getItem('cc-web-splits');
            if (!saved) return;

            const state = JSON.parse(saved);
            
            // Restore divider position + orientation preference
            if (state.dividerPosition) {
                this.dividerPosition = state.dividerPosition;
            }
            if (state.orientation === 'horizontal' || state.orientation === 'vertical') {
                this.orientation = state.orientation;
            }

            // Note: Don't auto-restore enabled state on page load
            // User needs to manually create splits
            // This prevents issues with stale session IDs
        } catch (error) {
            console.error('Failed to restore split state:', error);
        }
    }

    // Setup drop zones for drag-to-split. Right edge -> left/right split,
    // bottom edge -> top/bottom split.
    setupDropZones() {
        const terminalContainer = document.getElementById('terminalContainer');
        if (!terminalContainer) return;

        const dropZone = document.createElement('div');
        dropZone.className = 'split-drop-zone';
        dropZone.style.display = 'none';
        terminalContainer.appendChild(dropZone);

        const edgeAt = (e, rect) => {
            const distRight = rect.right - e.clientX;
            const distBottom = rect.bottom - e.clientY;
            const nearRight = distRight < 120;
            const nearBottom = distBottom < 120;
            if (nearBottom && (!nearRight || distBottom <= distRight)) return 'vertical';
            if (nearRight) return 'horizontal';
            return null;
        };

        const isSessionDrag = (e) =>
            !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('application/x-session-id');

        terminalContainer.addEventListener('dragover', (e) => {
            if (this.enabled || !isSessionDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = terminalContainer.getBoundingClientRect();
            const edge = edgeAt(e, rect);
            if (edge) {
                dropZone.classList.toggle('bottom', edge === 'vertical');
                dropZone.style.display = 'block';
            } else {
                dropZone.style.display = 'none';
            }
        });

        terminalContainer.addEventListener('dragleave', () => { dropZone.style.display = 'none'; });

        terminalContainer.addEventListener('drop', async (e) => {
            dropZone.style.display = 'none';
            const sessionId = e.dataTransfer && e.dataTransfer.getData('application/x-session-id');
            if (!sessionId || this.enabled) return;
            if (sessionId === this.app.currentClaudeSessionId) return;
            const rect = terminalContainer.getBoundingClientRect();
            const edge = edgeAt(e, rect);
            if (edge) {
                e.preventDefault();
                await this.createSplit(sessionId, edge);
            }
        });
    }

}

// Export for use in app.js
window.SplitContainer = SplitContainer;

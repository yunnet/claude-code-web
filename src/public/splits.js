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
function registerPlanLinks(term) {
    if (!term || typeof term.registerLinkProvider !== 'function') return;
    // Paths containing `.claude/plans/` and ending in `.md` (relative or absolute).
    const RE = /[^\s"'`()]*\.claude\/plans\/[^\s"'`()]+\.md/g;
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
                            const url = (window.authManager && window.authManager.getPlanUrl)
                                ? window.authManager.getPlanUrl(matched)
                                : `/api/plan?path=${encodeURIComponent(matched)}`;
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
            // Match the main terminal's scroll feel.
            smoothScrollDuration: 100,
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
        registerPlanLinks(this.terminal);

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
        this.dividerPosition = 50; // percentage
        
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
        let startX = 0;
        let startPosition = 50;

        this.divider.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startPosition = this.dividerPosition;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const container = this.splitContainerEl.getBoundingClientRect();
            const delta = e.clientX - startX;
            const deltaPercent = (delta / container.width) * 100;
            
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

    updateDividerPosition() {
        const leftSplit = this.splitContainerEl.querySelector('.split-left');
        const rightSplit = this.splitContainerEl.querySelector('.split-right');
        
        if (leftSplit && rightSplit) {
            leftSplit.style.width = `${this.dividerPosition}%`;
            rightSplit.style.width = `${100 - this.dividerPosition}%`;
            
            // Fit both terminals
            this.splits.forEach(split => split.fit());
        }
    }

    async createSplit(sessionId) {
        if (this.enabled) return; // Already split

        this.enabled = true;
        
        // Hide single terminal container
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) {
            terminalContainer.style.display = 'none';
        }

        // Show split container
        this.splitContainerEl.style.display = 'flex';

        // Update divider position
        this.updateDividerPosition();

        // Set sessions - left gets current session, right gets the dragged session
        const currentSessionId = this.app.currentClaudeSessionId;
        await this.splits[0].setSession(currentSessionId);
        await this.splits[1].setSession(sessionId);

        // Focus right split (newly created)
        this.focusSplit(1);

        // Save state
        this.saveState();

        console.log(`[SplitContainer] Created split with sessions: ${currentSessionId} | ${sessionId}`);
    }

    closeSplit() {
        if (!this.enabled) return;

        this.enabled = false;

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

        // Reconnect main terminal to current session if we have one
        if (this.app.currentClaudeSessionId) {
            setTimeout(() => {
                this.app.connect();
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

        const activeSplit = this.splits[this.activeSplitIndex];
        if (activeSplit) {
            await activeSplit.setSession(sessionId);
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
                    // Create split - need to pick a session to split with
                    // For now, just show a message
                    console.log('[SplitContainer] To create a split, drag a tab to the right edge of the terminal');
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
            
            // Restore divider position
            if (state.dividerPosition) {
                this.dividerPosition = state.dividerPosition;
            }

            // Note: Don't auto-restore enabled state on page load
            // User needs to manually create splits
            // This prevents issues with stale session IDs
        } catch (error) {
            console.error('Failed to restore split state:', error);
        }
    }

    // Setup drop zones for drag-to-split
    setupDropZones() {
        const terminalContainer = document.getElementById('terminalContainer');
        if (!terminalContainer) return;

        // Create drop zone indicator
        const dropZone = document.createElement('div');
        dropZone.className = 'split-drop-zone';
        dropZone.style.display = 'none';
        terminalContainer.appendChild(dropZone);

        // Listen for drag events on terminal container
        terminalContainer.addEventListener('dragover', (e) => {
            // Only show drop zone if we're not already in split mode
            if (this.enabled) return;
            
            const sessionId = e.dataTransfer?.getData('application/x-session-id');
            if (!sessionId) return;
            
            // Don't allow splitting with the current session
            if (sessionId === this.app.currentClaudeSessionId) return;

            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            // Show drop zone if near right edge
            const rect = terminalContainer.getBoundingClientRect();
            const isNearRightEdge = (e.clientX > rect.right - 100);

            if (isNearRightEdge) {
                dropZone.style.display = 'block';
            } else {
                dropZone.style.display = 'none';
            }
        });

        terminalContainer.addEventListener('dragleave', () => {
            dropZone.style.display = 'none';
        });

        terminalContainer.addEventListener('drop', async (e) => {
            const sessionId = e.dataTransfer?.getData('application/x-session-id');
            if (!sessionId) return;
            
            // Don't allow splitting with the current session
            if (sessionId === this.app.currentClaudeSessionId) {
                dropZone.style.display = 'none';
                return;
            }

            const rect = terminalContainer.getBoundingClientRect();
            const isNearRightEdge = (e.clientX > rect.right - 100);

            if (isNearRightEdge && !this.enabled) {
                e.preventDefault();
                await this.createSplit(sessionId);
            }

            dropZone.style.display = 'none';
        });
    }
}

// Export for use in app.js
window.SplitContainer = SplitContainer;

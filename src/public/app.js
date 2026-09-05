class ClaudeCodeWebInterface {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.webLinksAddon = null;
        this.socket = null;
        this.connectionId = null;
        this.currentClaudeSessionId = null;
        this.currentClaudeSessionName = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.folderMode = true; // Always use folder mode
        this.currentFolderPath = null;
        this.claudeSessions = [];
        this.isCreatingNewSession = false;
        this.isMobile = this.detectMobile();
        this.planDetector = null;
        this.planModal = null;
        // Aliases for assistants (populated from /api/config)
        this.aliases = { claude: 'Claude' };
        
        
        // Initialize the session tab manager
        this.sessionTabManager = null;
        
        // Usage stats
        this.sessionStats = null;
        this.sessionTimer = null;
        this.sessionTimerInterval = null;
        
        this.splitContainer = null;
        this.init();
    }

    // Helper method for authenticated fetch calls
    async authFetch(url, options = {}) {
        const authHeaders = window.authManager.getAuthHeaders();
        const mergedOptions = {
            ...options,
            headers: {
                ...authHeaders,
                ...(options.headers || {})
            }
        };
        const response = await fetch(url, mergedOptions);
        
        // If we get a 401, the token might be invalid or missing
        if (response.status === 401 && window.authManager.authRequired) {
            // Clear any invalid token
            window.authManager.token = null;
            sessionStorage.removeItem('cc-web-token');
            // Show login prompt
            window.authManager.showLoginPrompt();
        }
        
        return response;
    }

    async init() {
        // Check authentication first
        const authenticated = await window.authManager.initialize();
        if (!authenticated) {
            // Auth prompt is shown, stop initialization
            console.log('[Init] Authentication required, waiting for login...');
            return;
        }
        
        await this.loadConfig();
        this.setupTerminal();
        this.setupUI();
        this.setupPlanDetector();
        this.loadSettings();
        this.applyAliasesToUI();
        
        // Show loading while we initialize
        this.showOverlay('loadingSpinner');
        
        // Initialize the session tab manager and wait for sessions to load
        this.sessionTabManager = new SessionTabManager(this);
        const reconcile = await this.sessionTabManager.init();
        
        // Initialize split container
        if (window.SplitContainer) {
            this.splitContainer = new window.SplitContainer(this);
            this.splitContainer.setupDropZones();
        }
        
        // Show mode switcher on mobile
        if (this.isMobile) {
            this.showModeSwitcher();
        }
        
        // Session restore. reconcileSessions decided one of:
        //  - conflict: the persisted tab set doesn't match the server → let the
        //    user pick which sessions to open (no silent adopt / no auto-create).
        //  - adopted/restored: tabs are already built; join the chosen active one.
        //  - unavailable: the session list couldn't be fetched. The stored tab set
        //    is left alone (see reconcileSessions) so a blip doesn't erase it.
        //  - nothing at all: first run → folder picker to create the first session.
        if (reconcile && reconcile.mode === 'unavailable') {
            this.hideOverlay();
            this.showError('Could not load the session list — check the connection and reload.');
            this.showFolderBrowser();
        } else if (reconcile && reconcile.mode === 'conflict') {
            this.hideOverlay();
            this.showSessionReconcileModal(reconcile);
        } else if (this.sessionTabManager.tabs.size > 0) {
            const activeId = (reconcile && reconcile.activeId) || this.sessionTabManager.tabs.keys().next().value;
            await this.sessionTabManager.switchToTab(activeId);
            // Hide the loading overlay now that we've joined a session — but keep
            // the "Start Claude" restart prompt visible when the joined session's
            // Claude process has stopped.
            const startPromptVisible = document.getElementById('startPrompt')?.style.display === 'block';
            if (!startPromptVisible) this.hideOverlay();
        } else {
            // No sessions anywhere - show the folder picker to create the first one.
            this.hideOverlay();
            this.showFolderBrowser();
        }
        
        this.setupViewportSizing();

        window.addEventListener('beforeunload', () => {
            this.disconnect();
        });
    }

    async loadConfig() {
        try {
            const res = await this.authFetch('/api/config');
            if (res.ok) {
                const cfg = await res.json();
                if (cfg?.aliases) {
                    this.aliases = { claude: cfg.aliases.claude || 'Claude' };
                }
                if (typeof cfg.folderMode === 'boolean') {
                    this.folderMode = cfg.folderMode;
                }
                // The directory ccw was launched from. We treat it as "no project
                // chosen" so Start Claude prompts for a real project folder instead
                // of silently running in the launch/home directory.
                if (cfg.baseFolder) {
                    this.baseFolder = cfg.baseFolder;
                }
                if (cfg.homeDir) {
                    this.homeDir = cfg.homeDir;
                }
                // Build/version marker in the left drawer footer, so dev (32353)
                // and stable (32352) can be told apart and compared at a glance.
                const vEl = document.getElementById('menuVersion');
                if (vEl) {
                    const parts = [];
                    if (cfg.version) parts.push('v' + cfg.version);
                    if (cfg.port) parts.push(':' + cfg.port);
                    if (cfg.buildId) parts.push(cfg.buildId);
                    vEl.textContent = parts.length ? parts.join(' · ') : '—';
                }
            }
        } catch (_) { /* best-effort */ }
    }

    getAlias() {
        return (this.aliases && this.aliases.claude) || 'Claude';
    }

    applyAliasesToUI() {
        // Start prompt buttons
        const startBtn = document.getElementById('startBtn');
        const dangerousSkipBtn = document.getElementById('dangerousSkipBtn');
        if (startBtn) startBtn.textContent = `Start ${this.getAlias()}`;
        if (dangerousSkipBtn) dangerousSkipBtn.textContent = `Dangerous ${this.getAlias()}`;

        // Plan modal title
        const planTitle = document.querySelector('#planModal .modal-header h2');
        if (planTitle) planTitle.innerHTML = `<span class=\"icon\" aria-hidden=\"true\">${window.icons?.clipboard?.(18) || ''}</span> ${this.getAlias()}'s Plan`;
    }
    
    detectMobile() {
        // Check for touch capability and common mobile user agents
        const hasTouchScreen = 'ontouchstart' in window || 
                              navigator.maxTouchPoints > 0 || 
                              navigator.msMaxTouchPoints > 0;
        
        const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        
        // Also check viewport width for tablets
        const smallViewport = window.innerWidth <= 1024;
        
        return hasTouchScreen && (mobileUserAgent || smallViewport);
    }
    
    showModeSwitcher() {
        // Create mode switcher button if it doesn't exist
        if (!document.getElementById('modeSwitcher')) {
            const modeSwitcher = document.createElement('div');
            modeSwitcher.id = 'modeSwitcher';
            modeSwitcher.className = 'mode-switcher';
            // Label these, don't decorate them: on a phone there is no hover, so a
            // `title` is invisible and a glyph would have to carry the whole
            // meaning. The old pair (an info "i" and a close "X") said nothing
            // about sending Esc or cycling modes. Both are keystroke buttons, and
            // Esc in particular has no honest icon — an X reads as "close", an
            // arrow as "back" — so the set is worded, not drawn, and the two share
            // one treatment so they read as a pair. Colour carries the identity.
            modeSwitcher.innerHTML = `
                <button id="escapeBtn" class="escape-btn" type="button"
                        title="Send the Esc key" aria-label="Send the Esc key">
                    <span class="fab-key">ESC</span>
                </button>
                <button id="modeSwitcherBtn" class="mode-switcher-btn" type="button"
                        title="Cycle permission mode (Shift+Tab)" aria-label="Cycle permission mode (Shift+Tab)">
                    <span class="fab-key">MODE</span>
                </button>
            `;
            document.body.appendChild(modeSwitcher);
            this.positionModeSwitcher();
            
            // Add event listener for mode switcher
            document.getElementById('modeSwitcherBtn').addEventListener('click', () => {
                this.switchMode();
            });
            
            // Add event listener for escape button
            document.getElementById('escapeBtn').addEventListener('click', () => {
                this.sendEscape();
            });
        }
    }
    
    // Park the button stack directly above Claude's input box rather than on top
    // of it, leaving the same gap between the two buttons and between the lower
    // button and the box's top rule. The box is terminal CONTENT, not DOM, so its
    // position can't be hard-coded — it moves with the font size, the row count
    // and the soft keyboard — and has to be measured from the buffer each time
    // the terminal reflows.
    positionModeSwitcher() {
        const sw = document.getElementById('modeSwitcher');
        const term = this.terminal;
        if (!sw || !term || !term.element || !term.rows) return;
        const rect = term.element.getBoundingClientRect();
        if (!rect.height) return;
        const rowH = rect.height / term.rows;
        const buf = term.buffer.active;

        // Claude fences its input box with two horizontal rules and puts the
        // status line under it. The topmost rule in the last dozen rows marks the
        // top of everything we must stay clear of.
        let boxTop = null;
        for (let y = term.rows - 1, scanned = 0; y >= 0 && scanned < 12; y--, scanned++) {
            const line = buf.getLine(buf.viewportY + y);
            if (line && line.translateToString(true).trim().startsWith('─')) boxTop = y;
        }
        // No box on screen (Claude not started, or a plain shell): still keep off
        // the last two rows so the prompt is never covered.
        const rowsToClear = term.rows - (boxTop === null ? term.rows - 2 : boxTop);
        const cs = getComputedStyle(sw);
        const gap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 10;
        const belowTerminal = Math.max(0, window.innerHeight - rect.bottom);
        sw.style.bottom = Math.round(belowTerminal + rowsToClear * rowH + gap) + 'px';
    }

    sendEscape() {
        // Send ESC key to terminal
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            // Send ESC key (ASCII 27 or \x1b)
            this.send({ type: 'input', data: '\x1b' });
        }
        
        // Add visual feedback
        const btn = document.getElementById('escapeBtn');
        if (btn) {
            btn.classList.add('pressed');
            setTimeout(() => {
                btn.classList.remove('pressed');
            }, 200);
        }
    }
    
    // Send Shift+Tab, which is what cycles Claude's permission mode. We do NOT
    // track which mode that lands on: the client used to cycle a private
    // chat/code/plan counter and colour the button from it, but nothing kept it in
    // step with Claude (whose cycle isn't those three anyway), so the badge and the
    // tooltip were routinely wrong. The status line in the terminal is the truth.
    switchMode() {
        const btn = document.getElementById('modeSwitcherBtn');

        // Send Shift+Tab to terminal to trigger the actual mode switch in Claude Code
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            // Send Shift+Tab key combination (ESC[Z is the terminal sequence for Shift+Tab)
            this.send({ type: 'input', data: '\x1b[Z' });
        }
        
        // Add visual feedback
        if (btn) {
            btn.classList.add('switching');
            setTimeout(() => {
                btn.classList.remove('switching');
            }, 300);
        }
    }

    setupTerminal() {
        // Adjust font size for mobile devices
        const isMobile = this.detectMobile();
        const fontSize = isMobile ? 12 : 14;
        
        this.terminal = new Terminal({
            fontSize: fontSize,
            fontFamily: 'JetBrains Mono, Fira Code, Monaco, Consolas, monospace',
            // Theme-aware palette (light/dark) from splits.js:getTerminalTheme(),
            // which loads before app.js. Selects by the `data-theme` attribute set
            // synchronously in <head>, so the terminal matches the UI theme. The
            // dark palette is identical to the original hardcoded one.
            theme: getTerminalTheme(),
            allowProposedApi: true,
            scrollback: 10000,
            rightClickSelectsWord: false,
            allowTransparency: true,
            // Treat Option/Alt as Meta so Claude Code's Option shortcuts (e.g.
            // Option+P to switch models) reach the CLI instead of being eaten.
            macOptionIsMeta: true,
            // Blink the cursor like a native terminal.
            cursorBlink: true,
            // Native-terminal scroll feel: animate wheel scrolls on desktop.
            // On mobile keep it instant (0) — the touch handler drives scrolling
            // itself with its own inertia, and animating each step there makes the
            // viewport lag behind the finger. Desktop value is user-configurable
            // via Settings (0 = instant / no damping).
            smoothScrollDuration: isMobile ? 0 : this.loadSettings(this.currentClaudeSessionId).smoothScrollDuration,
            fastScrollModifier: 'shift',
            fastScrollSensitivity: 5,
            // Disable focus tracking to prevent ^[[I and ^[[O sequences
            windowOptions: {
                reportFocus: false
            }
        });

        this.fitAddon = new FitAddon.FitAddon();
        this.webLinksAddon = new WebLinksAddon.WebLinksAddon();
        
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.webLinksAddon);

        // Activate Unicode v11 width tables so emoji and box-drawing characters
        // measure the same width the native terminal gives them — otherwise
        // Claude Code's framed UI drifts out of alignment.
        try {
            if (window.Unicode11Addon) {
                this.terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
                this.terminal.unicode.activeVersion = '11';
            }
        } catch (e) {
            console.warn('Unicode11 addon unavailable:', e);
        }

        this.terminal.open(document.getElementById('terminal'));

        // Make plan-file paths in output clickable (open the .md in a new tab).
        registerPlanLinks(this.terminal, () => this.currentClaudeSessionId);

        // Renderer (must load after open()). Prefer WebGL — it's markedly faster
        // than canvas/DOM under Claude Code's heavy full-screen repaints, which is
        // what keeps the terminal responsive when a lot is streaming. Fall back to
        // canvas, then the built-in DOM renderer. If the GPU drops the WebGL
        // context mid-session, dispose it and fall back so the terminal keeps
        // rendering instead of freezing.
        this.activeRenderer = 'dom';
        const loadCanvasRenderer = () => {
            try {
                if (window.CanvasAddon) {
                    this.terminal.loadAddon(new CanvasAddon.CanvasAddon());
                    this.activeRenderer = 'canvas';
                }
            } catch (e) {
                console.warn('Canvas renderer unavailable, using DOM renderer:', e);
            }
        };
        try {
            if (window.WebglAddon) {
                const webgl = new WebglAddon.WebglAddon();
                webgl.onContextLoss(() => {
                    console.warn('WebGL context lost — falling back to canvas renderer');
                    try { webgl.dispose(); } catch (_) {}
                    this.activeRenderer = 'dom';
                    loadCanvasRenderer();
                });
                this.terminal.loadAddon(webgl);
                this.activeRenderer = 'webgl';
            } else {
                loadCanvasRenderer();
            }
        } catch (e) {
            console.warn('WebGL renderer unavailable, falling back to canvas:', e);
            loadCanvasRenderer();
        }
        console.log('[terminal] renderer:', this.activeRenderer);

        // RAF write batching. Claude Code's TUI can emit output faster than xterm
        // can render (xterm caps itself at <16ms/frame, ~5-35 MB/s). Writing every
        // WebSocket chunk immediately lets the internal buffer pile up until the
        // terminal goes sluggish and stops echoing keystrokes. Instead we coalesce
        // chunks and flush at most once per animation frame (~60/s).
        this._termWriteQueue = [];
        this._termWriteScheduled = false;

        // Flow control (backpressure). Track bytes received but not yet rendered
        // by xterm. When the backlog exceeds HIGH we ask the server to pause the
        // PTY; once it drains below LOW we resume. This stops a fast producer
        // (Claude repainting) from outrunning the renderer and freezing input.
        this._pendingBytes = 0;
        this._flowPaused = false;
        this._flowHigh = 128 * 1024;
        this._flowLow = 16 * 1024;

        this.fitTerminal();

        // Enable copy-to-clipboard from the terminal. xterm swallows key events,
        // so without this Ctrl+C over a selection is sent as SIGINT and text can
        // never be copied. Convention: copy when there is a selection, otherwise
        // let Ctrl+C fall through as an interrupt.
        this.terminal.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;

            // Shift+Enter / Option(Alt)+Enter → insert a newline instead of
            // submitting. xterm.js can't distinguish these from plain Enter (all
            // send \r) because it lacks the Kitty keyboard protocol. Claude Code
            // maps LF (\n, i.e. Ctrl+J) to "newline" in EVERY terminal with no
            // setup, so we send that directly — no protocol negotiation needed.
            if (e.key === 'Enter' && (e.shiftKey || e.altKey) && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.send({ type: 'input', data: '\n' });
                return false; // handled — do not let xterm send \r (submit)
            }

            const key = (e.key || '').toLowerCase();
            if (key === 'c' && (e.ctrlKey || e.metaKey)) {
                const selection = this.terminal.getSelection();
                if (selection) {
                    this.copyToClipboard(selection);
                    this.terminal.clearSelection();
                    return false; // handled — do not forward to the shell
                }
            }
            return true;
        });

        // Handle OSC 52 clipboard writes. Programs running in the terminal (e.g.
        // Claude Code) copy by emitting `ESC ] 52 ; c ; <base64> ST`. xterm does
        // not act on this by default, so the copy silently failed in the browser.
        // Decode it and write to the real clipboard (with our HTTP fallback).
        this.terminal.parser.registerOscHandler(52, (payload) => this.handleOsc52(payload));

        // Mobile touch scrolling. Programs like Claude Code enable mouse tracking
        // (the terminal gets the `enable-mouse-events` class), which routes touch
        // drags to the app as mouse events instead of scrolling the viewport — so
        // swiping does nothing on a phone. Translate vertical swipes into terminal
        // scrolls. Mobile-only: on desktop this handler is never attached, so wheel
        // scrolling and selection are completely unaffected.
        if (this.isMobile) {
            this.setupMobileTouchScroll(document.getElementById('terminal'), this.terminal);
        }

        this.terminal.onData((data) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                // Filter out focus tracking sequences before sending
                const filteredData = data.replace(/\x1b\[\[?[IO]/g, '');
                if (filteredData) {
                    this.send({ type: 'input', data: filteredData });
                }
            }
        });

        // The input box moves as content reflows, so re-park the mobile buttons
        // on render — coalesced to one measurement per frame.
        if (this.isMobile) {
            this.terminal.onRender(() => {
                if (this._fabPlaceScheduled) return;
                this._fabPlaceScheduled = requestAnimationFrame(() => {
                    this._fabPlaceScheduled = null;
                    this.positionModeSwitcher();
                });
            });
        }

        this.terminal.onResize(({ cols, rows }) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.send({ type: 'resize', cols, rows });
            }
        });

        // Terminal bell parity. A native terminal rings on BEL (0x07); Claude
        // Code emits it (e.g. on completion when the terminal bell channel is on).
        // Surface it as a short beep, and a desktop notification if the tab is
        // in the background — so a long task can finish while you work elsewhere.
        this.terminal.onBell(() => this.handleBell());

        // Terminal title parity. Claude Code sets the terminal title (OSC 0/2) to
        // reflect its state; a native terminal shows it in the window/tab. Mirror
        // it to the browser tab so the status is visible even when backgrounded.
        // Strip Claude's leading animated spinner glyph (✳ ✶ ✻ ✽ ● …) and any
        // other leading symbol decoration — next to the favicon it looks like a
        // second tab icon. Keep only the actual title text.
        this.terminal.onTitleChange((title) => {
            if (!title) return;
            const cleaned = title.replace(/^[\s\p{S}]+/u, '').trim();
            if (cleaned) document.title = cleaned;
        });

        // Paste / drop images into the terminal (single-view). We can't hand a
        // real clipboard image to the shell, so upload it and inject the saved
        // file path into the prompt for Claude Code to read.
        this.setupImagePaste();
    }

    // Ring the terminal bell: a short WebAudio blip plus, when the tab is hidden,
    // a browser notification. Best-effort — silently ignores unsupported browsers
    // or denied permissions.
    handleBell() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
                this._audioCtx = this._audioCtx || new Ctx();
                const ctx = this._audioCtx;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 880;
                gain.gain.setValueAtTime(0.0001, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
                osc.connect(gain).connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.2);
            }
        } catch (e) { /* audio blocked before first interaction — ignore */ }

        try {
            if (document.hidden && 'Notification' in window) {
                if (Notification.permission === 'granted') {
                    new Notification(`${this.getAlias()} needs your attention`);
                } else if (Notification.permission !== 'denied') {
                    Notification.requestPermission();
                }
            }
        } catch (e) { /* notifications unsupported — ignore */ }
    }

    // Wire paste (Ctrl/Cmd+V) and drag-drop of image files onto the terminal.
    // Works in plain-HTTP contexts because it reads the DOM paste/drop events
    // (clipboardData / dataTransfer), not navigator.clipboard.
    setupImagePaste() {
        const termEl = document.getElementById('terminal');
        const containerEl = document.getElementById('terminalContainer');
        if (!termEl) return;

        termEl.addEventListener('paste', (e) => {
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            const images = [];
            for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) images.push(file);
                }
            }
            if (images.length === 0) return; // plain text paste — leave to xterm
            e.preventDefault();
            images.forEach((f) => this.uploadAndInsertImage(f));
        });

        if (containerEl) {
            // Allow dropping files here (default would navigate the page). Only
            // take over the gesture when the drag actually carries files, so the
            // tab→split drag handler in splits.js is left untouched.
            containerEl.addEventListener('dragover', (e) => {
                if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
                    e.preventDefault();
                }
            });
            containerEl.addEventListener('drop', (e) => {
                const files = e.dataTransfer && e.dataTransfer.files;
                const images = files ? Array.from(files).filter((f) => f.type.startsWith('image/')) : [];
                if (images.length === 0) return; // not an image drop — let other handlers run
                e.preventDefault();
                images.forEach((f) => this.uploadAndInsertImage(f));
            });
        }
    }

    // Upload one image file to the server and, on success, inject its saved
    // path into the terminal input so Claude Code picks it up as an image.
    async uploadAndInsertImage(file) {
        if (!this.currentClaudeSessionId) {
            this.showToast('Start Claude before pasting an image', true);
            return;
        }
        try {
            const res = await this.authFetch(
                `/api/upload-image?sessionId=${encodeURIComponent(this.currentClaudeSessionId)}`,
                { method: 'POST', body: file, headers: { 'Content-Type': file.type } }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                this.showToast(data.error || 'Image upload failed', true);
                return;
            }
            // Inject the absolute path (+trailing space) as if typed. No newline:
            // the user adds their prompt and sends it themselves.
            this.send({ type: 'input', data: data.path + ' ' });
            this.showToast('Image inserted');
        } catch (err) {
            this.showToast('Image upload failed', true);
        }
    }

    // Minimal self-removing toast (bottom-center). Avoids hijacking the terminal
    // with the full-screen error overlay for transient paste feedback.
    showToast(message, isError = false) {
        const el = document.createElement('div');
        el.textContent = message;
        el.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:60px', 'transform:translateX(-50%)',
            'z-index:6000', 'padding:8px 14px', 'border-radius:6px', 'font-size:13px',
            'color:#fff', 'pointer-events:none', 'opacity:0', 'transition:opacity 0.2s',
            `background:${isError ? 'rgba(248,81,73,0.95)' : 'rgba(40,167,69,0.95)'}`
        ].join(';');
        document.body.appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = '1'; });
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 250);
        }, 2200);
    }

    // Translate one-finger vertical swipes into terminal scrolling. Needed on
    // mobile because mouse-tracking mode swallows touch drags. Small movements
    // (taps) pass through untouched so tapping/clicking in the TUI still works.
    setupMobileTouchScroll(termEl, terminal) {
        if (!termEl || !terminal) return;
        let startY = null, lastY = null, lastT = 0, scrolling = false;
        // Where the gesture is on screen. The synthetic wheel has to carry this:
        // a full-screen TUI decides whether (and what) to scroll from the cell the
        // pointer is over, so a fixed point meant we always claimed the top-left
        // corner no matter where the user actually swiped.
        let ptX = 0, ptY = 0;
        let velocity = 0;          // finger speed in px/ms (sign: + = moving down)
        let momentumRAF = null;
        let acc = 0;               // leftover fractional pixels → whole lines
        const THRESHOLD = 8;       // px before a drag counts as a scroll (lets taps through)

        const cellPx = () => {
            const vp = termEl.querySelector('.xterm-viewport');
            const rows = terminal.rows || 24;
            return (vp && vp.clientHeight) ? vp.clientHeight / rows : 18;
        };
        const wheelTarget = () =>
            termEl.querySelector('.xterm-viewport') || termEl.querySelector('.xterm') || termEl;
        const stopMomentum = () => {
            if (momentumRAF) { cancelAnimationFrame(momentumRAF); momentumRAF = null; }
        };

        // Scroll by whole lines; +lines reveals OLDER content. Two cases:
        //  • normal buffer (inline Claude / shell): scroll xterm's own scrollback.
        //  • alternate buffer (Claude fullscreen TUI, mouse tracking on): there is
        //    NO xterm scrollback, so forward mouse-wheel events — xterm encodes
        //    them and the app scrolls its own view. One wheel notch per line.
        const applyScroll = (lines) => {
            if (!lines) return;
            if (terminal.buffer.active.type === 'alternate') {
                const el = wheelTarget();
                const deltaY = lines > 0 ? -120 : 120; // older → wheel up
                // Fall back to the middle of the terminal if we somehow have no
                // touch point — never the corner, which may not be scrollable.
                const box = el.getBoundingClientRect();
                const x = ptX || Math.round(box.left + box.width / 2);
                const y = ptY || Math.round(box.top + box.height / 2);
                for (let i = Math.abs(lines); i > 0; i--) {
                    el.dispatchEvent(new WheelEvent('wheel', {
                        deltaY, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true
                    }));
                }
            } else {
                terminal.scrollLines(-lines);
            }
        };
        const flush = () => {
            const cell = cellPx();
            const lines = (acc / cell) | 0; // truncate toward 0
            if (lines !== 0) { applyScroll(lines); acc -= lines * cell; }
        };

        termEl.addEventListener('touchstart', (e) => {
            stopMomentum(); // a new touch halts any ongoing glide (native feel)
            if (e.touches.length === 1) {
                ptX = e.touches[0].clientX; ptY = e.touches[0].clientY;
                startY = lastY = e.touches[0].clientY;
                lastT = performance.now();
                scrolling = false; velocity = 0; acc = 0;
            } else { startY = lastY = null; }
        }, { passive: true });

        termEl.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1 || lastY === null) return;
            const y = e.touches[0].clientY;
            ptX = e.touches[0].clientX; ptY = y;
            if (!scrolling && Math.abs(y - startY) < THRESHOLD) return;
            scrolling = true;
            const now = performance.now();
            const dy = y - lastY; lastY = y;
            velocity = dy / Math.max(1, now - lastT); // px/ms for inertia
            lastT = now;
            acc += dy; flush();
            e.preventDefault(); // own the gesture: no page rubber-band, no stray app clicks
        }, { passive: false });

        const end = () => {
            const wasScrolling = scrolling;
            const v0 = velocity;
            startY = lastY = null; scrolling = false; velocity = 0;
            // Flick → keep scrolling in that direction with decaying inertia, so a
            // quick swipe reviews a long history instead of needing many drags.
            if (!wasScrolling || Math.abs(v0) < 0.25) { acc = 0; return; }
            let v = v0;              // px/ms
            let last = performance.now();
            const step = () => {
                const now = performance.now();
                const dt = now - last; last = now;
                acc += v * dt; flush();
                v *= Math.pow(0.95, dt / 16);   // ~5% decay per 16ms frame
                momentumRAF = (Math.abs(v) > 0.02) ? requestAnimationFrame(step) : null;
            };
            momentumRAF = requestAnimationFrame(step);
        };
        termEl.addEventListener('touchend', end, { passive: true });
        termEl.addEventListener('touchcancel', () => {
            stopMomentum(); startY = lastY = null; scrolling = false; velocity = 0; acc = 0;
        }, { passive: true });
    }

    // OSC 52 payload is "<selection>;<base64>" e.g. "c;SGVsbG8=". A base64 of
    // "?" is a read/query request, which we don't support. Returns true when
    // handled so xterm doesn't pass the sequence through as visible text.
    handleOsc52(payload) {
        try {
            const sep = payload.indexOf(';');
            if (sep === -1) return true;
            const b64 = payload.slice(sep + 1).trim();
            if (!b64 || b64 === '?') return true; // query/clear — nothing to copy
            const binary = atob(b64);
            // atob yields a Latin1 string; reinterpret bytes as UTF-8 so that
            // multibyte text (e.g. Chinese) is decoded correctly.
            const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
            const text = new TextDecoder('utf-8').decode(bytes);
            this.copyToClipboard(text);
        } catch (_) { /* malformed payload — ignore */ }
        return true;
    }

    // Copy text to the clipboard. Uses the async Clipboard API in a secure
    // context (https/localhost) and falls back to a hidden-textarea +
    // execCommand for plain-HTTP LAN access, where navigator.clipboard is
    // unavailable.
    copyToClipboard(text) {
        if (!text) return;
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).catch(() => this._legacyCopy(text));
        } else {
            this._legacyCopy(text);
        }
    }

    _legacyCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (err) { /* ignore */ }
        document.body.removeChild(ta);
    }

    showSessionSelectionModal() {
        // Create a simple modal to show existing sessions
        const modal = document.createElement('div');
        modal.className = 'session-modal active';
        modal.id = 'sessionSelectionModal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Select a Session</h2>
                    <button class="close-btn" id="closeSessionSelection">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="session-list">
                        ${this.claudeSessions.map(session => {
                            const statusIcon = `<span class=\"dot ${session.active ? 'dot-on' : 'dot-idle'}\"></span>`;
                            const clientsText = session.connectedClients === 1 ? '1 client' : `${session.connectedClients} clients`;
                            return `
                                <div class="session-item" data-session-id="${session.id}" style="cursor: pointer; padding: 15px; border: 1px solid #333; border-radius: 5px; margin-bottom: 10px;">
                                    <div class="session-info">
                                        <span class="session-status">${statusIcon}</span>
                                        <div class="session-details">
                                            <div class="session-name">${session.name}</div>
                                            <div class="session-meta">${clientsText} • ${new Date(session.created).toLocaleString()}</div>
                                            ${session.workingDir ? `<div class=\"session-folder\" title=\"${session.workingDir}\"><span class=\"icon\" aria-hidden=\"true\">${window.icons?.folder?.(14) || ''}</span> ${session.workingDir}</div>` : ''}
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <div style="margin-top: 20px; text-align: center;">
                        <button class="btn btn-secondary" id="selectSessionNewFolder">Load a New Folder Instead</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Add event listeners
        modal.querySelectorAll('.session-item').forEach(item => {
            item.addEventListener('click', async () => {
                const sessionId = item.dataset.sessionId;
                await this.joinSession(sessionId);
                modal.remove();
            });
        });
        
        document.getElementById('closeSessionSelection').addEventListener('click', () => {
            modal.remove();
            this.hideOverlay();
            this.showFolderBrowser();
        });
        
        document.getElementById('selectSessionNewFolder').addEventListener('click', () => {
            modal.remove();
            this.hideOverlay();
            this.showFolderBrowser();
        });
        
        // Close on background click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
                this.hideOverlay();
                this.showFolderBrowser();
            }
        });
    }
    
    setupUI() {
        const startBtn = document.getElementById('startBtn');
        const dangerousSkipBtn = document.getElementById('dangerousSkipBtn');
        const explorerBtn = document.getElementById('explorerBtn');
        const retryBtn = document.getElementById('retryBtn');
        
        // Mobile menu buttons (keeping for mobile support)
        const closeMenuBtn = document.getElementById('closeMenuBtn');
        const settingsBtnMobile = document.getElementById('settingsBtnMobile');
        
        if (startBtn) startBtn.addEventListener('click', () => this.startClaudeSession(this.claudeStartOptions()));
        if (dangerousSkipBtn) dangerousSkipBtn.addEventListener('click', () => this.startClaudeSession({ ...this.claudeStartOptions(), dangerouslySkipPermissions: true }));
        // Desktop file-explorer button (replaced the old Settings gear; Settings
        // stays reachable from the hamburger menu). The explorer lives in
        // file-explorer.js and exposes window.fileExplorer.
        if (explorerBtn) explorerBtn.addEventListener('click', () => window.fileExplorer && window.fileExplorer.open());

        const layoutBtn = document.getElementById('layoutBtn');
        if (layoutBtn) layoutBtn.addEventListener('click', () => {
            if (this.splitContainer) this.splitContainer.openLayoutMenu(layoutBtn);
        });
        if (retryBtn) retryBtn.addEventListener('click', () => this.reconnect());

        // Tile view toggle
        // Mobile menu event listeners
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        if (hamburgerBtn) hamburgerBtn.addEventListener('click', () => this.toggleMobileMenu());
        if (closeMenuBtn) closeMenuBtn.addEventListener('click', () => this.closeMobileMenu());
        if (settingsBtnMobile) {
            settingsBtnMobile.addEventListener('click', () => {
                this.showSettings();
                this.closeMobileMenu();
            });
        }
        
        // Mobile sessions button
        const sessionsBtnMobile = document.getElementById('sessionsBtnMobile');
        if (sessionsBtnMobile) {
            sessionsBtnMobile.addEventListener('click', () => {
                this.showMobileSessionsModal();
                this.closeMobileMenu();
            });
        }
        
        this.setupSettingsModal();
        this.setupFolderBrowser();
        this.setupNewSessionModal();
        this.setupMobileSessionsModal();

        // Custom prompts dropdown removed
    }

    setupSettingsModal() {
        const modal = document.getElementById('settingsModal');
        const closeBtn = document.getElementById('closeSettingsBtn');
        const saveBtn = document.getElementById('saveSettingsBtn');
        const fontSizeSlider = document.getElementById('fontSize');
        const fontSizeValue = document.getElementById('fontSizeValue');

        closeBtn.addEventListener('click', () => this.hideSettings());
        saveBtn.addEventListener('click', () => this.saveSettings());
        
        fontSizeSlider.addEventListener('input', (e) => {
            fontSizeValue.textContent = e.target.value + 'px';
        });

        const smoothScroll = document.getElementById('smoothScroll');
        const smoothScrollValue = document.getElementById('smoothScrollValue');
        if (smoothScroll) {
            smoothScroll.addEventListener('input', (e) => {
                smoothScrollValue.textContent = e.target.value + 'ms';
            });
        }

        // Plan directories: add on button click / Enter. Removal is delegated
        // from the list (each row's × has data-dir). Both POST immediately.
        const planDirAddBtn = document.getElementById('planDirAddBtn');
        const planDirInput = document.getElementById('planDirInput');
        if (planDirAddBtn) planDirAddBtn.addEventListener('click', () => this.addPlanDir());
        if (planDirInput) planDirInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.addPlanDir(); }
        });
        const planDirsList = document.getElementById('planDirsList');
        if (planDirsList) planDirsList.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-remove-dir]');
            if (btn) this.removePlanDir(btn.getAttribute('data-remove-dir'));
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideSettings();
            }
        });
    }

    // setupCommandsMenu removed

    // populateCommandsDropdown removed

    // appendCustomCommandItem removed

    // runCommandFromPath removed

    // setupCustomCommandModal removed

    // openCustomCommandModal removed

    // closeCustomCommandModal removed

    connect(sessionId = null) {
        return new Promise((resolve, reject) => {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = `${protocol}//${location.host}`;
            if (sessionId) {
                wsUrl += `?sessionId=${sessionId}`;
            }
            
            // Add auth token if required
            wsUrl = window.authManager.getWebSocketUrl(wsUrl);
            
            this.updateStatus('Connecting...');
            // Only show loading spinner if overlay is already visible
            // Don't force it to show if we're handling restored sessions
            if (document.getElementById('overlay').style.display !== 'none') {
                this.showOverlay('loadingSpinner');
            }
            
            try {
                this.socket = new WebSocket(wsUrl);
                
                this.socket.onopen = () => {
                    this.reconnectAttempts = 0;
                    this.updateStatus('Connected');
                    console.log('Connected to server');
                    
                    // Load available sessions
                    this.loadSessions();
                    
                    // Only show start prompt if we don't have sessions AND no current session
                    // The init() method will handle showing/hiding overlays for restored sessions
                    if (!this.currentClaudeSessionId && (!this.sessionTabManager || this.sessionTabManager.tabs.size === 0)) {
                        this.showOverlay('startPrompt');
                    }
                    
                    // Show close session button if we have a selected working directory
                    if (this.selectedWorkingDir) {
                        // Close session buttons removed with header
                    }
                    
                    resolve();
                };
            
            this.socket.onmessage = (event) => {
                this.handleMessage(JSON.parse(event.data));
            };
            
            this.socket.onclose = (event) => {
                this.updateStatus('Disconnected');
                // Reconnect button removed with header
                
                if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
                    setTimeout(() => this.reconnect(), this.reconnectDelay * Math.pow(2, this.reconnectAttempts));
                    this.reconnectAttempts++;
                } else {
                    this.showError('Connection lost. Please check your network and try again.');
                }
            };
            
            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.showError('Failed to connect to the server');
                reject(error);
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.showError('Failed to create connection');
            reject(error);
        }
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }

    reconnect() {
        this.disconnect();
        setTimeout(() => {
            this.connect().catch(err => console.error('Reconnection failed:', err));
        }, 1000);
        // Reconnect button removed with header
    }

    send(data) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(data));
        }
    }

    // Current terminal grid size, sent with start_* so the PTY spawns at the
    // real width instead of the 80x24 default (which leaves a blank strip on
    // the right of wide screens).
    termDims() {
        return { cols: this.terminal?.cols, rows: this.terminal?.rows };
    }

    // Force the server PTY to match this client's terminal size. Used when
    // joining an already-running session (page reload / restored session): the
    // PTY may have been spawned at a different width and, since our terminal
    // size isn't changing, no onResize event would fire to correct it.
    syncPtySize() {
        this.fitTerminal();
        const { cols, rows } = this.termDims();
        if (cols && rows) this.send({ type: 'resize', cols, rows });
    }

    handleMessage(message) {
        switch (message.type) {
            case 'connected':
                this.connectionId = message.connectionId;
                break;
                
            case 'session_created':
                this.currentClaudeSessionId = message.sessionId;
                this.currentClaudeSessionName = message.sessionName;
                this.applySessionVisuals(message.sessionId); // per-session visual settings
                this.updateWorkingDir(message.workingDir);
                this.updateSessionButton(message.sessionName);
                this.loadSessions();
                
                // Add tab for the new session if using tab manager
                if (this.sessionTabManager) {
                    this.sessionTabManager.addTab(message.sessionId, message.sessionName, 'idle', message.workingDir);
                    this.sessionTabManager.switchToTab(message.sessionId);
                }
                
                this.showOverlay('startPrompt');
                break;
                
            case 'session_joined':
                console.log('[session_joined] Message received, active:', message.active, 'tabs:', this.sessionTabManager?.tabs.size);
                this.currentClaudeSessionId = message.sessionId;
                this.currentClaudeSessionName = message.sessionName;
                this.applySessionVisuals(message.sessionId); // per-session visual settings
                this.updateWorkingDir(message.workingDir);
                this.updateSessionButton(message.sessionName);

                // Update tab status
                if (this.sessionTabManager) {
                    this.sessionTabManager.updateTabStatus(message.sessionId, message.active ? 'active' : 'idle');
                }
                
                // Notify split container of session change
                if (this.splitContainer) {
                    this.splitContainer.onTabSwitch(message.sessionId);
                }
                
                // Resolve pending join promise if it exists
                if (this.pendingJoinResolve && this.pendingJoinSessionId === message.sessionId) {
                    this.pendingJoinResolve();
                    this.pendingJoinResolve = null;
                    this.pendingJoinSessionId = null;
                }
                
                // Replay output buffer if available
                if (message.outputBuffer && message.outputBuffer.length > 0) {
                    this.clearTerminalWriteQueue();
                    this.terminal.clear();
                    message.outputBuffer.forEach(data => {
                        // Filter out focus tracking sequences (^[[I and ^[[O)
                        const filteredData = data.replace(/\x1b\[\[?[IO]/g, '');
                        this.queueTerminalWrite(filteredData);
                    });
                }
                
                // Show appropriate UI based on session state
                console.log('[session_joined] Checking if should show overlay. Active:', message.active);
                if (message.active) {
                    console.log('[session_joined] Session is active, hiding overlay');
                    this.hideOverlay();
                    // Re-sync the PTY to our width (the session may have been
                    // spawned at a different size). A tick lets the terminal
                    // finish laying out before we measure it.
                    setTimeout(() => this.syncPtySize(), 50);
                    // Don't auto-focus to avoid focus tracking sequences
                    // User can click to focus when ready
                } else if (this.pendingStart) {
                    // The user hit Start before picking a folder; start now in the
                    // newly-created session instead of prompting a second time.
                    const { options } = this.pendingStart;
                    this.pendingStart = null;
                    this.startClaudeSession(options);
                } else {
                    // Session exists but Claude is not running
                    // Check if this is a brand new session (empty output buffer indicates new)
                    const isNewSession = !message.outputBuffer || message.outputBuffer.length === 0;

                    if (isNewSession) {
                        console.log('[session_joined] New session detected, showing start prompt');
                        this.showOverlay('startPrompt');
                    } else {
                        console.log('[session_joined] Existing session with stopped Claude, showing restart prompt');
                        // For existing sessions where Claude has stopped, show start prompt
                        // This allows the user to restart Claude in the same session
                        this.flushTerminalWrites();
                        this.terminal.writeln(`\r\n\x1b[33m${this.getAlias()} has stopped in this session. Click "Start ${this.getAlias()}" to restart.\x1b[0m`);
                        this.showOverlay('startPrompt');
                    }
                }
                break;
                
            case 'session_left':
                this.currentClaudeSessionId = null;
                this.currentClaudeSessionName = null;
                this.updateSessionButton('Sessions');
                this.clearTerminalWriteQueue();
                this.terminal.clear();

                // Update tab status
                if (this.sessionTabManager && message.sessionId) {
                    this.sessionTabManager.updateTabStatus(message.sessionId, 'disconnected');
                }
                
                // Only show start prompt if we don't have any tabs
                // When switching tabs, we leave one and join another, so don't show prompt
                if (!this.sessionTabManager || this.sessionTabManager.tabs.size === 0) {
                    this.showOverlay('startPrompt');
                }
                break;
                
            case 'claude_started':
                this.hideOverlay();
                // Don't auto-focus to avoid focus tracking sequences
                // User can click to focus when ready
                this.loadSessions(); // Refresh session list

                // Update tab status to active
                if (this.sessionTabManager && this.currentClaudeSessionId) {
                    this.sessionTabManager.updateTabStatus(this.currentClaudeSessionId, 'active');
                }
                break;
                
            case 'claude_stopped':
                this.flushTerminalWrites();
                this.terminal.writeln(`\r\n\x1b[33m${this.getAlias()} stopped\x1b[0m`);
                // Show start prompt to allow restarting Claude in this session
                this.showOverlay('startPrompt');
                this.loadSessions(); // Refresh session list
                break;
                
            case 'output':
                // Filter out focus tracking sequences (^[[I and ^[[O)
                const filteredData = message.data.replace(/\x1b\[\[?[IO]/g, '');
                this.queueTerminalWrite(filteredData);

                // Update session activity indicator with output data
                if (this.sessionTabManager && this.currentClaudeSessionId) {
                    this.sessionTabManager.markSessionActivity(this.currentClaudeSessionId, true, message.data);
                }
                break;
                
            case 'exit':
                this.flushTerminalWrites();
                this.terminal.writeln(`\r\n\x1b[33m${this.getAlias()} exited with code ${message.code}\x1b[0m`);
                
                // Mark session as error if non-zero exit code
                if (this.sessionTabManager && this.currentClaudeSessionId && message.code !== 0) {
                    this.sessionTabManager.markSessionError(this.currentClaudeSessionId, true);
                }
                
                this.showOverlay('startPrompt');
                this.loadSessions(); // Refresh session list
                break;
                
            case 'error':
                this.showError(message.message);
                
                // Mark session as having an error
                if (this.sessionTabManager && this.currentClaudeSessionId) {
                    this.sessionTabManager.markSessionError(this.currentClaudeSessionId, true);
                }
                break;
                
            case 'info':
                // Info message - show the start prompt if Claude is not running
                if (message.message.includes('not running')) {
                    this.showOverlay('startPrompt');
                }
                break;
                
            case 'session_deleted':
                this.showError(message.message);
                this.currentClaudeSessionId = null;
                this.currentClaudeSessionName = null;
                this.updateSessionButton('Sessions');
                if (this.sessionTabManager && message.sessionId) {
                    this.sessionTabManager.closeSession(message.sessionId, { skipServerRequest: true });
                }
                this.loadSessions();
                break;
                
            case 'pong':
                break;

            case 'hook_event':
                // Structured Claude Code hook event relayed by the server. The
                // ExitPlanMode PreToolUse event carries the full plan text —
                // this replaces the old terminal-scraping plan detector.
                if (message.tool_name === 'ExitPlanMode' &&
                    message.tool_input && message.tool_input.plan) {
                    this.showPlanModal({ content: message.tool_input.plan });
                }
                break;

            default:
                console.log('Unknown message type:', message.type);
        }
    }

    // Read the Claude launch options (model / permission mode) chosen in the
    // start prompt. Empty values are omitted so Claude uses its
    // own defaults. Passed through to `claude --model` / `--permission-mode`.
    claudeStartOptions() {
        const opts = {};
        const model = document.getElementById('claudeModelSelect')?.value || '';
        const permissionMode = document.getElementById('claudePermissionSelect')?.value || '';
        if (model) opts.model = model;
        if (permissionMode) opts.permissionMode = permissionMode;
        return opts;
    }

    // When a Start is requested but currentClaudeSessionId is momentarily null
    // (e.g. it fired during a refresh before session_joined landed), adopt the
    // already-selected tab instead of spawning a stray NEW session. Returns the
    // session id to start on, or null when there is genuinely no session/tab (the
    // caller then creates one).
    resolveStartSession() {
        if (this.currentClaudeSessionId) return this.currentClaudeSessionId;
        const stm = this.sessionTabManager;
        const activeTab = stm && stm.activeTabId;
        if (activeTab && stm.tabs.has(activeTab)) {
            this.currentClaudeSessionId = activeTab;
            // The server handles ws messages with an async handler it does not
            // serialize, and joinClaudeSession awaits a leave before it sets
            // wsInfo.claudeSessionId — so a start_* sent in this same tick can
            // overtake the join and come back "No session joined". Park the wait
            // here; the start callers await it before sending.
            this.pendingStartJoin = new Promise((resolve) => {
                this.pendingJoinResolve = resolve;
                this.pendingJoinSessionId = activeTab;
                this.send({ type: 'join_session', sessionId: activeTab });
                setTimeout(() => {
                    if (this.pendingJoinSessionId === activeTab) {
                        this.pendingJoinResolve = null;
                        this.pendingJoinSessionId = null;
                    }
                    resolve(); // don't hang the start if the ack never lands
                }, 2000);
            });
            return activeTab;
        }
        return null;
    }

    // Await a join issued by resolveStartSession, if there is one outstanding.
    async awaitPendingStartJoin() {
        if (!this.pendingStartJoin) return;
        const pending = this.pendingStartJoin;
        this.pendingStartJoin = null;
        await pending;
    }

    async startClaudeSession(options = {}) {
        // Require a project directory before starting — otherwise it would run in
        // the launch/home directory. Prompt for a folder first if none is chosen.
        if (this.ensureProjectFolder(options)) return;

        this.showOverlay('loadingSpinner');
        document.getElementById('loadingSpinner').querySelector('p').textContent =
            options.dangerouslySkipPermissions
                ? `Starting ${this.getAlias()} (skipping permissions)...`
                : `Starting ${this.getAlias()}...`;

        if (!this.resolveStartSession()) {
            const sessionName = `Session ${new Date().toLocaleString()}`;
            this.send({
                type: 'create_session',
                name: sessionName,
                workingDir: this.selectedWorkingDir
            });
            // Wait for session creation, then start
            setTimeout(() => {
                this.send({ type: 'start_claude', options, uiTheme: this.currentUiTheme(), ...this.termDims() });
            }, 500);
            return;
        }
        // Don't race the join we may have just issued (see resolveStartSession).
        await this.awaitPendingStartJoin();
        this.send({ type: 'start_claude', options, uiTheme: this.currentUiTheme(), ...this.termDims() });
    }

    clearTerminal() {
        this.clearTerminalWriteQueue();
        this.terminal.clear();
    }

    toggleMobileMenu() {
        const mobileMenu = document.getElementById('mobileMenu');
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        if (mobileMenu) mobileMenu.classList.toggle('active');
        if (hamburgerBtn) hamburgerBtn.classList.toggle('active');
    }

    closeMobileMenu() {
        const mobileMenu = document.getElementById('mobileMenu');
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        if (mobileMenu) mobileMenu.classList.remove('active');
        if (hamburgerBtn) hamburgerBtn.classList.remove('active');
    }

    // Bind the app's height to the *visual* viewport, not the layout viewport.
    // On mobile, 100dvh does NOT shrink when the soft keyboard opens — the
    // keyboard overlays the page — so the terminal keeps its full height and
    // Claude's bottom UI (the input box + the "bypass permissions … · ← for
    // agents" hint line) ends up hidden behind the keyboard. Driving the height
    // from visualViewport.height makes the terminal shrink exactly like a native
    // terminal window does, keeping that last line visible above the keyboard.
    setupViewportSizing() {
        const vv = window.visualViewport;

        const applyHeight = () => {
            const h = vv ? vv.height : window.innerHeight;
            document.documentElement.style.setProperty('--app-height', `${Math.round(h)}px`);
        };

        // Refitting the terminal (and messaging the PTY) is comparatively heavy,
        // and the keyboard open/close animation fires a burst of resize events —
        // so debounce the fit while updating the CSS height immediately (cheap).
        let refitTimer = null;
        const scheduleRefit = () => {
            if (refitTimer) return;
            refitTimer = requestAnimationFrame(() => {
                refitTimer = null;
                this.fitTerminal();
                // Keep pinned to the bottom so Claude's freshly-reflowed bottom UI
                // stays in view after the viewport changes.
                if (this.terminal) {
                    try { this.terminal.scrollToBottom(); } catch (_) {}
                }
                this.positionModeSwitcher();
            });
        };

        const onChange = () => { applyHeight(); scheduleRefit(); };

        if (vv) {
            vv.addEventListener('resize', onChange);
            vv.addEventListener('scroll', onChange);
        }
        window.addEventListener('resize', onChange);
        window.addEventListener('orientationchange', onChange);

        // Container size can change without a window resize — the tab bar
        // appearing/growing, or the terminal webfont finishing loading and
        // changing the cell metrics. Observe the wrapper (whose box is driven by
        // layout, not by terminal content, so this can't self-trigger a loop)
        // and refit so `rows` always matches what's actually visible.
        try {
            const wrapper = document.getElementById('terminal')?.parentElement;
            if (wrapper && 'ResizeObserver' in window) {
                new ResizeObserver(scheduleRefit).observe(wrapper);
            }
        } catch (_) {}

        // Refit once the terminal font has loaded — its cell height can differ
        // from the fallback font used at first paint, which otherwise leaves the
        // initial `rows` off by a line or two.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(scheduleRefit).catch(() => {});
        }

        // Prime it once on startup.
        applyHeight();
    }

    // Queue terminal output for batched rendering on the next animation frame.
    // Coalescing many small chunks into one write per frame keeps the render
    // loop from falling behind under Claude Code's heavy repaints.
    queueTerminalWrite(data) {
        if (!data) return;
        this._termWriteQueue.push(data);
        this._pendingBytes += data.length;
        this._maybeFlowPause();
        if (!this._termWriteScheduled) {
            this._termWriteScheduled = true;
            requestAnimationFrame(() => this.flushTerminalWrites());
        }
    }

    // Flush queued output to xterm as a single write. Safe to call synchronously
    // (e.g. before writing a status line) to preserve ordering with the stream.
    // The write callback fires once xterm has parsed the chunk, so it's the
    // right place to decrement the backpressure watermark.
    flushTerminalWrites() {
        this._termWriteScheduled = false;
        if (!this._termWriteQueue || this._termWriteQueue.length === 0) return;
        const chunk = this._termWriteQueue.join('');
        this._termWriteQueue.length = 0;
        if (this.terminal) {
            const len = chunk.length;
            this.terminal.write(chunk, () => {
                this._pendingBytes = Math.max(0, this._pendingBytes - len);
                this._maybeFlowResume();
            });
        }
    }

    // Drop any pending output (used when switching/clearing sessions so stale
    // bytes from the previous session can't land after the clear). Resets the
    // backpressure watermark and lifts any pause we were holding.
    clearTerminalWriteQueue() {
        if (this._termWriteQueue) this._termWriteQueue.length = 0;
        this._termWriteScheduled = false;
        this._pendingBytes = 0;
        if (this._flowPaused) {
            this._flowPaused = false;
            this.send({ type: 'resume' });
        }
    }

    // Ask the server to pause the PTY once the unrendered backlog is too large.
    _maybeFlowPause() {
        if (!this._flowPaused && this._pendingBytes > this._flowHigh) {
            this._flowPaused = true;
            this.send({ type: 'pause' });
        }
    }

    // Resume once the backlog has drained back below the low watermark.
    _maybeFlowResume() {
        if (this._flowPaused && this._pendingBytes < this._flowLow) {
            this._flowPaused = false;
            this.send({ type: 'resume' });
        }
    }

    fitTerminal() {
        if (this.fitAddon) {
            try {
                this.fitAddon.fit();
                
                // On mobile, ensure terminal doesn't exceed viewport width
                if (this.isMobile) {
                    const terminalElement = document.querySelector('.xterm');
                    if (terminalElement) {
                        const viewportWidth = window.innerWidth;
                        const currentWidth = terminalElement.offsetWidth;
                        
                        if (currentWidth > viewportWidth) {
                            // Reduce columns to fit viewport
                            const charWidth = currentWidth / this.terminal.cols;
                            const maxCols = Math.floor((viewportWidth - 20) / charWidth);
                            this.terminal.resize(maxCols, this.terminal.rows);
                        }
                    }
                }
            } catch (error) {
                console.error('Error fitting terminal:', error);
            }
        }
    }

    updateStatus(status) {
        // Status display removed with header - status now shown in tabs
        console.log('Status:', status);
    }

    updateWorkingDir(dir) {
        // Working dir display removed with header - shown in tab titles
        this.currentWorkingDir = dir || null;
        console.log('Working directory:', dir);
    }

    // Whether starting an assistant should first prompt for a project folder.
    // True when there is no chosen directory, or the directory would be the
    // launch/home directory (which we don't treat as a real project).
    needsFolderSelection() {
        const dir = this.currentClaudeSessionId ? this.currentWorkingDir : this.selectedWorkingDir;
        if (!dir) return true;
        // Not a real project: the launch dir, the user's home, or filesystem root.
        if (this.baseFolder && dir === this.baseFolder) return true;
        if (this.homeDir && dir === this.homeDir) return true;
        if (dir === '/') return true;
        return false;
    }

    // Open the folder browser to pick a project, routing the selection into the
    // new-session flow. Returns true if selection was required (caller should
    // stop and let the user choose).
    ensureProjectFolder(options) {
        if (!this.needsFolderSelection()) return false;
        // Remember the start the user asked for so it can run in the folder they
        // are about to choose, instead of prompting them twice.
        this.pendingStart = { options: options || {} };
        this.isCreatingNewSession = true;
        this.hideOverlay(); // hide the start prompt behind the folder browser
        this.showFolderBrowser();
        return true;
    }

    // Cancelling folder selection abandons any pending auto-start.
    cancelFolderBrowser() {
        this.pendingStart = null;
        this.isCreatingNewSession = false;
        this.closeFolderBrowser();
    }

    showOverlay(contentId) {
        const overlay = document.getElementById('overlay');
        const contents = ['loadingSpinner', 'startPrompt', 'errorMessage'];
        
        contents.forEach(id => {
            document.getElementById(id).style.display = id === contentId ? 'block' : 'none';
        });
        
        overlay.style.display = 'flex';
        // The overlay covers the whole viewport at z-index 5000, which would
        // otherwise swallow every click on the tab bar. This flag is what lets
        // the stylesheet lift the chrome above it — see the tab-bar/overlay
        // block in style.css. These two methods are the only places the
        // overlay's display is written, so the flag can't drift out of sync.
        document.body.classList.add('overlay-open');
    }

    hideOverlay() {
        const overlay = document.getElementById('overlay');
        if (overlay) {
            console.log('[hideOverlay] Hiding overlay, current display:', overlay.style.display);
            overlay.style.display = 'none';
            console.log('[hideOverlay] Overlay hidden, new display:', overlay.style.display);
        } else {
            console.error('[hideOverlay] Overlay element not found!');
        }
        document.body.classList.remove('overlay-open');
    }

    showError(message) {
        document.getElementById('errorText').textContent = message;
        this.showOverlay('errorMessage');
    }

    showSettings() {
        const modal = document.getElementById('settingsModal');
        modal.classList.add('active');
        
        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }
        
        // Make it clear these settings apply to the ACTIVE session.
        const title = document.getElementById('settingsTitle');
        if (title) {
            const name = this.currentClaudeSessionId ? (this.currentClaudeSessionName || 'this session') : null;
            title.textContent = name ? `Settings — ${name}` : 'Settings';
        }

        const settings = this.loadSettings(this.currentClaudeSessionId);
        document.getElementById('fontSize').value = settings.fontSize;
        document.getElementById('fontSizeValue').textContent = settings.fontSize + 'px';
        const themeSelect = document.getElementById('themeSelect');
        if (themeSelect) themeSelect.value = settings.theme === 'light' ? 'light' : 'dark';
        const ss = document.getElementById('smoothScroll');
        if (ss) {
            ss.value = settings.smoothScrollDuration;
            document.getElementById('smoothScrollValue').textContent = settings.smoothScrollDuration + 'ms';
        }
        this.loadPlanDirsUI();
        this.loadScrollbackUI();
    }

    // Scrollback depth is a SERVER setting, unlike the visual ones above: it
    // decides what is written to disk and replayed over the socket, so it cannot
    // live in this browser's localStorage. Read it fresh each time the panel
    // opens — another device may have changed it.
    async loadScrollbackUI() {
        const input = document.getElementById('scrollbackChunks');
        if (!input) return;
        try {
            const res = await this.authFetch('/api/settings/scrollback');
            if (!res.ok) return;
            const data = await res.json();
            input.value = data.chunks;
            if (Number.isInteger(data.min)) input.min = data.min;
            if (Number.isInteger(data.max)) input.max = data.max;
        } catch (_) { /* leave the markup default; saving still works */ }
    }

    hideSettings() {
        document.getElementById('settingsModal').classList.remove('active');

        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }
    }

    // Fetch the server's configured plan dirs (+ auto-covered session roots) and
    // render them in Settings. Server-side state, so it's read fresh each open.
    async loadPlanDirsUI() {
        const list = document.getElementById('planDirsList');
        const sid = this.currentClaudeSessionId;
        if (!sid) {
            if (list) { list.innerHTML = ''; list.appendChild(this._planDirNote('Start a session to configure its plan directories.')); }
            return;
        }
        try {
            const res = await this.authFetch('/api/plan-dirs?sessionId=' + encodeURIComponent(sid));
            if (!res.ok) return;
            this.renderPlanDirs(await res.json());
        } catch (_) { /* best-effort */ }
    }

    _planDirNote(text) {
        const el = document.createElement('div');
        el.className = 'plan-dir-row plan-dir-empty';
        el.textContent = text;
        return el;
    }

    renderPlanDirs(data) {
        const list = document.getElementById('planDirsList');
        if (!list) return;
        const dirs = (data && data.dirs) || [];
        const globalDirs = (data && data.globalDirs) || [];
        const sessionRoots = (data && data.sessionRoots) || [];
        list.innerHTML = '';
        if (!dirs.length) {
            list.appendChild(this._planDirNote('No extra directories for this session.'));
        } else {
            for (const dir of dirs) {
                const row = document.createElement('div');
                row.className = 'plan-dir-row';
                const p = document.createElement('span');
                p.className = 'plan-dir-path';
                p.textContent = dir; // textContent — never innerHTML (paths are data)
                p.title = dir;
                const rm = document.createElement('button');
                rm.className = 'plan-dir-remove';
                rm.setAttribute('data-remove-dir', dir);
                rm.title = 'Remove';
                rm.textContent = '×';
                row.appendChild(p);
                row.appendChild(rm);
                list.appendChild(row);
            }
        }
        // Global dirs (shared base, read-only here — set via --plans-dir).
        for (const dir of globalDirs) {
            const row = document.createElement('div');
            row.className = 'plan-dir-row plan-dir-global';
            const p = document.createElement('span');
            p.className = 'plan-dir-path';
            p.textContent = dir;
            p.title = dir;
            const tag = document.createElement('span');
            tag.className = 'plan-dir-tag';
            tag.textContent = 'global';
            row.appendChild(p);
            row.appendChild(tag);
            list.appendChild(row);
        }
        // Only refresh the hint when we have session roots (i.e. from the GET,
        // not from a POST response which omits them).
        const hint = document.getElementById('planDirsHint');
        if (hint && sessionRoots.length) {
            hint.textContent = "This session's .claude/plans is always available. Auto-covered: " + sessionRoots.join(', ');
        }
    }

    async postPlanDirs(dirs) {
        const sid = this.currentClaudeSessionId;
        if (!sid) return null;
        try {
            const res = await this.authFetch('/api/plan-dirs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sid, dirs })
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (_) { return null; }
    }

    currentPlanDirRows() {
        return Array.from(document.querySelectorAll('#planDirsList [data-remove-dir]'))
            .map((b) => b.getAttribute('data-remove-dir'));
    }

    async addPlanDir() {
        const input = document.getElementById('planDirInput');
        if (!input) return;
        const val = input.value.trim();
        if (!val) return;
        const data = await this.postPlanDirs([...this.currentPlanDirRows(), val]);
        if (!data) return;
        input.value = '';
        this.renderPlanDirs(data);
        if (data.rejected && data.rejected.length) {
            this.showNotification('Not added: ' + data.rejected.map((r) => `${r.dir} (${r.reason})`).join(', '));
        }
    }

    async removePlanDir(dir) {
        const data = await this.postPlanDirs(this.currentPlanDirRows().filter((d) => d !== dir));
        if (data) this.renderPlanDirs(data);
    }

    // Visual settings are PER-SESSION: keyed by sessionId in localStorage. A new
    // session (no stored entry) inherits the global default (`cc-web-settings`),
    // which tracks the most recently saved settings — so your latest preferences
    // become the default for new sessions while each existing session keeps its own.
    loadSettings(sessionId) {
        const defaults = {
            fontSize: 14,
            theme: 'dark',
            // Desktop wheel-scroll animation in ms. 0 = instant (snappiest);
            // higher feels smoother/heavier. Mobile always uses 0 (its own
            // touch-momentum handler drives scrolling).
            smoothScrollDuration: 100
        };
        try {
            if (sessionId) {
                const map = JSON.parse(localStorage.getItem('cc-web-session-settings') || '{}');
                if (map && map[sessionId]) return { ...defaults, ...map[sessionId] };
            }
            const global = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
            return { ...defaults, ...global };
        } catch (error) {
            console.error('Failed to load settings:', error);
            return defaults;
        }
    }

    saveSettings() {
        const settings = {
            fontSize: parseInt(document.getElementById('fontSize').value),
            theme: (document.getElementById('themeSelect')?.value) || 'dark',
            smoothScrollDuration: parseInt(document.getElementById('smoothScroll')?.value ?? 100)
        };
        try {
            // Update the global default (latest wins → new sessions inherit it).
            localStorage.setItem('cc-web-settings', JSON.stringify(settings));
            // And store as the active session's own settings.
            const sid = this.currentClaudeSessionId;
            if (sid) {
                const map = JSON.parse(localStorage.getItem('cc-web-session-settings') || '{}');
                map[sid] = settings;
                localStorage.setItem('cc-web-session-settings', JSON.stringify(map));
            }
            this.applySettings(settings);
            this.saveScrollbackSetting();
            this.hideSettings();
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }

    // Fire-and-report: the panel closes either way. A server setting failing to
    // save should say so, not hold the visual settings hostage — those already
    // went to localStorage by the time this runs.
    async saveScrollbackSetting() {
        const input = document.getElementById('scrollbackChunks');
        if (!input) return;
        const chunks = parseInt(input.value, 10);
        if (!Number.isInteger(chunks)) return;
        try {
            const res = await this.authFetch('/api/settings/scrollback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chunks })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                this.showToast(data.error || 'Could not save the scrollback setting', true);
                return;
            }
            // The server clamps to its own range, so report what it actually
            // took rather than letting the panel claim a number it did not.
            input.value = data.chunks;
            if (data.chunks !== chunks) {
                this.showToast(`Scrollback set to ${data.chunks} chunks (the allowed limit)`);
            }
        } catch (_) {
            this.showToast('Could not save the scrollback setting', true);
        }
    }

    // Apply a settings object live (no reload) to the main terminal + splits.
    applySettings(settings) {
        this.applyTheme(settings.theme);
        this.terminal.options.fontSize = settings.fontSize;
        const scrollDur = this.isMobile ? 0 : settings.smoothScrollDuration;
        this.terminal.options.smoothScrollDuration = scrollDur;
        if (this.splitContainer && this.splitContainer.splits) {
            this.splitContainer.splits.forEach((sp) => {
                if (sp && sp.terminal) {
                    sp.terminal.options.smoothScrollDuration = scrollDur;
                    sp.terminal.options.fontSize = settings.fontSize;
                }
            });
        }
        this.fitTerminal();
    }

    // Which palette the terminal is actually painted with. Sent with start_claude
    // so Claude's own theme matches the background we draw behind it.
    currentUiTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    // Live theme switch (no page reload): flip the `data-theme` attribute (CSS
    // chrome) and re-apply the xterm palette to every terminal.
    applyTheme(theme) {
        if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        const t = (typeof getTerminalTheme === 'function') ? getTerminalTheme() : null;
        if (t) {
            this.terminal.options.theme = t;
            if (this.splitContainer && this.splitContainer.splits) {
                this.splitContainer.splits.forEach((sp) => {
                    if (sp && sp.terminal) sp.terminal.options.theme = t;
                });
            }
        }
    }

    // Apply a session's stored visual settings when it becomes the active tab.
    applySessionVisuals(sessionId) {
        this.applySettings(this.loadSettings(sessionId));
    }

    startHeartbeat() {
        setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.send({ type: 'ping' });
            }
        }, 30000);
    }

    // Folder Browser Methods
    setupFolderBrowser() {
        const modal = document.getElementById('folderBrowserModal');
        const upBtn = document.getElementById('folderUpBtn');
        const homeBtn = document.getElementById('folderHomeBtn');
        const selectBtn = document.getElementById('selectFolderBtn');
        const cancelBtn = document.getElementById('cancelFolderBtn');
        const showHiddenCheckbox = document.getElementById('showHiddenFolders');
        const createFolderBtn = document.getElementById('createFolderBtn');
        const confirmCreateBtn = document.getElementById('confirmCreateFolderBtn');
        const cancelCreateBtn = document.getElementById('cancelCreateFolderBtn');
        const newFolderInput = document.getElementById('newFolderNameInput');
        
        upBtn.addEventListener('click', () => this.navigateToParent());
        homeBtn.addEventListener('click', () => this.navigateToHome());

        // Let the path bar be typed into: Enter navigates to the entered path,
        // Escape restores the current path. (Was readonly before.)
        const pathInput = document.getElementById('currentPathInput');
        if (pathInput) {
            pathInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const target = pathInput.value.trim();
                    if (target) this.loadFolders(target);
                } else if (e.key === 'Escape') {
                    pathInput.value = this.currentFolderPath || '';
                    pathInput.blur();
                }
            });
        }
        selectBtn.addEventListener('click', () => this.selectCurrentFolder());
        cancelBtn.addEventListener('click', () => this.cancelFolderBrowser());
        showHiddenCheckbox.addEventListener('change', () => this.loadFolders(this.currentFolderPath));
        createFolderBtn.addEventListener('click', () => this.showCreateFolderInput());
        confirmCreateBtn.addEventListener('click', () => this.createFolder());
        cancelCreateBtn.addEventListener('click', () => this.hideCreateFolderInput());
        
        // Allow Enter key to create folder
        newFolderInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.createFolder();
            } else if (e.key === 'Escape') {
                this.hideCreateFolderInput();
            }
        });
        
        // Close modal when clicking outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.cancelFolderBrowser();
            }
        });
    }

    async showFolderBrowser() {
        const modal = document.getElementById('folderBrowserModal');
        modal.classList.add('active');
        
        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }
        
        // Load home directory by default
        await this.loadFolders();
    }

    closeFolderBrowser() {
        const modal = document.getElementById('folderBrowserModal');
        modal.classList.remove('active');
        
        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }
        
        // Reset the creating new session flag if canceling
        this.isCreatingNewSession = false;
        
        // If no folder selected, show error
        if (!this.currentFolderPath) {
            this.showError('You must select a folder to continue');
        }
    }

    async loadFolders(path = null) {
        const showHidden = document.getElementById('showHiddenFolders').checked;
        const params = new URLSearchParams();
        if (path) params.append('path', path);
        if (showHidden) params.append('showHidden', 'true');
        
        try {
            const response = await this.authFetch(`/api/folders?${params}`);
            if (!response.ok) {
                // Handle 401 specifically - show auth prompt
                if (response.status === 401) {
                    console.log('Authentication required - showing login prompt');
                    window.authManager.showLoginPrompt();
                    return;
                }
                const error = await response.json();
                throw new Error(error.message || 'Failed to load folders');
            }
            
            const data = await response.json();
            this.currentFolderPath = data.currentPath;
            this.renderFolders(data);
        } catch (error) {
            console.error('Failed to load folders:', error);
            this.showError(`Failed to load folders: ${error.message}`);
        }
    }

    renderFolders(data) {
        const pathInput = document.getElementById('currentPathInput');
        const folderList = document.getElementById('folderList');
        const upBtn = document.getElementById('folderUpBtn');
        
        // Update path display
        pathInput.value = data.currentPath;
        
        // Enable/disable up button
        upBtn.disabled = !data.parentPath;
        
        // Clear and populate folder list
        folderList.innerHTML = '';

        // ".." entry to step up to the parent, reachable directly from the list
        // (in addition to the up-arrow in the path bar). Shown even when there
        // are no subfolders, so you're never stuck in a leaf directory.
        if (data.parentPath) {
            const upItem = document.createElement('div');
            upItem.className = 'folder-item folder-item-parent';
            upItem.innerHTML = `
                <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 19a2 2 0 0 0 2-2V9l-2-3H9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2z"/>
                    <polyline points="12 15 9 12 12 9"/>
                    <line x1="9" y1="12" x2="16" y2="12"/>
                </svg>
                <span class="folder-name">.. (parent directory)</span>
            `;
            upItem.addEventListener('click', () => this.loadFolders(data.parentPath));
            folderList.appendChild(upItem);
        }

        if (data.folders.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-folder-message';
            empty.textContent = data.parentPath ? 'No subfolders here' : 'No folders found';
            folderList.appendChild(empty);
            return;
        }

        data.folders.forEach(folder => {
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';
            folderItem.innerHTML = `
                <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="folder-name">${folder.name}</span>
                ${folder.isSymlink ? '<span class="folder-symlink" title="Symbolic link">↗</span>' : ''}
            `;
            folderItem.addEventListener('click', () => this.loadFolders(folder.path));
            folderList.appendChild(folderItem);
        });
    }

    async navigateToParent() {
        if (this.currentFolderPath) {
            const parentPath = this.currentFolderPath.split('/').slice(0, -1).join('/') || '/';
            await this.loadFolders(parentPath);
        }
    }

    async navigateToHome() {
        await this.loadFolders();
    }

    showCreateFolderInput() {
        const createBar = document.getElementById('folderCreateBar');
        const input = document.getElementById('newFolderNameInput');
        createBar.style.display = 'flex';
        input.value = '';
        input.focus();
    }

    hideCreateFolderInput() {
        const createBar = document.getElementById('folderCreateBar');
        const input = document.getElementById('newFolderNameInput');
        createBar.style.display = 'none';
        input.value = '';
    }

    async createFolder() {
        const input = document.getElementById('newFolderNameInput');
        const folderName = input.value.trim();
        
        if (!folderName) {
            this.showError('Please enter a folder name');
            return;
        }
        
        if (folderName.includes('/') || folderName.includes('\\')) {
            this.showError('Folder name cannot contain path separators');
            return;
        }
        
        try {
            const response = await this.authFetch('/api/create-folder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    parentPath: this.currentFolderPath || '/',
                    folderName: folderName
                })
            });
            
            if (!response.ok) {
                // Handle 401 specifically - show auth prompt
                if (response.status === 401) {
                    console.log('Authentication required - showing login prompt');
                    window.authManager.showLoginPrompt();
                    return;
                }
                const error = await response.json();
                throw new Error(error.message || 'Failed to create folder');
            }
            
            // Hide the input and reload the folder list
            this.hideCreateFolderInput();
            await this.loadFolders(this.currentFolderPath);
        } catch (error) {
            console.error('Failed to create folder:', error);
            this.showError(`Failed to create folder: ${error.message}`);
        }
    }

    async selectCurrentFolder() {
        if (!this.currentFolderPath) {
            this.showError('No folder selected');
            return;
        }
        
        // Store the selected working directory
        this.selectedWorkingDir = this.currentFolderPath;
        
        // If not connected yet, connect first with the selected directory
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            try {
                // Set the working directory on the server
                const response = await this.authFetch('/api/folders/select', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ path: this.currentFolderPath })
                });
                
                if (!response.ok) throw new Error('Failed to set working directory');
                
                const data = await response.json();
                this.selectedWorkingDir = data.workingDir;
                
                // Update UI - working dir now shown in tab titles
                
                // Close folder browser
                this.closeFolderBrowser();
                
                // Connect to the server
                await this.connect();
                
                // Show new session modal with folder name pre-filled
                this.showNewSessionModal();
                const folderName = this.selectedWorkingDir.split('/').pop() || 'Session';
                document.getElementById('sessionName').value = folderName;
                document.getElementById('sessionWorkingDir').value = this.selectedWorkingDir;
                return;
            } catch (error) {
                console.error('Failed to set working directory:', error);
                this.showError('Failed to set working directory');
                return;
            }
        }
        
        // If we're creating a new session (either no active session OR explicitly creating new)
        if (!this.currentClaudeSessionId || this.isCreatingNewSession) {
            this.closeFolderBrowser();
            this.showNewSessionModal();
            // Pre-fill the session name with folder name and working directory
            const folderName = this.currentFolderPath.split('/').pop() || 'Session';
            document.getElementById('sessionName').value = folderName;
            document.getElementById('sessionWorkingDir').value = this.currentFolderPath;
            this.isCreatingNewSession = false; // Reset the flag
            return;
        }
        
        // Otherwise, set working directory for current session
        try {
            const response = await this.authFetch('/api/set-working-dir', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ path: this.currentFolderPath })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to set working directory');
            }
            
            const result = await response.json();
            console.log('Working directory set to:', result.workingDir);
            
            // Close folder browser and connect
            this.closeFolderBrowser();
            await this.connect();
        } catch (error) {
            console.error('Failed to set working directory:', error);
            this.showError(`Failed to set working directory: ${error.message}`);
        }
    }
    
    async closeSession() {
        try {
            // Send close session message via WebSocket if connected
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.send({ type: 'close_session' });
            }
            
            // Clear the working directory on the server
            const response = await this.authFetch('/api/close-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to close session');
            }
            
            // Reset the local state
            this.selectedWorkingDir = null;
            this.currentFolderPath = null;
            
            // Hide the close session button
            // Close session buttons removed with header
            
            // Disconnect WebSocket
            this.disconnect();
            
            // Clear terminal
            this.clearTerminal();
            
            // Show folder browser again
            this.showFolderBrowser();
            
        } catch (error) {
            console.error('Failed to close session:', error);
            this.showError(`Failed to close session: ${error.message}`);
        }
    }

    // Session Management Methods
    toggleSessionDropdown() {
        // Session dropdown removed with header - using tabs instead
    }
    
    showMobileSessionsModal() {
        document.getElementById('mobileSessionsModal').classList.add('active');
        
        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }
        
        this.loadMobileSessions();
    }
    
    hideMobileSessionsModal() {
        document.getElementById('mobileSessionsModal').classList.remove('active');
        
        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }
    }
    
    async loadMobileSessions() {
        try {
            const response = await this.authFetch('/api/sessions/list');
            if (!response.ok) throw new Error('Failed to load sessions');
            
            const data = await response.json();
            this.claudeSessions = data.sessions;
            this.renderMobileSessionList();
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }
    
    renderMobileSessionList() {
        const sessionList = document.getElementById('mobileSessionList');
        sessionList.innerHTML = '';
        
        if (this.claudeSessions.length === 0) {
            sessionList.innerHTML = '<div class="no-sessions">No active sessions</div>';
            return;
        }
        
        this.claudeSessions.forEach(session => {
            const sessionItem = document.createElement('div');
            sessionItem.className = 'session-item';
            if (session.id === this.currentClaudeSessionId) {
                sessionItem.classList.add('active');
            }
            
            const statusIcon = `<span class="dot ${session.active ? 'dot-on' : 'dot-idle'}"></span>`;
            const clientsText = session.connectedClients === 1 ? '1 client' : `${session.connectedClients} clients`;
            
            sessionItem.innerHTML = `
                <div class="session-info">
                    <span class="session-status">${statusIcon}</span>
                    <div class="session-details">
                        <div class="session-name">${session.name}</div>
                        <div class="session-meta">${clientsText} • ${new Date(session.created).toLocaleTimeString()}</div>
                        ${session.workingDir ? `<div class=\"session-folder\" title=\"${session.workingDir}\"><span class=\"icon\" aria-hidden=\"true\">${window.icons?.folder?.(14) || ''}</span> ${session.workingDir.split('/').pop() || '/'}</div>` : ''}
                    </div>
                </div>
                <div class="session-actions">
                    ${session.id === this.currentClaudeSessionId ? 
                        '<button class="btn-icon" title="Leave session" data-action="leave"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></button>' :
                        '<button class="btn-icon" title="Join session" data-action="join"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></button>'
                    }
                    <button class="btn-icon" title="Delete session" data-action="delete">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            `;
            
            sessionItem.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const action = btn.dataset.action;
                    if (action === 'join') {
                        this.joinSession(session.id);
                        this.hideMobileSessionsModal();
                    } else if (action === 'leave') {
                        this.leaveSession(session.id);
                        this.hideMobileSessionsModal();
                    } else if (action === 'delete') {
                        if (confirm(`Delete session "${session.name}"?`)) {
                            this.deleteSession(session.id);
                        }
                    }
                });
            });
            
            sessionList.appendChild(sessionItem);
        });
    }

    // Reconcile picker: shown on refresh only when the persisted tab set doesn't
    // match the server. Lists every server session; the user checks which to open
    // as tabs, picks the active one, can delete strays, or create a new session.
    showSessionReconcileModal(reconcile) {
        const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const { server = [], persisted = { ids: [], activeId: null }, dead = [], extra = [] } = reconcile || {};
        const persistedIds = new Set(persisted.ids);
        document.querySelectorAll('.session-reconcile-modal').forEach((m) => m.remove());
        const modal = document.createElement('div');
        modal.className = 'session-modal active session-reconcile-modal';
        const rows = server.map((sv) => {
            const checked = persistedIds.has(sv.id) ? 'checked' : '';
            const isActive = sv.id === persisted.activeId;
            const folder = sv.workingDir ? sv.workingDir.split('/').filter(Boolean).pop() : '';
            const statusText = sv.active ? this.getAlias() + ' running' : 'idle';
            return `
            <div class="session-item reconcile-row" data-id="${esc(sv.id)}">
              <input type="checkbox" class="rc-open" ${checked}>
              <div class="session-details">
                <div class="session-name">${esc(sv.name)}</div>
                <div class="session-meta"><span class="dot ${sv.active ? 'dot-on' : 'dot-idle'}"></span> ${esc(statusText)}${folder ? ' · ' + esc(folder) : ''}</div>
              </div>
              <label class="rc-current" title="Make this the active session"><input type="radio" name="rc-active" value="${esc(sv.id)}" ${isActive ? 'checked' : ''}> Active</label>
              <button class="btn-icon rc-del" title="Delete session">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>`;
        }).join('');
        const notes = [];
        const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        if (dead.length) notes.push(`${plural(dead.length, 'tab points', 'tabs point')} at a session that no longer exists; it will be dropped.`);
        if (extra.length) notes.push(`${plural(extra.length, 'session is', 'sessions are')} new to this browser — tick the ones to open.`);
        modal.innerHTML = `
          <div class="modal-content">
            <div class="modal-header"><h2>Restore sessions</h2></div>
            <p class="rc-note">Your tabs don't match the sessions on the server. Choose which to open:</p>
            ${notes.map((n) => `<p class="rc-note">${esc(n)}</p>`).join('')}
            <div class="session-list">${rows || '<div class="no-sessions">No sessions</div>'}</div>
            <div class="modal-actions">
              <button class="btn btn-secondary" id="rcNew">+ New session</button>
              <button class="btn btn-primary" id="rcConfirm">Open</button>
            </div>
          </div>`;
        document.body.appendChild(modal);

        modal.querySelectorAll('.rc-del').forEach((btn) => btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const row = btn.closest('.reconcile-row');
            const id = row && row.dataset.id;
            if (id && confirm('Delete this session? This cannot be undone.')) { this.deleteSession(id, { skipConfirm: true }); row.remove(); }
        }));
        modal.querySelector('#rcNew').addEventListener('click', () => { modal.remove(); this.showFolderBrowser(); });
        modal.querySelector('#rcConfirm').addEventListener('click', async () => {
            const rowsEls = [...modal.querySelectorAll('.reconcile-row')];
            const chosen = rowsEls.filter((r) => r.querySelector('.rc-open').checked).map((r) => r.dataset.id);
            const activeRadio = modal.querySelector('input[name="rc-active"]:checked');
            let activeId = activeRadio ? activeRadio.value : (chosen[0] || null);
            if (activeId && !chosen.includes(activeId)) activeId = chosen[0] || null;
            modal.remove();
            const stm = this.sessionTabManager;
            const byId = new Map(server.map((s) => [s.id, s]));
            // Keep the persisted order for surviving ids, then append newly-chosen ones.
            const ordered = [...persisted.ids.filter((id) => chosen.includes(id)), ...chosen.filter((id) => !persisted.ids.includes(id))];
            ordered.forEach((id) => { const sv = byId.get(id); if (sv) stm.addTab(sv.id, sv.name, sv.active ? 'active' : 'idle', sv.workingDir, false); });
            // Sessions still on the server but left unchecked = seen-but-not-opened;
            // remember them so a later refresh doesn't re-prompt for the same ones.
            const chosenSet = new Set(chosen);
            // rowsEls was captured before modal.remove(); deleted rows are already
            // gone from it. Remaining-but-unchecked rows = seen-but-not-opened.
            const ignoredIds = rowsEls.map((r) => r.dataset.id).filter((id) => !chosenSet.has(id));
            stm.saveTabState(ignoredIds);
            if (activeId) { await stm.switchToTab(activeId); this.hideOverlay(); }
            else { this.hideOverlay(); this.showFolderBrowser(); }
        });
    }

    async loadSessions() {
        try {
            const response = await this.authFetch('/api/sessions/list');
            if (!response.ok) throw new Error('Failed to load sessions');
            
            const data = await response.json();
            this.claudeSessions = data.sessions;
            this.renderSessionList();
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }
    
    renderSessionList() {
        // This method is deprecated - sessions are now displayed as tabs
        // The sessionList element no longer exists as we use tabs instead
        // Keeping empty method to avoid errors from old code references
        return;
    }
    
    handleSessionAction(action, sessionId) {
        switch (action) {
            case 'join':
                this.joinSession(sessionId);
                break;
            case 'leave':
                this.leaveSession();
                break;
            case 'delete':
                this.deleteSession(sessionId);
                break;
        }
    }
    
    async joinSession(sessionId) {
        // Ensure we're connected first
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            // Check if we're already connecting (readyState === 0 means CONNECTING)
            if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
                // Wait for existing connection to complete
                await new Promise((resolve) => {
                    const checkConnection = setInterval(() => {
                        if (this.socket.readyState === WebSocket.OPEN) {
                            clearInterval(checkConnection);
                            resolve();
                        }
                    }, 50);
                    // Timeout after 5 seconds
                    setTimeout(() => {
                        clearInterval(checkConnection);
                        resolve();
                    }, 5000);
                });
            } else {
                // No socket or socket is closed, create new connection
                await this.connect();
                // Wait a bit for connection to establish
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // Create a promise that resolves when we receive session_joined message
        return new Promise((resolve) => {
            // Store the resolve function to call when we get the response
            this.pendingJoinResolve = resolve;
            this.pendingJoinSessionId = sessionId;
            
            // Send the join request
            this.send({ type: 'join_session', sessionId });
            
            // Set a timeout in case the response never comes
            setTimeout(() => {
                if (this.pendingJoinResolve) {
                    this.pendingJoinResolve = null;
                    this.pendingJoinSessionId = null;
                    resolve(); // Resolve anyway after timeout
                }
            }, 2000);
        });
    }
    
    leaveSession() {
        this.send({ type: 'leave_session' });
        // Session dropdown removed - using tabs
    }
    
    // skipConfirm: for callers that already asked (the reconcile picker), so the
    // user isn't made to confirm the same deletion twice.
    async deleteSession(sessionId, { skipConfirm = false } = {}) {
        if (!skipConfirm && !confirm('Are you sure you want to delete this session? This will stop any running Claude process.')) {
            return;
        }

        try {
            const response = await this.authFetch(`/api/sessions/${sessionId}`, {
                method: 'DELETE'
            });
            
            if (!response.ok) throw new Error('Failed to delete session');
            
            this.loadSessions();
            
            if (sessionId === this.currentClaudeSessionId) {
                this.currentClaudeSessionId = null;
                this.currentClaudeSessionName = null;
                this.updateSessionButton('Sessions');
                this.clearTerminalWriteQueue();
                this.terminal.clear();
                this.showOverlay('startPrompt');
            }
        } catch (error) {
            console.error('Failed to delete session:', error);
            this.showError('Failed to delete session');
        }
    }
    
    updateSessionButton(text) {
        // Session button removed with header - using tabs instead
        console.log('Session:', text);
    }
    
    setupNewSessionModal() {
        const modal = document.getElementById('newSessionModal');
        const closeBtn = document.getElementById('closeNewSessionBtn');
        const cancelBtn = document.getElementById('cancelNewSessionBtn');
        const createBtn = document.getElementById('createSessionBtn');
        const nameInput = document.getElementById('sessionName');
        const dirInput = document.getElementById('sessionWorkingDir');
        
        closeBtn.addEventListener('click', () => this.hideNewSessionModal());
        cancelBtn.addEventListener('click', () => this.hideNewSessionModal());
        createBtn.addEventListener('click', () => this.createNewSession());
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideNewSessionModal();
            }
        });
        
        // Allow Enter key to create session
        [nameInput, dirInput].forEach(input => {
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.createNewSession();
                }
            });
        });
    }
    
    setupMobileSessionsModal() {
        const closeMobileSessionsBtn = document.getElementById('closeMobileSessionsModal');
        const newSessionBtnMobile = document.getElementById('newSessionBtnMobile');
        
        if (closeMobileSessionsBtn) {
            closeMobileSessionsBtn.addEventListener('click', () => this.hideMobileSessionsModal());
        }
        if (newSessionBtnMobile) {
            newSessionBtnMobile.addEventListener('click', () => {
                this.hideMobileSessionsModal();
                // Show folder picker for new session
                this.isCreatingNewSession = true;
                this.selectedWorkingDir = null;
                this.currentFolderPath = null;
                this.showFolderBrowser();
            });
        }
    }
    
    showNewSessionModal() {
        document.getElementById('newSessionModal').classList.add('active');
        // Session dropdown removed - using tabs
        
        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }
        
        document.getElementById('sessionName').focus();
    }
    
    hideNewSessionModal() {
        document.getElementById('newSessionModal').classList.remove('active');
        
        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }
        
        document.getElementById('sessionName').value = '';
        document.getElementById('sessionWorkingDir').value = '';
    }
    
    async createNewSession() {
        const name = document.getElementById('sessionName').value.trim() || `Session ${new Date().toLocaleString()}`;
        const workingDir = document.getElementById('sessionWorkingDir').value.trim() || this.selectedWorkingDir;
        
        if (!workingDir) {
            this.showError('Please select a working directory first');
            return;
        }
        
        try {
            const response = await this.authFetch('/api/sessions/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, workingDir })
            });
            
            if (!response.ok) throw new Error('Failed to create session');
            
            const data = await response.json();
            
            // Hide the modal
            this.hideNewSessionModal();
            
            // Add tab for the new session
            if (this.sessionTabManager) {
                this.sessionTabManager.addTab(data.sessionId, name, 'idle', workingDir);
                // switchToTab will handle joining the session
                await this.sessionTabManager.switchToTab(data.sessionId);
            } else {
                // No tab manager, join directly
                await this.joinSession(data.sessionId);
            }
            
            // Update sessions list
            this.loadSessions();
        } catch (error) {
            console.error('Failed to create session:', error);
            this.showError('Failed to create session');
        }
    }
    
    setupPlanDetector() {
        // Plan detection is now driven by structured Claude Code hook events
        // (see the 'hook_event' WebSocket case) instead of scraping terminal
        // output. This only wires the plan modal's buttons.
        this.planModal = document.getElementById('planModal');

        const acceptBtn = document.getElementById('acceptPlanBtn');
        const rejectBtn = document.getElementById('rejectPlanBtn');
        const closeBtn = document.getElementById('closePlanBtn');

        if (acceptBtn) acceptBtn.addEventListener('click', () => this.acceptPlan());
        if (rejectBtn) rejectBtn.addEventListener('click', () => this.rejectPlan());
        if (closeBtn) closeBtn.addEventListener('click', () => this.hidePlanModal());
    }
    
    showPlanModal(plan) {
        const modal = document.getElementById('planModal');
        const content = document.getElementById('planContent');

        content.innerHTML = this.renderPlanMarkdown(plan.content || '');
        modal.classList.add('active');

        // Play a subtle notification sound (optional)
        this.playNotificationSound();
    }
    
    // Render the plan markdown (from Claude's ExitPlanMode tool_input.plan) to
    // safe HTML. HTML is escaped first (the text is model output), fenced code
    // blocks are pulled out before inline formatting so their contents aren't
    // mangled by the bold/italic/backtick passes, then headings and inline marks
    // are applied to the prose. The container is `white-space: pre-wrap`, so
    // line breaks are preserved without extra <br>/<p> wrapping.
    renderPlanMarkdown(md) {
        const esc = (s) => s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 1) Extract fenced code blocks to placeholders (before escaping prose).
        const blocks = [];
        let text = md.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, code) => {
            const i = blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`) - 1;
            return ` CB${i} `;
        });

        // 2) Escape the remaining prose, then apply block/inline markdown.
        text = esc(text)
            .replace(/^### (.*)$/gm, '<h3>$1</h3>')
            .replace(/^## (.*)$/gm, '<h2>$1</h2>')
            .replace(/^# (.*)$/gm, '<h1>$1</h1>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // 3) Restore the code blocks.
        return text.replace(/ CB(\d+) /g, (_, i) => blocks[Number(i)]);
    }

    hidePlanModal() {
        const modal = document.getElementById('planModal');
        modal.classList.remove('active');
    }
    
    acceptPlan() {
        // Current Claude presents plan approval as a menu (❯1. Yes … / 2 / 3),
        // not a y/n prompt. Enter selects the highlighted default ("Yes"), which
        // approves the plan. (The old 'y\n' only worked by accident via the \n.)
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'input',
                data: '\r' // Enter → approve (select default menu item)
            }));
        }
        
        this.hidePlanModal();

        // Show confirmation
        this.showNotification('Plan accepted! Claude will begin implementation.');
    }
    
    rejectPlan() {
        // Reject = back out of the plan-approval menu. Escape cancels the menu
        // and returns to plan mode (verified against Claude 2.1.218) without
        // approving. (The old 'n\n' actually approved: 'n' isn't a menu key and
        // the trailing newline selected the default "Yes".)
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'input',
                data: '\x1b' // Escape → cancel approval, stay in plan mode
            }));
        }
        
        this.hidePlanModal();

        // Show confirmation
        this.showNotification('Plan rejected. You can provide feedback to Claude.');
    }
    
    updatePlanModeIndicator(isActive) {
        const statusElement = document.getElementById('status');
        if (!statusElement) return; // No explicit status area in current UI
        if (isActive) {
            statusElement.innerHTML = `<span class="icon" style="color: var(--success);">${window.icons?.clipboard?.(14) || ''}</span> Plan Mode Active`;
        } else {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                statusElement.textContent = 'Connected';
                statusElement.className = 'status connected';
            }
        }
    }
    
    showNotification(message) {
        // Simple notification - you could enhance this with a toast notification
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--accent);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 10002;
            animation: slideIn 0.3s ease;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
    playNotificationSound() {
        // Optional: Play a subtle sound when plan is detected
        // You can add an audio element to play a notification sound
        try {
            const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBRld0Oy9diMFl2+z2e7NeSgFxYvg+8SEIwW3we6eVg0FqOTupjMBSanLvV0OBba37J5QCgU4cLvfvn0cBUCd1Oq2yFSvvayILgm359+2pw8HVqfu3LNDCEij59+NLwBarvfZN20aBVGU4OyrdR0Ff5/i5paFFDGD0+ylVBYF3NTaz38nBThl4fDbmU0NF1PD5uyqUBcIJJDO5buGNggMoNvyx08FB1er/OykQRIKrau3mHs0BQ5azvfZx30VBbDe3LVmFAVK0PC1vnoPC42S4ObNozsJB1Ox58+TYyAKL5zN9r19JAWFz9P6s4s6C2uz+L2VJwUUncflwpdMC0HD5d5sFAVWv+PYiEQIDXq16eyxlSAK57vi75NkBqOZ88WzlnAHl9TmsS8JBaLj4rQ8BigO1/rPuIMtBjGI1PG+kCcFxoTg+bxnMwfSfOL55LVeCn/R+Mltbw8FBpP48KBwKgtDqPDfnzsLCJDZ/dpTWRUHo+S6+M9+lQdRp/DdnysJFXG559GdWwgTgN7z04k2Be/B8d2AUAILJLTy2Y8xBZmduvneOxYFy6H24LhpGgWunuznm0sTDbXm9bldBQuK6u7LfxUIPLH74Z5CBRt37uWmTRgB7ez+0ogeCi+J0Oe4X');
            audio.volume = 0.3;
            audio.play();
        } catch (e) {
            // Ignore sound errors
        }
    }

}

// Add animation keyframes
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

document.addEventListener('DOMContentLoaded', () => {
    const app = new ClaudeCodeWebInterface();
    window.app = app;
    app.startHeartbeat();
});

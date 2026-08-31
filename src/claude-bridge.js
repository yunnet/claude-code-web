const { spawn } = require('node-pty');
const path = require('path');
const fs = require('fs');

class ClaudeBridge {
  constructor() {
    this.sessions = new Map();
    this.claudeCommand = this.findClaudeCommand();
  }

  findClaudeCommand() {
    const possibleCommands = [
      '/home/ec2-user/.claude/local/claude',
      'claude',
      'claude-code',
      path.join(process.env.HOME || '/', '.claude', 'local', 'claude'),
      path.join(process.env.HOME || '/', '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude'
    ];

    for (const cmd of possibleCommands) {
      try {
        if (fs.existsSync(cmd) || this.commandExists(cmd)) {
          console.log(`Found Claude command at: ${cmd}`);
          return cmd;
        }
      } catch (error) {
        continue;
      }
    }

    console.error('Claude command not found, using default "claude"');
    return 'claude';
  }

  commandExists(command) {
    try {
      require('child_process').execFileSync('which', [command], { stdio: 'ignore' });
      return true;
    } catch (error) {
      return false;
    }
  }

  async startSession(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const {
      workingDir = process.cwd(),
      uiTheme = '',
      dangerouslySkipPermissions = false,
      resume = false,
      model = '',
      permissionMode = '',
      onOutput = () => {},
      onExit = () => {},
      onError = () => {},
      cols = 80,
      rows = 24,
      // Hook relay wiring (from the server). When all three are present we
      // register a Claude Code PreToolUse(ExitPlanMode) hook so plan mode is
      // detected via a structured event instead of scraping the terminal.
      hookScript = '',
      hookPort = 0,
      hookToken = ''
    } = options;

    // Args shared by a fresh launch and a resume.
    const baseArgs = dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : [];
    // Route Claude's notification events (task finished / needs input /
    // permission prompt) to the terminal bell — the BEL travels PTY→WS→xterm and
    // the client's onBell turns it into a beep + notification. Injected via
    // --settings so the user's own settings.json is untouched.
    baseArgs.push('--settings', JSON.stringify(
      this.buildInjectedSettings(sessionId, { hookScript, hookPort, hookToken, uiTheme })
    ));

    // Optional model / permission-mode chosen in the UI. Whitelisted so a bad
    // value can't reach the CLI (spawn uses an argv array, so there is no shell
    // injection risk either). --dangerously-skip-permissions wins over an
    // explicit permission mode.
    if (model && ['opus', 'sonnet', 'haiku'].includes(model)) {
      baseArgs.push('--model', model);
    }
    if (!dangerouslySkipPermissions && permissionMode &&
        ['plan', 'acceptEdits', 'default'].includes(permissionMode)) {
      baseArgs.push('--permission-mode', permissionMode);
    }

    // Spawn Claude bound to our stable session id. `--session-id <uuid>` starts a
    // brand-new conversation under that id; `--resume <uuid>` re-attaches to it
    // later (after a server restart or a dead PTY) so the conversation is NOT
    // lost. The id is the cc-web session's own uuid.
    const spawnClaude = (mode) => {
      const idArgs = mode === 'resume' ? ['--resume', sessionId] : ['--session-id', sessionId];
      console.log(`Starting Claude session ${sessionId} [${mode}] cwd=${workingDir} size=${cols}x${rows}`);
      if (dangerouslySkipPermissions) {
        console.log(`⚠️ WARNING: Skipping permissions with --dangerously-skip-permissions flag`);
      }
      // Make every spawned Claude a clean TOP-LEVEL session. If cc-web itself was
      // launched from inside a Claude session, the inherited CLAUDE_CODE_CHILD_SESSION
      // marker turns OFF transcript saving — which would make --resume find nothing
      // ("No conversation found") and silently break session recovery. Drop that
      // marker and force session persistence so conversations are always saved and
      // resumable, regardless of how cc-web was started.
      const childEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
        // Force synchronized output (DEC mode 2026): xterm 6.0 supports it, so
        // Claude wraps each frame in BSU/ESU and repaints atomically — no
        // stream flicker/tearing over the WebSocket.
        CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1',
        // Persist transcripts so --resume can restore the conversation.
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1'
      };
      // Hook relay token: inherited by the ExitPlanMode hook (cc-hook.js) via the
      // environment instead of argv, so it doesn't leak through /proc/<pid>/cmdline.
      if (hookToken) childEnv.CCWEB_HOOK_TOKEN = hookToken;
      delete childEnv.CLAUDE_CODE_CHILD_SESSION;
      return spawn(this.claudeCommand, [...idArgs, ...baseArgs], {
        cwd: workingDir,
        env: childEnv,
        cols,
        rows,
        // 256-color terminfo to match TERM above.
        name: 'xterm-256color'
      });
    };

    try {
      let mode = resume ? 'resume' : 'fresh';
      let launchedAt = Date.now();
      let fellBack = false;
      let trustPromptHandled = false;
      let inUseNoted = false;
      let phantomRecovered = false;
      let dataBuffer = '';

      const session = {
        process: null,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null
      };
      this.sessions.set(sessionId, session);

      // Wire the PTY's data/exit/error handlers. Extracted so we can re-wire a
      // replacement process when a failed --resume falls back to a fresh launch.
      // Each handler ignores events from a stale process (one we've already
      // replaced), so the fallback swap can't corrupt session state.
      const wire = (proc) => {
        proc.onData((data) => {
          if (proc !== session.process) return; // stale process — ignore
          if (process.env.DEBUG) {
            console.log(`Session ${sessionId} output:`, data);
          }
          dataBuffer += data;
          // Resume fallback (interactive): Claude prints "No conversation found"
          // WITHOUT exiting when the id is unknown. Detect it and relaunch fresh
          // once, bound to the same id, so the session recovers instead of
          // sitting on an error. (Belt-and-suspenders with the exit check below.)
          if (mode === 'resume' && !fellBack && dataBuffer.includes('No conversation found')) {
            triggerFallback('no conversation found');
            return; // swallow the failed-resume output; fresh process takes over
          }
          // Fresh launch collided with a still-registered session id (a phantom
          // left by an interrupted start). Explain it once; the circuit breaker
          // on the server side stops the retry loop.
          if (mode === 'fresh' && !inUseNoted && dataBuffer.toLowerCase().includes('already in use')) {
            inUseNoted = true;
            onOutput('\r\n\x1b[33mThis session id is already in use (a stuck/phantom session). If it keeps failing, create a new session.\x1b[0m\r\n');
          }
          if (!trustPromptHandled && dataBuffer.includes('Do you trust the files in this folder?')) {
            trustPromptHandled = true;
            console.log(`Auto-accepting trust prompt for session ${sessionId}`);
            setTimeout(() => {
              try { session.process.write('\r'); } catch (_) {}
              console.log(`Sent Enter to accept trust prompt for session ${sessionId}`);
            }, 500);
          }
          if (dataBuffer.length > 10000) {
            dataBuffer = dataBuffer.slice(-5000);
          }
          onOutput(data);
        });

        proc.onExit((exitCode, signal) => {
          if (proc !== session.process) return; // stale process — ignore
          // node-pty may report exit as (code, signal) or a single
          // {exitCode, signal} object depending on version — normalise it.
          const code = (exitCode && typeof exitCode === 'object') ? exitCode.exitCode : exitCode;
          const sig = (exitCode && typeof exitCode === 'object') ? exitCode.signal : signal;

          // Resume fallback: re-attach failed fast (e.g. bad session state) —
          // relaunch fresh once.
          if (mode === 'resume' && !fellBack && code !== 0 && (Date.now() - launchedAt) < 8000) {
            triggerFallback(`quick exit code ${code}`);
            return; // swallow the failed-resume exit; fresh process takes over
          }

          // Phantom self-heal: a fresh launch that dies fast on "already in use"
          // means the id is registered but empty (an interrupted start left only a
          // bridge-session line — resume found no conversation, fresh can't claim
          // it). Delete that empty transcript and retry fresh once so the session
          // just works instead of getting stuck.
          const looksInUse = inUseNoted || dataBuffer.toLowerCase().includes('already in use');
          if (mode === 'fresh' && !phantomRecovered && code !== 0 && (Date.now() - launchedAt) < 8000 && looksInUse) {
            phantomRecovered = true;
            if (this.clearEmptyTranscript(sessionId)) {
              // We are inside a PTY event handler — the enclosing try/catch has
              // long since returned, so a spawn failure here would surface as an
              // uncaughtException and take the server down. Fall through to the
              // normal exit path instead. (No kill of the old process: it is the
              // one that just exited.)
              try {
                launchedAt = Date.now();
                inUseNoted = false;
                dataBuffer = '';
                console.log(`Cleared empty phantom transcript for ${sessionId}; retrying fresh`);
                session.process = spawnClaude('fresh');
                wire(session.process);
                return; // swallow this exit; the retried process takes over
              } catch (err) {
                console.error(`Phantom retry failed to spawn for ${sessionId}:`, err);
              }
            }
          }

          console.log(`Claude session ${sessionId} exited with code ${code}, signal ${sig}`);
          if (session.killTimeout) {
            clearTimeout(session.killTimeout);
            session.killTimeout = null;
          }
          session.active = false;
          this.sessions.delete(sessionId);
          onExit(exitCode, signal);
        });

        proc.on('error', (error) => {
          if (proc !== session.process) return; // stale process — ignore
          console.error(`Claude session ${sessionId} error:`, error);
          if (session.killTimeout) {
            clearTimeout(session.killTimeout);
            session.killTimeout = null;
          }
          session.active = false;
          this.sessions.delete(sessionId);
          onError(error);
        });
      };

      // Swap the current (failed-resume) process for a fresh one bound to the
      // same id. Only ever runs once (guarded by `fellBack`).
      const triggerFallback = (reason) => {
        fellBack = true;
        mode = 'fresh';
        launchedAt = Date.now();
        trustPromptHandled = false;
        dataBuffer = '';
        const old = session.process;
        console.log(`Resume fallback for ${sessionId} (${reason}); starting a fresh session`);
        // Guarded for the same reason as the phantom retry below: this runs from
        // a PTY data handler, outside the enclosing try/catch.
        try {
          session.process = spawnClaude('fresh'); // becomes the new current process
          wire(session.process);
          if (old && old !== session.process) { try { old.kill(); } catch (_) {} }
        } catch (err) {
          console.error(`Resume fallback failed to spawn for ${sessionId}:`, err);
        }
      };

      session.process = spawnClaude(mode);
      wire(session.process);

      console.log(`Claude session ${sessionId} started successfully [${mode}]`);
      return session;

    } catch (error) {
      console.error(`Failed to start Claude session ${sessionId}:`, error);
      throw new Error(`Failed to start Claude Code: ${error.message}`);
    }
  }

  // Build the settings object injected via `claude --settings`. Always routes
  // notifications to the terminal bell; when hook-relay params are present it
  // also registers a PreToolUse(ExitPlanMode) hook whose command relays the plan
  // event to the server via bin/cc-hook.js. Claude presents a plan by calling
  // the ExitPlanMode tool, so PreToolUse fires with the full plan in
  // tool_input.plan. argv strings are single-quote escaped; token/session are
  // uuids so there is no shell-injection risk. Extracted so it is unit-testable
  // without spawning a PTY.
  // Delete an EMPTY Claude transcript for this session id (only a bridge-session
  // metadata line, no user/assistant turns) so a stuck "already in use" id can be
  // reclaimed with --session-id. Safe: it only removes a tiny file with no real
  // conversation. Globs across project dirs so we don't depend on the dir-encoding.
  // Also drops the id's session-env dir, which is dead once the transcript is.
  clearEmptyTranscript(sessionId) {
    // The id is interpolated into paths we then delete — one of them recursively,
    // inside the user's home. Ids are server-minted uuids, but they also round-trip
    // through sessions.json, so re-check the shape rather than trust the caller.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId || ''))) {
      return false;
    }
    try {
      const os = require('os');
      const root = path.join(os.homedir(), '.claude', 'projects');
      if (!fs.existsSync(root)) return false;
      for (const proj of fs.readdirSync(root)) {
        const f = path.join(root, proj, `${sessionId}.jsonl`);
        if (!fs.existsSync(f)) continue;
        const st = fs.statSync(f);
        if (st.size >= 4096) continue; // real conversations are far bigger
        const content = fs.readFileSync(f, 'utf8');
        if (/"type"\s*:\s*"(user|assistant)"/.test(content)) continue; // has real turns
        fs.unlinkSync(f);
        try { fs.rmSync(path.join(os.homedir(), '.claude', 'session-env', sessionId), { recursive: true, force: true }); } catch (_) {}
        return true;
      }
    } catch (_) { /* best-effort */ }
    return false;
  }

  // Claude's theme has to match the background WE paint, because the browser
  // terminal is the background. On light we ask for `light-ansi` rather than
  // `light`: the truecolor `light` theme rules its input box in #999999, which
  // is 2.85:1 on our white canvas — effectively invisible, and nothing on our
  // side can lift it (white is already the highest-contrast light background for
  // that grey). The `-ansi` variant draws the same chrome in ANSI colours, which
  // come from OUR palette, so contrast is ours to guarantee (ANSI 7 = #6e7781,
  // 4.49:1). Dark needs no such help, so it keeps the richer truecolor theme.
  static themeForUi(uiTheme) {
    return uiTheme === 'light' ? 'light-ansi' : 'dark';
  }

  buildInjectedSettings(sessionId, { hookScript = '', hookPort = 0, hookToken = '', uiTheme = '' } = {}) {
    const settings = { preferredNotifChannel: 'terminal_bell' };
    if (uiTheme === 'light' || uiTheme === 'dark') {
      settings.theme = ClaudeBridge.themeForUi(uiTheme);
    }
    if (hookScript && hookPort && hookToken) {
      // The token is passed to cc-hook.js via the CCWEB_HOOK_TOKEN env var (set
      // on the spawned Claude, inherited by its hooks), NOT on the command line:
      // argv is world-readable via /proc/<pid>/cmdline, whereas /proc/<pid>/environ
      // is owner-only. port/session are non-secret and stay as argv.
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const command = `${q(process.execPath)} ${q(hookScript)} --port ${Number(hookPort)} --session ${q(sessionId)}`;
      settings.hooks = {
        PreToolUse: [
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command }] }
        ]
      };
    }
    return settings;
  }

  async sendInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.write(data);
    } catch (error) {
      throw new Error(`Failed to send input to session ${sessionId}: ${error.message}`);
    }
  }

  async resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.resize(cols, rows);
    } catch (error) {
      console.warn(`Failed to resize session ${sessionId}:`, error.message);
    }
  }

  // Flow control: stop/resume reading from the PTY. When paused, node-pty stops
  // draining the pty master, so the child (Claude) blocks once the OS buffer
  // fills — backpressure that lets a slow browser catch up instead of the
  // server buffering output unboundedly.
  pause(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.process) {
      try { session.process.pause(); } catch (_) { /* pty may not support */ }
    }
  }

  resume(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.process) {
      try { session.process.resume(); } catch (_) { /* pty may not support */ }
    }
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      // Clear any existing kill timeout
      if (session.killTimeout) {
        clearTimeout(session.killTimeout);
        session.killTimeout = null;
      }

      if (session.active && session.process) {
        session.process.kill('SIGTERM');
        
        session.killTimeout = setTimeout(() => {
          if (session.active && session.process) {
            session.process.kill('SIGKILL');
          }
        }, 5000);
      }
    } catch (error) {
      console.warn(`Error stopping session ${sessionId}:`, error.message);
    }

    session.active = false;
    this.sessions.delete(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      workingDir: session.workingDir,
      created: session.created,
      active: session.active
    }));
  }

  async cleanup() {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }
  }

}

module.exports = ClaudeBridge;
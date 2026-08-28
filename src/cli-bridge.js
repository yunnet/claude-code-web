const { spawn } = require('node-pty');
const path = require('path');
const fs = require('fs');

const HOME = process.env.HOME || '/';

// ponytail: one bridge for the CLIs that only differ by binary name + search
// paths (+ whether they take a "dangerous" flag). Codex and the generic Agent
// were byte-for-byte identical apart from those. Claude keeps its own bridge —
// it also injects hook settings and does resume/session-id, so it's genuinely
// different.
const codexConfig = {
  label: 'Codex',
  commandCandidates: [
    path.join(HOME, '.codex', 'local', 'codex'),
    'codex',
    'codex-code',
    path.join(HOME, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/usr/bin/codex'
  ],
  defaultCommand: 'codex',
  dangerousFlag: '--dangerously-bypass-approvals-and-sandbox'
};

const agentConfig = {
  label: 'Agent',
  commandCandidates: [
    path.join(HOME, '.cursor', 'local', 'cursor-agent'),
    'cursor-agent',
    path.join(HOME, '.local', 'bin', 'cursor-agent'),
    '/usr/local/bin/cursor-agent',
    '/usr/bin/cursor-agent'
  ],
  defaultCommand: 'cursor-agent',
  dangerousFlag: null // Agent has no bypass-approvals flag.
};

class CliBridge {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.command = this.findCommand();
  }

  findCommand() {
    for (const cmd of this.config.commandCandidates) {
      try {
        if (fs.existsSync(cmd) || this.commandExists(cmd)) {
          console.log(`Found ${this.config.label} command at: ${cmd}`);
          return cmd;
        }
      } catch (error) {
        continue;
      }
    }
    console.error(`${this.config.label} command not found, using default "${this.config.defaultCommand}"`);
    return this.config.defaultCommand;
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
      dangerouslySkipPermissions = false,
      onOutput = () => {},
      onExit = () => {},
      onError = () => {},
      cols = 80,
      rows = 24
    } = options;

    try {
      const label = this.config.label;
      console.log(`Starting ${label} session ${sessionId}`);
      console.log(`Command: ${this.command}`);
      console.log(`Working directory: ${workingDir}`);
      console.log(`Terminal size: ${cols}x${rows}`);

      const args = (this.config.dangerousFlag && dangerouslySkipPermissions)
        ? [this.config.dangerousFlag]
        : [];
      if (args.length) {
        console.log(`⚠️ WARNING: Bypassing approvals and sandbox with ${this.config.dangerousFlag} flag`);
      }

      const child = spawn(this.command, args, {
        cwd: workingDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
          COLORTERM: 'truecolor'
        },
        cols,
        rows,
        name: 'xterm-256color'
      });

      const session = {
        process: child,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null
      };
      this.sessions.set(sessionId, session);

      let dataBuffer = '';
      child.onData((data) => {
        if (process.env.DEBUG) {
          console.log(`${label} session ${sessionId} output:`, data);
        }
        dataBuffer += data;
        if (dataBuffer.length > 10000) dataBuffer = dataBuffer.slice(-5000);
        onOutput(data);
      });

      child.onExit((exitCode, signal) => {
        console.log(`${label} session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
        if (session.killTimeout) { clearTimeout(session.killTimeout); session.killTimeout = null; }
        session.active = false;
        this.sessions.delete(sessionId);
        onExit(exitCode, signal);
      });

      child.on('error', (error) => {
        console.error(`${label} session ${sessionId} error:`, error);
        if (session.killTimeout) { clearTimeout(session.killTimeout); session.killTimeout = null; }
        session.active = false;
        this.sessions.delete(sessionId);
        onError(error);
      });

      console.log(`${label} session ${sessionId} started successfully`);
      return session;
    } catch (error) {
      console.error(`Failed to start ${this.config.label} session ${sessionId}:`, error);
      throw new Error(`Failed to start ${this.config.label}: ${error.message}`);
    }
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

  // Flow control: pause/resume reading from the PTY (see claude-bridge).
  pause(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.process) { try { session.process.pause(); } catch (_) {} }
  }

  resume(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.process) { try { session.process.resume(); } catch (_) {} }
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      if (session.killTimeout) { clearTimeout(session.killTimeout); session.killTimeout = null; }
      if (session.active && session.process) {
        session.process.kill('SIGTERM');
        session.killTimeout = setTimeout(() => {
          if (session.active && session.process) session.process.kill('SIGKILL');
        }, 5000);
      }
    } catch (error) {
      console.warn(`Error stopping ${this.config.label} session ${sessionId}:`, error.message);
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
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.stopSession(sessionId);
    }
  }
}

module.exports = { CliBridge, codexConfig, agentConfig };

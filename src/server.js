const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const ClaudeBridge = require('./claude-bridge');
const SessionStore = require('./utils/session-store');
const gitBranches = require('./git-branches');

class ClaudeCodeWebServer {
  constructor(options = {}) {
    this.port = options.port || 32352;
    // A short fingerprint of the source tree, computed once at startup, so two
    // instances (dev 32353 / stable 32352) can be compared at a glance in the UI:
    // same buildId = same code, different = one side wasn't redeployed.
    this.buildId = this.computeBuildId();
    this.auth = options.auth;
    this.noAuth = options.noAuth || false;
    this.dev = options.dev || false;
    this.useHttps = options.https || false;
    this.certFile = options.cert;
    this.keyFile = options.key;
    this.folderMode = options.folderMode !== false; // Default to true
    this.selectedWorkingDir = null;
    this.baseFolder = process.cwd(); // The folder where the app runs from
    // Explicit plan directories for GET /api/plan. When non-empty they OVERRIDE
    // the default (auto-discovered `<project>/.claude/plans`): only files under
    // these dirs are served, and the `.claude/plans` path segment isn't required.
    // Runtime-editable list of extra plan directories. A persisted list (edited
    // via /api/plan-dirs) takes precedence; otherwise seed from --plans-dir.
    const seededPlanDirs = (options.planDirs || []).map((p) => path.resolve(p));
    const persistedPlanDirs = this.loadPlanDirs();
    this.planDirs = persistedPlanDirs !== null ? persistedPlanDirs : seededPlanDirs;
    this.app = express();
    this.claudeSessions = new Map(); // Persistent sessions, keyed by session id
    this.webSocketConnections = new Map(); // Maps WebSocket connection ID to session info
    // Single-use, short-lived credentials for ONE file each (see createFileTicket).
    // They are what lets the explorer render html/svg without putting the
    // long-lived auth token in a URL the rendered page can read back.
    this.fileTickets = new Map();
    this.claudeBridge = new ClaudeBridge();
    this.sessionStore = new SessionStore();
    this.autoSaveInterval = null;
    this.startTime = Date.now(); // Track server start time
    this.isShuttingDown = false; // Flag to prevent duplicate shutdown
    // Commands dropdown removed
    // Assistant aliases (for UI display only)
    this.aliases = {
      claude: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
    };
    
    this.setupExpress();
    this.loadPersistedSessions();
    this.setupAutoSave();
  }
  
  async loadPersistedSessions() {
    try {
      const sessions = await this.sessionStore.loadSessions();
      this.claudeSessions = sessions;
      if (sessions.size > 0) {
        console.log(`Loaded ${sessions.size} persisted sessions`);
      }
    } catch (error) {
      console.error('Failed to load persisted sessions:', error);
    }
  }
  
  setupAutoSave() {
    // Auto-save sessions every 30 seconds
    this.autoSaveInterval = setInterval(() => {
      this.saveSessionsToDisk();
    }, 30000);

    // Also save on process exit. Keep references so dispose() can remove them:
    // otherwise every server instance leaks these listeners, and the beforeExit
    // handler (which does async I/O) re-arms the event loop forever, hanging any
    // process that constructs a server without listening (e.g. the test run).
    this._onSigint = () => this.handleShutdown();
    this._onSigterm = () => this.handleShutdown();
    this._onBeforeExit = () => this.saveSessionsToDisk();
    process.on('SIGINT', this._onSigint);
    process.on('SIGTERM', this._onSigterm);
    process.on('beforeExit', this._onBeforeExit);
  }

  // Release the auto-save timer and the process listeners registered in
  // setupAutoSave, so a disposed server no longer keeps the process alive.
  dispose() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
    if (this._onSigint) process.removeListener('SIGINT', this._onSigint);
    if (this._onSigterm) process.removeListener('SIGTERM', this._onSigterm);
    if (this._onBeforeExit) process.removeListener('beforeExit', this._onBeforeExit);
    this._onSigint = this._onSigterm = this._onBeforeExit = null;
  }
  
  async saveSessionsToDisk() {
    if (this.claudeSessions.size > 0) {
      await this.sessionStore.saveSessions(this.claudeSessions);
    }
  }
  
  async handleShutdown() {
    // Prevent multiple shutdown attempts
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    console.log('\nGracefully shutting down...');
    await this.saveSessionsToDisk();
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    this.close();
    process.exit(0);
  }

  isPathWithinBase(targetPath) {
    // The folder browser must let a NEW session be created in ANY project
    // directory, so navigation is not locked to the launch directory — a user
    // creating a session picks wherever their project lives. `baseFolder` is
    // only the default starting directory shown when the browser opens (and the
    // target of the "home" button). This is a local, auth-protected tool running
    // as the user, so it may browse anywhere the user's own account can.
    // Any resolvable absolute path is allowed.
    try {
      path.resolve(targetPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Express 4 does not catch a rejected promise from an `async` handler: it
  // surfaces as an unhandledRejection, and Node 22 turns that into process
  // exit — taking every live PTY with it. A single `?path=a&path=b` did
  // exactly that, because a repeated query param arrives as an Array and
  // path.resolve throws on it. Every async route goes through this wrapper, so
  // a throw ends as a 500 the way it would in a sync handler.
  static asyncRoute(handler) {
    return (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch((error) => {
        console.error('[async route]', req.method, req.originalUrl, error);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error', message: error.message });
      });
    };
  }

  // A query param can arrive as a string, as undefined, or — when it is
  // repeated — as an Array. Callers want the single-string case or nothing.
  static singleQueryValue(value) {
    if (value === undefined) return { ok: true, value: undefined };
    if (typeof value === 'string') return { ok: true, value };
    return { ok: false };
  }

  validatePath(targetPath) {
    if (!targetPath) {
      return { valid: false, error: 'Path is required' };
    }
    
    const resolvedPath = path.resolve(targetPath);
    
    if (!this.isPathWithinBase(resolvedPath)) {
      return { 
        valid: false, 
        error: 'Access denied: Path is outside the allowed directory' 
      };
    }
    
    return { valid: true, path: resolvedPath };
  }

  setupExpress() {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Serve manifest.json with correct MIME type
    this.app.get('/manifest.json', (req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
    });
    
    this.app.use(express.static(path.join(__dirname, 'public')));

    // PWA Icon routes - generate icons dynamically
    const iconSizes = [16, 32, 144, 180, 192, 512];
    iconSizes.forEach(size => {
      this.app.get(`/icon-${size}.png`, (req, res) => {
        // Single green Claude-robot icon for the browser tab / PWA / apple-touch.
        // Fixed 24-unit viewBox scaled to `size`, so it stays crisp at 16px too.
        const svg = `
          <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <rect width="24" height="24" rx="5" fill="#2ea043"/>
            <g fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="2.5" x2="12" y2="5"/>
              <rect x="4" y="5" width="16" height="15" rx="4"/>
              <path d="M9 11h.01M15 11h.01"/>
              <path d="M9 16c1.2 .9 2.4 .9 3.6 0"/>
            </g>
          </svg>
        `;
        const svgBuffer = Buffer.from(svg);
        res.setHeader('Content-Type', 'image/svg+xml');
        // Short cache so an icon change actually reaches users (the previous
        // one-year cache was why a stale icon stuck around).
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(svgBuffer);
      });
    });

    // Auth status endpoint - always accessible
    this.app.get('/auth-status', (req, res) => {
      res.json({ 
        authRequired: !this.noAuth && !!this.auth,
        authenticated: false 
      });
    });

    // Auth verify endpoint - check if token is valid
    this.app.post('/auth-verify', (req, res) => {
      if (this.noAuth || !this.auth) {
        return res.json({ valid: true }); // No auth required
      }
      
      const { token } = req.body;
      const valid = token === this.auth;
      
      if (valid) {
        res.json({ valid: true });
      } else {
        res.status(401).json({ valid: false, error: 'Invalid token' });
      }
    });

    // Claude Code hook relay endpoint. bin/cc-hook.js (invoked by Claude via the
    // hooks injected in claude-bridge) POSTs its event JSON here; we forward it
    // over WebSocket to the session's browsers as a `hook_event`. Registered
    // BEFORE the global auth middleware because it authenticates with a
    // per-session hook token (not the global token, to shrink the leak surface)
    // and only accepts loopback callers — the relay always runs on this host.
    this.app.post('/api/hooks/:sessionId', (req, res) => this.handleHookEvent(req, res));

    // Serve a development-plan markdown file so the terminal's plan links can open
    // it in a new browser tab. Registered BEFORE the global auth middleware because
    // opening a tab is a browser navigation that can't send an Authorization header
    // — so, like the WebSocket, it authenticates with a query token (still required).
    this.app.get('/api/plan', (req, res) => this.servePlanFile(req, res));
    // Plugin-friendly variant: the URL ends in `.md` (the plan path is the last
    // segment, the token is a path segment, no query string) so browser Markdown
    // extensions — which trigger on URLs ending in `.md` — activate on it. The
    // plan path is a single percent-encoded segment (slashes as %2F); Express
    // decodes it back before servePlanFile resolves it.
    this.app.get('/api/plan/:token/:file', (req, res) => this.servePlanFile(req, res));
    // Session-scoped form: the plan link carries the active session id so the
    // allow-list uses that session's workingDir + its own planDirs (plus the
    // global ones). `-` means "no session" (falls back to all sessions).
    this.app.get('/api/plan/:token/:session/:file', (req, res) => this.servePlanFile(req, res));

    // Serve an arbitrary file for the file explorer to open in a new browser tab.
    // Like /api/plan it's a browser-navigation exception (a new tab can't send an
    // Authorization header) so it authenticates with a token in the URL, and is
    // registered BEFORE the global auth middleware. The path form ends in the
    // file's real extension so the browser renders it natively (images/text/pdf).
    this.app.get('/api/fs/file/:token/:file', (req, res) => this.serveFile(req, res));

    if (!this.noAuth && this.auth) {
      this.app.use((req, res, next) => {
        // Header-only: the token must not travel in the query string (it would
        // leak into access logs, browser history, and Referer). All browser
        // REST calls send the Authorization header; the page itself is served by
        // express.static before this middleware; the WebSocket authenticates
        // separately in verifyClient (browsers can't set headers on a WS, so it
        // keeps its query token there).
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${this.auth}` && auth !== this.auth) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
    }

    // Image upload for pasting/dropping images into the terminal. Saves the
    // image into <session workingDir>/.ccw-uploads and returns its absolute
    // path; the client then injects that path into the PTY input so Claude
    // Code reads it as an image. Route-scoped express.raw keeps the global
    // express.json() untouched. Registered after the auth middleware so it is
    // protected by the same token check.
    const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    this.app.post('/api/upload-image',
      express.raw({ type: Object.keys(IMAGE_EXT), limit: '15mb' }),
      (req, res) => {
        try {
          const sessionId = req.query.sessionId;
          const session = sessionId && this.claudeSessions.get(sessionId);
          if (!session) {
            return res.status(404).json({ error: 'Session not found' });
          }
          if (!session.active) {
            return res.status(400).json({ error: 'Start Claude in this session before pasting an image' });
          }
          const ext = IMAGE_EXT[(req.headers['content-type'] || '').split(';')[0].trim()];
          if (!ext) {
            return res.status(415).json({ error: 'Unsupported image type' });
          }
          if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Empty image body' });
          }
          const workingDir = session.workingDir;
          if (!workingDir || !fs.existsSync(workingDir)) {
            return res.status(400).json({ error: 'Session has no valid working directory' });
          }
          const dir = path.join(workingDir, '.ccw-uploads');
          const firstTime = !fs.existsSync(dir);
          fs.mkdirSync(dir, { recursive: true });
          // Make the folder self-ignoring so pasted images never dirty the repo.
          if (firstTime) {
            try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n'); } catch (_) { /* best-effort */ }
          }
          const filename = `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
          const filePath = path.join(dir, filename);
          fs.writeFileSync(filePath, req.body);
          res.json({ path: filePath });
        } catch (error) {
          if (this.dev) console.error('Image upload failed:', error.message);
          res.status(500).json({ error: 'Image upload failed', message: error.message });
        }
      });

    // Commands API removed

    this.app.get('/api/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        claudeSessions: this.claudeSessions.size,
        activeConnections: this.webSocketConnections.size 
      });
    });
    
    // Get session persistence info
    this.app.get('/api/sessions/persistence', ClaudeCodeWebServer.asyncRoute(async (req, res) => {
      const metadata = await this.sessionStore.getSessionMetadata();
      res.json({
        ...metadata,
        currentSessions: this.claudeSessions.size,
        autoSaveEnabled: true,
        autoSaveInterval: 30000
      });
    }));

    // List all Claude sessions
    this.app.get('/api/sessions/list', (req, res) => {
      const sessionList = Array.from(this.claudeSessions.entries()).map(([id, session]) => ({
        id,
        name: session.name,
        created: session.created,
        active: session.active,
        workingDir: session.workingDir,
        connectedClients: session.connections.size,
        lastActivity: session.lastActivity
      }));
      res.json({ sessions: sessionList });
    });

    // Create a new session
    this.app.post('/api/sessions/create', (req, res) => {
      const { name, workingDir } = req.body;
      const sessionId = uuidv4();
      
      // Validate working directory if provided
      let validWorkingDir = this.baseFolder;
      if (workingDir) {
        const validation = this.validatePath(workingDir);
        if (!validation.valid) {
          return res.status(403).json({ 
            error: validation.error,
            message: 'Cannot create session with working directory outside the allowed area' 
          });
        }
        validWorkingDir = validation.path;
      } else if (this.selectedWorkingDir) {
        validWorkingDir = this.selectedWorkingDir;
      }
      
      const session = {
        id: sessionId,
        name: name || `Session ${new Date().toLocaleString()}`,
        created: new Date(),
        lastActivity: new Date(),
        active: false,
        workingDir: validWorkingDir,
        planDirs: [], // per-session extra plan directories (additive to global + auto-discovery)
        connections: new Set(),
        // Flow control: connections that have asked us to pause the PTY (slow
        // renderer). The PTY stays paused while any connection is in this set.
        pausedConnections: new Set(),
        flowResumeTimer: null,
        outputBuffer: [],
        maxBufferSize: 1000
      };
      
      this.claudeSessions.set(sessionId, session);
      
      // Save sessions after creating new one
      this.saveSessionsToDisk();
      
      if (this.dev) {
        console.log(`Created new session: ${sessionId} (${session.name})`);
      }
      
      res.json({ 
        success: true,
        sessionId,
        session: {
          id: sessionId,
          name: session.name,
          workingDir: session.workingDir
        }
      });
    });

    // Get session details
    this.app.get('/api/sessions/:sessionId', (req, res) => {
      const session = this.claudeSessions.get(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      res.json({
        id: session.id,
        name: session.name,
        created: session.created,
        active: session.active,
        workingDir: session.workingDir,
        connectedClients: session.connections.size,
        lastActivity: session.lastActivity
      });
    });

    // Rename a session. Without this the new name lived only in the renaming
    // browser's memory: the tab state in localStorage keeps ids and nothing
    // else, so a reload dropped it, and it never reached sessions.json or any
    // other device — even though the persisted session already has a name.
    this.app.patch('/api/sessions/:sessionId', (req, res) => {
      const session = this.claudeSessions.get(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const raw = req.body && req.body.name;
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'name must be a string' });
      }
      const name = raw.trim();
      if (!name) {
        return res.status(400).json({ error: 'name must not be empty' });
      }
      if (name.length > 200) {
        return res.status(400).json({ error: 'name must be at most 200 characters' });
      }
      session.name = name;
      this.saveSessionsToDisk();
      res.json({ success: true, id: session.id, name: session.name });
    });

    // Delete a Claude session
    this.app.delete('/api/sessions/:sessionId', (req, res) => {
      const sessionId = req.params.sessionId;
      const session = this.claudeSessions.get(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // Stop Claude process if running
      if (session.active) {
        this.claudeBridge.stopSession(sessionId);
      }
      
      // Disconnect all WebSocket connections for this session
      session.connections.forEach(wsId => {
        const wsInfo = this.webSocketConnections.get(wsId);
        if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
          wsInfo.ws.send(JSON.stringify({ 
            type: 'session_deleted',
            message: 'Session has been deleted'
          }));
          wsInfo.ws.close();
        }
      });
      
      // Best-effort: remove pasted-image scratch dir for this session.
      try {
        if (session.workingDir) {
          const uploadsDir = path.join(session.workingDir, '.ccw-uploads');
          if (fs.existsSync(uploadsDir)) fs.rmSync(uploadsDir, { recursive: true, force: true });
        }
      } catch (_) { /* best-effort cleanup */ }

      this.claudeSessions.delete(sessionId);

      // Save sessions after deletion
      this.saveSessionsToDisk();

      res.json({ success: true, message: 'Session deleted' });
    });

    this.app.get('/api/config', (req, res) => {
      res.json({
        folderMode: this.folderMode,
        selectedWorkingDir: this.selectedWorkingDir,
        baseFolder: this.baseFolder,
        homeDir: require('os').homedir(),
        aliases: this.aliases,
        version: require('../package.json').version,
        port: this.port,
        buildId: this.buildId
      });
    });

    this.app.post('/api/create-folder', (req, res) => {
      const { parentPath, folderName } = req.body;
      
      if (!folderName || !folderName.trim()) {
        return res.status(400).json({ message: 'Folder name is required' });
      }
      
      if (folderName.includes('/') || folderName.includes('\\')) {
        return res.status(400).json({ message: 'Invalid folder name' });
      }
      
      const basePath = parentPath || this.baseFolder;
      const fullPath = path.join(basePath, folderName);
      
      // Validate that the parent path and resulting path are within base folder
      const parentValidation = this.validatePath(basePath);
      if (!parentValidation.valid) {
        return res.status(403).json({ 
          message: 'Cannot create folder outside the allowed area' 
        });
      }
      
      const fullValidation = this.validatePath(fullPath);
      if (!fullValidation.valid) {
        return res.status(403).json({ 
          message: 'Cannot create folder outside the allowed area' 
        });
      }
      
      try {
        // Check if folder already exists
        if (fs.existsSync(fullValidation.path)) {
          return res.status(409).json({ message: 'Folder already exists' });
        }
        
        // Create the folder
        fs.mkdirSync(fullValidation.path, { recursive: true });
        
        res.json({
          success: true,
          path: fullValidation.path,
          message: `Folder "${folderName}" created successfully`
        });
      } catch (error) {
        console.error('Failed to create folder:', error);
        res.status(500).json({ 
          message: `Failed to create folder: ${error.message}` 
        });
      }
    });

    this.app.get('/api/folders', (req, res) => {
      const requestedPath = req.query.path || this.baseFolder;
      
      // Validate the requested path
      const validation = this.validatePath(requestedPath);
      if (!validation.valid) {
        return res.status(403).json({ 
          error: validation.error,
          message: 'Access to this directory is not allowed' 
        });
      }
      
      const currentPath = validation.path;
      
      try {
        const items = fs.readdirSync(currentPath, { withFileTypes: true });
        const folders = items
          .filter(item => {
            // Regular directory.
            if (item.isDirectory()) return true;
            // Symlink pointing at a directory: readdir reports the link type
            // (not the target), so isDirectory() is false — resolve the target.
            if (item.isSymbolicLink()) {
              try {
                return fs.statSync(path.join(currentPath, item.name)).isDirectory();
              } catch (_) {
                return false; // broken/dangling symlink
              }
            }
            return false;
          })
          .filter(item => !item.name.startsWith('.') || req.query.showHidden === 'true')
          .map(item => ({
            name: item.name,
            path: path.join(currentPath, item.name),
            isDirectory: true,
            isSymlink: item.isSymbolicLink()
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        
        const parentDir = path.dirname(currentPath);
        const canGoUp = this.isPathWithinBase(parentDir) && parentDir !== currentPath;
        
        res.json({
          currentPath,
          parentPath: canGoUp ? parentDir : null,
          folders,
          home: this.baseFolder,
          baseFolder: this.baseFolder
        });
      } catch (error) {
        res.status(403).json({ 
          error: 'Cannot access directory',
          message: error.message 
        });
      }
    });

    // File explorer directory listing: like /api/folders but returns files AND
    // folders (with size/mtime) for a read-only Explorer-style browser. Normal
    // header auth (a regular fetch), unlike /api/fs/file which is a browser-nav
    // token exception.
    this.app.get('/api/fs/list', (req, res) => this.listDirectory(req, res));

    // Mint a single-use ticket for one file so the explorer can open a RENDERED
    // html/svg in a new tab without the auth token riding the URL. Normal header
    // auth (a regular fetch), so the ticket itself is the only thing the opened
    // page can read out of its own location — and it is dead on arrival.
    this.app.post('/api/fs/ticket', (req, res) => this.createFileTicket(req, res));

    // Current branch of every git repository one level under a directory — the
    // "many sub-projects in one big directory" layout. Read-only, header auth,
    // and NOT on a timer: it runs only when the panel is opened or refreshed.
    // `?status=1` adds the working-tree state, which costs a git process per
    // repo instead of a single file read, so it is opt-in per request.
    this.app.get('/api/git/branches', ClaudeCodeWebServer.asyncRoute((req, res) => this.listBranches(req, res)));

    // Runtime-editable plan directories (additive to auto-discovery). Normal
    // header auth. GET returns the configured dirs plus active session roots (the
    // latter are already auto-covered, shown for context). POST replaces the list
    // after validating each entry is a real existing directory, and persists it.
    this.app.get('/api/plan-dirs', (req, res) => this.getPlanDirs(req, res));
    this.app.post('/api/plan-dirs', (req, res) => this.setPlanDirs(req, res));

    this.app.post('/api/set-working-dir', (req, res) => {
      const { path: selectedPath } = req.body;

      // Validate the path
      const validation = this.validatePath(selectedPath);
      if (!validation.valid) {
        return res.status(403).json({ 
          error: validation.error,
          message: 'Cannot set working directory outside the allowed area' 
        });
      }
      
      const validatedPath = validation.path;
      
      try {
        if (!fs.existsSync(validatedPath)) {
          return res.status(404).json({ error: 'Directory does not exist' });
        }
        
        const stats = fs.statSync(validatedPath);
        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path is not a directory' });
        }
        
        this.selectedWorkingDir = validatedPath;
        res.json({ 
          success: true, 
          workingDir: this.selectedWorkingDir 
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to set working directory',
          message: error.message 
        });
      }
    });

    this.app.post('/api/folders/select', (req, res) => {
      try {
        const { path: selectedPath } = req.body;
        
        // Validate the path
        const validation = this.validatePath(selectedPath);
        if (!validation.valid) {
          return res.status(403).json({ 
            error: validation.error,
            message: 'Cannot select directory outside the allowed area' 
          });
        }
        
        const validatedPath = validation.path;
        
        // Verify the path exists and is a directory
        if (!fs.existsSync(validatedPath) || !fs.statSync(validatedPath).isDirectory()) {
          return res.status(400).json({ 
            error: 'Invalid directory path' 
          });
        }
        
        // Store the selected working directory
        this.selectedWorkingDir = validatedPath;
        
        res.json({ 
          success: true,
          workingDir: this.selectedWorkingDir
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to set working directory',
          message: error.message 
        });
      }
    });

    this.app.post('/api/close-session', (req, res) => {
      try {
        // Clear the selected working directory
        this.selectedWorkingDir = null;
        
        res.json({ 
          success: true,
          message: 'Working directory cleared'
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to clear working directory',
          message: error.message 
        });
      }
    });

    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
  }

  async start() {
    let server;
    
    if (this.useHttps) {
      if (!this.certFile || !this.keyFile) {
        throw new Error('HTTPS requires both --cert and --key options');
      }
      
      const cert = fs.readFileSync(this.certFile);
      const key = fs.readFileSync(this.keyFile);
      server = https.createServer({ cert, key }, this.app);
    } else {
      server = http.createServer(this.app);
    }

    this.wss = new WebSocket.Server({ 
      server,
      verifyClient: (info) => {
        if (!this.noAuth && this.auth) {
          const url = new URL(info.req.url, 'ws://localhost');
          const token = url.searchParams.get('token');
          return token === this.auth;
        }
        return true;
      }
    });

    this.wss.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    return new Promise((resolve, reject) => {
      server.listen(this.port, (err) => {
        if (err) {
          reject(err);
        } else {
          this.server = server;
          resolve(server);
        }
      });
    });
  }

  handleWebSocketConnection(ws, req) {
    const wsId = uuidv4(); // Unique ID for this WebSocket connection
    const url = new URL(req.url, `ws://localhost`);
    const claudeSessionId = url.searchParams.get('sessionId');
    
    if (this.dev) {
      console.log(`New WebSocket connection: ${wsId}`);
      if (claudeSessionId) {
        console.log(`Joining Claude session: ${claudeSessionId}`);
      }
    }

    // Store WebSocket connection info
    const wsInfo = {
      id: wsId,
      ws,
      claudeSessionId: null,
      created: new Date()
    };
    this.webSocketConnections.set(wsId, wsInfo);

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        await this.handleMessage(wsId, data);
      } catch (error) {
        if (this.dev) {
          console.error('Error handling message:', error);
        }
        this.sendToWebSocket(ws, {
          type: 'error',
          message: 'Failed to process message'
        });
      }
    });

    ws.on('close', () => {
      if (this.dev) {
        console.log(`WebSocket connection closed: ${wsId}`);
      }
      this.cleanupWebSocketConnection(wsId);
    });

    ws.on('error', (error) => {
      if (this.dev) {
        console.error(`WebSocket error for connection ${wsId}:`, error);
      }
      this.cleanupWebSocketConnection(wsId);
    });

    // Send initial connection message
    this.sendToWebSocket(ws, {
      type: 'connected',
      connectionId: wsId
    });

    // If sessionId provided, auto-join that session
    if (claudeSessionId && this.claudeSessions.has(claudeSessionId)) {
      this.joinClaudeSession(wsId, claudeSessionId);
    }
  }

  async handleMessage(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    switch (data.type) {
      case 'create_session':
        await this.createAndJoinSession(wsId, data.name, data.workingDir);
        break;

      case 'join_session':
        await this.joinClaudeSession(wsId, data.sessionId);
        break;

      case 'leave_session':
        await this.leaveClaudeSession(wsId);
        break;

      case 'start_claude':
        await this.startClaude(wsId, data.options || {}, data.cols, data.rows, data.uiTheme);
        break;
      
      case 'input':
        if (wsInfo.claudeSessionId) {
          // Verify the session exists and the WebSocket is part of it
          const session = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (session && session.connections.has(wsId)) {
            // Only send if Claude is running in this session
            if (session.active) {
              try {
                await this.claudeBridge.sendInput(wsInfo.claudeSessionId, data.data);
              } catch (error) {
                if (this.dev) {
                  console.error(`Failed to send input to session ${wsInfo.claudeSessionId}:`, error.message);
                }
                this.sendToWebSocket(wsInfo.ws, {
                  type: 'error',
                  message: 'Claude is not running in this session. Start it first.'
                });
              }
            } else {
              this.sendToWebSocket(wsInfo.ws, {
                type: 'info',
                message: 'Claude is not running. Start it to send input.'
              });
            }
          }
        }
        break;
      
      case 'resize':
        if (wsInfo.claudeSessionId) {
          // Verify the session exists and the WebSocket is part of it
          const session = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (session && session.connections.has(wsId)) {
            // Only resize if Claude is actually running
            if (session.active) {
              try {
                await this.claudeBridge.resize(wsInfo.claudeSessionId, data.cols, data.rows);
              } catch (error) {
                if (this.dev) {
                  console.log(`Resize ignored - Claude not active in session ${wsInfo.claudeSessionId}`);
                }
              }
            }
          }
        }
        break;

      case 'pause':
      case 'resume':
        if (wsInfo.claudeSessionId) {
          const session = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (session && session.connections.has(wsId)) {
            this.handleFlowControl(session, wsId, data.type === 'pause');
          }
        }
        break;

      case 'stop':
        if (wsInfo.claudeSessionId) {
          await this.stopClaude(wsInfo.claudeSessionId);
        }
        break;

      case 'ping':
        this.sendToWebSocket(wsInfo.ws, { type: 'pong' });
        break;

        break;

      default:
        if (this.dev) {
          console.log(`Unknown message type: ${data.type}`);
        }
    }
  }

  async createAndJoinSession(wsId, name, workingDir) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    // Validate working directory if provided
    let validWorkingDir = this.baseFolder;
    if (workingDir) {
      const validation = this.validatePath(workingDir);
      if (!validation.valid) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Cannot create session with working directory outside the allowed area'
        });
        return;
      }
      validWorkingDir = validation.path;
    } else if (this.selectedWorkingDir) {
      validWorkingDir = this.selectedWorkingDir;
    }

    // Create new Claude session
    const sessionId = uuidv4();
    const session = {
      id: sessionId,
      name: name || `Session ${new Date().toLocaleString()}`,
      created: new Date(),
      lastActivity: new Date(),
      active: false,
      workingDir: validWorkingDir,
      connections: new Set([wsId]),
      // Flow control: connections that have asked us to pause the PTY.
      pausedConnections: new Set(),
      flowResumeTimer: null,
      outputBuffer: [],
      maxBufferSize: 1000
    };
    
    this.claudeSessions.set(sessionId, session);
    wsInfo.claudeSessionId = sessionId;
    
    // Save sessions after creating new one
    this.saveSessionsToDisk();
    
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_created',
      sessionId,
      sessionName: session.name,
      workingDir: session.workingDir
    });
  }

  async joinClaudeSession(wsId, claudeSessionId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    const session = this.claudeSessions.get(claudeSessionId);
    if (!session) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Session not found'
      });
      return;
    }

    // Leave current session if any
    if (wsInfo.claudeSessionId) {
      await this.leaveClaudeSession(wsId);
    }

    // Join new session
    wsInfo.claudeSessionId = claudeSessionId;
    session.connections.add(wsId);
    session.lastActivity = new Date();
    session.lastAccessed = Date.now();

    // Send session info and replay buffer
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_joined',
      sessionId: claudeSessionId,
      sessionName: session.name,
      workingDir: session.workingDir,
      active: session.active,
      outputBuffer: session.outputBuffer.slice(-200) // Send last 200 lines
    });

    if (this.dev) {
      console.log(`WebSocket ${wsId} joined Claude session ${claudeSessionId}`);
    }
  }

  async leaveClaudeSession(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;

    const session = this.claudeSessions.get(wsInfo.claudeSessionId);
    if (session) {
      session.connections.delete(wsId);
      this.clearConnectionFlowControl(session, wsId);
      session.lastActivity = new Date();
    }

    wsInfo.claudeSessionId = null;
    
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_left'
    });
  }

  // Circuit breaker for the start->exit->restart loop: when Claude keeps dying
  // right after start (e.g. a session id that can neither --resume nor be claimed
  // fresh), stop retrying and surface something actionable.
  startCircuitOpen(session) {
    const fails = session && session._startFails;
    return !!(fails && fails.count >= 3 && (Date.now() - fails.last) < 20000);
  }

  // Send the breaker's explanation and report that the start was refused.
  refuseStart(wsInfo) {
    const alias = (this.aliases && this.aliases.claude) || 'Claude';
    this.sendToWebSocket(wsInfo.ws, {
      type: 'error',
      message: `${alias} keeps exiting immediately, so automatic retries have stopped. This session id may be in use or corrupted — please create a new session.`
    });
    return true;
  }

  // Feed the breaker from a bridge's onExit: a non-zero exit within a few seconds
  // of the start counts as a rapid failure; anything else clears the streak.
  recordStartExit(session, code) {
    if (!session) return;
    const c = (code && typeof code === 'object') ? code.exitCode : code;
    const quick = session._startAt && (Date.now() - session._startAt) < 12000;
    if (c !== 0 && quick) {
      session._startFails = session._startFails || { count: 0, last: 0 };
      session._startFails.count++;
      session._startFails.last = Date.now();
    } else {
      session._startFails = { count: 0, last: 0 };
    }
  }

  async startClaude(wsId, options, cols, rows, uiTheme) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return; // connection already gone — nobody to answer
    if (!wsInfo.claudeSessionId) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'No session joined'
      });
      return;
    }

    const session = this.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session) return;

    if (session.active) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Claude is already running in this session'
      });
      return;
    }

    // Capture the session ID to avoid closure issues
    const sessionId = wsInfo.claudeSessionId;

    if (this.startCircuitOpen(session)) return void this.refuseStart(wsInfo);
    session._startAt = Date.now();

    // Per-session secret for the hook relay endpoint. Generated once and reused
    // across resumes so the injected hook command stays valid for the session.
    if (!session.hookToken) session.hookToken = uuidv4();

    try {
      await this.claudeBridge.startSession(sessionId, {
        workingDir: session.workingDir,
        // The browser terminal IS the background, so Claude's theme follows the
        // UI's light/dark setting rather than the user's global settings.json.
        uiTheme,
        // Wire the plan hook: Claude's ExitPlanMode PreToolUse event is relayed
        // by bin/cc-hook.js back to /api/hooks/:sessionId and broadcast to the UI.
        hookScript: path.join(__dirname, '..', 'bin', 'cc-hook.js'),
        hookPort: this.port,
        hookToken: session.hookToken,
        // Resume the Claude conversation if this cc-web session has started Claude
        // before (bound to this session id via --session-id). Survives server
        // restarts / dead PTYs instead of starting a brand-new conversation.
        resume: !!session.claudeStarted,
        // Spawn the PTY at the client's real terminal size so the program uses
        // the full width. Without this it defaults to 80 cols and wide screens
        // show a blank strip on the right. (Falls back to the bridge default.)
        cols, rows,
        onOutput: (data) => {
          // Get the current session again to ensure we have the right reference
          const currentSession = this.claudeSessions.get(sessionId);
          if (!currentSession) return;
          
          // Add to buffer
          currentSession.outputBuffer.push(data);
          if (currentSession.outputBuffer.length > currentSession.maxBufferSize) {
            currentSession.outputBuffer.shift();
          }
          
          // Broadcast to all connected clients for THIS specific session
          this.broadcastToSession(sessionId, {
            type: 'output',
            data
          });
        },
        onExit: (code, signal) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            this.recordStartExit(currentSession, code);
          }
          this.broadcastToSession(sessionId, {
            type: 'exit',
            code,
            signal
          });
        },
        onError: (error) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
          }
          this.broadcastToSession(sessionId, {
            type: 'error',
            message: error.message
          });
        },
        ...options
      });

      session.active = true;
      session.lastActivity = new Date();
      // Remember that Claude has been started under this session id so future
      // starts (incl. after a server restart) resume the conversation instead of
      // starting fresh. Persist it so the flag survives a restart.
      if (!session.claudeStarted) {
        session.claudeStarted = true;
        this.saveSessionsToDisk();
      }
      this.broadcastToSession(sessionId, {
        type: 'claude_started',
        sessionId: sessionId
      });

    } catch (error) {
      if (this.dev) {
        console.error(`Error starting Claude in session ${wsInfo.claudeSessionId}:`, error);
      }
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Failed to start Claude Code: ${error.message}`
      });
    }
  }

  async stopClaude(claudeSessionId) {
    const session = this.claudeSessions.get(claudeSessionId);
    if (!session || !session.active) return;

    await this.claudeBridge.stopSession(claudeSessionId);
    session.active = false;
    session.lastActivity = new Date();

    this.broadcastToSession(claudeSessionId, {
      type: 'claude_stopped'
    });
  }

  sendToWebSocket(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // Apply a pause/resume request from one connection. The PTY stays paused as
  // long as ANY connection is paused (the slowest renderer drives the pace), so
  // a fast client isn't throttled by a slow one and vice versa.
  handleFlowControl(session, wsId, wantPause) {
    if (!session.pausedConnections) session.pausedConnections = new Set();
    const wasPaused = session.pausedConnections.size > 0;
    if (wantPause) {
      session.pausedConnections.add(wsId);
    } else {
      session.pausedConnections.delete(wsId);
    }
    const shouldPause = session.pausedConnections.size > 0;
    if (shouldPause && !wasPaused) {
      this.pauseSessionPty(session);
      // Safety valve: never stay paused forever (e.g. a client that paused then
      // vanished). Force-resume after 5s; a still-backed-up client re-pauses.
      if (session.flowResumeTimer) clearTimeout(session.flowResumeTimer);
      session.flowResumeTimer = setTimeout(() => {
        session.flowResumeTimer = null;
        session.pausedConnections.clear();
        this.resumeSessionPty(session);
      }, 5000);
    } else if (!shouldPause && wasPaused) {
      if (session.flowResumeTimer) { clearTimeout(session.flowResumeTimer); session.flowResumeTimer = null; }
      this.resumeSessionPty(session);
    }
  }

  pauseSessionPty(session) {
    if (!session || !session.active) return;
    try { this.claudeBridge.pause(session.id); } catch (_) {}
  }

  resumeSessionPty(session) {
    if (!session) return;
    try { this.claudeBridge.resume(session.id); } catch (_) {}
  }

  // Remove a connection from a session's flow-control set and resume the PTY if
  // no one else is holding it paused. Called when a connection leaves/closes so
  // a disconnect can't leave the PTY stuck paused.
  clearConnectionFlowControl(session, wsId) {
    if (!session || !session.pausedConnections) return;
    if (session.pausedConnections.delete(wsId) && session.pausedConnections.size === 0) {
      if (session.flowResumeTimer) { clearTimeout(session.flowResumeTimer); session.flowResumeTimer = null; }
      this.resumeSessionPty(session);
    }
  }

  // Handle a Claude Code hook relay POST (from bin/cc-hook.js). Loopback-only,
  // authenticated with the session's own hookToken, then rebroadcast to the
  // session's browsers as a `hook_event`. Extracted from the route so it is
  // unit-testable with mock req/res, without binding a socket.
  handleHookEvent(req, res) {
    const remote = (req.socket && req.socket.remoteAddress) || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) return res.status(403).json({ error: 'Forbidden' });

    const sessionId = req.params.sessionId;
    const session = this.claudeSessions.get(sessionId);
    if (!session || !session.hookToken) return res.status(404).json({ error: 'Unknown session' });
    if (req.headers.authorization !== `Bearer ${session.hookToken}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body || {};
    this.broadcastToSession(sessionId, {
      type: 'hook_event',
      sessionId,
      event: event.hook_event_name,
      tool_name: event.tool_name,
      tool_input: event.tool_input
    });
    res.json({ ok: true });
  }

  // Serve a plan markdown file for GET /api/plan. Extracted so it is unit-testable
  // with mock req/res. Security: query/path token auth (still required), and a
  // strict allow-list — the resolved real path must be a `.md` under EITHER a
  // `.claude/plans/` directory inside an auto root (base folder / active session
  // working dir) OR a configured plan dir. realpath() resolves symlinks so links
  // can't escape.
  servePlanFile(req, res) {
    // Token and path come from either the query (`?path=&token=`) or the
    // plugin-friendly path form (`/api/plan/:token/:file`). Express has already
    // decoded the path params.
    const params = req.params || {};
    if (!this.noAuth && this.auth) {
      const token = params.token !== undefined ? params.token : req.query.token;
      if (token !== `Bearer ${this.auth}` && token !== this.auth) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    let raw = params.file !== undefined ? params.file : req.query.path;
    if (typeof raw !== 'string' || raw.length === 0 || raw.indexOf('\0') !== -1) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Claude prints home-relative plan paths with a leading ~ (e.g.
    // ~/proj/.claude/plans/x.md), so the clickable link carries that ~. Expand it
    // to an absolute path here; otherwise it's treated as relative and joined
    // under the roots as `<root>/~/...`, which never exists (404).
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~' + path.sep)) {
      raw = path.join(require('os').homedir(), raw.slice(1));
    }

    // Allowed roots are the UNION of two sets (additive, not override):
    //  • auto roots — the base folder plus session working dir(s); a file here
    //    must also sit under a `.claude/plans/` segment (so we serve the current
    //    project's plans automatically without serving arbitrary md).
    //  • plan dirs — the global `this.planDirs` (--plans-dir / runtime) plus, when
    //    the request names a session, that session's own `planDirs` — any `.md`
    //    under them, no segment requirement.
    // The `/api/plan/:token/:session/:file` route scopes to one session (its
    // workingDir + its planDirs). The 2-segment route (or `-`) has no session, so
    // it falls back to every active session's workingDir (global planDirs only).
    const scoped = params.session && params.session !== '-'
      ? this.claudeSessions.get(params.session)
      : null;
    const autoRoots = [this.baseFolder];
    const planDirsForReq = this.planDirs.slice();
    if (scoped) {
      if (scoped.workingDir) autoRoots.push(scoped.workingDir);
      if (Array.isArray(scoped.planDirs)) planDirsForReq.push(...scoped.planDirs);
    } else {
      for (const s of this.claudeSessions.values()) {
        if (s && s.workingDir) autoRoots.push(s.workingDir);
      }
    }
    const realAutoRoots = [];
    for (const r of autoRoots) {
      try { realAutoRoots.push(fs.realpathSync(r)); } catch (_) { /* skip unreadable root */ }
    }
    const realPlanDirs = [];
    for (const r of planDirsForReq) {
      try { realPlanDirs.push(fs.realpathSync(r)); } catch (_) { /* skip */ }
    }
    const under = (real, roots) => roots.some((rr) => real === rr || real.startsWith(rr + path.sep));

    const PLANS_SEGMENT = `${path.sep}.claude${path.sep}plans${path.sep}`;
    // Relative paths are resolved against every candidate root.
    const candidates = path.isAbsolute(raw)
      ? [raw]
      : [...autoRoots, ...planDirsForReq].map((r) => path.join(r, raw));
    for (const cand of candidates) {
      try {
        const real = fs.realpathSync(cand);
        if (!real.endsWith('.md')) continue;
        const inPlanDir = under(real, realPlanDirs);
        const inAutoRoot = under(real, realAutoRoots) && real.indexOf(PLANS_SEGMENT) !== -1;
        if (!inPlanDir && !inAutoRoot) continue;
        const stat = fs.statSync(real);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        // text/plain (not text/markdown): Chrome has no native markdown viewer,
        // so text/markdown gets downloaded rather than rendered as a page —
        // browser Markdown extensions can only transform a rendered text page.
        return this.sendInlineFile(res, real, 'text/plain; charset=utf-8', fs.readFileSync(real));
      } catch (_) { /* try the next candidate */ }
    }
    return res.status(404).json({ error: 'Not found' });
  }

  // Shared inline-file response for the plan/file endpoints. Sets the safe header
  // set once: nosniff (no MIME sniffing), no-referrer (the token rides these URLs,
  // so never leak it via Referer), no-cache, and an RFC 5987 filename* so non-ASCII
  // (e.g. Chinese) names don't throw in setHeader (a raw non-latin1 value throws).
  sendInlineFile(res, realPath, contentType, content) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(realPath))}`);
    return res.send(content);
  }

  // GET /api/fs/list?path=&hidden= — directory listing (files + folders) for the
  // read-only file explorer. Folders first, then files, each with size/mtime.
  // Scope matches the folder browser: any path the user's account can read (this
  // is a local, auth-protected, single-user tool).
  // status=1 forks a git process per repo. Run the scans one after another so a
  // client that hammers the endpoint queues up instead of multiplying the fork
  // count across the shared single-threaded server. Concurrency *within* one
  // scan is still bounded separately, in git-branches.js.
  runStatusScan(repos) {
    const start = () => gitBranches.attachStatus(repos);
    const next = (this.branchStatusChain || Promise.resolve()).then(start, start);
    this.branchStatusChain = next.catch(() => {});
    return next;
  }

  // GET /api/git/branches?path=<dir>[&status=1]
  // The default response is a pure file read (~13ms for 11 repos) so the panel
  // paints immediately. status=1 shells out to git once per repo and is only
  // requested when the user asks for it, because it measured ~18x slower.
  async listBranches(req, res) {
    // A repeated ?path= arrives as an Array. path.resolve throws on it, and in
    // an async handler that throw used to end the process — so reject the shape
    // up front rather than relying on the wrapper to catch it.
    const raw = ClaudeCodeWebServer.singleQueryValue(req.query.path);
    if (!raw.ok) {
      return res.status(400).json({ error: 'path must be a single value' });
    }
    const requested = raw.value || this.baseFolder;
    const validation = this.validatePath(requested);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error, message: 'Access to this directory is not allowed' });
    }
    try {
      const result = gitBranches.scanBranches(validation.path);
      if (req.query.status === '1' || req.query.status === 'true') {
        await this.runStatusScan(result.repos);
        result.status = true;
      }
      // The absolute path of each repo is only needed server-side; the client
      // renders names, so don't hand the filesystem layout back to the browser.
      res.json({
        path: result.path,
        repos: result.repos.map(({ path: _p, ...rest }) => rest),
        truncated: result.truncated,
        // Directories the entry cap stopped us looking at. The client shows
        // this: a partial scan must never be presented as a complete one.
        unexamined: result.unexamined,
        status: !!result.status,
        error: result.error
      });
    } catch (error) {
      res.status(500).json({ error: 'Cannot scan branches', message: error.message });
    }
  }

  listDirectory(req, res) {
    const MAX_ITEMS = 2000; // Bound the per-entry stat cost so a huge directory
                            // (node_modules, /nix/store) can't freeze the shared
                            // single-threaded server with 10k+ sync stat calls.
    const requested = req.query.path || this.baseFolder;
    const validation = this.validatePath(requested);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error, message: 'Access to this directory is not allowed' });
    }
    const dir = validation.path;
    const showHidden = req.query.hidden === '1' || req.query.hidden === 'true';
    try {
      // First pass: classify (no syscall except for the rare symlink) and sort.
      // Only the second pass stats for size, and only for the capped slice.
      const classified = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!showHidden && ent.name.startsWith('.')) continue;
        const isSymlink = ent.isSymbolicLink();
        let isDir = ent.isDirectory();
        if (isSymlink) {
          try { isDir = fs.statSync(path.join(dir, ent.name)).isDirectory(); } catch (_) { continue; } // broken link
        }
        classified.push({ name: ent.name, isDir, isSymlink });
      }
      // Folders first, then files; each alphabetical (case-insensitive).
      classified.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const truncated = classified.length > MAX_ITEMS;
      const items = (truncated ? classified.slice(0, MAX_ITEMS) : classified).map((e) => {
        let size = 0;
        if (!e.isDir) {
          try { size = fs.statSync(path.join(dir, e.name)).size; } catch (_) { /* unreadable; keep 0 */ }
        }
        return { name: e.name, type: e.isDir ? 'dir' : 'file', size, isSymlink: e.isSymlink };
      });
      const parentDir = path.dirname(dir);
      res.json({ path: dir, parent: parentDir !== dir ? parentDir : null, home: this.baseFolder, items, truncated });
    } catch (error) {
      const status = error && error.code === 'ENOENT' ? 404 : 403;
      res.status(status).json({ error: 'Cannot access directory', message: error.message });
    }
  }

  // GET /api/fs/file/:token/:file — serve a file's bytes so the explorer can open
  // it in a new tab. Browser-nav token exception (like /api/plan): token and path
  // are path segments (a new tab can't send a header). Content-Type is picked by
  // extension so the browser renders images/text/pdf natively; the realpath is
  // resolved (symlinks) and the target must be a regular file ≤ 10 MB.
  serveFile(req, res) {
    const params = req.params || {};
    // Two ways a browser navigation can authenticate here:
    //  • a single-use ticket bound to one file — consumed on first use, and the
    //    ONLY credential we let a *rendered* html/svg see in its own location;
    //  • the long-lived auth token — still accepted (plan links, direct URLs),
    //    but then html/svg fall back to text/plain source, because a rendered
    //    page can read `location` and POST the token anywhere.
    // Auth is decided before any fs call so an unauthenticated caller can't probe
    // for file existence through the status code.
    const ticket = this.takeFileTicket(params.token);
    if (!ticket && !this.noAuth && this.auth) {
      const token = params.token;
      if (token !== `Bearer ${this.auth}` && token !== this.auth) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    const raw = params.file;
    if (typeof raw !== 'string' || raw.length === 0 || raw.indexOf('\0') !== -1) {
      return res.status(404).json({ error: 'Not found' });
    }
    const validation = this.validatePath(raw);
    if (!validation.valid) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      const real = fs.realpathSync(validation.path);
      const stat = fs.statSync(real);
      if (!stat.isFile()) return res.status(404).json({ error: 'Not found' });

      // Download: hand the bytes over as an attachment. No render, so no CSP
      // and no content sniffing to worry about — and no size cap either, since
      // the reason to cap a preview (don't paint half a gigabyte) doesn't apply
      // to saving a file. Streamed rather than read whole: this server is
      // single-threaded and shared, and readFileSync on a large file blocks it.
      if (ticket && ticket.download && ticket.real === real) {
        return this.sendAttachment(res, real, stat.size);
      }

      if (stat.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large' });
      // Render only via a ticket that matches this exact file (and is now spent).
      // Deliberately not relaxed for --disable-auth: one rule for every mode beats
      // "renders on my box, shows source in production".
      const render = !!(ticket && ticket.real === real);
      const csp = this.renderSandboxCsp(real, render);
      if (csp) res.setHeader('Content-Security-Policy', csp);
      return this.sendInlineFile(res, real, this.contentTypeForFile(real, render), fs.readFileSync(real));
    } catch (_) {
      return res.status(404).json({ error: 'Not found' });
    }
  }

  // Stream a file to the browser as a download. Same header hygiene as
  // sendInlineFile (nosniff, no-referrer, RFC 5987 name for non-ASCII), but
  // `attachment`, which also guarantees the browser never renders it.
  sendAttachment(res, realPath, size) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Length', size);
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(realPath))}`);
    const stream = fs.createReadStream(realPath);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Not found' }); else res.destroy(); });
    res.on('close', () => stream.destroy());   // client went away mid-download
    return stream.pipe(res);
  }

  // POST /api/fs/ticket {path} — mint a single-use, 30s credential for ONE file.
  // Normal header auth. Kept deliberately worthless: bound to one realpath, spent
  // on first read, so a rendered page that scrapes it out of its own URL gains
  // nothing. This is what keeps the long-lived auth token out of rendered URLs.
  createFileTicket(req, res) {
    const requested = (req.body && req.body.path) || '';
    // A download ticket serves the file as an attachment instead of rendering
    // it. Downloads land in the browser's download history, which outlives a
    // tab, so they get a ticket for the same reason rendering does: whatever
    // ends up recorded there must be spent already.
    const download = !!(req.body && req.body.download);
    const validation = this.validatePath(requested);
    if (!validation.valid) return res.status(404).json({ error: 'Not found' });
    let real;
    try {
      real = fs.realpathSync(validation.path);
      if (!fs.statSync(real).isFile()) return res.status(404).json({ error: 'Not found' });
    } catch (_) {
      return res.status(404).json({ error: 'Not found' });
    }
    this.pruneFileTickets();
    const ticket = `t_${uuidv4().replace(/-/g, '')}`;
    this.fileTickets.set(ticket, { real, download, expires: Date.now() + 30000 });
    return res.json({ ticket, expiresInMs: 30000 });
  }

  // Look up and CONSUME a ticket. Returns null for anything that isn't a live
  // ticket, so callers fall through to the normal token check.
  takeFileTicket(value) {
    if (typeof value !== 'string' || !value.startsWith('t_')) return null;
    const entry = this.fileTickets.get(value);
    if (!entry) return null;
    this.fileTickets.delete(value); // single use, hit or miss
    if (entry.expires <= Date.now()) return null;
    return entry;
  }

  // Drop expired tickets, and bound the map so a loop of mint requests can't grow
  // it without limit (oldest first — Map keeps insertion order).
  pruneFileTickets() {
    const now = Date.now();
    for (const [key, entry] of this.fileTickets) {
      if (entry.expires <= now) this.fileTickets.delete(key);
    }
    while (this.fileTickets.size >= 200) {
      this.fileTickets.delete(this.fileTickets.keys().next().value);
    }
  }

  // CSP for a rendered html/svg: an opaque origin (no allow-same-origin) AND no
  // network at all. The sandbox alone is not enough — it stops the page reading
  // this origin's storage, but not the page reading its own URL and shipping it
  // out via fetch/img/window.open/location. `default-src 'none'` closes the
  // subresource routes; dropping allow-popups closes window.open; the ticket
  // being single-use closes what's left (a top-level `location =` escape, which
  // CSP cannot block since navigate-to is gone). Returns '' when not rendering.
  renderSandboxCsp(filePath, render) {
    if (!render) return '';
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      // Scripts run so inlined diagram/chart code still draws; they just have
      // nowhere to send anything. External CDN subresources will not load.
      return "sandbox allow-scripts; default-src 'none'; img-src data: blob:; " +
        "media-src data: blob:; font-src data:; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'";
    }
    if (ext === '.svg') {
      // A graphic needs no script at all, so don't grant allow-scripts.
      return "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
        "form-action 'none'; base-uri 'none'";
    }
    return '';
  }

  // Pick a Content-Type from the file extension. HTML and SVG are text/plain
  // (source, the safe default) UNLESS `render` — see serveFile: rendering is
  // granted only when the URL carries no reusable credential, and then
  // renderSandboxCsp puts the page in an opaque origin with no network.
  contentTypeForFile(filePath, render = false) {
    const ext = path.extname(filePath).toLowerCase();
    const images = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon'
    };
    const textExts = [
      '.txt', '.log', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx',
      '.jsx', '.css', '.scss', '.less', '.xml', '.yml', '.yaml',
      '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h',
      '.cc', '.cpp', '.hpp', '.cs', '.php', '.pl', '.lua', '.r', '.ini', '.conf', '.cfg',
      '.toml', '.env', '.sql', '.csv', '.tsv', '.gitignore', '.dockerfile', '.makefile'
    ];
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.html' || ext === '.htm') return render ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    if (ext === '.svg') return render ? 'image/svg+xml' : 'text/plain; charset=utf-8';
    if (images[ext]) return images[ext];
    if (textExts.includes(ext)) return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
  }

  // Fingerprint the served source tree (path + size + mtime of every file under
  // src/, minus the static vendor bundle) into a short hash. Computed once at
  // startup; surfaced via /api/config so the UI can show which build is running.
  computeBuildId() {
    try {
      const root = __dirname; // this file lives in src/
      const parts = [];
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name.startsWith('.') || ent.name === 'vendor' || ent.name === 'node_modules') continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.isFile()) {
            const st = fs.statSync(full);
            parts.push(`${path.relative(root, full)}:${st.size}:${Math.round(st.mtimeMs)}`);
          }
        }
      };
      walk(root);
      parts.sort();
      return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 8);
    } catch (_) {
      return 'unknown';
    }
  }

  // Where the runtime plan-dirs list is persisted — same data dir as SessionStore
  // (CCW_DATA_DIR override, else ~/.claude-code-web), so it survives restarts.
  planDirsFile() {
    const base = process.env.CCW_DATA_DIR
      ? path.resolve(process.env.CCW_DATA_DIR)
      : path.join(require('os').homedir(), '.claude-code-web');
    return path.join(base, 'plan-dirs.json');
  }

  // Load the persisted plan dirs, or null if none/invalid (caller then seeds from
  // the --plans-dir flag). Resolved to absolute paths.
  loadPlanDirs() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.planDirsFile(), 'utf8'));
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string').map((p) => path.resolve(p));
    } catch (_) { /* no file / invalid → fall back to the flag seed */ }
    return null;
  }

  // GET /api/plan-dirs?sessionId= — that session's own plan dirs, plus the global
  // dirs (shared base, read-only in the UI) and the session's working dir (already
  // auto-covered). Per-session so each tab configures its own extra directories.
  getPlanDirs(req, res) {
    const session = this.claudeSessions.get(req.query.sessionId);
    if (!session) return res.status(400).json({ error: 'unknown or missing sessionId' });
    res.json({
      dirs: Array.isArray(session.planDirs) ? session.planDirs : [],
      globalDirs: this.planDirs,
      sessionRoots: session.workingDir ? [session.workingDir] : []
    });
  }

  // POST /api/plan-dirs { sessionId, dirs } — replace that session's plan dirs.
  // Each entry must resolve (realpath) to an existing directory; invalid ones are
  // reported in `rejected` and dropped. Deduped and persisted with the session.
  // Only registers directories to the allow-list; reads still go through
  // servePlanFile's realpath check, so no arbitrary-path read is introduced.
  setPlanDirs(req, res) {
    const body = req.body || {};
    const session = this.claudeSessions.get(body.sessionId);
    if (!session) return res.status(400).json({ error: 'unknown or missing sessionId' });
    if (!Array.isArray(body.dirs)) return res.status(400).json({ error: 'dirs must be an array' });
    const { accepted, rejected } = this._validatePlanDirs(body.dirs);
    session.planDirs = accepted;
    this.saveSessionsToDisk();
    res.json({ dirs: session.planDirs, globalDirs: this.planDirs, rejected });
  }

  // Validate a list of directory paths: each must realpath to an existing dir.
  // Returns { accepted: realpaths (deduped), rejected: [{dir, reason}] }.
  _validatePlanDirs(input) {
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const d of input) {
      if (typeof d !== 'string' || !d.trim()) { rejected.push({ dir: d, reason: 'empty' }); continue; }
      try {
        const real = fs.realpathSync(path.resolve(d.trim()));
        if (!fs.statSync(real).isDirectory()) { rejected.push({ dir: d, reason: 'not a directory' }); continue; }
        if (!seen.has(real)) { seen.add(real); accepted.push(real); }
      } catch (_) {
        rejected.push({ dir: d, reason: 'not found' });
      }
    }
    return { accepted, rejected };
  }

  broadcastToSession(claudeSessionId, data) {
    const session = this.claudeSessions.get(claudeSessionId);
    if (!session) return;

    session.connections.forEach(wsId => {
      const wsInfo = this.webSocketConnections.get(wsId);
      // Double-check that this WebSocket is actually part of this session
      if (wsInfo && 
          wsInfo.claudeSessionId === claudeSessionId && 
          wsInfo.ws.readyState === WebSocket.OPEN) {
        this.sendToWebSocket(wsInfo.ws, data);
      }
    });
  }

  cleanupWebSocketConnection(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    // Remove from Claude session if joined
    if (wsInfo.claudeSessionId) {
      const session = this.claudeSessions.get(wsInfo.claudeSessionId);
      if (session) {
        session.connections.delete(wsId);
        this.clearConnectionFlowControl(session, wsId);
        session.lastActivity = new Date();

        // Don't stop Claude if other connections exist
        if (session.connections.size === 0 && this.dev) {
          console.log(`No more connections to session ${wsInfo.claudeSessionId}`);
        }
      }
    }

    this.webSocketConnections.delete(wsId);
  }

  close() {
    // Save sessions before closing
    this.saveSessionsToDisk();
    
    // Clear auto-save interval
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    
    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
    
    // Stop all sessions
    for (const [sessionId, session] of this.claudeSessions.entries()) {
      if (session.active) {
        this.claudeBridge.stopSession(sessionId);
      }
    }
    
    // Clear all data
    this.claudeSessions.clear();
    this.webSocketConnections.clear();
  }

}

async function startServer(options) {
  const server = new ClaudeCodeWebServer(options);
  return await server.start();
}

module.exports = { startServer, ClaudeCodeWebServer };

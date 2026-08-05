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
const CodexBridge = require('./codex-bridge');
const AgentBridge = require('./agent-bridge');
const SessionStore = require('./utils/session-store');
const UsageReader = require('./usage-reader');
const UsageAnalytics = require('./usage-analytics');

class ClaudeCodeWebServer {
  constructor(options = {}) {
    this.port = options.port || 32352;
    this.auth = options.auth;
    this.noAuth = options.noAuth || false;
    this.dev = options.dev || false;
    this.useHttps = options.https || false;
    this.certFile = options.cert;
    this.keyFile = options.key;
    this.folderMode = options.folderMode !== false; // Default to true
    this.selectedWorkingDir = null;
    this.baseFolder = process.cwd(); // The folder where the app runs from
    // Session duration in hours (default to 5 hours from first message)
    this.sessionDurationHours = parseFloat(process.env.CLAUDE_SESSION_HOURS || options.sessionHours || 5);
    
    this.app = express();
    this.claudeSessions = new Map(); // Persistent sessions (claude, codex, or agent)
    this.webSocketConnections = new Map(); // Maps WebSocket connection ID to session info
    this.claudeBridge = new ClaudeBridge();
    this.codexBridge = new CodexBridge();
    this.agentBridge = new AgentBridge();
    this.sessionStore = new SessionStore();
    this.usageReader = new UsageReader(this.sessionDurationHours);
    this.usageAnalytics = new UsageAnalytics({
      sessionDurationHours: this.sessionDurationHours,
      plan: options.plan || process.env.CLAUDE_PLAN || 'max20',
      customCostLimit: parseFloat(process.env.CLAUDE_COST_LIMIT || options.customCostLimit || 50.00)
    });
    this.autoSaveInterval = null;
    this.startTime = Date.now(); // Track server start time
    this.isShuttingDown = false; // Flag to prevent duplicate shutdown
    // Shared usage snapshot cache. Every connected browser polls get_usage on a
    // timer, and each poll runs four transcript-scanning calculators. Without
    // this, N clients × frequent polls fan out into overlapping full scans that
    // peg CPU and leak file descriptors. Cache the heavy result briefly and
    // collapse concurrent requests onto a single in-flight computation.
    this._usageSnapshot = null;
    this._usageSnapshotTime = 0;
    this._usageSnapshotInflight = null;
    this._usageSnapshotTTL = 15000; // ms
    // Commands dropdown removed
    // Assistant aliases (for UI display only)
    this.aliases = {
      claude: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
      codex: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
      agent: options.agentAlias || process.env.AGENT_ALIAS || 'Cursor'
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
    
    // Also save on process exit
    process.on('SIGINT', () => this.handleShutdown());
    process.on('SIGTERM', () => this.handleShutdown());
    process.on('beforeExit', () => this.saveSessionsToDisk());
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

    if (!this.noAuth && this.auth) {
      this.app.use((req, res, next) => {
        const token = req.headers.authorization || req.query.token;
        if (token !== `Bearer ${this.auth}` && token !== this.auth) {
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
          // Only Claude sessions support image paste for now.
          if (session.agent !== 'claude') {
            return res.status(400).json({ error: '仅支持 Claude 会话贴图' });
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
    this.app.get('/api/sessions/persistence', async (req, res) => {
      const metadata = await this.sessionStore.getSessionMetadata();
      res.json({
        ...metadata,
        currentSessions: this.claudeSessions.size,
        autoSaveEnabled: true,
        autoSaveInterval: 30000
      });
    });

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
        agent: null, // 'claude' | 'codex' when started
        workingDir: validWorkingDir,
        connections: new Set(),
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
        aliases: this.aliases
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
        await this.startClaude(wsId, data.options || {}, data.cols, data.rows);
        break;
      case 'start_codex':
        await this.startCodex(wsId, data.options || {}, data.cols, data.rows);
        break;
      case 'start_agent':
        await this.startAgent(wsId, data.options || {}, data.cols, data.rows);
        break;
      
      case 'input':
        if (wsInfo.claudeSessionId) {
          // Verify the session exists and the WebSocket is part of it
          const session = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (session && session.connections.has(wsId)) {
            // Only send if an agent is running in this session
            if (session.active && session.agent) {
              try {
                if (session.agent === 'codex') {
                  await this.codexBridge.sendInput(wsInfo.claudeSessionId, data.data);
                } else if (session.agent === 'agent') {
                  await this.agentBridge.sendInput(wsInfo.claudeSessionId, data.data);
                } else {
                  await this.claudeBridge.sendInput(wsInfo.claudeSessionId, data.data);
                }
              } catch (error) {
                if (this.dev) {
                  console.error(`Failed to send input to session ${wsInfo.claudeSessionId}:`, error.message);
                }
                this.sendToWebSocket(wsInfo.ws, {
                  type: 'error',
                  message: 'Agent is not running in this session. Please start an agent first.'
                });
              }
            } else {
              this.sendToWebSocket(wsInfo.ws, {
                type: 'info',
                message: 'No agent is running. Choose an option to start.'
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
            // Only resize if an agent is actually running
            if (session.active && session.agent) {
              try {
                if (session.agent === 'codex') {
                  await this.codexBridge.resize(wsInfo.claudeSessionId, data.cols, data.rows);
                } else if (session.agent === 'agent') {
                  await this.agentBridge.resize(wsInfo.claudeSessionId, data.cols, data.rows);
                } else {
                  await this.claudeBridge.resize(wsInfo.claudeSessionId, data.cols, data.rows);
                }
              } catch (error) {
                if (this.dev) {
                  console.log(`Resize ignored - agent not active in session ${wsInfo.claudeSessionId}`);
                }
              }
            }
          }
        }
        break;
      
      case 'stop':
        if (wsInfo.claudeSessionId) {
          const session = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (session?.agent === 'codex') {
            await this.stopCodex(wsInfo.claudeSessionId);
          } else if (session?.agent === 'agent') {
            await this.stopAgent(wsInfo.claudeSessionId);
          } else {
            await this.stopClaude(wsInfo.claudeSessionId);
          }
        }
        break;

      case 'ping':
        this.sendToWebSocket(wsInfo.ws, { type: 'pong' });
        break;

      case 'get_usage':
        this.handleGetUsage(wsInfo);
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
      outputBuffer: [],
      sessionStartTime: null, // Will be set when Claude starts
      sessionUsage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalCost: 0,
        models: {}
      },
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
      session.lastActivity = new Date();
    }

    wsInfo.claudeSessionId = null;
    
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_left'
    });
  }

  async startClaude(wsId, options, cols, rows) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
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
        message: 'An agent is already running in this session'
      });
      return;
    }

    // Capture the session ID to avoid closure issues
    const sessionId = wsInfo.claudeSessionId;
    
    try {
      await this.claudeBridge.startSession(sessionId, {
        workingDir: session.workingDir,
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
      session.agent = 'claude';
      session.lastActivity = new Date();
      // Remember that Claude has been started under this session id so future
      // starts (incl. after a server restart) resume the conversation instead of
      // starting fresh. Persist it so the flag survives a restart.
      if (!session.claudeStarted) {
        session.claudeStarted = true;
        this.saveSessionsToDisk();
      }
      // Set session start time if this is the first time Claude is started in this session
      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
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
    session.agent = null;
    session.lastActivity = new Date();

    this.broadcastToSession(claudeSessionId, {
      type: 'claude_stopped'
    });
  }

  async startCodex(wsId, options, cols, rows) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
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
        message: 'An agent is already running in this session'
      });
      return;
    }

    const sessionId = wsInfo.claudeSessionId;
    try {
      await this.codexBridge.startSession(sessionId, {
        workingDir: session.workingDir,
        cols, rows,
        onOutput: (data) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (!currentSession) return;
          currentSession.outputBuffer.push(data);
          if (currentSession.outputBuffer.length > currentSession.maxBufferSize) {
            currentSession.outputBuffer.shift();
          }
          this.broadcastToSession(sessionId, { type: 'output', data });
        },
        onExit: (code, signal) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            currentSession.agent = null;
          }
          this.broadcastToSession(sessionId, { type: 'exit', code, signal });
        },
        onError: (error) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            currentSession.agent = null;
          }
          this.broadcastToSession(sessionId, { type: 'error', message: error.message });
        },
        ...options
      });

      session.active = true;
      session.agent = 'codex';
      session.lastActivity = new Date();
      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
      }

      this.broadcastToSession(sessionId, {
        type: 'codex_started',
        sessionId: sessionId
      });

    } catch (error) {
      if (this.dev) {
        console.error(`Error starting Codex in session ${wsInfo.claudeSessionId}:`, error);
      }
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Failed to start Codex Code: ${error.message}`
      });
    }
  }

  async stopCodex(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session || !session.active) return;
    await this.codexBridge.stopSession(sessionId);
    session.active = false;
    session.agent = null;
    session.lastActivity = new Date();
    this.broadcastToSession(sessionId, { type: 'codex_stopped' });
  }

  async startAgent(wsId, options, cols, rows) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
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
        message: 'An agent is already running in this session'
      });
      return;
    }

    const sessionId = wsInfo.claudeSessionId;
    try {
      await this.agentBridge.startSession(sessionId, {
        workingDir: session.workingDir,
        cols, rows,
        onOutput: (data) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (!currentSession) return;
          currentSession.outputBuffer.push(data);
          if (currentSession.outputBuffer.length > currentSession.maxBufferSize) {
            currentSession.outputBuffer.shift();
          }
          this.broadcastToSession(sessionId, { type: 'output', data });
        },
        onExit: (code, signal) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            currentSession.agent = null;
          }
          this.broadcastToSession(sessionId, { type: 'exit', code, signal });
        },
        onError: (error) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            currentSession.agent = null;
          }
          this.broadcastToSession(sessionId, { type: 'error', message: error.message });
        },
        ...options
      });

      session.active = true;
      session.agent = 'agent';
      session.lastActivity = new Date();
      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
      }

      this.broadcastToSession(sessionId, {
        type: 'agent_started',
        sessionId: sessionId
      });

    } catch (error) {
      if (this.dev) {
        console.error(`Error starting Agent in session ${wsInfo.claudeSessionId}:`, error);
      }
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Failed to start Agent: ${error.message}`
      });
    }
  }

  async stopAgent(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session || !session.active) return;
    await this.agentBridge.stopSession(sessionId);
    session.active = false;
    session.agent = null;
    session.lastActivity = new Date();
    this.broadcastToSession(sessionId, { type: 'agent_stopped' });
  }

  sendToWebSocket(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
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
        if (session.agent === 'codex') {
          this.codexBridge.stopSession(sessionId);
        } else if (session.agent === 'agent') {
          this.agentBridge.stopSession(sessionId);
        } else {
        this.claudeBridge.stopSession(sessionId);
        }
      }
    }
    
    // Clear all data
    this.claudeSessions.clear();
    this.webSocketConnections.clear();
  }

  // Compute the heavy, transcript-scanning usage numbers at most once per TTL,
  // and share a single in-flight computation across concurrent callers so that
  // many clients polling get_usage don't trigger overlapping full scans.
  async getUsageSnapshot() {
    const now = Date.now();
    if (this._usageSnapshot && (now - this._usageSnapshotTime) < this._usageSnapshotTTL) {
      return this._usageSnapshot;
    }
    if (this._usageSnapshotInflight) {
      return this._usageSnapshotInflight;
    }
    this._usageSnapshotInflight = (async () => {
      // Sequential (not Promise.all) to keep the peak open-file count low.
      const currentSessionStats = await this.usageReader.getCurrentSessionStats();
      const burnRateData = await this.usageReader.calculateBurnRate(60);
      const overlappingSessions = await this.usageReader.detectOverlappingSessions();
      const dailyStats = await this.usageReader.getUsageStats(24);
      const snapshot = { currentSessionStats, burnRateData, overlappingSessions, dailyStats };
      this._usageSnapshot = snapshot;
      this._usageSnapshotTime = Date.now();
      return snapshot;
    })();
    try {
      return await this._usageSnapshotInflight;
    } finally {
      this._usageSnapshotInflight = null;
    }
  }

  async handleGetUsage(wsInfo) {
    try {
      const { currentSessionStats, burnRateData, overlappingSessions, dailyStats } =
        await this.getUsageSnapshot();

      // Update analytics with current session data
      if (currentSessionStats && currentSessionStats.sessionStartTime) {
        // Start tracking this session in analytics
        this.usageAnalytics.startSession(
          currentSessionStats.sessionId,
          new Date(currentSessionStats.sessionStartTime)
        );
        
        // Add usage data to analytics
        if (currentSessionStats.totalTokens > 0) {
          this.usageAnalytics.addUsageData({
            tokens: currentSessionStats.totalTokens,
            inputTokens: currentSessionStats.inputTokens,
            outputTokens: currentSessionStats.outputTokens,
            cacheCreationTokens: currentSessionStats.cacheCreationTokens,
            cacheReadTokens: currentSessionStats.cacheReadTokens,
            cost: currentSessionStats.totalCost,
            model: Object.keys(currentSessionStats.models)[0] || 'unknown',
            sessionId: currentSessionStats.sessionId
          });
        }
      }
      
      // Get comprehensive analytics
      const analytics = this.usageAnalytics.getAnalytics();
      
      // Calculate session timer if we have a current session
      let sessionTimer = null;
      if (currentSessionStats && currentSessionStats.sessionStartTime) {
        // Session starts at the hour, not the exact minute
        const startTime = new Date(currentSessionStats.sessionStartTime);
        const now = new Date();
        const elapsedMs = now - startTime;
        
        // Calculate remaining time in session window (5 hours from first message)
        const sessionDurationMs = this.sessionDurationHours * 60 * 60 * 1000;
        const remainingMs = Math.max(0, sessionDurationMs - elapsedMs);
        
        const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
        const minutes = Math.floor((elapsedMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((elapsedMs % (1000 * 60)) / 1000);
        
        const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
        const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        
        sessionTimer = {
          startTime: currentSessionStats.sessionStartTime,
          elapsed: elapsedMs,
          remaining: remainingMs,
          formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
          remainingFormatted: `${String(remainingHours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`,
          hours,
          minutes,
          seconds,
          remainingMs,
          sessionDurationHours: this.sessionDurationHours,
          sessionNumber: currentSessionStats.sessionNumber || 1, // Add session number
          isExpired: remainingMs === 0,
          burnRate: burnRateData.rate,
          burnRateConfidence: burnRateData.confidence,
          depletionTime: analytics.predictions.depletionTime,
          depletionConfidence: analytics.predictions.confidence
        };
      }
      
      this.sendToWebSocket(wsInfo.ws, {
        type: 'usage_update',
        sessionStats: currentSessionStats || {
          requests: 0,
          totalTokens: 0,
          totalCost: 0,
          message: 'No active Claude session'
        },
        dailyStats: dailyStats,
        sessionTimer: sessionTimer,
        analytics: analytics,
        burnRate: burnRateData,
        overlappingSessions: overlappingSessions.length,
        plan: this.usageAnalytics.currentPlan,
        limits: this.usageAnalytics.planLimits[this.usageAnalytics.currentPlan]
      });
      
    } catch (error) {
      console.error('Error getting usage stats:', error);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Failed to retrieve usage statistics'
      });
    }
  }

}

async function startServer(options) {
  const server = new ClaudeCodeWebServer(options);
  return await server.start();
}

module.exports = { startServer, ClaudeCodeWebServer };

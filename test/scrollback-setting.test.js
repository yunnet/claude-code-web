const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');
const SessionStore = require('../src/utils/session-store');

// How much terminal scrollback survives a restart used to be three separate
// hard-coded numbers in two files: persist 100 chunks, replay 200, hold 1000 in
// memory. Raising only the persist cap changes nothing a user can see, because
// the replay slice is what reaches the browser — so these tests treat "one
// setting drives all three" as the contract, not an implementation detail.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

const SESSION_ID = 'b2eb18c9-d0b4-4264-9735-d60baa516a3a';

describe('scrollback chunk setting', function () {
  let dataDir;
  let prevEnv;
  let server;

  beforeEach(function () {
    prevEnv = process.env.CCW_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-sb-'));
    process.env.CCW_DATA_DIR = dataDir;
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    if (prevEnv === undefined) delete process.env.CCW_DATA_DIR;
    else process.env.CCW_DATA_DIR = prevEnv;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  const chunks = (n) => Array.from({ length: n }, (_, i) => `chunk-${i}\r\n`);

  const fakeSession = (buffer) => ({
    name: 'test',
    created: new Date(),
    lastActivity: new Date(),
    workingDir: dataDir,
    planDirs: [],
    claudeStarted: true,
    outputBuffer: buffer,
    connections: new Set(),
    active: false
  });

  it('defaults to 500, up from the 100 that made a restart feel empty', function () {
    const res = mockRes();
    server.getScrollback({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.chunks, 500);
    assert.strictEqual(res.body.default, 500);
    assert.strictEqual(server.sessionStore.maxOutputChunks, 500);
  });

  it('trims the persisted buffer to the configured size', function () {
    const store = new SessionStore();
    store.maxOutputChunks = 500;
    const record = store.toRecord(SESSION_ID, fakeSession(chunks(600)));
    assert.strictEqual(record.outputBuffer.length, 500);
    // The TAIL is what matters — keeping the first 500 would preserve the oldest
    // output and drop everything you were just looking at.
    assert.strictEqual(record.outputBuffer[499], 'chunk-599\r\n');
  });

  it('replays the configured size, not a hard-coded 200', async function () {
    // The one that fails if only the persist cap is raised. Replay is what the
    // browser actually receives, so a setting that does not move it is a lie.
    const sent = [];
    server.setScrollbackChunks(500);
    server.claudeSessions.set(SESSION_ID, fakeSession(chunks(600)));
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: null });
    server.sendToWebSocket = (_ws, msg) => sent.push(msg);

    await server.joinClaudeSession('ws1', SESSION_ID);

    const joined = sent.find((m) => m.type === 'session_joined');
    assert.ok(joined, 'expected a session_joined message');
    assert.strictEqual(joined.outputBuffer.length, 500);
    assert.strictEqual(joined.outputBuffer[499], 'chunk-599\r\n');
  });

  it('keeps the in-memory buffer at least as large as what it must persist', function () {
    // Persisting N chunks is impossible if memory only ever holds fewer.
    server.setScrollbackChunks(3000);
    assert.ok(server.maxBufferSize() >= 3000, `memory cap ${server.maxBufferSize()} < 3000`);
    // Existing sessions must be raised too, not just ones created later.
    const session = fakeSession(chunks(10));
    session.maxBufferSize = 1000;
    server.claudeSessions.set(SESSION_ID, session);
    server.setScrollbackChunks(4000);
    assert.ok(session.maxBufferSize >= 4000, `live session cap ${session.maxBufferSize} < 4000`);
  });

  it('clamps out-of-range values instead of rejecting them', function () {
    for (const [input, expected] of [[0, 50], [-5, 50], [10, 50], [99999, 5000]]) {
      const res = mockRes();
      server.setScrollback({ body: { chunks: input } }, res);
      assert.strictEqual(res.statusCode, 200, `input ${input} should not be an error`);
      assert.strictEqual(res.body.chunks, expected, `input ${input} should clamp to ${expected}`);
      assert.strictEqual(server.sessionStore.maxOutputChunks, expected);
    }
  });

  it('rejects anything that is not a whole number', function () {
    for (const bad of ['abc', 1.5, null, undefined, {}, NaN, Infinity, '500']) {
      const res = mockRes();
      server.setScrollback({ body: { chunks: bad } }, res);
      assert.strictEqual(res.statusCode, 400, `${JSON.stringify(bad)} should be a 400`);
    }
    // A rejected write must not have moved the live value.
    assert.strictEqual(server.sessionStore.maxOutputChunks, 500);
  });

  it('persists across a restart', function () {
    const res = mockRes();
    server.setScrollback({ body: { chunks: 1200 } }, res);
    assert.strictEqual(res.body.chunks, 1200);
    assert.ok(fs.existsSync(path.join(dataDir, 'scrollback.json')));

    const restarted = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    try {
      assert.strictEqual(restarted.sessionStore.maxOutputChunks, 1200);
    } finally {
      if (typeof restarted.dispose === 'function') restarted.dispose();
    }
  });

  it('clamps an out-of-range value found on disk, rather than discarding it', function () {
    // Hand-edited to more than we allow: the useful answer is the most we will
    // honour, not a silent drop back to the default (which would be LESS than
    // what was there before the edit). Same rule as the POST path.
    for (const [onDisk, expected] of [[99999, 5000], [-1, 50], [0, 50]]) {
      fs.writeFileSync(path.join(dataDir, 'scrollback.json'), JSON.stringify({ chunks: onDisk }));
      const s = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      try {
        assert.strictEqual(s.sessionStore.maxOutputChunks, expected, `${onDisk} should clamp to ${expected}`);
      } finally {
        if (typeof s.dispose === 'function') s.dispose();
      }
    }
  });

  it('falls back to the default when the settings file is unreadable', function () {
    // Genuinely unusable content, as opposed to a number outside the range.
    for (const junk of ['not json at all', '{"chunks": "banana"}', '[]', '{"chunks": 1.5}']) {
      fs.writeFileSync(path.join(dataDir, 'scrollback.json'), junk);
      const s = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      try {
        assert.strictEqual(s.sessionStore.maxOutputChunks, 500, `junk ${junk} should fall back to 500`);
      } finally {
        if (typeof s.dispose === 'function') s.dispose();
      }
    }
  });
});

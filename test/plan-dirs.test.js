const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

describe('plan dirs API — per session', function() {
  let server;
  let dataDir;
  let realDir;
  let sessionDir;
  let prevEnv;

  beforeEach(function() {
    prevEnv = process.env.CCW_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-data-'));
    process.env.CCW_DATA_DIR = dataDir;
    realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')));
    sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    // A minimal session object (what claudeSessions holds).
    server.claudeSessions.set('A', { id: 'A', workingDir: sessionDir, planDirs: [], connections: new Set() });
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    if (prevEnv === undefined) delete process.env.CCW_DATA_DIR; else process.env.CCW_DATA_DIR = prevEnv;
    for (const d of [dataDir, realDir, sessionDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  });

  it('GET returns the session dirs, global dirs and the session root', function() {
    const res = mockRes();
    server.getPlanDirs({ query: { sessionId: 'A' } }, res);
    assert.deepStrictEqual(res.body.dirs, []);
    assert.ok(Array.isArray(res.body.globalDirs));
    assert.deepStrictEqual(res.body.sessionRoots, [sessionDir]);
  });

  it('GET with an unknown/missing sessionId is a 400', function() {
    let res = mockRes();
    server.getPlanDirs({ query: { sessionId: 'nope' } }, res);
    assert.strictEqual(res.statusCode, 400);
    res = mockRes();
    server.getPlanDirs({ query: {} }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('POST registers a real directory on that session (deduped, rejecting bogus)', function() {
    const res = mockRes();
    server.setPlanDirs({ body: { sessionId: 'A', dirs: [realDir, '/no/such/dir', realDir, ''] } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.dirs, [realDir]); // deduped, bogus dropped
    assert.deepStrictEqual(server.claudeSessions.get('A').planDirs, [realDir]);
    const reasons = res.body.rejected.map((r) => r.reason).sort();
    assert.deepStrictEqual(reasons, ['empty', 'not found']);
  });

  it('POST rejects a file path (not a directory)', function() {
    const file = path.join(realDir, 'f.txt');
    fs.writeFileSync(file, 'x');
    const res = mockRes();
    server.setPlanDirs({ body: { sessionId: 'A', dirs: [file] } }, res);
    assert.deepStrictEqual(res.body.dirs, []);
    assert.strictEqual(res.body.rejected[0].reason, 'not a directory');
  });

  it('POST with an unknown session or a non-array body is a 400', function() {
    let res = mockRes();
    server.setPlanDirs({ body: { sessionId: 'nope', dirs: [realDir] } }, res);
    assert.strictEqual(res.statusCode, 400);
    res = mockRes();
    server.setPlanDirs({ body: { sessionId: 'A', dirs: 'notarray' } }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('per-session isolation: setting dirs on A does not affect B', function() {
    server.claudeSessions.set('B', { id: 'B', workingDir: sessionDir, planDirs: [], connections: new Set() });
    server.setPlanDirs({ body: { sessionId: 'A', dirs: [realDir] } }, mockRes());
    assert.deepStrictEqual(server.claudeSessions.get('A').planDirs, [realDir]);
    assert.deepStrictEqual(server.claudeSessions.get('B').planDirs, []);
  });

  it('global dirs (from --plans-dir / plan-dirs.json) load at startup as the shared base', function() {
    server.dispose();
    // A persisted global plan-dirs.json is loaded into this.planDirs (base for all sessions).
    fs.writeFileSync(path.join(dataDir, 'plan-dirs.json'), JSON.stringify([realDir]));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false, planDirs: ['/tmp/ignored-seed'] });
    assert.deepStrictEqual(server.planDirs, [realDir]); // persisted wins over the flag seed
    server.claudeSessions.set('A', { id: 'A', workingDir: sessionDir, planDirs: [], connections: new Set() });
    const res = mockRes();
    server.getPlanDirs({ query: { sessionId: 'A' } }, res);
    assert.deepStrictEqual(res.body.globalDirs, [realDir]);
  });
});

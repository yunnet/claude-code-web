const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

describe('Server Aliases', function() {
  let server;

  // The server constructor starts a 30s auto-save setInterval and registers
  // process listeners (incl. a beforeExit handler that re-arms the event loop);
  // dispose() releases them so the process can exit cleanly instead of hanging.
  afterEach(function() {
    if (server && typeof server.dispose === 'function') {
      server.dispose();
    }
    server = null;
  });

  it('should set aliases from options', function() {
    server = new ClaudeCodeWebServer({
      claudeAlias: 'Buddy',
      codexAlias: 'Robo',
      agentAlias: 'Helper',
      noAuth: true // avoid auth middleware complexity
    });

    assert.strictEqual(server.aliases.claude, 'Buddy');
    assert.strictEqual(server.aliases.codex, 'Robo');
    assert.strictEqual(server.aliases.agent, 'Helper');
  });

  it('should default aliases when not provided', function() {
    server = new ClaudeCodeWebServer({ noAuth: true });
    assert.ok(server.aliases.claude && server.aliases.claude.length > 0);
    assert.ok(server.aliases.codex && server.aliases.codex.length > 0);
    assert.ok(server.aliases.agent && server.aliases.agent.length > 0);
  });
});


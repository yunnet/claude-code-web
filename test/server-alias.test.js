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

  it('should set the alias from options', function() {
    server = new ClaudeCodeWebServer({
      claudeAlias: 'Buddy',
      noAuth: true // avoid auth middleware complexity
    });

    assert.strictEqual(server.aliases.claude, 'Buddy');
  });

  it('should default the alias when not provided', function() {
    server = new ClaudeCodeWebServer({ noAuth: true });
    assert.ok(server.aliases.claude && server.aliases.claude.length > 0);
  });

  // Codex/cursor-agent support was removed in 3.21.0; nothing should reintroduce
  // an alias for a CLI this server can no longer launch.
  it('carries no alias for a CLI that can no longer be started', function() {
    server = new ClaudeCodeWebServer({ noAuth: true });
    assert.deepStrictEqual(Object.keys(server.aliases), ['claude']);
  });
});

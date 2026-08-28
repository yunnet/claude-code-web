const assert = require('assert');
const { CliBridge, codexConfig, agentConfig } = require('../src/cli-bridge');

// ponytail: the merge's only risk is losing a method or the dangerous-flag
// difference. This checks exactly that, without spawning a real CLI.
describe('CliBridge (merged codex/agent bridge)', function() {
  const surface = ['startSession', 'sendInput', 'resize', 'pause', 'resume',
                   'stopSession', 'getSession', 'getAllSessions', 'cleanup'];

  for (const [name, cfg] of [['codex', codexConfig], ['agent', agentConfig]]) {
    it(`${name} bridge exposes the full method surface`, function() {
      const b = new CliBridge(cfg);
      for (const m of surface) assert.strictEqual(typeof b[m], 'function', `missing ${m}`);
      assert.deepStrictEqual(b.getAllSessions(), []);
      assert.ok(typeof b.command === 'string' && b.command.length);
    });
  }

  it('only codex carries the dangerous bypass flag', function() {
    assert.strictEqual(codexConfig.dangerousFlag, '--dangerously-bypass-approvals-and-sandbox');
    assert.strictEqual(agentConfig.dangerousFlag, null);
  });
});

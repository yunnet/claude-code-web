const assert = require('assert');
const ClaudeBridge = require('../src/claude-bridge');

describe('ClaudeBridge', function() {
  let bridge;

  beforeEach(function() {
    bridge = new ClaudeBridge();
  });

  describe('constructor', function() {
    it('should initialize with a Map for sessions', function() {
      assert(bridge.sessions instanceof Map);
      assert.strictEqual(bridge.sessions.size, 0);
    });

    it('should find a claude command on initialization', function() {
      assert(typeof bridge.claudeCommand === 'string');
      assert(bridge.claudeCommand.length > 0);
    });
  });

  describe('commandExists', function() {
    it('should return true for existing commands like "ls"', function() {
      const result = bridge.commandExists('ls');
      assert.strictEqual(result, true);
    });

    it('should return false for non-existent commands', function() {
      const result = bridge.commandExists('nonexistentcommand12345');
      assert.strictEqual(result, false);
    });

    it('should handle command names with special characters safely', function() {
      // This tests the security fix - commands with shell metacharacters should not break
      const result = bridge.commandExists('ls; echo "injected"');
      assert.strictEqual(result, false);
    });
  });

  describe('getSession', function() {
    it('should return undefined for non-existent session', function() {
      const result = bridge.getSession('nonexistent');
      assert.strictEqual(result, undefined);
    });
  });

  describe('getAllSessions', function() {
    it('should return empty array when no sessions exist', function() {
      const result = bridge.getAllSessions();
      assert(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });
  });

  describe('buildInjectedSettings', function() {
    it('should always route notifications to the terminal bell', function() {
      const s = bridge.buildInjectedSettings('sess-1', {});
      assert.strictEqual(s.preferredNotifChannel, 'terminal_bell');
    });

    it('should NOT register hooks when relay params are missing', function() {
      assert.strictEqual(bridge.buildInjectedSettings('sess-1', {}).hooks, undefined);
      assert.strictEqual(
        bridge.buildInjectedSettings('sess-1', { hookScript: '/x/cc-hook.js', hookPort: 0, hookToken: 't' }).hooks,
        undefined
      );
    });

    it('should register a PreToolUse(ExitPlanMode) hook when relay params are present', function() {
      const s = bridge.buildInjectedSettings('sess-abc', {
        hookScript: '/opt/app/bin/cc-hook.js',
        hookPort: 32353,
        hookToken: 'tok-xyz'
      });
      assert(s.hooks && Array.isArray(s.hooks.PreToolUse));
      const group = s.hooks.PreToolUse[0];
      assert.strictEqual(group.matcher, 'ExitPlanMode');
      const cmd = group.hooks[0].command;
      assert.strictEqual(group.hooks[0].type, 'command');
      // The command relays this session's plan event with the right args.
      assert(cmd.includes('/opt/app/bin/cc-hook.js'), 'command includes hook script path');
      assert(cmd.includes('--port 32353'), 'command includes port');
      assert(cmd.includes('sess-abc'), 'command includes session id');
      assert(cmd.includes('tok-xyz'), 'command includes token');
    });

    it('should single-quote-escape argv to avoid shell injection', function() {
      const s = bridge.buildInjectedSettings("a'b; rm -rf /", {
        hookScript: '/bin/cc-hook.js', hookPort: 1, hookToken: 't'
      });
      const cmd = s.hooks.PreToolUse[0].hooks[0].command;
      // The dangerous session id is wrapped/escaped, not left bare.
      assert(!cmd.includes("a'b; rm -rf /"), 'raw dangerous string is not present unescaped');
      assert(cmd.includes(`'a'\\''b; rm -rf /'`), 'session id is single-quote escaped');
    });
  });
});
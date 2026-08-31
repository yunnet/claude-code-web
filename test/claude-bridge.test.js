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
      // The token must NOT be on the command line — it travels via the
      // CCWEB_HOOK_TOKEN env var so it can't leak through /proc/<pid>/cmdline.
      assert(!cmd.includes('tok-xyz'), 'command must NOT include the hook token');
      assert(!cmd.includes('--token'), 'command must NOT carry a --token flag');
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

  describe('theme injection', function() {
    // The browser terminal is the background Claude draws on, so Claude's theme
    // has to follow the UI's, not the user's global settings.json.
    it('maps the UI theme to a Claude theme', function() {
      assert.strictEqual(ClaudeBridge.themeForUi('light'), 'light-ansi');
      assert.strictEqual(ClaudeBridge.themeForUi('dark'), 'dark');
    });

    it('uses light-ansi, not light — light rules its input box at 2.85:1 on white', function() {
      const s = bridge.buildInjectedSettings('sid', { uiTheme: 'light' });
      assert.strictEqual(s.theme, 'light-ansi');
    });

    it('injects the dark theme for a dark UI', function() {
      assert.strictEqual(bridge.buildInjectedSettings('sid', { uiTheme: 'dark' }).theme, 'dark');
    });

    it('injects no theme when the UI did not report one (older client)', function() {
      assert.ok(!('theme' in bridge.buildInjectedSettings('sid', {})));
      assert.ok(!('theme' in bridge.buildInjectedSettings('sid', { uiTheme: 'nonsense' })));
    });

    it('keeps the notification channel and hooks alongside the theme', function() {
      const s = bridge.buildInjectedSettings('sid', {
        uiTheme: 'light', hookScript: '/bin/cc-hook.js', hookPort: 1, hookToken: 't'
      });
      assert.strictEqual(s.preferredNotifChannel, 'terminal_bell');
      assert.strictEqual(s.theme, 'light-ansi');
      assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes('cc-hook.js'));
    });
  });

  describe('clearEmptyTranscript', function() {
    // The id is interpolated into paths this deletes — one of them recursively,
    // inside the user's home. Anything that isn't a uuid must be refused before
    // a single fs call happens.
    it('refuses ids that are not uuids', function() {
      const bad = ['../../..', '.', '..', '', null, undefined, 'a/b', 'not-a-uuid',
                   '../../../.claude', '3f389a10-7fe6-42ed-81fc-ada46a5f4232/../..'];
      for (const id of bad) {
        assert.strictEqual(bridge.clearEmptyTranscript(id), false, `must refuse ${JSON.stringify(id)}`);
      }
    });

    it('accepts a well-formed uuid (and reports false when nothing matches)', function() {
      assert.strictEqual(bridge.clearEmptyTranscript('3f389a10-7fe6-42ed-81fc-ada46a5f4232'), false);
    });
  });
});
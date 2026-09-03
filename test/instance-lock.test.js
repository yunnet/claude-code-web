const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The registry holds the auth token, so its file mode is a security property,
// not a detail. And it is read by a *different* process than the one that wrote
// it, which is what makes atomicity and stale detection matter here rather than
// being theoretical.
describe('instance lock', function () {
  let root;
  let lock;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-lock-'));
    process.env.CCW_DATA_DIR = root;
    // dataDir() reads the env at call time, but require caching would otherwise
    // carry a previous test's module state; reload to keep each case isolated.
    delete require.cache[require.resolve('../src/instance-lock')];
    lock = require('../src/instance-lock');
  });

  afterEach(function () {
    delete process.env.CCW_DATA_DIR;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  describe('writeLock', function () {
    it('writes 0600 — the token is in this file', function () {
      // argv put the token in /proc/<pid>/cmdline at mode 444. If this file is
      // not 0600 the move buys nothing, so assert the number.
      const p = lock.writeLock({ port: 32353, authToken: 'secret-token', sourceDir: '/src' });
      assert.ok(p, 'a path was returned');
      const mode = fs.statSync(p).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
      // The containing directory must not be world-listable either.
      const dirMode = fs.statSync(lock.instancesDir()).mode & 0o777;
      assert.strictEqual(dirMode, 0o700, `expected dir 0700, got ${dirMode.toString(8)}`);
    });

    it('records what /proc used to be needed for', function () {
      lock.writeLock({ port: 32353, sourceDir: '/data/cc-web', version: '4.3.0', buildId: 'abc123' });
      const r = lock.readLock(32353);
      assert.strictEqual(r.port, 32353);
      assert.strictEqual(r.pid, process.pid);
      assert.strictEqual(r.sourceDir, '/data/cc-web');
      assert.strictEqual(r.dataDir, root);
      assert.strictEqual(r.version, '4.3.0');
      assert.strictEqual(r.buildId, 'abc123');
      assert.ok(r.startedAt, 'carries a start time');
    });

    it('omits the token entirely in --disable-auth mode', function () {
      lock.writeLock({ port: 32352, sourceDir: '/src' });
      const r = lock.readLock(32352);
      // Omitted, not null: the field's presence is what means "wants a token".
      assert.ok(!('authToken' in r), 'no authToken key at all');
    });

    it('leaves no temp file behind', function () {
      lock.writeLock({ port: 32353, authToken: 't' });
      const leftovers = fs.readdirSync(lock.instancesDir()).filter(f => f.includes('.tmp'));
      assert.deepStrictEqual(leftovers, [], 'the rename consumed the temp file');
    });

    it('refuses a port that is not a port, instead of building a path from it', function () {
      for (const port of [0, -1, 70000, 1.5, '32353', null, undefined, '../../etc/passwd']) {
        assert.strictEqual(lock.writeLock({ port }), null, `must refuse ${JSON.stringify(port)}`);
      }
      assert.strictEqual(lock.readLock('../../etc/passwd'), null);
    });
  });

  describe('listLocks', function () {
    it('skips a corrupt file rather than failing the whole listing', function () {
      lock.writeLock({ port: 32352, sourceDir: '/a' });
      lock.writeLock({ port: 32353, sourceDir: '/b' });
      fs.writeFileSync(path.join(lock.instancesDir(), '32999.lock'), '{ this is not json');

      const all = lock.listLocks();
      assert.strictEqual(all.length, 2, 'the two good records survive');
      assert.deepStrictEqual(all.map(r => r.port).sort(), [32352, 32353]);
    });

    it('rejects a record whose body disagrees with its filename', function () {
      // Corruption, not staleness: the filename is the authority on the port.
      fs.mkdirSync(lock.instancesDir(), { recursive: true });
      fs.writeFileSync(path.join(lock.instancesDir(), '32353.lock'), JSON.stringify({ port: 9999, pid: 1 }));
      assert.strictEqual(lock.readLock(32353), null);
      assert.deepStrictEqual(lock.listLocks(), []);
    });

    it('returns an empty list when nothing has ever run', function () {
      assert.deepStrictEqual(lock.listLocks(), []);
    });
  });

  describe('isLockLive', function () {
    it('treats a recycled pid as dead, not alive', function () {
      // The trap this guards: pids are recycled. Asking only "does this pid
      // exist" keeps a dead instance's record forever once its pid is reused.
      // pid 1 always exists and is never our server.
      assert.strictEqual(lock.isLockLive({ pid: 1, port: 32353 }, { portInUse: false }), false,
        'existing pid + port not listening = stale');
      assert.strictEqual(lock.isLockLive({ pid: 1, port: 32353 }, { portInUse: true }), true);
    });

    it('calls a vanished pid dead', function () {
      // A pid that cannot exist: above the kernel maximum.
      assert.strictEqual(lock.isLockLive({ pid: 0x7ffffffe, port: 32353 }), false);
    });

    it('calls this very process alive', function () {
      assert.strictEqual(lock.isLockLive({ pid: process.pid, port: 32353 }), true);
    });

    it('refuses records with no usable pid', function () {
      for (const r of [null, {}, { pid: 'x' }, { pid: null }]) {
        assert.strictEqual(lock.isLockLive(r), false);
      }
    });
  });

  describe('pruneStaleLocks', function () {
    it('clears what a kill -9 left behind and keeps what is running', function () {
      lock.writeLock({ port: 32353, sourceDir: '/live' });          // this process
      fs.writeFileSync(
        path.join(lock.instancesDir(), '32352.lock'),
        JSON.stringify({ port: 32352, pid: 0x7ffffffe, sourceDir: '/dead' }),
        { mode: 0o600 },
      );

      const pruned = lock.pruneStaleLocks();
      assert.deepStrictEqual(pruned, [32352]);
      assert.deepStrictEqual(lock.listLocks().map(r => r.port), [32353]);
    });

    it('never prunes its own record', function () {
      lock.writeLock({ port: 32353 });
      assert.deepStrictEqual(lock.pruneStaleLocks(), []);
      assert.ok(lock.readLock(32353), 'still there');
    });
  });

  describe('removeLock', function () {
    it('removes on shutdown and reports honestly when there is nothing to remove', function () {
      lock.writeLock({ port: 32353 });
      assert.strictEqual(lock.removeLock(32353), true);
      assert.strictEqual(lock.readLock(32353), null);
      assert.strictEqual(lock.removeLock(32353), false, 'second removal is a no-op, not an error');
    });
  });
});

// The token's resolution order is the whole point of the change, and it lives in
// bin/cc-web.js where there is no exported function to call. Driving the real
// CLI for each case would mean four servers and four ports per run; asserting on
// the source keeps it fast and still fails if someone reorders the branches or
// quietly changes what happens when no token is given.
describe('auth token sources', function () {
  const fs = require('fs');
  const path = require('path');
  const BIN = fs.readFileSync(path.join(__dirname, '..', 'bin', 'cc-web.js'), 'utf8');

  function branchOrder() {
    const order = [];
    for (const m of BIN.matchAll(/(options\.authFile|process\.env\.CCWEB_AUTH|options\.auth)\b/g)) {
      const k = m[1];
      if (!order.includes(k)) order.push(k);
    }
    return order;
  }

  it('prefers the file, then the env var, then the flag', function () {
    // A file keeps the token out of the process image entirely; the env var at
    // least lands in /proc/<pid>/environ (mode 600) instead of cmdline (444).
    assert.deepStrictEqual(
      branchOrder().slice(0, 3),
      ['options.authFile', 'process.env.CCWEB_AUTH', 'options.auth'],
    );
  });

  it('still generates a token and keeps auth on when given none', function () {
    // Load-bearing default. Changing it would silently turn a protected instance
    // into an open one, which is exactly the kind of "improvement" this guards.
    assert.ok(/authToken = generateRandomToken\(\)/.test(BIN), 'falls back to a generated token');
    assert.ok(/--disable-auth/.test(BIN), 'disabling auth stays explicit and opt-in');
  });

  it('keeps --auth working, and says why it is the worst option', function () {
    assert.ok(/--auth <token>/.test(BIN), 'the old flag is not removed');
    assert.ok(/proc/.test(BIN), 'the flag description or warning explains the exposure');
  });

  it('fails loudly on an unreadable or empty --auth-file', function () {
    // Silently generating a random token here would look like it worked while
    // locking the user out of their own instance.
    assert.ok(/cannot read --auth-file/.test(BIN));
    assert.ok(/is empty/.test(BIN));
    assert.ok(/process\.exit\(1\)/.test(BIN));
  });

  it('reports its real version', function () {
    // It advertised 3.4.0 while package.json said 4.2.1.
    assert.ok(/\.version\(require\('\.\.\/package\.json'\)\.version\)/.test(BIN),
      'version comes from package.json, not a hardcoded string');
  });
});

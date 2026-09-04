const assert = require('assert');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SessionStore = require('../src/utils/session-store');

// A uuid, because the store refuses anything else: the id becomes a filename.
const ID = (n) => `0000000${n}-1111-2222-3333-444444444444`;

// Every case gets its own CCW_DATA_DIR. An earlier version of these tests
// redirected storageDir after construction, which silently stopped working
// once the paths were derived in the constructor — and one run migrated the
// live instance's sessions into its real data dir. Set the env, build the
// store, never touch a real directory.
function withTempStore() {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ccw-sess-'));
  process.env.CCW_DATA_DIR = dir;
  return { dir, store: new SessionStore() };
}

const sessionOf = (over = {}) => ({
  name: 'Test Session',
  workingDir: '/data/work',
  planDirs: [],
  created: new Date('2026-09-01T00:00:00Z'),
  lastActivity: new Date(),
  lastAccessed: Date.now(),
  outputBuffer: [],
  ...over,
});

describe('SessionStore', function () {
  let dir;
  let store;

  beforeEach(function () {
    ({ dir, store } = withTempStore());
  });

  afterEach(function () {
    delete process.env.CCW_DATA_DIR;
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  describe('saveSessions', function () {
    it('writes one file per session, named by id', async function () {
      await store.saveSessions(new Map([
        [ID(1), sessionOf({ name: 'one' })],
        [ID(2), sessionOf({ name: 'two' })],
      ]));
      const files = (await fs.readdir(path.join(dir, 'sessions'))).sort();
      assert.deepStrictEqual(files, [`${ID(1)}.json`, `${ID(2)}.json`]);
    });

    it('DELETES NOTHING — the point of the whole change', async function () {
      // Two instances sharing a data dir each hold half the sessions. If saving
      // one half removed the other, this store would repeat the failure it
      // exists to fix: on 2026-09-03 a full-file rewrite by a second instance
      // silently dropped the first one's sessions.
      await store.saveSessions(new Map([[ID(1), sessionOf({ name: 'theirs' })]]));
      await store.saveSessions(new Map([[ID(2), sessionOf({ name: 'ours' })]]));

      const loaded = await store.loadSessions();
      assert.strictEqual(loaded.size, 2, 'the first save survived the second');
      assert.strictEqual(loaded.get(ID(1)).name, 'theirs');
      assert.strictEqual(loaded.get(ID(2)).name, 'ours');
    });

    it('leaves no temp file behind', async function () {
      await store.saveSessions(new Map([[ID(1), sessionOf()]]));
      const leftovers = (await fs.readdir(path.join(dir, 'sessions'))).filter(f => f.includes('.tmp'));
      assert.deepStrictEqual(leftovers, []);
    });

    it('refuses an id that is not a uuid, rather than building a path from it', async function () {
      for (const bad of ['session1', '../../etc/passwd', '', null, undefined, 'a/b']) {
        assert.strictEqual(await store.writeOne(bad, sessionOf()), false, `must refuse ${JSON.stringify(bad)}`);
      }
      const files = await fs.readdir(path.join(dir, 'sessions')).catch(() => []);
      assert.deepStrictEqual(files, [], 'nothing was written');
    });

    it('caps the output buffer at 100 chunks, as before', async function () {
      const chunks = Array.from({ length: 250 }, (_, i) => `chunk-${i}`);
      await store.saveSessions(new Map([[ID(1), sessionOf({ outputBuffer: chunks })]]));
      const back = (await store.loadSessions()).get(ID(1));
      assert.strictEqual(back.outputBuffer.length, 100);
      assert.strictEqual(back.outputBuffer[99], 'chunk-249', 'kept the newest');
    });

    it('does not persist runtime state', async function () {
      await store.saveSessions(new Map([
        [ID(1), sessionOf({ active: true, connections: new Set(['ws-1']) })],
      ]));
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'sessions', `${ID(1)}.json`), 'utf8'));
      assert.ok(!('active' in raw), 'active is not stored');
      assert.ok(!('connections' in raw), 'connections are not stored');

      const back = (await store.loadSessions()).get(ID(1));
      assert.strictEqual(back.active, false, 'restored idle: its PTY died with the old process');
      assert.strictEqual(back.connections.size, 0);
    });
  });

  describe('loadSessions', function () {
    it('returns an empty Map when nothing has been saved', async function () {
      const sessions = await store.loadSessions();
      assert.ok(sessions instanceof Map);
      assert.strictEqual(sessions.size, 0);
    });

    it('round-trips every field', async function () {
      await store.saveSessions(new Map([[ID(1), sessionOf({
        name: 'cgs-master', workingDir: '/data/work/x', planDirs: ['/p'],
        claudeStarted: true, outputBuffer: ['\x1b[32mgreen\x1b[0m'],
      })]]));
      const s = (await store.loadSessions()).get(ID(1));
      assert.strictEqual(s.name, 'cgs-master');
      assert.strictEqual(s.workingDir, '/data/work/x');
      assert.deepStrictEqual(s.planDirs, ['/p']);
      assert.strictEqual(s.claudeStarted, true);
      // Terminal bytes go through untouched — that invariant does not stop at
      // the socket.
      assert.deepStrictEqual(s.outputBuffer, ['\x1b[32mgreen\x1b[0m']);
      assert.ok(s.created instanceof Date);
    });

    it('a corrupt file costs one session, not the whole list', async function () {
      await store.saveSessions(new Map([[ID(1), sessionOf({ name: 'good' })]]));
      await fs.writeFile(path.join(dir, 'sessions', `${ID(9)}.json`), '{ not json');

      const loaded = await store.loadSessions();
      assert.strictEqual(loaded.size, 1, 'the healthy session still loads');
      assert.strictEqual(loaded.get(ID(1)).name, 'good');
      const moved = (await fs.readdir(path.join(dir, 'sessions'))).filter(f => f.includes('.corrupted.'));
      assert.strictEqual(moved.length, 1, 'the bad file is moved aside, not left to trip the next load');
    });

    it('ignores files that are not uuid-named', async function () {
      await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
      // The trap this guards is the one Claude Code hit and documented: lenient
      // parsing turns `2026-03-14_notes.md` into an id and then sweeps it.
      await fs.writeFile(path.join(dir, 'sessions', '2026-03-14_notes.json'), '{"id":"x"}');
      const loaded = await store.loadSessions();
      assert.strictEqual(loaded.size, 0);
      assert.ok(fsSync.existsSync(path.join(dir, 'sessions', '2026-03-14_notes.json')),
        'and leaves the stranger alone rather than deleting it');
    });

    it('expires per session, so one live tab does not keep stale siblings alive', async function () {
      const old = new Date(Date.now() - 30 * 86400000);
      await store.saveSessions(new Map([
        [ID(1), sessionOf({ name: 'fresh' })],
        [ID(2), sessionOf({ name: 'ancient', lastActivity: old })],
      ]));
      const loaded = await store.loadSessions();
      assert.deepStrictEqual([...loaded.keys()], [ID(1)]);
      assert.ok(!fsSync.existsSync(path.join(dir, 'sessions', `${ID(2)}.json`)), 'the expired file is removed');
    });
  });

  describe('deleteSession', function () {
    it('removes one session and leaves the rest', async function () {
      await store.saveSessions(new Map([[ID(1), sessionOf()], [ID(2), sessionOf()]]));
      assert.strictEqual(await store.deleteSession(ID(1)), true);
      const loaded = await store.loadSessions();
      assert.deepStrictEqual([...loaded.keys()], [ID(2)]);
    });

    it('reports honestly when there is nothing to delete', async function () {
      assert.strictEqual(await store.deleteSession(ID(7)), false);
    });

    it('refuses a non-uuid id', async function () {
      assert.strictEqual(await store.deleteSession('../../etc/passwd'), false);
    });
  });

  describe('migration from sessions.json', function () {
    it('splits the legacy file and leaves the original untouched', async function () {
      const legacy = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        sessions: [
          { id: ID(1), name: 'a', workingDir: '/w/a', outputBuffer: ['x'], claudeStarted: true,
            created: new Date().toISOString(), lastActivity: new Date().toISOString(), lastAccessed: 1 },
          { id: ID(2), name: 'b', workingDir: '/w/b', outputBuffer: [], planDirs: ['/p'],
            created: new Date().toISOString(), lastActivity: new Date().toISOString(), lastAccessed: 2 },
        ],
      };
      const legacyPath = path.join(dir, 'sessions.json');
      await fs.writeFile(legacyPath, JSON.stringify(legacy));
      const before = await fs.readFile(legacyPath, 'utf8');

      const loaded = await store.loadSessions();
      assert.strictEqual(loaded.size, 2);
      assert.strictEqual(loaded.get(ID(1)).name, 'a');
      assert.strictEqual(loaded.get(ID(1)).claudeStarted, true);
      assert.deepStrictEqual(loaded.get(ID(2)).planDirs, ['/p']);

      // Reverting this change has to be a git operation, not data recovery.
      assert.strictEqual(await fs.readFile(legacyPath, 'utf8'), before, 'sessions.json is byte-identical');
    });

    it('does not re-import once per-session files exist', async function () {
      await store.saveSessions(new Map([[ID(1), sessionOf({ name: 'current' })]]));
      await fs.writeFile(path.join(dir, 'sessions.json'), JSON.stringify({
        sessions: [{ id: ID(1), name: 'stale-from-json', workingDir: '/old' }],
      }));
      const fresh = new SessionStore();
      assert.strictEqual((await fresh.loadSessions()).get(ID(1)).name, 'current');
    });
  });

  describe('two writers, one data dir', function () {
    // The scenario this store was rewritten for, run for real: two processes,
    // each aware only of its own session, writing at the same time.
    it('keeps both instances\' sessions', async function () {
      this.timeout(30000);
      const script = path.join(dir, 'writer.js');
      await fs.writeFile(script, `
        const S = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'utils', 'session-store'))});
        const s = new S();
        const id = process.argv[2];
        (async () => {
          for (let i = 0; i < 30; i++) {
            await s.saveSessions(new Map([[id, {
              name: 'owner-' + id.slice(0, 8), workingDir: '/w', planDirs: [],
              created: new Date(), lastActivity: new Date(), lastAccessed: Date.now(),
              outputBuffer: ['round-' + i],
            }]]));
            await new Promise(r => setTimeout(r, 5));
          }
        })();
      `);

      const run = (id) => new Promise((resolve) => {
        execFile(process.execPath, [script, id], { env: { ...process.env, CCW_DATA_DIR: dir } },
          () => resolve());
      });
      await Promise.all([run(ID(1)), run(ID(2))]);

      const loaded = await store.loadSessions();
      assert.strictEqual(loaded.size, 2,
        `both writers' sessions must survive; got ${[...loaded.keys()]}`);
    });
  });
});

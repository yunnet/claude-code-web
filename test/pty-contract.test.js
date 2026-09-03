const assert = require('assert');
const os = require('os');
const pty = require('node-pty');

// node-pty is the whole point of this project: browser bytes in, terminal bytes
// out, untouched. These lock that contract against the library itself, because
// a version bump can rewrite the plumbing under a stable-looking API — 1.1.0
// replaced the read side (a net.Socket built on the deprecated
// process.binding('pipe_wrap')) with a tty.ReadStream, and the write side with
// its own queue. The public interface did not move an inch. Only behaviour
// tests would have caught a regression in that.
//
// claude-bridge.js uses exactly: spawn, onData, onExit, on('error'), write,
// resize, pause, resume, kill. Every one is exercised here.
describe('node-pty contract', function () {
  this.timeout(30000);

  const SHELL = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const ARGS = process.platform === 'win32' ? [] : ['--norc', '--noprofile'];

  function spawnShell(opts = {}) {
    return pty.spawn(SHELL, ARGS, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: os.tmpdir(),
      env: { ...process.env, PS1: '' },
      ...opts
    });
  }

  // Collect output until `marker` shows up, so tests wait on the child rather
  // than on a fixed sleep that would be flaky under load.
  function until(proc, marker, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}; got ${buf.length} bytes`)), timeoutMs);
      proc.onData(d => {
        buf += d;
        if (buf.includes(marker)) { clearTimeout(timer); resolve(buf); }
      });
    });
  }

  let proc;
  afterEach(function () {
    if (proc) { try { proc.kill(); } catch (_) {} proc = null; }
  });

  it('exposes every API claude-bridge.js depends on', function () {
    proc = spawnShell();
    assert.strictEqual(typeof proc.pid, 'number');
    assert.ok(proc.pid > 0, 'a real pid');
    for (const fn of ['onData', 'onExit', 'write', 'resize', 'kill', 'pause', 'resume']) {
      assert.strictEqual(typeof proc[fn], 'function', `${fn}() exists`);
    }
    // Not in the published typings, but claude-bridge.js wires an error handler
    // on it. Undocumented or not, it is part of the contract this app relies on.
    assert.strictEqual(typeof proc.on, 'function', "on() exists for the error path");
    assert.doesNotThrow(() => proc.on('error', () => {}));
  });

  it('passes bytes through without losing or reordering a line', async function () {
    // The core invariant. 5000 numbered lines: every one must arrive, in order.
    proc = spawnShell();
    const N = 5000;
    // The shell echoes the command line straight back, so a marker written
    // literally would be "seen" before a single line of output arrives. Split it
    // so the echo reads BURST""DONE and only the real output says BURSTDONE.
    proc.write(`for i in $(seq 1 ${N}); do echo "L$i-0123456789abcdef"; done; echo "BURST""DONE"\r`);
    const out = await until(proc, 'BURSTDONE');

    const seen = [];
    for (const m of out.matchAll(/L(\d+)-0123456789abcdef/g)) seen.push(Number(m[1]));
    // The shell echoes the command line back, so the first match can be part of
    // the echo; work from the tail, which is pure output.
    const tail = seen.slice(-N);
    assert.strictEqual(tail.length, N, `expected ${N} lines, got ${tail.length}`);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(tail[i], i + 1, `line ${i + 1} is missing or out of order (saw ${tail[i]})`);
    }
  });

  it('carries a resize through to the child process', async function () {
    proc = spawnShell();
    proc.resize(100, 30);
    proc.write('echo SIZE=$COLUMNS,$LINES\r');
    const out = await until(proc, 'SIZE=100,30');
    assert.ok(/SIZE=100,30/.test(out), 'the child sees the new size');
  });

  it('honours pause() and resume()', async function () {
    // 1.1.0 rewrote this path; claude-bridge.js drives it from the WebSocket's
    // flow-control messages. Paused must mean no data, and resume must recover.
    proc = spawnShell();
    let bytes = 0;
    let duringPause = 0;
    let paused = false;
    proc.onData(d => { bytes += d.length; if (paused) duringPause += d.length; });
    proc.write('for i in $(seq 1 200000); do echo "pad-$i-padpadpadpad"; done\r');

    await new Promise(r => setTimeout(r, 600));
    assert.ok(bytes > 0, 'data was flowing before the pause');

    paused = true;
    proc.pause();
    await new Promise(r => setTimeout(r, 600));
    // A chunk already in flight may land right after pause(); what must not
    // happen is the stream continuing to pour.
    assert.ok(duringPause < 100000, `paused stream still delivered ${duringPause} bytes`);

    paused = false;
    const atResume = bytes;
    proc.resume();
    await new Promise(r => setTimeout(r, 600));
    assert.ok(bytes > atResume, 'resume() started the data again');
  });

  it('reports the exit through onExit after kill()', async function () {
    proc = spawnShell();
    const exit = new Promise(resolve => proc.onExit(resolve));
    await new Promise(r => setTimeout(r, 300));
    proc.kill();
    const e = await Promise.race([exit, new Promise((_, rej) => setTimeout(() => rej(new Error('onExit never fired')), 8000))]);
    assert.strictEqual(typeof e.exitCode, 'number');
    proc = null;
  });

  it('leaves no child behind once killed', async function () {
    const p = spawnShell();
    const pid = p.pid;
    const exit = new Promise(resolve => p.onExit(resolve));
    await new Promise(r => setTimeout(r, 300));
    p.kill();
    await exit;
    await new Promise(r => setTimeout(r, 500));
    let alive = true;
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    assert.strictEqual(alive, false, `pty process ${pid} survived kill()`);
  });

  it('is built against N-API, not V8 — the reason for the 1.1.0 bump', function () {
    // NAN binds the V8 C++ ABI, so every Node major needed a recompile, and the
    // read path went through process.binding('pipe_wrap'), deprecated for years.
    // If a future install silently drops back to a NAN build, this fails here
    // rather than as a mystery crash on the next Node upgrade.
    const meta = require('node-pty/package.json');
    assert.ok(!meta.dependencies || !meta.dependencies.nan, 'node-pty must not depend on nan');
    assert.ok(meta.dependencies && meta.dependencies['node-addon-api'], 'node-pty builds on node-addon-api (N-API)');
  });
});

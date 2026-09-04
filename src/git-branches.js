// Reads the current branch of every git repository sitting one level under a
// directory — the shape of a "big directory" holding many sub-projects.
//
// The design turns on one measurement. A branch name lives in `.git/HEAD`, a
// one-line file, so a whole tree costs a readdir plus one small read each:
// 17ms for 11 repos. Anything about the *working tree* — dirty files, ahead /
// behind — needs a real `git` process per repo, and that same tree measured
// 1814ms. A hundred times more.
//
// So the two are split. The branch scan is cheap, synchronous, and always runs.
// The status scan is asynchronous, concurrency-bounded, and only runs when the
// caller explicitly asks for it. Nothing here polls: this server has already
// been brought to its knees once by a background scan on a timer.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Bounds the per-entry cost so a directory with thousands of children can't
// stall the shared single-threaded server.
const MAX_REPOS = 50;
// 2000 matches listDirectory's MAX_ITEMS, which already accepts one stat per
// entry at this size — measured at 40ms for 2001 entries here. The old 500 was
// low enough that an ordinary directory could push a real repository past it
// and lose it without saying so.
const MAX_ENTRIES = 2000;
// A HEAD file is one short line. Reading a fixed prefix means a bogus (or
// hostile) multi-gigabyte file at `.git/HEAD` costs the same as a real one.
const HEAD_BYTES = 512;
const STATUS_CONCURRENCY = 4;
const STATUS_TIMEOUT_MS = 10000;
const STATUS_MAX_BUFFER = 8 * 1024 * 1024;
// Pull gets far longer than a status check. Measured across 11 real repos, a
// fetch settles in ~1.6s — except one that had not finished after 120s with an
// identical remote, helper and credential file, and a 3.5 MB .git. Slow is not
// the same as broken, and a 15s ceiling would report it as broken.
const PULL_TIMEOUT_MS = 60000;

// Read at most `max` bytes from a file, without caring how big it really is.
function readPrefix(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Resolve a repo's git directory. Normally `.git` is a directory, but for a
// worktree or a submodule it is a FILE holding `gitdir: <path>` — miss that and
// every worktree silently reads as "not a repository".
function resolveGitDir(repoDir) {
  const dotGit = path.join(repoDir, '.git');
  let st;
  try {
    st = fs.statSync(dotGit);
  } catch (_) {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;

  const text = readPrefix(dotGit, 4096);
  const m = text && text.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  // The recorded path may be relative to the repo directory, and may also be
  // absolute and point anywhere — that is git's own format, and following it is
  // the only way a worktree or submodule resolves. A crafted `.git` file could
  // therefore aim this at an arbitrary directory, and the caller would learn
  // whether <that>/HEAD parses as a ref or a sha. That matches the scope the
  // rest of this server already grants (isPathWithinBase allows any resolvable
  // path — a local, single-user, auth-protected tool), and it requires the
  // hostile file to already sit inside a directory the user is browsing.
  const target = path.resolve(repoDir, m[1]);
  try {
    return fs.statSync(target).isDirectory() ? target : null;
  } catch (_) {
    return null;
  }
}

// The current branch of one repository, or null if it isn't one.
// A detached HEAD holds a raw sha instead of a symbolic ref; report it as such
// rather than pretending there is no branch.
function readHead(repoDir) {
  const gitDir = resolveGitDir(repoDir);
  if (!gitDir) return null;

  const text = readPrefix(path.join(gitDir, 'HEAD'), HEAD_BYTES);
  if (!text) return null;

  const ref = text.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m);
  if (ref) return { branch: ref[1], detached: false };

  const sha = text.trim().match(/^([0-9a-f]{7,64})$/i);
  if (sha) return { branch: sha[1].slice(0, 7), detached: true };

  return null;
}

// Every git repository directly under `dir`, plus `dir` itself when it is one
// (a single-repo project, where there are no sub-projects to list).
function scanBranches(dir) {
  const repos = [];

  const self = readHead(dir);
  if (self) repos.push({ name: '.', path: dir, ...self });

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return { path: dir, repos, truncated: 0, unexamined: 0, error: error.code || 'EACCES' };
  }

  let scanned = 0;
  let truncated = 0;
  let unexamined = 0;
  for (const entry of entries) {
    // `.git` itself, plus editor/tool dot-directories, are never sub-projects.
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    // MAX_ENTRIES bounds the stat calls, and it used to silently eat real
    // repositories: 600 plain directories ahead of one repo meant the repo was
    // never examined and the caller was told "0 repos, 101 truncated" — a
    // number that counted plain directories, which were never candidates. A
    // panel whose whole job is "list every sub-project" must not lose one
    // quietly, so the two counts are now kept apart: `truncated` is repos that
    // were found and dropped, `unexamined` is directories never looked at.
    if (++scanned > MAX_ENTRIES) { unexamined++; continue; }

    const child = path.join(dir, entry.name);
    const head = readHead(child);
    if (!head) continue;
    if (repos.length >= MAX_REPOS) { truncated++; continue; }
    repos.push({ name: entry.name, path: child, ...head });
  }

  repos.sort((a, b) => (a.name === '.' ? -1 : b.name === '.' ? 1 : a.name.localeCompare(b.name)));
  return { path: dir, repos, truncated, unexamined };
}

// `git status --porcelain -b` answers both questions in ONE process: the `## `
// header carries ahead/behind, and every remaining line is a changed path. Two
// separate git calls would double the expensive part for no extra information.
function readStatus(repoPath) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoPath, 'status', '--porcelain', '-b'],
      { timeout: STATUS_TIMEOUT_MS, maxBuffer: STATUS_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const lines = String(stdout).split('\n').filter(Boolean);
        const header = lines[0] && lines[0].startsWith('## ') ? lines.shift() : '';
        const ahead = header.match(/ahead (\d+)/);
        const behind = header.match(/behind (\d+)/);
        resolve({
          dirty: lines.length,
          ahead: ahead ? Number(ahead[1]) : 0,
          behind: behind ? Number(behind[1]) : 0
        });
      }
    );
  });
}

// Every descendant of a pid, deepest last, read from /proc.
//
// Linux-only by design. This project already leans on /proc elsewhere (the
// instance registry probes liveness through it) and it is a self-hosted tool,
// not a portable product. Where /proc is absent this returns just the pid, and
// the caller degrades to killing the direct child — no worse than before.
function processTree(pid) {
  const found = [pid];
  const queue = [pid];
  while (queue.length) {
    const current = queue.shift();
    let kids = [];
    try {
      // One entry per thread; a process's children can be listed under any of
      // them, so read them all.
      const tasks = fs.readdirSync(`/proc/${current}/task`);
      for (const task of tasks) {
        const raw = fs.readFileSync(`/proc/${current}/task/${task}/children`, 'utf8');
        kids = kids.concat(raw.split(/\s+/).filter(Boolean).map(Number));
      }
    } catch (_) {
      // Process exited between listing and reading, or no /proc at all.
    }
    for (const kid of kids) {
      if (Number.isInteger(kid) && kid > 0 && !found.includes(kid)) {
        found.push(kid);
        queue.push(kid);
      }
    }
  }
  return found;
}

// Kill a process and everything it spawned.
//
// Children first: killing the parent first can let a child be reparented to
// init before we get to it, and then it is no longer in the tree we collected.
let logKilledTree = () => {};
function setKilledTreeLogger(fn) { logKilledTree = fn; }

function killTree(pid) {
  const tree = processTree(pid);
  for (const target of tree.slice().reverse()) {
    try { process.kill(target, 'SIGKILL'); } catch (_) { /* already gone */ }
  }
  return tree;
}

// A remote URL can carry credentials — `http://user:pass@host/...` was sitting
// in two of these repos' .git/config. git echoes the URL back in its errors, so
// scrub before anything is handed to a browser.
function redactCredentials(text) {
  return String(text == null ? '' : text).replace(/\/\/[^\s/@]*:[^\s/@]*@/g, '//***:***@');
}

/**
 * Fast-forward one repository from its upstream.
 *
 * --ff-only on purpose. A plain `git pull` builds a merge commit when the local
 * branch has its own work, and can fail halfway through with a dirty tree. This
 * either moves cleanly forward or does nothing and says why — which is the right
 * default for a button whose whole job is "sync me up". Real merges belong in a
 * terminal, where there is someone to answer the questions.
 *
 * @returns {Promise<{ok: boolean, reason: string, updated?: boolean, from?: string, to?: string, message?: string}>}
 */
async function pullRepo(repoPath) {
  const head = readHead(repoPath);
  if (!head) return { ok: false, reason: 'not-a-repo' };

  // Look before touching. A pull over uncommitted work is the one outcome that
  // costs the user something they cannot get back, so it is checked first and
  // through the existing status reader rather than a second `git status` here.
  const status = await readStatus(repoPath);
  if (status === null) return { ok: false, reason: 'failed', message: 'could not read the working tree' };
  if (status.dirty > 0) {
    return { ok: false, reason: 'dirty', message: `${status.dirty} uncommitted change(s)` };
  }

  const before = readHead(repoPath);
  return new Promise((resolve) => {
    // Time it out by hand rather than with execFile's own `timeout`, and kill
    // the process TREE rather than the process.
    //
    // `git pull` is a wrapper: it forks `git fetch`, which forks
    // `git remote-http`. execFile's timeout signals only the wrapper, so both
    // children survive — measured against an unreachable remote.
    //
    // Process groups are not the way out here, and the experiment that proved
    // it is worth recording. `detached: true` did NOT make the child a group
    // leader: its pid was 2524895 while its pgid was 2524887, so
    // `process.kill(-child.pid)` raised ESRCH — killing a group that does not
    // exist. Reaching for the *real* pgid instead killed the test runner
    // itself, because without detach the child sits in its parent's group.
    // In the server that would mean a pull timeout taking cc-web down with it.
    //
    // So: walk the tree and kill exactly its members. No assumptions about
    // groups, and no way to reach anything outside this one process.
    let child;
    let timedOut = false;
    let timer = null;
    child = execFile(
      'git',
      ['-C', repoPath, 'pull', '--ff-only'],
      {
        maxBuffer: STATUS_MAX_BUFFER,
        windowsHide: true,
        // No terminal here, so a credential prompt would hang rather than ask.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        const out = redactCredentials(`${stdout || ''}${stderr || ''}`).trim();
        // Already settled by the timer above; a late callback has nothing to say.
        if (timedOut) return;
        if (error) {
          if (error.killed || error.signal) {
            return resolve({ ok: false, reason: 'timeout', message: `no response after ${PULL_TIMEOUT_MS / 1000}s` });
          }
          if (/no tracking information|no upstream/i.test(out)) {
            return resolve({ ok: false, reason: 'no-upstream', message: 'this branch tracks nothing' });
          }
          if (/not possible to fast-forward|diverge/i.test(out)) {
            return resolve({ ok: false, reason: 'not-fast-forward', message: 'local commits would need a merge' });
          }
          return resolve({ ok: false, reason: 'failed', message: out.split('\n')[0] || error.message });
        }
        const after = readHead(repoPath);
        const updated = !!(before && after && before.branch !== after.branch) || !/Already up to date/i.test(out);
        resolve({
          ok: true,
          reason: updated ? 'updated' : 'up-to-date',
          updated,
          from: before ? before.branch : null,
          to: after ? after.branch : null,
          message: out.split('\n')[0] || '',
        });
      },
    );
    timer = setTimeout(() => {
      timedOut = true;
      const killed = killTree(child.pid);
      if (killed.length > 1) {
        logKilledTree(killed);
      }
      // Resolve here rather than waiting for the exec callback. Killing the
      // group can leave that callback un-fired — the caller would then wait
      // forever on a promise that never settles, which is a worse failure than
      // the timeout it was meant to report.
      resolve({ ok: false, reason: 'timeout', message: `no response after ${PULL_TIMEOUT_MS / 1000}s` });
    }, PULL_TIMEOUT_MS);
  });
}

// Attach working-tree status to an already-scanned repo list. Bounded
// concurrency: 11 simultaneous `git status` runs on a cold cache is a real
// I/O spike, and this server shares its single thread with live terminals.
async function attachStatus(repos) {
  const queue = repos.slice();
  const workers = Array.from({ length: Math.min(STATUS_CONCURRENCY, queue.length) }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      const status = await readStatus(repo.path);
      if (status) Object.assign(repo, status);
    }
  });
  await Promise.all(workers);
  return repos;
}

module.exports = { scanBranches, attachStatus, readHead, readStatus, pullRepo, redactCredentials, processTree, killTree, setKilledTreeLogger, MAX_REPOS, MAX_ENTRIES, PULL_TIMEOUT_MS };

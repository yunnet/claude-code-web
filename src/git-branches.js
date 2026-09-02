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
const MAX_ENTRIES = 500;
// A HEAD file is one short line. Reading a fixed prefix means a bogus (or
// hostile) multi-gigabyte file at `.git/HEAD` costs the same as a real one.
const HEAD_BYTES = 512;
const STATUS_CONCURRENCY = 4;
const STATUS_TIMEOUT_MS = 10000;
const STATUS_MAX_BUFFER = 8 * 1024 * 1024;

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
  // The recorded path may be relative to the repo directory.
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
    return { path: dir, repos, truncated: 0, error: error.code || 'EACCES' };
  }

  let scanned = 0;
  let truncated = 0;
  for (const entry of entries) {
    // `.git` itself, plus editor/tool dot-directories, are never sub-projects.
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (++scanned > MAX_ENTRIES) { truncated++; continue; }

    const child = path.join(dir, entry.name);
    const head = readHead(child);
    if (!head) continue;
    if (repos.length >= MAX_REPOS) { truncated++; continue; }
    repos.push({ name: entry.name, path: child, ...head });
  }

  repos.sort((a, b) => (a.name === '.' ? -1 : b.name === '.' ? 1 : a.name.localeCompare(b.name)));
  return { path: dir, repos, truncated };
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

module.exports = { scanBranches, attachStatus, readHead, readStatus, MAX_REPOS, MAX_ENTRIES };

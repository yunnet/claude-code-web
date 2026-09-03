// A registry of running instances, one small file per listening port.
//
// The problem it solves is mundane and kept costing real time: with a dev and a
// stable instance sharing a machine, working out which port runs which source
// tree, against which data dir, meant reading /proc/<pid>/cwd, /proc/<pid>/environ
// and /proc/<pid>/maps. The server knows all of it at startup; it just never
// wrote it down.
//
// The second job is holding the auth token. Passing it as `--auth <token>` puts
// it in /proc/<pid>/cmdline, which is mode 444 — world-readable, and this box has
// more than one real user. A 0600 file is not a hardened secret store, but it
// does close the cross-user read that argv leaves wide open.
//
// The layout borrows from how Claude Code's CLI finds editor extensions: the
// FILENAME carries the port, so listing the directory is already the discovery
// step — no file needs to be opened to learn what is running where.
//
//   <dataDir>/instances/<port>.lock
//
// Everything here is best-effort. A registry that can refuse to start the server
// would be worse than no registry, so every write path swallows its errors and
// every read path returns null rather than throwing.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Same data dir as SessionStore and plan-dirs: CCW_DATA_DIR when set, else
// ~/.claude-code-web. Two instances isolate by pointing this elsewhere.
function dataDir() {
  return process.env.CCW_DATA_DIR
    ? path.resolve(process.env.CCW_DATA_DIR)
    : path.join(os.homedir(), '.claude-code-web');
}

function instancesDir() {
  return path.join(dataDir(), 'instances');
}

function lockPath(port) {
  return path.join(instancesDir(), `${port}.lock`);
}

// Ports are the filenames, so anything that isn't a plain positive integer is
// not one of ours and must never be turned into a path.
function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/**
 * Write (or replace) this instance's lock file.
 *
 * Written 0600 from the moment it exists: creating it first and chmod'ing after
 * would leave a window where the token is world-readable, which is the very
 * thing this file exists to avoid.
 *
 * Written to a temp name and renamed, so a reader never sees half a JSON object.
 * The temp name carries the pid so two instances racing on the same port (which
 * shouldn't happen, but does when a restart overlaps) can't clobber each other's
 * partial write.
 *
 * @returns {string|null} the path written, or null if it could not be written
 */
function writeLock(info) {
  const port = info && info.port;
  if (!isValidPort(port)) return null;

  const record = {
    port,
    pid: process.pid,
    sourceDir: info.sourceDir || process.cwd(),
    dataDir: dataDir(),
    version: info.version || null,
    buildId: info.buildId || null,
    https: !!info.https,
    startedAt: new Date().toISOString(),
  };
  // Absent in --disable-auth mode. Omitted rather than set to null so the field's
  // presence means "this instance wants a token".
  if (info.authToken) record.authToken = info.authToken;

  const target = lockPath(port);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(instancesDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, target);
    return target;
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
    return null;
  }
}

/**
 * Read one instance's lock. Returns null for missing, unreadable, malformed, or
 * mislabelled files — a single bad file must not break discovery for the rest.
 */
function readLock(port) {
  if (!isValidPort(port)) return null;
  try {
    const raw = fs.readFileSync(lockPath(port), 'utf8');
    const record = JSON.parse(raw);
    // The filename is the authority on which port this is. A record whose body
    // disagrees is corrupt, not merely stale.
    if (record && record.port === port) return record;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Every lock in the registry, newest first. Unparseable entries are skipped
 * silently; they're pruned separately rather than reported on every listing.
 */
function listLocks() {
  let entries;
  try {
    entries = fs.readdirSync(instancesDir());
  } catch (_) {
    return [];
  }
  const locks = [];
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    const port = Number(name.slice(0, -5));
    const record = readLock(port);
    if (record) locks.push(record);
  }
  return locks.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function removeLock(port) {
  if (!isValidPort(port)) return false;
  try {
    fs.unlinkSync(lockPath(port));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Is the process behind this record still the instance that wrote it?
 *
 * signal 0 alone is not enough: pids are recycled, so a dead instance's pid may
 * well belong to something unrelated by now, and "the pid exists" would keep a
 * stale record alive forever. The port is the tiebreaker — a live instance is
 * still listening on the port its filename claims, and a recycled pid almost
 * certainly is not. EPERM counts as alive: the process exists, it just isn't ours.
 */
function isLockLive(record, { portInUse } = {}) {
  if (!record || !Number.isInteger(record.pid)) return false;
  let pidAlive;
  try {
    process.kill(record.pid, 0);
    pidAlive = true;
  } catch (error) {
    pidAlive = error && error.code === 'EPERM';
  }
  if (!pidAlive) return false;
  // Caller can supply the authoritative answer (it may already hold the socket).
  if (typeof portInUse === 'boolean') return portInUse;
  return true;
}

/**
 * Drop records whose process is gone. Called at startup so a kill -9'd instance
 * doesn't leave a lock claiming a port nothing is listening on.
 *
 * @returns {number[]} the ports pruned
 */
function pruneStaleLocks() {
  const pruned = [];
  for (const record of listLocks()) {
    if (record.pid === process.pid) continue;
    if (!isLockLive(record)) {
      if (removeLock(record.port)) pruned.push(record.port);
    }
  }
  return pruned;
}

module.exports = {
  dataDir,
  instancesDir,
  lockPath,
  writeLock,
  readLock,
  listLocks,
  removeLock,
  isLockLive,
  pruneStaleLocks,
};

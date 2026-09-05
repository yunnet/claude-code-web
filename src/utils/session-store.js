const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

// Session persistence: one file per session.
//
//   <dataDir>/sessions/<session-id>.json
//
// This used to be a single sessions.json rewritten in full every thirty
// seconds. That is fine with one server and quietly destructive with two: on
// 2026-09-03 a restart lost its CCW_DATA_DIR, the dev instance adopted
// stable's directory, and both rewrote the whole file on their own timers.
// Last writer won. Nothing errored.
//
// The first attempt at a fix was SQLite, and racing two writers against it
// disproved the premise: the conflict was never about write atomicity.
// `saveSessions(map)` means "this is the complete set", so it deletes what it
// does not recognise — and an instance only recognises its own sessions.
// A transaction just makes the deletion atomic. Both writers still lose.
//
// One file per session removes the shared mutable document, so there is
// nothing to race over. It is how Claude Code itself handles many CLI
// instances sharing ~/.claude (`sessions/<pid>.json`, one writer per file,
// aggregate on read), and the same shape as this project's own
// instances/<port>.lock.
//
// The consequence — and the thing that is easy to get wrong — is that
// deletion must now be explicit. See deleteSession.

// Sessions untouched for longer than this are dropped on load. Judged per
// session now: with one file there was a single savedAt, so one active tab
// kept every stale sibling alive.
const MAX_AGE_DAYS = 7;
// How many PTY chunks of scrollback survive a restart. 100 was the cap the
// single-file store applied, and it was far too small to notice: a chunk is
// whatever one read off the PTY returned, and measured against real sessions the
// median is 77-174 bytes — so 100 chunks came to 8-24 KB, much of it Claude's
// redraw escapes rather than text. 500 is the new default; the running value is
// per-instance (`maxOutputChunks`) because it is user-configurable at runtime.
const DEFAULT_OUTPUT_CHUNKS = 500;

// Ids are interpolated into a path, so re-check the shape rather than trust
// the caller — the same guard, and the same reasoning, as
// claude-bridge.js:clearEmptyTranscript.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionId(id) {
  return UUID.test(String(id || ''));
}

class SessionStore {
    constructor() {
        // CCW_DATA_DIR lets a second instance (e.g. the dev sandbox on another
        // port) keep its own session list. The claude CLI's own ~/.claude config
        // stays shared.
        this.storageDir = process.env.CCW_DATA_DIR
            ? path.resolve(process.env.CCW_DATA_DIR)
            : path.join(os.homedir(), '.claude-code-web');
        // Writable at runtime: the server sets it from the persisted setting on
        // startup and again whenever it changes, so a save takes effect on the
        // next autosave rather than on the next restart.
        this.maxOutputChunks = DEFAULT_OUTPUT_CHUNKS;
        this.initializeStorage();
    }

    // Derived on each access rather than frozen in the constructor, so pointing
    // storageDir somewhere else actually moves the store — a test that redirects
    // it after construction otherwise keeps writing to the real data dir, which
    // is how a test run once migrated the live instance's sessions.
    get sessionsDir() {
        return path.join(this.storageDir, 'sessions');
    }

    // Read once on first load to adopt an existing install, then left alone —
    // never deleted, never renamed, never written. Reverting this change is
    // then `git revert` and nothing else.
    get legacyFile() {
        return path.join(this.storageDir, 'sessions.json');
    }

    async initializeStorage() {
        try {
            await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
        } catch (error) {
            console.error('Failed to create storage directory:', error);
        }
    }

    sessionFile(id) {
        return path.join(this.sessionsDir, `${id}.json`);
    }

    // What actually goes on disk. Runtime-only fields are dropped rather than
    // stored false: a restored session's PTY died with the process that owned
    // it, so `active` can only ever be false and `connections` empty.
    toRecord(id, session) {
        return {
            id,
            name: session.name || 'Unnamed Session',
            created: session.created || new Date(),
            lastActivity: session.lastActivity || new Date(),
            workingDir: session.workingDir || process.cwd(),
            planDirs: Array.isArray(session.planDirs) ? session.planDirs : [],
            // Whether Claude has been started under this session id (bound via
            // --session-id). Lets a restart resume the conversation instead of
            // starting fresh.
            claudeStarted: !!session.claudeStarted,
            outputBuffer: Array.isArray(session.outputBuffer)
                ? session.outputBuffer.slice(-this.maxOutputChunks)
                : [],
            lastAccessed: session.lastAccessed || Date.now(),
            savedAt: new Date().toISOString(),
        };
    }

    async writeOne(id, session) {
        if (!isValidSessionId(id)) return false;
        const target = this.sessionFile(id);
        // Temp name carries the pid so two writers cannot clobber each other's
        // partial write, then rename makes the swap atomic for readers.
        const tmp = `${target}.${process.pid}.tmp`;
        try {
            await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
            await fs.writeFile(tmp, JSON.stringify(this.toRecord(id, session), null, 2));
            await fs.rename(tmp, target);
            return true;
        } catch (error) {
            try { await fs.unlink(tmp); } catch (_) { /* nothing to clean up */ }
            console.error(`Failed to save session ${id}:`, error.message);
            return false;
        }
    }

    /**
     * Persist the given sessions.
     *
     * Writes only what it was handed and **deletes nothing**. That is the whole
     * point: an instance holding half the sessions in a shared data dir must
     * not be able to remove the other half. Closing a session is a separate,
     * explicit act — see deleteSession.
     */
    async saveSessions(sessions) {
        try {
            await this.migrateLegacyIfEmpty();
            const results = await Promise.all(
                [...sessions.entries()].map(([id, session]) => this.writeOne(id, session)),
            );
            return results.every(Boolean);
        } catch (error) {
            console.error('Failed to save sessions:', error.message);
            return false;
        }
    }

    /**
     * Remove one session's file. Called when a session is actually closed.
     *
     * Before this, deletion was a side effect of rewriting the whole file with
     * the session missing. That implicit behaviour is exactly what made two
     * instances delete each other's work, so it is gone, and the caller has to
     * say what it means.
     */
    async deleteSession(id) {
        if (!isValidSessionId(id)) return false;
        try {
            await fs.unlink(this.sessionFile(id));
            return true;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`Failed to delete session ${id}:`, error.message);
            }
            return false;
        }
    }

    // One unreadable file costs one session now, not the whole list. The bad
    // file is moved aside so the next load does not trip over it again.
    async readOne(id) {
        const file = this.sessionFile(id);
        try {
            const raw = await fs.readFile(file, 'utf8');
            if (!raw || !raw.trim()) return null;
            const record = JSON.parse(raw);
            if (!record || record.id !== id) return null;
            return record;
        } catch (error) {
            if (error instanceof SyntaxError) {
                console.error(`Session file ${id}.json is corrupted, skipping`);
                try { await fs.rename(file, `${file}.corrupted.${Date.now()}`); } catch (_) {}
            } else if (error.code !== 'ENOENT') {
                console.error(`Failed to read session ${id}:`, error.message);
            }
            return null;
        }
    }

    async loadSessions() {
        try {
            await this.migrateLegacyIfEmpty();

            let entries;
            try {
                entries = await fs.readdir(this.sessionsDir);
            } catch (error) {
                if (error.code !== 'ENOENT') console.error('Failed to list sessions:', error.message);
                return new Map();
            }

            const sessions = new Map();
            for (const entry of entries) {
                if (!entry.endsWith('.json')) continue;
                const id = entry.slice(0, -5);
                // Only a uuid is one of ours. Without this, a stray file with a
                // number-ish name would be parsed, and worse, swept as stale.
                if (!isValidSessionId(id)) continue;

                const record = await this.readOne(id);
                if (!record) continue;

                // Age is judged per session, so one live tab no longer keeps
                // every abandoned sibling alive.
                const stamp = record.lastActivity || record.savedAt;
                if (stamp) {
                    const days = (Date.now() - new Date(stamp).getTime()) / 86400000;
                    if (days > MAX_AGE_DAYS) {
                        await this.deleteSession(id);
                        continue;
                    }
                }

                sessions.set(id, {
                    ...record,
                    created: record.created ? new Date(record.created) : new Date(),
                    lastActivity: record.lastActivity ? new Date(record.lastActivity) : new Date(),
                    active: false,
                    connections: new Set(),
                    outputBuffer: record.outputBuffer || [],
                    // Memory must hold at least what we intend to persist,
                    // or the cap below would silently defeat the setting.
                    maxBufferSize: Math.max(1000, this.maxOutputChunks),
                    usageData: record.usageData || null,
                });
            }

            console.log(`Restored ${sessions.size} sessions from disk`);
            return sessions;
        } catch (error) {
            console.error('Failed to load sessions:', error.message);
            return new Map();
        }
    }

    /**
     * Split an existing sessions.json into per-session files, once.
     *
     * The original is left exactly where it is. It is stale from this point on,
     * which is the intent: reverting is a git operation, not a data recovery.
     */
    async migrateLegacyIfEmpty() {
        if (this._migrationChecked) return;
        this._migrationChecked = true;
        try {
            await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
            const existing = (await fs.readdir(this.sessionsDir)).filter(f => f.endsWith('.json'));
            if (existing.length > 0) return;
            if (!fsSync.existsSync(this.legacyFile)) return;

            const parsed = JSON.parse(await fs.readFile(this.legacyFile, 'utf8'));
            if (!parsed || !Array.isArray(parsed.sessions)) return;

            let n = 0;
            for (const s of parsed.sessions) {
                if (!s || !isValidSessionId(s.id)) continue;
                if (await this.writeOne(s.id, s)) n++;
            }
            console.log(`Migrated ${n} sessions to per-session files (sessions.json left in place)`);
        } catch (error) {
            console.error('Could not migrate the legacy sessions file:', error.message);
        }
    }

    async clearOldSessions() {
        try {
            const entries = await fs.readdir(this.sessionsDir);
            await Promise.all(
                entries.filter(f => f.endsWith('.json')).map(f => fs.unlink(path.join(this.sessionsDir, f)).catch(() => {})),
            );
            console.log('Cleared old sessions');
            return true;
        } catch (error) {
            if (error.code !== 'ENOENT') console.error('Failed to clear sessions:', error);
            return false;
        }
    }

    async getSessionMetadata() {
        try {
            const entries = (await fs.readdir(this.sessionsDir)).filter(f => f.endsWith('.json'));
            let fileSize = 0;
            let savedAt = null;
            for (const entry of entries) {
                const full = path.join(this.sessionsDir, entry);
                try {
                    const st = await fs.stat(full);
                    fileSize += st.size;
                    const iso = st.mtime.toISOString();
                    if (!savedAt || iso > savedAt) savedAt = iso;
                } catch (_) { /* skip */ }
            }
            return {
                exists: entries.length > 0,
                savedAt,
                sessionCount: entries.length,
                fileSize,
                version: '2.0',
            };
        } catch (error) {
            return { exists: false, error: error.message };
        }
    }
}

module.exports = SessionStore;
module.exports.isValidSessionId = isValidSessionId;
module.exports.DEFAULT_OUTPUT_CHUNKS = DEFAULT_OUTPUT_CHUNKS;

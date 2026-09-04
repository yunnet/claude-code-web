const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gitBranches = require('../src/git-branches');

// A real git tree, not a mock: the module's whole job is reading git's on-disk
// layout, and the cases that actually break it (a worktree's `.git` FILE, a
// detached HEAD holding a bare sha) only exist once git has written them.
function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function makeRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' });
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-qm', 'initial');
  if (branch) git(dir, 'checkout', '-qb', branch);
}

describe('git-branches', function () {
  this.timeout(20000);

  let root;
  let big;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-branches-'));
    big = path.join(root, 'big');
    fs.mkdirSync(big);

    makeRepo(path.join(big, 'alpha'), 'task-100');
    makeRepo(path.join(big, 'beta'), 'task-100');
    makeRepo(path.join(big, 'gamma'));                  // stays on the default branch
    makeRepo(path.join(big, 'detached'));
    git(path.join(big, 'detached'), 'checkout', '-q', '--detach');

    fs.mkdirSync(path.join(big, 'plain-dir'));          // no .git at all
    fs.writeFileSync(path.join(big, 'loose.txt'), 'x');  // a file, not a directory
    makeRepo(path.join(big, '.hidden-repo'));            // dot-directory
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('scanBranches', function () {
    it('lists every sub-repository with its current branch', function () {
      const result = gitBranches.scanBranches(big);
      const byName = Object.fromEntries(result.repos.map(r => [r.name, r.branch]));
      assert.strictEqual(byName.alpha, 'task-100');
      assert.strictEqual(byName.beta, 'task-100');
      assert.ok(byName.gamma, 'gamma reports its default branch');
    });

    it('skips plain directories, files and dot-directories', function () {
      const names = gitBranches.scanBranches(big).repos.map(r => r.name);
      assert.ok(!names.includes('plain-dir'), 'a directory without .git is not a repo');
      assert.ok(!names.includes('loose.txt'), 'a file is never a repo');
      assert.ok(!names.includes('.hidden-repo'), 'dot-directories are tooling, not sub-projects');
    });

    it('reports a detached HEAD as detached, with the short sha', function () {
      const repo = gitBranches.scanBranches(big).repos.find(r => r.name === 'detached');
      assert.strictEqual(repo.detached, true);
      assert.match(repo.branch, /^[0-9a-f]{7}$/);
    });

    it('reads a worktree, whose .git is a FILE pointing elsewhere', function () {
      // The naive `-d .git` test silently drops every worktree; that is the
      // regression this guards.
      const wt = path.join(big, 'worktree');
      git(path.join(big, 'beta'), 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
      assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'fixture really is a .git file');
      const repo = gitBranches.scanBranches(big).repos.find(r => r.name === 'worktree');
      assert.ok(repo, 'the worktree is listed');
      assert.strictEqual(repo.branch, 'wt-branch');
      fs.rmSync(wt, { recursive: true, force: true });
      git(path.join(big, 'beta'), 'worktree', 'prune');
    });

    it('lists the directory ITSELF when it is a repo, as "."', function () {
      const single = path.join(root, 'single');
      makeRepo(single, 'solo');
      const result = gitBranches.scanBranches(single);
      assert.strictEqual(result.repos.length, 1);
      assert.strictEqual(result.repos[0].name, '.');
      assert.strictEqual(result.repos[0].branch, 'solo');
    });

    it('returns an empty list, not an error, for a directory with no repos', function () {
      const result = gitBranches.scanBranches(path.join(big, 'plain-dir'));
      assert.deepStrictEqual(result.repos, []);
      assert.ok(!result.error);
    });

    it('reports a missing directory instead of throwing', function () {
      const result = gitBranches.scanBranches(path.join(root, 'does-not-exist'));
      assert.strictEqual(result.error, 'ENOENT');
      assert.deepStrictEqual(result.repos, []);
    });

    it('caps the listing so a huge directory cannot stall the server', function () {
      assert.ok(gitBranches.MAX_REPOS <= 100, 'repo cap stays small');
      // Matches listDirectory's MAX_ITEMS, which already accepts one stat per
      // entry at this size (measured 40ms for 2001 entries).
      assert.strictEqual(gitBranches.MAX_ENTRIES, 2000);
    });

    it('never lets the entry cap hide a repository in silence', function () {
      // The cap used to eat real repositories AND misreport the loss: 600 plain
      // directories ahead of one repo gave "0 repos, truncated 101", where 101
      // counted plain directories that were never candidates. The two counts
      // are now distinct, so a partial scan is visible as a partial scan.
      const many = path.join(root, 'many');
      fs.mkdirSync(many);
      for (let i = 0; i < gitBranches.MAX_ENTRIES + 5; i++) fs.mkdirSync(path.join(many, `d${String(i).padStart(5, '0')}`));

      const result = gitBranches.scanBranches(many);
      assert.strictEqual(result.truncated, 0, 'no repository was found, so none was dropped');
      assert.ok(result.unexamined > 0, 'the directories past the cap are reported, not hidden');
      assert.strictEqual(result.unexamined, 5, 'and the count is of unexamined dirs, not of repos');
    });

    it('counts truncated as repositories dropped, never as plain directories', function () {
      const lots = path.join(root, 'lots');
      fs.mkdirSync(lots);
      for (let i = 0; i < gitBranches.MAX_REPOS + 3; i++) makeRepo(path.join(lots, `r${String(i).padStart(3, '0')}`));
      const result = gitBranches.scanBranches(lots);
      assert.strictEqual(result.repos.length, gitBranches.MAX_REPOS);
      assert.strictEqual(result.truncated, 3, 'exactly the repos that did not fit');
      assert.strictEqual(result.unexamined, 0, 'nothing went unexamined');
    });

    it('never hands back a HEAD that is neither a ref nor a sha', function () {
      const junk = path.join(root, 'junk');
      fs.mkdirSync(path.join(junk, '.git'), { recursive: true });
      fs.writeFileSync(path.join(junk, '.git', 'HEAD'), 'not a ref at all\n');
      assert.strictEqual(gitBranches.readHead(junk), null);
    });

    it('reads only a prefix of HEAD, so a giant file costs nothing', function () {
      const fat = path.join(root, 'fat');
      fs.mkdirSync(path.join(fat, '.git'), { recursive: true });
      // A valid ref line followed by 5MB of padding: the parse must succeed
      // from the prefix and must not depend on reading the whole file.
      fs.writeFileSync(path.join(fat, '.git', 'HEAD'), 'ref: refs/heads/tiny\n' + 'x'.repeat(5 * 1024 * 1024));
      assert.deepStrictEqual(gitBranches.readHead(fat), { branch: 'tiny', detached: false });
    });
  });

  describe('attachStatus', function () {
    it('counts uncommitted changes without a second git invocation', async function () {
      const repos = gitBranches.scanBranches(big).repos;
      fs.writeFileSync(path.join(big, 'alpha', 'dirty.txt'), 'changed\n');
      await gitBranches.attachStatus(repos);
      const alpha = repos.find(r => r.name === 'alpha');
      const gamma = repos.find(r => r.name === 'gamma');
      assert.strictEqual(alpha.dirty, 1);
      assert.strictEqual(gamma.dirty, 0);
      // No upstream configured, so both counters read zero rather than undefined.
      assert.strictEqual(alpha.ahead, 0);
      assert.strictEqual(alpha.behind, 0);
    });

    it('leaves a repo untouched when git fails, rather than poisoning the row', async function () {
      const repos = [{ name: 'bogus', path: path.join(root, 'not-a-repo-at-all'), branch: 'x' }];
      await gitBranches.attachStatus(repos);
      assert.strictEqual(repos[0].dirty, undefined);
      assert.strictEqual(repos[0].branch, 'x');
    });
  });
});

describe('server route: listBranches', function () {
  this.timeout(20000);

  const { ClaudeCodeWebServer } = require('../src/server');

  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; }
    };
  }

  let server;
  let root;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-branchroute-'));
    makeRepo(path.join(root, 'one'), 'feature-x');
    fs.mkdirSync(path.join(root, 'outside-marker'));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    server.baseFolder = root;
  });

  after(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the sub-project branches for an allowed directory', async function () {
    const res = mockRes();
    await server.listBranches({ query: { path: root } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.repos.length, 1);
    assert.strictEqual(res.body.repos[0].name, 'one');
    assert.strictEqual(res.body.repos[0].branch, 'feature-x');
  });

  it('falls back to the base folder when no path is given', async function () {
    const res = mockRes();
    await server.listBranches({ query: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.path, root);
  });

  it('applies the SAME path policy as the existing file browser', async function () {
    // isPathWithinBase deliberately allows any resolvable absolute path: this is
    // an auth-protected local tool running as the user, and the folder browser
    // has to reach any project directory. The invariant worth pinning is that
    // this endpoint does not invent its own policy — tighten validatePath and
    // both endpoints must move together, with no gap opening between them.
    for (const candidate of ['/etc', path.join(root, '..', '..', 'etc'), root]) {
      const branchRes = mockRes();
      const listRes = mockRes();
      await server.listBranches({ query: { path: candidate } }, branchRes);
      server.listDirectory({ query: { path: candidate } }, listRes);
      assert.strictEqual(
        branchRes.statusCode === 403,
        listRes.statusCode === 403,
        `branches and fs/list disagree about ${candidate}`
      );
    }
  });

  it('reports a directory it cannot read instead of throwing', async function () {
    const res = mockRes();
    await server.listBranches({ query: { path: path.join(root, 'nope') } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.error, 'ENOENT');
    assert.deepStrictEqual(res.body.repos, []);
  });

  it('does not hand absolute repo paths back to the browser', async function () {
    const res = mockRes();
    await server.listBranches({ query: { path: root } }, res);
    // The client renders names only; leaking the server's layout buys nothing
    // and tells an attacker where things live.
    assert.ok(!('path' in res.body.repos[0]), 'per-repo absolute path is stripped');
  });

  it('omits working-tree status unless it is explicitly requested', async function () {
    let res = mockRes();
    await server.listBranches({ query: { path: root } }, res);
    assert.strictEqual(res.body.status, false);
    assert.strictEqual(res.body.repos[0].dirty, undefined, 'the expensive half did not run');

    res = mockRes();
    await server.listBranches({ query: { path: root, status: '1' } }, res);
    assert.strictEqual(res.body.status, true);
    assert.strictEqual(res.body.repos[0].dirty, 0);
  });
});

describe('branch panel styling', function () {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'style.css'), 'utf8');
  const JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'git-branches.js'), 'utf8');

  it('defines every group colour for BOTH themes', function () {
    // The first cut used GitHub's dark palette for both, and those greens and
    // blues measured 2.5:1 on the light theme's white — the panel's most
    // important text was its least readable. A group with no light-theme
    // override silently reintroduces that.
    const groups = Number((JS.match(/const GROUP_COUNT = (\d+)/) || [])[1]);
    assert.ok(groups > 0, 'GROUP_COUNT is declared in the panel script');
    for (let i = 0; i < groups; i++) {
      assert.ok(new RegExp(`\\.branch-g${i}\\b`).test(CSS), `.branch-g${i} has a dark-theme colour`);
      assert.ok(
        new RegExp(`\\[data-theme="light"\\][^{]*\\.branch-g${i}\\b`).test(CSS),
        `.branch-g${i} has a light-theme colour`
      );
    }
  });

  it('lets CSS own the colour, so it can follow the theme', function () {
    assert.ok(!/\.style\.color\s*=/.test(JS), 'no inline colour: an inline style cannot be themed');
  });

  it('stays reachable on a phone, and capped so it fits one', function () {
    // It used to be desktop-only, hidden by the same query the file explorer
    // used. "Did every repo move to the task branch?" gets asked more often
    // away from the desk, not less — so the wrapper is no longer hidden at any
    // width. What made that safe to do is the cap below: the panel is
    // right-anchored at 340px but never wider than 90vw, so it stays inside a
    // 390px viewport instead of running off the edge.
    assert.ok(!/\.branch-wrapper\s*\{[^}]*display:\s*none/.test(CSS),
      'the branch button is not hidden on narrow screens');
    assert.ok(/\.branch-panel\b[^}]*max-width:\s*90vw/.test(CSS),
      'the panel is capped to the viewport, which is what lets it show on a phone');
    assert.ok(!/#explorerBtn\s*\{\s*display:\s*none/.test(CSS),
      'the file explorer button it used to share that query with is shown too');

    // 340px right-anchored to a 44px button puts the left edge at -10px on a
    // 390px phone. Below 480px the wrapper drops its own positioning so the
    // panel anchors to the tab bar instead — which only works because the bar
    // is the positioning context, so assert that too rather than leave it to
    // luck.
    assert.ok(/@media \(max-width: 480px\)\s*\{\s*\.branch-wrapper\s*\{\s*position:\s*static/.test(CSS),
      'narrow screens re-anchor the panel to the tab bar');
    assert.ok(/\.session-tabs-bar\s*\{[^}]*position:\s*relative/.test(CSS),
      'the tab bar is the positioning context that re-anchoring falls back to');
  });
});

describe('git pull', function () {
  this.timeout(30000);

  const { execFileSync, execFile } = require('child_process');
  const gitb = require('../src/git-branches');

  function git(cwd, ...args) {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  }

  let root;
  let bare;
  let mine;
  let theirs;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-pull-'));
    bare = path.join(root, 'origin.git');
    mine = path.join(root, 'mine');
    theirs = path.join(root, 'theirs');

    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' });
    execFileSync('git', ['clone', '-q', bare, mine], { stdio: 'pipe' });
    git(mine, 'config', 'user.email', 'test@example.com');
    git(mine, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(mine, 'f.txt'), 'v1\n');
    git(mine, 'add', 'f.txt');
    git(mine, 'commit', '-qm', 'first');
    git(mine, 'push', '-q', '-u', 'origin', 'HEAD');

    execFileSync('git', ['clone', '-q', bare, theirs], { stdio: 'pipe' });
    git(theirs, 'config', 'user.email', 'other@example.com');
    git(theirs, 'config', 'user.name', 'Other');
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Someone else pushes, so `mine` is behind by one.
  function advanceUpstream(text) {
    fs.writeFileSync(path.join(theirs, 'f.txt'), text);
    git(theirs, 'commit', '-qam', 'upstream work');
    git(theirs, 'push', '-q');
  }

  it('fast-forwards a clean repo that is behind', async function () {
    advanceUpstream('v2\n');
    const before = execFileSync('git', ['-C', mine, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = await gitb.pullRepo(mine);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, 'updated');
    const after = execFileSync('git', ['-C', mine, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.notStrictEqual(after, before, 'HEAD moved');
    assert.strictEqual(fs.readFileSync(path.join(mine, 'f.txt'), 'utf8'), 'v2\n');
  });

  it('reports up-to-date without pretending it did something', async function () {
    const result = await gitb.pullRepo(mine);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, 'up-to-date');
  });

  it('refuses over uncommitted work AND leaves it untouched', async function () {
    // The one outcome that costs the user something they cannot recover: a
    // pull merging over changes they never committed.
    advanceUpstream('v2\n');
    fs.writeFileSync(path.join(mine, 'mywork.txt'), 'not committed yet\n');
    const statusBefore = execFileSync('git', ['-C', mine, 'status', '--porcelain'], { encoding: 'utf8' });
    const headBefore = execFileSync('git', ['-C', mine, 'rev-parse', 'HEAD'], { encoding: 'utf8' });

    const result = await gitb.pullRepo(mine);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'dirty');

    assert.strictEqual(execFileSync('git', ['-C', mine, 'status', '--porcelain'], { encoding: 'utf8' }), statusBefore);
    assert.strictEqual(execFileSync('git', ['-C', mine, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), headBefore);
    assert.strictEqual(fs.readFileSync(path.join(mine, 'mywork.txt'), 'utf8'), 'not committed yet\n');
  });

  it('refuses a diverged branch instead of building a merge commit', async function () {
    advanceUpstream('v2\n');
    fs.writeFileSync(path.join(mine, 'local.txt'), 'local\n');
    git(mine, 'add', 'local.txt');
    git(mine, 'commit', '-qm', 'local only');
    const headBefore = execFileSync('git', ['-C', mine, 'rev-parse', 'HEAD'], { encoding: 'utf8' });

    const result = await gitb.pullRepo(mine);
    assert.strictEqual(result.reason, 'not-fast-forward');
    assert.strictEqual(execFileSync('git', ['-C', mine, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), headBefore);
  });

  it('refuses a directory that is not a repository', async function () {
    assert.strictEqual((await gitb.pullRepo(root)).reason, 'not-a-repo');
  });

  it('scrubs credentials out of anything it hands back', async function () {
    // Two of the real repos had `http://user:pass@host/...` in .git/config, and
    // git echoes the remote URL back in its errors.
    const dirty = 'fatal: unable to access http://gongxy:Secret123@git.example.cn/x.git/';
    const clean = gitb.redactCredentials(dirty);
    assert.ok(!clean.includes('Secret123'), 'the password is gone');
    assert.ok(clean.includes('***:***@'), 'and it is visibly redacted');
  });

  describe('timeout kills the whole process tree', function () {
    // Groups are not an option here, and the experiment that ruled them out is
    // recorded in git-branches.js: detached did not make the child a group
    // leader, and killing the real pgid took down the test runner itself.
    it('collects a process and its descendants', function (done) {
      const child = execFile('bash', ['-c', 'sleep 30 & sleep 30 & wait'], () => {});
      setTimeout(() => {
        const tree = gitb.processTree(child.pid);
        assert.ok(tree.length >= 3, `expected the shell and both sleeps, got ${tree.length}`);
        assert.strictEqual(tree[0], child.pid);
        assert.ok(!tree.includes(process.pid), 'and it must never contain us');
        gitb.killTree(child.pid);
        done();
      }, 400);
    });

    it('leaves nothing behind, and leaves us alive', function (done) {
      const child = execFile('bash', ['-c', 'sleep 30 & sleep 30 & wait'], () => {});
      setTimeout(() => {
        const killed = gitb.killTree(child.pid);
        setTimeout(() => {
          for (const pid of killed) {
            let alive = true;
            try { process.kill(pid, 0); } catch (_) { alive = false; }
            assert.strictEqual(alive, false, `pid ${pid} survived`);
          }
          // The check that matters most: an earlier attempt at this killed the
          // caller. In the server that is cc-web taking itself down on a pull
          // timeout.
          let selfAlive = true;
          try { process.kill(process.pid, 0); } catch (_) { selfAlive = false; }
          assert.strictEqual(selfAlive, true, 'the caller must survive');
          done();
        }, 500);
      }, 400);
    });
  });
});

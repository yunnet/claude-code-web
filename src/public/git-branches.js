// Branch panel: the current git branch of every sub-project under the tab's
// working directory. Opens from the desktop toolbar button (#branchBtn).
//
// A "big directory" here holds many independent repos side by side (cgs-cloud,
// cgs-front, flow-backend, ...). Which branch each one sits on is the thing you
// need constantly while working a task and the thing that silently goes wrong —
// one repo left behind on dev while the rest moved to the task branch.
//
// Two-stage on purpose: branch names come from reading .git/HEAD and land in
// milliseconds, so the panel paints at once. Working-tree state needs a git
// process per repo (~18x the cost) and only runs when "Check changes" is
// clicked. Nothing polls.

(function () {
  // Repos sharing a branch get the same accent, so "who moved to the task
  // branch and who didn't" is one glance instead of string comparison. A branch
  // only one repo is on gets no colour — there is nothing to compare it to.
  //
  // JS picks the GROUP, CSS picks the COLOUR. An inline style here cannot follow
  // the theme, and the dark-theme greens and blues measure 2.5:1 on the light
  // theme's white — worse than the muted text they were meant to stand out
  // from. So this hands out a class and lets the stylesheet answer per theme.
  // Past six shared branches the palette would wrap and hand two different
  // branches the same colour — precisely the misreading the colouring exists to
  // prevent. Groups beyond the sixth stay muted instead.
  const GROUP_COUNT = 6;

  // Same shape as the file explorer's row-download icon: a small outline glyph
  // parsed once and cloned per row, rather than re-running the HTML parser
  // eleven times.
  const PULL_ICON = '<svg class="pull-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 21h16"/></svg>';
  const pullIconNode = (() => {
    const t = document.createElement('template');
    t.innerHTML = PULL_ICON;
    return t.content.firstElementChild;
  })();

  class BranchPanel {
    constructor() {
      this.bound = false;
      this.open = false;
      this.dir = null;
      // Every load takes a ticket. A status scan runs ~18x longer than a plain
      // one, so a "Check changes" on project A could still be in flight when
      // the panel reopens on project B — and it would then repaint A's branches
      // under B's heading. Only the newest ticket is allowed to render.
      this.loadToken = 0;
    }

    el(id) { return document.getElementById(id); }

    // The tab's own project directory — the same source the rest of the app
    // uses. Deliberately NOT the file explorer's remembered browsing location:
    // this panel always answers for the project, not for wherever you last
    // clicked in the tree.
    workingDir() {
      const app = window.app;
      if (!app) return null;
      return (app.currentClaudeSessionId ? app.currentWorkingDir : app.selectedWorkingDir) || null;
    }

    bind() {
      if (this.bound) return;
      this.bound = true;
      const btn = this.el('branchBtn');
      if (!btn) return;
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
      this.el('branchRefreshBtn').addEventListener('click', () => this.load());
      this.el('branchStatusBtn').addEventListener('click', () => this.load(true));
      // Clicking anywhere else, or Escape, dismisses it — a glance panel should
      // never need a deliberate close.
      document.addEventListener('click', (e) => {
        if (!this.open) return;
        const wrap = this.el('branchWrapper');
        if (wrap && !wrap.contains(e.target)) this.hide();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open) this.hide(); });
      // One delegated listener for every row, the way the file explorer does it:
      // eleven rows would otherwise mean eleven closures, re-created on every
      // render. The target travels in dataset, never innerHTML.
      this.el('branchList').addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.row-pull');
        if (!btn || btn.disabled) return;
        e.stopPropagation();
        this.pull(btn);
      });
    }

    toggle() { this.open ? this.hide() : this.show(); }

    hide() {
      this.open = false;
      const panel = this.el('branchPanel');
      if (panel) panel.classList.remove('active');
    }

    show() {
      this.bind();
      const panel = this.el('branchPanel');
      if (!panel) return;
      this.open = true;
      panel.classList.add('active');
      this.load();
    }

    async load(withStatus = false) {
      const dir = this.workingDir();
      const list = this.el('branchList');
      const title = this.el('branchDir');
      if (!list) return;

      // With no session yet, hand the server no path and let it answer for its
      // own base folder — the same fallback the file explorer takes, so the two
      // never disagree about where "here" is.
      this.dir = dir;
      title.textContent = dir ? (dir.split('/').filter(Boolean).pop() || dir) : '';
      title.title = dir || '';

      if (withStatus) {
        const btn = this.el('branchStatusBtn');
        btn.disabled = true;
        btn.textContent = 'Checking...';
      } else {
        this.message('Loading...');
      }

      const token = ++this.loadToken;
      try {
        const query = [];
        if (dir) query.push('path=' + encodeURIComponent(dir));
        if (withStatus) query.push('status=1');
        const url = '/api/git/branches' + (query.length ? '?' + query.join('&') : '');
        const res = await fetch(url, { headers: window.authManager.getAuthHeaders() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (token !== this.loadToken) return;   // a newer load already rendered
        if (!dir && data.path) {
          title.textContent = data.path.split('/').filter(Boolean).pop() || data.path;
          title.title = data.path;
        }
        this.render(data);
      } catch (error) {
        if (token === this.loadToken) this.message('Could not read branches: ' + error.message);
      } finally {
        const btn = this.el('branchStatusBtn');
        btn.disabled = false;
        btn.textContent = 'Check changes';
      }
    }

    message(text) {
      const list = this.el('branchList');
      list.textContent = '';
      const div = document.createElement('div');
      div.className = 'branch-empty';
      div.textContent = text;
      list.appendChild(div);
      this.el('branchFooterInfo').textContent = '';
    }

    render(data) {
      const list = this.el('branchList');
      const repos = data.repos || [];
      list.textContent = '';

      if (!repos.length) {
        this.message(data.error === 'ENOENT' ? 'That directory no longer exists.'
                   : data.error ? 'Cannot read that directory.'
                   : data.unexamined ? `No git repositories found, but ${data.unexamined} directories were not examined — this one is too large to scan in full.`
                   : 'No git repositories here.');
        return;
      }

      // Colour only branches that more than one repo shares.
      const counts = new Map();
      for (const r of repos) counts.set(r.branch, (counts.get(r.branch) || 0) + 1);
      const group = new Map();
      let next = 0;
      for (const r of repos) {
        if (counts.get(r.branch) > 1 && !group.has(r.branch) && next < GROUP_COUNT) {
          group.set(r.branch, next++);
        }
      }

      const frag = document.createDocumentFragment();
      for (const repo of repos) {
        const row = document.createElement('div');
        row.className = 'branch-row';

        const name = document.createElement('span');
        name.className = 'branch-name';
        // Repo names come off the filesystem: textContent, never innerHTML.
        name.textContent = repo.name === '.' ? '(this directory)' : repo.name;
        name.title = name.textContent;
        row.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'branch-meta';

        if (repo.dirty) meta.appendChild(this.badge('● ' + repo.dirty, 'branch-dirty', repo.dirty + ' uncommitted change(s)'));
        if (repo.ahead) meta.appendChild(this.badge('↑' + repo.ahead, 'branch-ahead', repo.ahead + ' commit(s) ahead of upstream'));
        if (repo.behind) meta.appendChild(this.badge('↓' + repo.behind, 'branch-behind', repo.behind + ' commit(s) behind upstream'));

        const pull = document.createElement('button');
        pull.className = 'row-pull';
        pull.type = 'button';
        pull.title = `Fast-forward ${repo.name} from its upstream`;
        pull.setAttribute('aria-label', `Pull ${repo.name}`);
        pull.dataset.repo = repo.name;
        pull.appendChild(pullIconNode.cloneNode(true));
        meta.appendChild(pull);

        const branch = document.createElement('span');
        branch.className = 'branch-ref' + (repo.detached ? ' detached' : '');
        branch.textContent = repo.detached ? 'detached @ ' + repo.branch : repo.branch;
        branch.title = branch.textContent;
        const g = group.get(repo.branch);
        if (g !== undefined && !repo.detached) branch.classList.add('branch-g' + g);
        meta.appendChild(branch);

        row.appendChild(meta);
        frag.appendChild(row);
      }
      list.appendChild(frag);

      const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
      let info = plural(repos.length, 'repo') + ' · ' + plural(counts.size, 'branch').replace('branchs', 'branches');
      if (data.truncated) info += ' · +' + data.truncated + ' not shown';
      // A directory too large to scan in full is a PARTIAL answer, and a panel
      // whose job is "every sub-project" must say so rather than look complete.
      if (data.unexamined) info += ' · ' + data.unexamined + ' dirs not examined';
      this.el('branchFooterInfo').textContent = info;
    }

    // Fast-forward one repo, then show what happened on its own row.
    //
    // The result replaces the branch name in place rather than popping a toast:
    // the answer belongs next to the thing it is about, and eleven rows of
    // toasts would be unreadable.
    async pull(btn) {
      const row = btn.closest('.branch-row');
      const name = btn.dataset.repo;
      if (!row || !name) return;

      const note = row.querySelector('.branch-ref');
      const wasText = note ? note.textContent : '';
      const wasClass = note ? note.className : '';
      btn.disabled = true;
      row.classList.add('pulling');
      if (note) { note.textContent = 'pulling...'; note.className = 'branch-ref'; }

      let result;
      try {
        const res = await fetch('/api/git/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...window.authManager.getAuthHeaders() },
          body: JSON.stringify({ path: this.dir, name }),
        });
        result = await res.json();
      } catch (error) {
        result = { ok: false, reason: 'failed', message: error.message };
      }

      row.classList.remove('pulling');
      btn.disabled = false;
      if (!note) return;

      if (result && result.ok && result.reason === 'up-to-date') {
        note.textContent = 'up to date';
        note.className = 'branch-ref pull-ok';
      } else if (result && result.ok) {
        note.textContent = 'updated';
        note.className = 'branch-ref pull-ok';
        // The branch may have moved; refresh so the panel is not left showing
        // what was true before the pull.
        setTimeout(() => this.load(), 1200);
      } else {
        const why = {
          dirty: 'uncommitted changes',
          'no-upstream': 'no upstream',
          'not-fast-forward': 'needs a merge',
          timeout: 'timed out',
          'not-a-repo': 'not a repository',
        }[result && result.reason] || 'failed';
        note.textContent = why;
        note.className = 'branch-ref pull-bad';
        note.title = (result && result.message) || why;
        // Put the branch name back once the reason has been read.
        setTimeout(() => {
          if (note.classList.contains('pull-bad')) {
            note.textContent = wasText;
            note.className = wasClass;
          }
        }, 6000);
      }
    }

    badge(text, cls, title) {
      const s = document.createElement('span');
      s.className = 'branch-badge ' + cls;
      s.textContent = text;
      s.title = title;
      return s;
    }
  }

  window.branchPanel = new BranchPanel();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.branchPanel.bind());
  } else {
    window.branchPanel.bind();
  }
})();

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
  const GROUP_COLORS = ['#3fb950', '#58a6ff', '#d29922', '#bc8cff', '#ff7b72', '#39c5cf'];

  class BranchPanel {
    constructor() {
      this.bound = false;
      this.open = false;
      this.dir = null;
      this.checking = false;
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

      if (!dir) {
        title.textContent = '';
        this.message('No working directory for this tab yet.');
        return;
      }
      this.dir = dir;
      title.textContent = dir.split('/').filter(Boolean).pop() || dir;
      title.title = dir;

      if (withStatus) {
        this.checking = true;
        const btn = this.el('branchStatusBtn');
        btn.disabled = true;
        btn.textContent = 'Checking...';
      } else {
        this.message('Loading...');
      }

      try {
        const url = '/api/git/branches?path=' + encodeURIComponent(dir) + (withStatus ? '&status=1' : '');
        const res = await fetch(url, { headers: window.authManager.getAuthHeaders() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        this.render(data);
      } catch (error) {
        this.message('Could not read branches: ' + error.message);
      } finally {
        this.checking = false;
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
                   : 'No git repositories here.');
        return;
      }

      // Colour only branches that more than one repo shares.
      const counts = new Map();
      for (const r of repos) counts.set(r.branch, (counts.get(r.branch) || 0) + 1);
      const color = new Map();
      let next = 0;
      for (const r of repos) {
        if (counts.get(r.branch) > 1 && !color.has(r.branch)) {
          color.set(r.branch, GROUP_COLORS[next++ % GROUP_COLORS.length]);
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

        const branch = document.createElement('span');
        branch.className = 'branch-ref' + (repo.detached ? ' detached' : '');
        branch.textContent = repo.detached ? 'detached @ ' + repo.branch : repo.branch;
        branch.title = branch.textContent;
        const c = color.get(repo.branch);
        if (c && !repo.detached) branch.style.color = c;
        meta.appendChild(branch);

        row.appendChild(meta);
        frag.appendChild(row);
      }
      list.appendChild(frag);

      const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
      let info = plural(repos.length, 'repo') + ' · ' + plural(counts.size, 'branch').replace('branchs', 'branches');
      if (data.truncated) info += ' · +' + data.truncated + ' not shown';
      this.el('branchFooterInfo').textContent = info;
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

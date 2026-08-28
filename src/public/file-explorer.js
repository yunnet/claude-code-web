// Read-only file/folder explorer (Windows-Explorer style). Opens from the
// desktop toolbar button (#explorerBtn, wired in app.js). Lists a directory via
// GET /api/fs/list (header auth) and opens a clicked file in a new browser tab
// via GET /api/fs/file (window.authManager.getFileUrl). Folder names are set with
// textContent, never innerHTML, so a crafted filename can't inject markup.

(function () {
  const FOLDER_ICON = '<svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
  const FILE_ICON = '<svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v5h5"/><path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/></svg>';

  function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
  }

  class FileExplorer {
    constructor() {
      this.currentPath = null;
      this.home = null;
      this.parent = null;
      this.bound = false;
    }

    el(id) { return document.getElementById(id); }

    bind() {
      if (this.bound) return;
      this.bound = true;
      const modal = this.el('fileExplorerModal');
      if (!modal) return;
      this.el('explorerCloseBtn').addEventListener('click', () => this.close());
      // Click on the backdrop (outside the content) closes the explorer.
      modal.addEventListener('click', (e) => { if (e.target === modal) this.close(); });
      this.el('explorerUpBtn').addEventListener('click', () => { if (this.parent) this.load(this.parent); });
      this.el('explorerHomeBtn').addEventListener('click', () => this.load(this.home || undefined));
      this.el('explorerShowHidden').addEventListener('change', () => this.load(this.currentPath));
      this.el('explorerPathInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const v = this.el('explorerPathInput').value.trim();
          if (v) this.load(v);
        }
      });
      // Esc closes while the explorer is open.
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) this.close();
      });

      this.setupResize();
    }

    // The drawer is anchored to the right edge, so a handle on its LEFT edge
    // lets the user drag it wider/narrower. The chosen width persists.
    clampWidth(w) {
      const min = 300;
      const max = Math.max(min, Math.min(window.innerWidth - 40, window.innerWidth * 0.95));
      return Math.min(max, Math.max(min, w));
    }

    setupResize() {
      const modal = this.el('fileExplorerModal');
      const content = modal && modal.querySelector('.folder-browser-content');
      if (!content) return;

      // Restore the saved width.
      try {
        const saved = parseInt(localStorage.getItem('cc-web-explorer-width'), 10);
        if (saved) content.style.width = this.clampWidth(saved) + 'px';
      } catch (_) {}

      const handle = document.createElement('div');
      handle.className = 'explorer-resize-handle';
      handle.title = 'Drag to resize';
      content.appendChild(handle);

      let dragging = false;
      handle.addEventListener('mousedown', (e) => {
        dragging = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        content.style.width = this.clampWidth(window.innerWidth - e.clientX) + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { localStorage.setItem('cc-web-explorer-width', String(parseInt(content.style.width, 10) || 440)); } catch (_) {}
      });
    }

    open(startPath) {
      this.bind();
      const modal = this.el('fileExplorerModal');
      if (!modal) return;
      modal.classList.add('active');
      // Resume where we were, else start at home (server default = baseFolder).
      this.load(startPath || this.currentPath || undefined);
    }

    close() {
      const modal = this.el('fileExplorerModal');
      if (modal) modal.classList.remove('active');
    }

    async load(dirPath) {
      const list = this.el('explorerList');
      if (!list) return;
      const hidden = this.el('explorerShowHidden').checked ? '1' : '0';
      let url = '/api/fs/list?hidden=' + hidden;
      if (dirPath) url += '&path=' + encodeURIComponent(dirPath);
      list.innerHTML = '<div class="folder-item folder-empty">Loading…</div>';
      try {
        const headers = (window.authManager && window.authManager.getAuthHeaders) ? window.authManager.getAuthHeaders() : {};
        const res = await fetch(url, { headers });
        if (!res.ok) {
          const msg = res.status === 403 ? 'Access to this directory is not allowed' : ('Cannot open (' + res.status + ')');
          list.innerHTML = '';
          list.appendChild(this.emptyRow(msg));
          return;
        }
        const data = await res.json();
        this.currentPath = data.path;
        this.parent = data.parent || null;
        this.home = data.home || this.home;
        this.el('explorerPathInput').value = data.path;
        this.render(data.items || [], data.truncated);
      } catch (_) {
        list.innerHTML = '';
        list.appendChild(this.emptyRow('Failed to load directory'));
      }
    }

    emptyRow(text) {
      const div = document.createElement('div');
      div.className = 'folder-item folder-empty';
      div.textContent = text;
      return div;
    }

    render(items, truncated) {
      const list = this.el('explorerList');
      list.innerHTML = '';

      if (this.parent) {
        const up = document.createElement('div');
        up.className = 'folder-item folder-item-parent';
        up.innerHTML = FOLDER_ICON;
        const name = document.createElement('span');
        name.className = 'folder-name';
        name.textContent = '..';
        up.appendChild(name);
        up.addEventListener('click', () => this.load(this.parent));
        list.appendChild(up);
      }

      if (!items.length) {
        list.appendChild(this.emptyRow('This folder is empty'));
        return;
      }

      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'folder-item';
        row.innerHTML = item.type === 'dir' ? FOLDER_ICON : FILE_ICON;

        const name = document.createElement('span');
        name.className = 'folder-name';
        name.textContent = item.name;
        row.appendChild(name);

        if (item.isSymlink) {
          const link = document.createElement('span');
          link.className = 'folder-symlink';
          link.textContent = '↗';
          link.title = 'Symlink';
          row.appendChild(link);
        }

        if (item.type === 'file') {
          const size = document.createElement('span');
          size.className = 'folder-size';
          size.textContent = formatSize(item.size);
          row.appendChild(size);
        }

        const full = this.join(this.currentPath, item.name);
        if (item.type === 'dir') {
          row.addEventListener('click', () => this.load(full));
        } else {
          row.title = 'Open in a new tab';
          row.addEventListener('click', () => this.openFile(full));
        }
        list.appendChild(row);
      }

      if (truncated) {
        const note = this.emptyRow('Showing the first 2000 items — narrow down with the path bar.');
        note.classList.add('folder-truncated');
        list.appendChild(note);
      }
    }

    join(dir, name) {
      if (!dir) return name;
      return dir.endsWith('/') ? dir + name : dir + '/' + name;
    }

    openFile(filePath) {
      const url = (window.authManager && window.authManager.getFileUrl)
        ? window.authManager.getFileUrl(filePath)
        : '/api/fs/file/-/' + encodeURIComponent(filePath);
      window.open(url, '_blank', 'noopener');
    }
  }

  window.fileExplorer = new FileExplorer();
})();

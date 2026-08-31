// Read-only file/folder explorer (Windows-Explorer style). Opens from the
// desktop toolbar button (#explorerBtn, wired in app.js). Lists a directory via
// GET /api/fs/list (header auth) and opens a clicked file in a new browser tab
// via GET /api/fs/file (window.authManager.getFileUrl). Folder names are set with
// textContent, never innerHTML, so a crafted filename can't inject markup.

(function () {
  const FOLDER_ICON = '<svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
  const FILE_ICON = '<svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v5h5"/><path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/></svg>';

  // Parse each icon ONCE; rows clone the node. Assigning innerHTML per row runs
  // the HTML parser once per row, which is most of the cost of a big listing.
  const iconNode = (svg) => {
    const t = document.createElement('template');
    t.innerHTML = svg;
    return t.content.firstElementChild;
  };
  const FOLDER_ICON_NODE = iconNode(FOLDER_ICON);
  const FILE_ICON_NODE = iconNode(FILE_ICON);

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
      // One delegated listener for the whole list: a 2000-row listing used to
      // attach 2000 closures. Rows carry their target in data-path/data-type
      // (dataset, never innerHTML, so a crafted filename can't inject markup).
      this.el('explorerList').addEventListener('click', (e) => {
        const row = e.target.closest && e.target.closest('.folder-item');
        if (!row || !row.dataset.path) return;
        if (row.dataset.type === 'dir') this.load(row.dataset.path);
        else this.openFile(row.dataset.path);
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

      // Pointer events, not mouse events: this is a mobile-first PWA, and pointer
      // covers touch and pen as well without a second set of handlers.
      let dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });
      document.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.preventDefault(); // stop touch-drag from scrolling the page instead
        content.style.width = this.clampWidth(window.innerWidth - e.clientX) + 'px';
      });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { localStorage.setItem('cc-web-explorer-width', String(parseInt(content.style.width, 10) || 440)); } catch (_) {}
      };
      document.addEventListener('pointerup', endDrag);
      document.addEventListener('pointercancel', endDrag);
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
      // Assemble off-document and insert once, so the browser lays out and paints
      // the listing a single time instead of once per row.
      const frag = document.createDocumentFragment();

      if (this.parent) {
        const up = document.createElement('div');
        up.className = 'folder-item folder-item-parent';
        up.appendChild(FOLDER_ICON_NODE.cloneNode(true));
        const name = document.createElement('span');
        name.className = 'folder-name';
        name.textContent = '..';
        up.appendChild(name);
        up.dataset.type = 'dir';
        up.dataset.path = this.parent;
        frag.appendChild(up);
      }

      if (!items.length) {
        frag.appendChild(this.emptyRow('This folder is empty'));
        list.appendChild(frag);
        return;
      }

      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'folder-item';
        row.appendChild((item.type === 'dir' ? FOLDER_ICON_NODE : FILE_ICON_NODE).cloneNode(true));

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
          row.title = 'Open in a new tab';
        }

        row.dataset.type = item.type;
        row.dataset.path = this.join(this.currentPath, item.name);
        frag.appendChild(row);
      }

      if (truncated) {
        const note = this.emptyRow('Showing the first 2000 items — narrow down with the path bar.');
        note.classList.add('folder-truncated');
        frag.appendChild(note);
      }
      list.appendChild(frag);
    }

    join(dir, name) {
      if (!dir) return name;
      return dir.endsWith('/') ? dir + name : dir + '/' + name;
    }

    // Types the server will RENDER rather than show as source. They only get
    // rendered when the URL carries a single-use ticket instead of the auth
    // token, because a rendered page can read its own location.
    static get RENDERED_EXTS() { return ['.html', '.htm', '.svg']; }

    isRendered(filePath) {
      const name = String(filePath || '').toLowerCase();
      return FileExplorer.RENDERED_EXTS.some((ext) => name.endsWith(ext));
    }

    openFile(filePath) {
      const plainUrl = (window.authManager && window.authManager.getFileUrl)
        ? window.authManager.getFileUrl(filePath)
        : '/api/fs/file/-/' + encodeURIComponent(filePath);
      if (!this.isRendered(filePath) || !(window.authManager && window.authManager.getFileTicket)) {
        window.open(plainUrl, '_blank', 'noopener');
        return;
      }
      // Open the tab synchronously (a popup blocker would eat a window.open that
      // happens after an await), then point it at the ticketed URL. Can't pass
      // 'noopener' here — that makes window.open return null and we need the
      // handle — so sever the link by hand while the tab is still about:blank.
      // If minting fails we still land on the token URL, which serves the file as
      // source: degraded, never unsafe.
      const tab = window.open('', '_blank');
      if (tab) { try { tab.opener = null; } catch (_) {} }
      window.authManager.getFileTicket(filePath).then((ticket) => {
        const url = ticket
          ? `/api/fs/file/${encodeURIComponent(ticket)}/${encodeURIComponent(filePath)}`
          : plainUrl;
        if (tab) tab.location = url;
        else window.open(url, '_blank', 'noopener');
      });
    }
  }

  window.fileExplorer = new FileExplorer();
})();

// Right sidebar and page management.
import { h, $, ibtn, icon, cssColor, fmtDate, fmtSize, toast, errToast, formDialog, contextMenu, debounce } from './util.js';
import { setOutline, addAttachment, removeAttachment, rotatePages, reorderPages, duplicatePages } from './pdf/ops.js';
import { verifySignatures } from './pdf/sign.js';

const RAIL = [['comments', 'comment', 'Comments'], ['thumbs', 'thumbs', 'Page thumbnails'], ['bookmarks', 'bookmark', 'Bookmarks'], ['attachments', 'clip', 'Attachments'], ['layers', 'layers', 'Layers'], ['signatures', 'cert', 'Signatures'], ['search', 'search', 'Advanced search']];
const STATES = [['', 'No status'], ['Accepted', 'Accepted'], ['Rejected', 'Rejected'], ['Cancelled', 'Cancelled'], ['Completed', 'Completed']];

/** Loads thumbnails only when they become visible. */
function lazyThumbs(root, items, render) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      render(en.target);
    }
  }, { root, rootMargin: '400px' });
  items.forEach((el) => io.observe(el));
  return io;
}

export class Panels {
  constructor(app) {
    this.app = app; this.current = null;
    this.rail = $('#right-rail'); this.panel = $('#right-panel');
    this.rail.append(...RAIL.map(([id, ic, title]) => h('button', { class: 'ib', type: 'button', title, data: { panel: id }, onclick: () => this.toggle(id) }, icon(ic))));
    this.commentsChanged = debounce(() => { if (this.current === 'comments') this.render(); }, 60);
    this.filter = { q: '', sort: 'page' };
    this.selPages = new Set();
  }
  get doc() { return this.app.doc; }
  get viewer() { return this.app.viewer; }

  toggle(id) { if (this.current === id) this.hide(); else this.show(id); }
  hide() { this.current = null; this.panel.hidden = true; this.sync(); this.app.viewer.scheduleRender(); }
  show(id) { this.current = id; this.panel.hidden = false; this.sync(); this.render(); }
  sync() { [...this.rail.children].forEach((b) => b.classList.toggle('active', b.dataset.panel === this.current)); }
  refresh() { if (this.current && this.doc) this.render(); }

  frame(title, actions, body) {
    this.panel.replaceChildren(h('div', { class: 'rp-head' }, h('span', { class: 't' }, title), actions, ibtn('x', 'Close', () => this.hide())), h('div', { class: 'rp-body' }, body));
  }

  render() {
    if (!this.doc) return;
    const token = (this.renderToken = {});
    const m = { comments: 'renderComments', thumbs: 'renderThumbs', bookmarks: 'renderBookmarks', attachments: 'renderAttachments', layers: 'renderLayers', signatures: 'renderSignatures', search: 'renderSearch' };
    Promise.resolve(this[m[this.current]](token)).catch(errToast);
  }

  // --- Comments ------------------------------------------------------------------------
  renderComments() {
    const doc = this.doc;
    let list = doc.allAnnots();
    const q = this.filter.q.toLowerCase();
    if (q) list = list.filter((a) => `${a.contents} ${a.author} ${a.subject}`.toLowerCase().includes(q));
    if (this.filter.sort === 'date') list = [...list].sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    if (this.filter.sort === 'author') list = [...list].sort((a, b) => (a.author || '').localeCompare(b.author || ''));
    if (this.filter.sort === 'type') list = [...list].sort((a, b) => (a.subject || '').localeCompare(b.subject || ''));
    const tools = this.app.tools;
    const body = h('div', {},
      h('input', { class: 'fld', type: 'search', placeholder: 'Search comments', value: this.filter.q, oninput: debounce((e) => { this.filter.q = e.target.value; this.render(); setTimeout(() => { const f = $('.rp-body input[type=search]', this.panel); if (f) { f.focus(); f.setSelectionRange(99, 99); } }, 0); }, 180) }),
      h('div', { style: { display: 'flex', gap: '6px', margin: '6px 0', alignItems: 'center' } },
        h('select', { class: 'fld', onchange: (e) => { this.filter.sort = e.target.value; this.render(); } }, [['page', 'By page'], ['date', 'By date'], ['author', 'By author'], ['type', 'By type']].map(([v, l]) => h('option', { value: v, selected: this.filter.sort === v }, l)))),
    );
    if (!list.length) body.append(h('div', { class: 'empty' }, doc.signed ? 'In signed documents, existing comments are only visible on the page.' : 'No comments yet.'));
    let lastPage = -1;
    for (const a of list) {
      if (this.filter.sort === 'page' && a.page !== lastPage) { body.append(h('div', { class: 'pg-title' }, `Page ${doc.label(a.page)}`)); lastPage = a.page; }
      body.append(this.commentCard(a));
    }
    this.frame(`Comments (${doc.allAnnots().length})`, [ibtn('more', 'More options', (e) => contextMenu(e.clientX, e.clientY, [
      { label: 'Create comment summary as PDF', run: () => tools.commentSummary() },
      { label: 'Export comments (XFDF)...', run: () => tools.exportXfdf() },
      { label: 'Import comments (XFDF)...', run: () => tools.importXfdf() },
      '-',
      { label: 'Flatten comments into pages...', run: () => tools.flattenComments() },
      { label: 'Delete all comments...', run: () => tools.deleteAllComments() },
    ]))], body);
    this.highlightComment(this.app.overlay.selected);
  }
  commentCard(a) {
    const ov = this.app.overlay;
    const doc = this.doc;
    const tx = h('textarea', { class: 'tx', rows: 1, placeholder: 'Add comment', spellcheck: 'true' });
    tx.value = a.contents || '';
    let pushed = false;
    tx.addEventListener('input', () => { if (!pushed) { doc.pushUndo(); pushed = true; } a.contents = tx.value; ov.touch(a); doc.markDirty(); if (a.type === 'freetext' || a.type === 'callout') ov.renderPage(a.page); });
    tx.addEventListener('blur', () => { pushed = false; });
    tx.addEventListener('keydown', (e) => e.stopPropagation());
    const reply = h('input', { placeholder: 'Reply', spellcheck: 'true' });
    reply.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || !reply.value.trim()) return;
      doc.pushUndo();
      a.replies.push({ id: `r${Date.now()}`, author: this.app.userName(), contents: reply.value.trim(), modified: new Date().toISOString() });
      doc.markDirty(); this.render();
    });
    const status = h('select', { title: 'Status', onchange: (e) => { doc.pushUndo(); a.status = e.target.value || null; doc.markDirty(); } }, STATES.map(([v, l]) => h('option', { value: v, selected: (a.status || '') === v }, l)));
    return h('div', { class: 'cm', data: { id: a.id }, onclick: (e) => {
      if (e.target.closest('textarea,input,select,button')) { ov.selected !== a.id && ov.select(a.id); return; }
      this.viewer.goto(a.page, { pdfY: a.rect[3] + 30 }); ov.select(a.id);
    } },
      h('header', {}, h('span', { class: 'dot', style: { background: cssColor(a.color || a.textColor || a.stamp?.color || [0.6, 0.6, 0.6]) } }), h('span', { class: 'au' }, a.author || 'Unknown'), h('time', {}, fmtDate(a.modified)), ibtn('trash', 'Delete', () => ov.remove(a.id), { style: { minWidth: '24px', height: '24px' } })),
      h('small', { style: { color: 'var(--grey)' } }, a.subject || ''), tx,
      a.replies.map((r) => h('div', { class: 'rep' }, h('b', {}, r.author), ' ', h('time', {}, fmtDate(r.modified)), h('div', {}, r.contents))),
      h('div', { class: 'act' }, reply, status));
  }
  highlightComment(id) {
    if (this.current !== 'comments') return;
    this.panel.querySelectorAll('.cm').forEach((c) => {
      const on = c.dataset.id === id;
      c.classList.toggle('sel', on);
      if (on) c.scrollIntoView({ block: 'nearest' });
    });
  }

  // --- Thumbnails ------------------------------------------------------------------------
  thumbCard(i, width, sel, opts) {
    const doc = this.doc;
    const box = doc.pages[i]; const rot = box.rotate % 180 !== 0;
    const ratio = rot ? (box.view[2] - box.view[0]) / (box.view[3] - box.view[1]) : (box.view[3] - box.view[1]) / (box.view[2] - box.view[0]);
    const ph = h('div', { style: { width: `${width}px`, height: `${width * (rot ? 1 / ratio : ratio)}px`, background: '#fff' } });
    const el = h('button', { class: `thumb ${sel.has(i) ? 'sel' : ''} ${i === this.viewer.current && !opts.noCurrent ? 'on' : ''}`, type: 'button', draggable: 'true', data: { page: i } }, ph, h('div', { class: 'n' }, doc.label(i)));
    el.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { if (sel.has(i)) sel.delete(i); else sel.add(i); } else if (e.shiftKey && this.lastThumb !== undefined) { for (let k = Math.min(i, this.lastThumb); k <= Math.max(i, this.lastThumb); k++) sel.add(k); } else { sel.clear(); sel.add(i); }
      this.lastThumb = i;
      el.parentElement.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('sel', sel.has(+t.dataset.page)));
      opts.onClick?.(i);
    });
    el.addEventListener('dblclick', () => opts.onOpen?.(i));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!sel.has(i)) { sel.clear(); sel.add(i); el.parentElement.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('sel', sel.has(+t.dataset.page))); } this.pageMenu(e, sel); });
    el.addEventListener('dragstart', (e) => { if (!sel.has(i)) { sel.clear(); sel.add(i); } e.dataTransfer.setData('text/dp-pages', '1'); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/dp-pages')) return;
      e.preventDefault();
      el.parentElement.querySelectorAll('.drop-before,.drop-left').forEach((x) => x.classList.remove('drop-before', 'drop-left'));
      el.classList.add(opts.horizontal ? 'drop-left' : 'drop-before');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-left'));
    el.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes('text/dp-pages')) return;
      e.preventDefault(); e.stopPropagation();
      el.classList.remove('drop-before', 'drop-left');
      this.movePages([...sel], i);
    });
    el._render = async () => { try { const c = await this.viewer.thumbnail(i, width); if (el.isConnected) ph.replaceWith(c); } catch { /* verworfen */ } };
    return el;
  }
  async movePages(moving, before) {
    const n = this.doc.numPages;
    const set = new Set(moving);
    const rest = [...Array(n).keys()].filter((i) => !set.has(i));
    const pos = rest.filter((i) => i < before).length;
    const order = [...rest.slice(0, pos), ...[...set].sort((a, b) => a - b), ...rest.slice(pos)];
    if (order.every((v, i) => v === i)) return;
    await this.op((b) => reorderPages(b, order));
  }
  async op(fn) { try { return await this.doc.mutate(fn); } catch (e) { errToast(e); return false; } }
  pageMenu(e, sel) {
    const list = () => [...sel].sort((a, b) => a - b);
    contextMenu(e.clientX, e.clientY, [
      { label: 'Rotate clockwise', run: () => this.op((b) => rotatePages(b, list(), 90)) },
      { label: 'Rotate counterclockwise', run: () => this.op((b) => rotatePages(b, list(), -90)) },
      '-',
      { label: 'Duplicate', run: () => this.op((b) => duplicatePages(b, list())) },
      { label: 'Insert blank page after', run: () => this.app.tools.insertBlankAt(list().pop() + 1) },
      { label: 'Insert from file...', run: () => this.app.tools.insertFromFile(list().pop() + 1) },
      { label: 'Extract...', run: () => this.app.tools.extract(list()) },
      '-',
      { label: 'Delete', run: () => this.app.tools.deletePagesAsk(list()) },
    ]);
  }
  renderThumbs() {
    this.thumbSel = this.thumbSel || new Set();
    const items = this.doc.pages.map((_, i) => this.thumbCard(i, 150, this.thumbSel, { onClick: (p) => this.viewer.goto(p) }));
    const box = h('div', { class: 'thumbs' }, items);
    this.frame('Page thumbnails', [ibtn('pages', 'Organize pages', () => this.app.run('tool-organize'))], box);
    lazyThumbs(box.parentElement, items, (el) => el._render());
    box.querySelector('.thumb.on')?.scrollIntoView({ block: 'center' });
  }
  markCurrentThumb(i) {
    if (this.current !== 'thumbs') return;
    this.panel.querySelectorAll('.thumb').forEach((t) => { const on = +t.dataset.page === i; t.classList.toggle('on', on); if (on) t.scrollIntoView({ block: 'nearest' }); });
  }

  // --- Bookmarks -----------------------------------------------------------------------
  async loadOutline() {
    const doc = this.doc;
    const raw = await doc.pdf.getOutline();
    const conv = async (items) => {
      const out = [];
      for (const it of items || []) {
        const node = { title: it.title, children: await conv(it.items), open: it.count === undefined || it.count >= 0 };
        try {
          let d = it.dest;
          if (typeof d === 'string') d = await doc.pdf.getDestination(d);
          if (Array.isArray(d)) { node.page = typeof d[0] === 'object' ? await doc.pdf.getPageIndex(d[0]) : d[0]; if (d[1]?.name === 'XYZ' && typeof d[3] === 'number') node.top = d[3]; }
        } catch { /* target no longer exists */ }
        if (it.url) node.url = it.url;
        out.push(node);
      }
      return out;
    };
    return conv(raw);
  }
  async renderBookmarks(token) {
    const tree = await this.loadOutline();
    if (token !== this.renderToken) return;
    this.outline = tree;
    const treeEl = this.treeNodes(tree);
    const add = async () => {
      const r = await formDialog('New bookmark', [{ k: 't', label: 'Title', required: true, value: `Page ${this.viewer.current + 1}` }]);
      if (!r) return;
      const node = { title: r.t, page: this.viewer.current, children: [] };
      if (this.selBm) this.selBm.children.push(node); else tree.push(node);
      await this.saveOutline(tree);
    };
    this.frame('Bookmarks', [ibtn('plus', 'New bookmark', add), ibtn('edit', 'Rename', () => this.bmRename(tree)), ibtn('chevU', 'Move up', () => this.bmMove(tree, -1)), ibtn('chevD', 'Move down', () => this.bmMove(tree, 1)), ibtn('trash', 'Delete', () => this.bmDelete(tree))], tree.length ? treeEl : h('div', { class: 'empty' }, 'This document has no bookmarks.'));
  }
  treeNodes(items) {
    return h('ul', { class: 'tree' }, items.map((it) => {
      const kids = it.children?.length ? this.treeNodes(it.children) : null;
      if (kids && it.open === false) kids.hidden = true;
      const tw = h('button', { class: 'tw', type: 'button', onclick: () => { if (kids) { kids.hidden = !kids.hidden; it.open = !kids.hidden; tw.replaceChildren(icon(kids.hidden ? 'chevR' : 'chevD')); } } }, kids ? icon(it.open === false ? 'chevR' : 'chevD') : '');
      const row = h('div', { class: `tree-row ${this.selBm === it ? 'sel' : ''}` }, tw, h('button', { class: 'lb', type: 'button', title: it.title, onclick: () => {
        this.selBm = it;
        this.panel.querySelectorAll('.tree-row').forEach((r) => r.classList.remove('sel')); row.classList.add('sel');
        if (it.url) window.dp.openExternal(it.url); else if (it.page !== undefined) this.viewer.goto(it.page, { pdfY: it.top });
      } }, it.title));
      return h('li', {}, row, kids);
    }));
  }
  bmFind(tree, target) { for (let i = 0; i < tree.length; i++) { if (tree[i] === target) return [tree, i]; const r = this.bmFind(tree[i].children || [], target); if (r) return r; } return null; }
  async saveOutline(tree) { await this.op((b) => setOutline(b, tree)); }
  async bmRename(tree) { if (!this.selBm) { toast('Please select a bookmark first.'); return; } const r = await formDialog('Rename bookmark', [{ k: 't', label: 'Title', value: this.selBm.title, required: true }]); if (r) { this.selBm.title = r.t; await this.saveOutline(tree); } }
  async bmDelete(tree) { const f = this.selBm && this.bmFind(tree, this.selBm); if (!f) { toast('Please select a bookmark first.'); return; } f[0].splice(f[1], 1); this.selBm = null; await this.saveOutline(tree); }
  async bmMove(tree, d) { const f = this.selBm && this.bmFind(tree, this.selBm); if (!f) { toast('Please select a bookmark first.'); return; } const [l, i] = f; if (i + d < 0 || i + d >= l.length) return; [l[i], l[i + d]] = [l[i + d], l[i]]; await this.saveOutline(tree); }

  // --- Attachments ---------------------------------------------------------------------------
  async attachments() {
    const a = await this.doc.pdf.getAttachments();
    if (!a) return [];
    return (a instanceof Map ? [...a.values()] : Object.values(a));
  }
  async renderAttachments(token) {
    const list = await this.attachments();
    if (token !== this.renderToken) return;
    const save = async (f) => {
      if (this.app.settings.attachmentsSave === false) { toast('Saving attachments is blocked in Preferences (Trust Manager).', 'err'); return; }
      const data = await this.attachmentContent(f);
      const p = await window.dp.saveDialog({ title: 'Save attachment', defaultPath: f.filename, filters: [{ name: 'All files', extensions: ['*'] }] });
      if (p) { await window.dp.writeFile(p, data); toast('Attachment saved', 'ok'); }
    };
    const body = list.length ? list.map((f) => h('div', { class: 'kv' }, icon('clip'), h('span', { class: 'g', title: f.description || f.filename }, f.filename), h('small', {}, f.content ? fmtSize(f.content.length) : ''), ibtn('save', 'Save', () => save(f).catch(errToast)), ibtn('trash', 'Remove', () => this.op((b) => removeAttachment(b, f.filename))))) : h('div', { class: 'empty' }, 'No attachments.');
    this.frame('Attachments', [ibtn('plus', 'Attach file', () => this.addAttachment())], body);
  }
  async attachmentContent(f) {
    if (f.content) return f.content;
    return this.doc.pdf.getAttachmentContent ? (await this.doc.pdf.getAttachmentContent(f.id)).content : new Uint8Array();
  }
  async addAttachment() {
    const [p] = await window.dp.openDialog({ title: 'Attach file', filters: [{ name: 'All files', extensions: ['*'] }] });
    if (!p) return;
    const data = await window.dp.readFile(p);
    await this.op((b) => addAttachment(b, p.split(/[\\/]/).pop(), data));
  }

  // --- Layers ----------------------------------------------------------------------------
  renderLayers() {
    const cfg = this.doc.ocConfig;
    const groups = cfg?.getGroups?.();
    const entries = groups ? Object.entries(groups) : [];
    const body = entries.length ? entries.map(([id, g]) => h('label', { class: 'kv' }, h('input', { type: 'checkbox', checked: cfg.isVisible ? cfg.isVisible(g) : g.visible, onchange: (e) => { cfg.setVisibility(id, e.target.checked); this.viewer.invalidate(); } }), h('span', { class: 'g' }, g.name || id))) : h('div', { class: 'empty' }, 'This document has no layers.');
    this.frame('Layers', [], body);
  }

  // --- Signatures ------------------------------------------------------------------------
  renderSignatures() {
    const bytes = this.doc.saved;
    const list = this.doc.encrypted ? [] : verifySignatures(bytes);
    const body = list.length ? list.map((s, i) => {
      const badge = s.error ? ['bad', 'Error'] : !s.valid ? ['bad', 'Invalid'] : !s.covers ? ['warn', 'Changed after signing'] : s.selfSigned ? ['warn', 'Valid, identity unverified'] : ['ok', 'Valid'];
      return h('div', { class: 'cm' }, h('header', {}, h('b', { class: 'au' }, s.name || `Signature ${i + 1}`)), h('span', { class: `badge ${badge[0]}` }, badge[1]),
        s.signedAt ? h('div', {}, `Signed: ${fmtDate(s.signedAt)}`) : null,
        s.issuer ? h('div', {}, `Issuer: ${s.issuer}`) : null,
        s.notAfter ? h('div', {}, `Certificate valid until: ${fmtDate(s.notAfter)}`) : null,
        s.error ? h('div', { style: { color: 'var(--danger)' } }, s.error) : null,
        s.fingerprint ? h('details', {}, h('summary', {}, 'SHA-256 fingerprint'), h('code', { style: { wordBreak: 'break-all', fontSize: '11px' } }, s.fingerprint)) : null);
    }) : h('div', { class: 'empty' }, 'This document contains no digital signatures.');
    this.frame('Signatures', [], body);
  }

  // --- Advanced search ------------------------------------------------------------------
  renderSearch() {
    const input = h('input', { class: 'fld', type: 'search', placeholder: 'Search term', spellcheck: 'false', value: this.lastSearch || '' });
    const cs = h('input', { type: 'checkbox' }); const ww = h('input', { type: 'checkbox' });
    const results = h('div', {});
    const go = async () => {
      this.lastSearch = input.value;
      const found = await this.app.find.collect(input.value, { caseSensitive: cs.checked, wholeWord: ww.checked });
      results.replaceChildren(h('div', { class: 'pg-title' }, `${found.length} results`), ...found.slice(0, 500).map((m) => {
        const pre = m.text.slice(Math.max(0, m.start - 30), m.start); const hit = m.text.slice(m.start, m.end); const post = m.text.slice(m.end, m.end + 30);
        return h('button', { class: 'res', type: 'button', onclick: () => { this.app.find.matches = found; this.app.find.query = input.value; this.app.find.paintAll(); this.app.find.setCur(found.indexOf(m)); } }, h('small', { style: { color: 'var(--grey)' } }, `Page ${m.page + 1}: `), pre, h('mark', {}, hit), post);
      }));
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go().catch(errToast); });
    this.frame('Advanced search', [], [input, h('label', { class: 'kv' }, cs, 'Gross-/Kleinschreibung'), h('label', { class: 'kv' }, ww, 'Whole words only'), h('button', { class: 'btn primary', type: 'button', style: { margin: '6px 0' }, onclick: () => go().catch(errToast) }, 'Find'), results]);
    setTimeout(() => input.focus(), 20);
  }
}

/** Organize pages: overview of all pages with move, rotate, delete etc. */
export class Organizer {
  constructor(app) { this.app = app; this.el = $('#organizer'); this.sel = new Set(); this.width = 170; }
  get open() { return !this.el.hidden; }
  show() { this.el.hidden = false; document.body.classList.add('organizing'); this.render(); }
  hide() { this.el.hidden = true; document.body.classList.remove('organizing'); this.el.replaceChildren(); }
  render() {
    const app = this.app; const doc = app.doc; const P = app.panels; const T = app.tools;
    const list = () => [...this.sel].sort((a, b) => a - b);
    const need = (fn) => () => { if (!this.sel.size) { toast('Please select pages first.'); return; } fn(list()); };
    const items = doc.pages.map((_, i) => P.thumbCard(i, this.width, this.sel, { horizontal: true, noCurrent: true, onOpen: (p) => { this.hide(); app.viewer.goto(p); app.tools.closeGroup(); } }));
    const grid = h('div', { class: 'org-grid', style: { '--org-w': `${this.width + 20}px` } }, items);
    grid.style.setProperty('--org-w', `${this.width + 20}px`);
    const bar = h('div', { class: 'org-bar' },
      h('button', { class: 'btn', type: 'button', onclick: () => { doc.pages.forEach((_, i) => this.sel.add(i)); this.render(); } }, 'Select all'),
      h('button', { class: 'btn', type: 'button', onclick: () => { this.sel.clear(); this.render(); } }, 'None'),
      h('span', { class: 'sep' }),
      ibtn('rotL', 'Rotate counterclockwise', need((l) => P.op((b) => rotatePages(b, l, -90)))), ibtn('rotR', 'Rotate clockwise', need((l) => P.op((b) => rotatePages(b, l, 90)))),
      ibtn('dup', 'Duplicate', need((l) => P.op((b) => duplicatePages(b, l)))), ibtn('trash', 'Delete', need((l) => T.deletePagesAsk(l))), ibtn('extract', 'Extract', need((l) => T.extract(l))),
      h('span', { class: 'sep' }),
      h('button', { class: 'btn', type: 'button', onclick: () => T.insertFromFile(this.sel.size ? list().pop() + 1 : doc.numPages) }, 'Insert from file'), h('button', { class: 'btn', type: 'button', onclick: () => T.insertBlankAt(this.sel.size ? list().pop() + 1 : doc.numPages) }, 'Blank page'),
      h('button', { class: 'btn', type: 'button', onclick: need((l) => T.replaceFromFile(l)) }, 'Replace'), h('button', { class: 'btn', type: 'button', onclick: () => T.split() }, 'Split'),
      h('span', { class: 'spacer' }), ibtn('minus', 'Smaller', () => { this.width = Math.max(90, this.width - 40); this.render(); }), ibtn('plus', 'Larger', () => { this.width = Math.min(420, this.width + 40); this.render(); }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { this.hide(); T.closeGroup(); } }, 'Close'));
    this.el.replaceChildren(bar, grid);
    lazyThumbs(this.el, items, (el) => el._render());
  }
}

// Application: tabs, home page, commands, open/save/print.
import './motion.js';
import { Doc, pdfjs, RENDER_OPTS } from './document.js';
import { Viewer } from './viewer.js';
import { Overlay } from './overlay.js';
import { PageEditor } from './editor.js';
import { Find } from './find.js';
import { FieldDetector } from './formauto.js';
import { Panels, Organizer } from './panels.js';
import { Tools } from './tools.js';
import { h, $, $$, icon, ibtn, toast, errToast, busy, formDialog, messageBox, fmtDate, fmtSize, contextMenu, MAC, emptyState, canvasBytes } from './util.js';
import { setMetadata } from './pdf/ops.js';
import { openPreferences, withDefaults } from './prefs.js';
import { Scripting } from './scripting.js';
import { FormCalc } from './formcalc.js';
import { loadFonts } from './fonts.js';
import { scannedPages } from './scan.js';
import { fileToPdf } from './convert.js';
import { printDocument } from './print.js';
import { Autosave } from './autosave.js';
import { openPalette } from './palette.js';
import { listFonts, fontKind } from './pdf/docfonts.js';
import { loadForEdit } from './pdf/ops.js';

const dp = window.dp;

/**
 * Tool cards in full rows: the number of columns is chosen so that the last row is as full as possible
 * (e.g. 18 tools as 6 x 3 instead of 8 + 8 + 2), as long as the cards keep a comfortable width.
 */
const CARD_MIN = 200; const CARD_MAX = 420; const CARD_GAP = 10;
/** The tools on the home page. */
const HOME_TOOLS = ['edit', 'comment', 'fillsign', 'organize', 'combine', 'convert', 'create', 'ocr', 'protect', 'compress'];
/** Width in pixels of the picture of a recent file's first page (the cards are about 150 px wide on the screen). */
const THUMB_W = 320;

/**
 * Picture of the first page of a recent file for the home page, read from the file on disk (with its comments and form
 * values as saved). Returns the picture's address, or null: no picture for files over 80 MB and for documents that
 * need a password to open (their content is not copied into the picture folder).
 */
async function firstPagePicture(path) {
  const st = await dp.fileStat(path);
  if (!st || st.size > 80e6) return null;
  const task = pdfjs.getDocument({ data: await dp.readFile(path), ...RENDER_OPTS });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: THUMB_W / page.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d', { alpha: false }), viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE, background: 'white' }).promise;
    return await dp.recentThumb(path, await canvasBytes(c, 'image/jpeg', 0.85));
  } catch (e) {
    if (e?.name !== 'PasswordException') console.warn('Picture of the first page', e);
    return null;
  } finally { task.destroy(); }
}
function balanceGrid(grid) {
  const fit = () => {
    const n = grid.children.length; const w = grid.clientWidth;
    if (!n || !w) return;
    const width = (c) => (w - CARD_GAP * (c - 1)) / c;
    let best = null;
    for (let c = 1; c <= n; c++) {
      if (width(c) < CARD_MIN) break;
      if (width(c) > CARD_MAX && c < n) continue;
      const empty = (c - (n % c)) % c;
      if (!best || empty < best.empty || (empty === best.empty && c > best.c)) best = { c, empty };
    }
    const c = best ? best.c : Math.max(1, Math.floor((w + CARD_GAP) / (CARD_MIN + CARD_GAP)));
    grid.style.gridTemplateColumns = `repeat(${c}, minmax(0, 1fr))`;
    grid.dataset.cols = String(c);
  };
  new ResizeObserver(fit).observe(grid);
  fit();
  return grid;
}
const editing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
const inForm = () => !!document.activeElement?.closest?.('.annotationLayer');

class App {
  constructor() { this.docs = []; this.doc = null; this.view = 'home'; this.settings = {}; this.closed = []; }

  async init() {
    // IT policy: blocked features stay off, regardless of what the settings say.
    this.policy = Object.freeze({ allowJavaScript: false, allowOfficeMacros: false, ...(await dp.policy().catch(() => ({}))) });
    this.settings = this.enforcePolicy(withDefaults(await dp.settingsGet()));
    this.scripting = new Scripting(this);
    this.formCalc = new FormCalc(this);
    this.viewer = new Viewer(this, $('#viewer'));
    this.panels = new Panels(this);
    this.overlay = new Overlay(this);
    this.editor = new PageEditor(this);
    // All fonts like in Word, loaded in the background; new text starts in Word's default font.
    this.fontsReady = loadFonts().then(() => this.editor.useWordDefault());
    this.find = new Find(this);
    this.fieldDetect = new FieldDetector(this);
    this.organizer = new Organizer(this);
    this.tools = new Tools(this);
    this.overlay.tools = this.tools;
    this.onToolChanged = () => { this.tools.onToolChanged(); this.syncQuick(); };
    this.tools.renderAll();
    this.buildTop(); this.buildDocToolbar(); this.buildQuick(); this.buildPageControls();
    this.renderTabs(); this.renderHome(); this.renderToolsView();
    dp.onCommand((c, a) => this.run(c, a));
    dp.onOpenPaths((p) => p.forEach((x) => this.openPath(x)));
    dp.onRequestClose(() => this.requestQuit());
    this.bindKeys(); this.bindDrop(); this.bindHand(); this.bindPaste();
    window.__app = this;
    this.applySettings();
    // "Same as Windows": follow the switch between light and dark Windows immediately.
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyAppearance());
    this.autosave = new Autosave(this);
    const initial = await dp.ready();
    // Preference "Reopen the last open documents".
    if (this.settings.restoreDocs && !initial.length) {
      for (const p of this.settings.lastOpen || []) if (await dp.fileStat(p)) await this.openPath(p);
    }
    for (const p of initial) await this.openPath(p);
    await this.autosave.offerRecovery().catch((e) => console.warn('Recovery', e));
  }

  enforcePolicy(s) {
    if (!this.policy.allowJavaScript) s.jsEnabled = false;
    if (!this.policy.allowOfficeMacros) s.officeMacros = false;
    return s;
  }

  /** Applies the preferences to the running app. */
  applySettings() {
    const s = this.settings;
    Doc.settings = s;
    document.body.classList.toggle('form-hl', !!s.formHighlight);
    this.formHighlight = !!s.formHighlight;
    for (const k of ['freetext', 'callout']) if (this.overlay.props[k]) this.overlay.props[k].fontSize = Number(s.commentFontSize) || 12;
    this.tools.measure.unit = s.units === 'pt' ? 'pt' : s.units;
    this.find.setDefaults({ caseSensitive: !!s.searchCase, wholeWord: !!s.searchWhole });
    if (this.grid) this.applyGrid();
    this.drawRulers();
    this.applyAppearance();
  }
  /**
   * Appearance from Preferences: light (default), dark or same as Windows. The colors are defined as
   * variables in styles.css; here only the attribute on the root element is set. Takes effect immediately, without a restart.
   */
  applyAppearance() {
    const want = this.settings?.appearance;
    const dark = want === 'dark' || (want === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // The window buttons in the title bar (Windows) take the colors of the bar.
    const css = getComputedStyle(document.documentElement);
    dp.titlebar?.({ color: css.getPropertyValue('--titlebar').trim(), symbolColor: css.getPropertyValue('--ink2').trim() }).catch(() => {});
  }

  userName() { return this.settings.userName || 'User'; }
  saveSettings() { return dp.settingsSet(this.settings); }

  // --- Interface ---------------------------------------------------------------------------
  /**
   * Title bar (the window has no frame of its own): ☰ with the menu (Windows; a Mac keeps its menu bar at the top of
   * the screen), the tabs, a search field in the middle that opens the command search, and Open and Preferences.
   */
  buildTop() {
    document.body.classList.toggle('mac', MAC);
    if (!MAC) {
      this.menuBtn = ibtn('menu', 'Menu (Alt)', () => this.openMenu(), { id: 'menu-btn', 'aria-haspopup': 'menu', 'aria-label': 'Menu' });
      $('#topbar .tb-left').prepend(this.menuBtn);
      this.bindMenuKeys();
    }
    const search = h('button', { id: 'cmd-search', type: 'button', title: 'Search tools and commands (Ctrl+Shift+P)', 'aria-label': 'Search tools and commands', onclick: () => openPalette(this) },
      icon('search'), h('span', { class: 'ph' }, 'Search tools and commands'), h('kbd', {}, 'Ctrl+Shift+P'));
    // Typing on the focused field starts the search with that letter.
    search.addEventListener('keydown', (e) => { if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') { e.preventDefault(); openPalette(this, e.key); } });
    $('#topbar .tb-center').append(search);
    $('#top-actions').append(ibtn('open', 'Open (Ctrl+O)', () => this.run('open')), ibtn('gear', 'Preferences (Ctrl+K)', () => this.run('preferences')));
    dp.onWindowState?.((s) => this.applyWindowState(s));
    dp.windowState?.().then((s) => this.applyWindowState(s)).catch(() => {});
    new ResizeObserver(() => this.fitTitlebar()).observe($('#topbar'));
  }
  /** Opens the menu below the ☰ button (the same menu as the menu bar, with all shortcuts). */
  openMenu() {
    if (!this.menuBtn || document.querySelector('.scrim')) return;
    const r = this.menuBtn.getBoundingClientRect();
    dp.menu(r.left, r.bottom + 2).catch(() => {});
  }
  /** Windows: Alt on its own or F10 opens the menu, as the menu bar did. */
  bindMenuKeys() {
    let alt = false;
    document.addEventListener('keydown', (e) => {
      alt = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.repeat;
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); this.openMenu(); }
    }, true);
    document.addEventListener('keyup', (e) => { if (e.key === 'Alt' && alt) { alt = false; e.preventDefault(); this.openMenu(); } }, true);
    document.addEventListener('pointerdown', () => { alt = false; }, true);
    window.addEventListener('blur', () => { alt = false; });
  }
  applyWindowState(s) { document.body.classList.toggle('win-fullscreen', !!s?.fullscreen); }
  /**
   * The search field stays in the middle of the window as long as the tabs fit to the left of it. More tabs push it
   * to the right, then it becomes narrower (down to 180 px); only after that do the tabs become narrower.
   */
  fitTitlebar() {
    const bar = $('#topbar'); const tabs = $('#tabs'); const center = $('#topbar .tb-center');
    if (!bar || !tabs || !center || !bar.clientWidth) return;
    const cs = getComputedStyle(bar);
    const W = bar.clientWidth; const padL = parseFloat(cs.paddingLeft); const padR = parseFloat(cs.paddingRight);
    const lead = [...tabs.parentElement.children].filter((c) => c !== tabs).reduce((w, c) => w + c.offsetWidth + 2, 0);
    let need = 0;
    for (const t of tabs.children) {
      const name = t.querySelector('.name');
      need += Math.min(220, t.offsetWidth + (name ? name.scrollWidth - name.clientWidth : 0)) + 2;
    }
    const from = padL + lead + need + 12; const to = W - padR - $('#topbar .tb-right').offsetWidth - 12;
    let w = 400; let x = (W - w) / 2;
    if (x < from) x = from;
    if (x + w > to) w = Math.max(180, to - x);
    if (x + w > to) x = to - w;
    bar.style.setProperty('--search-x', `${Math.round(x)}px`);
    bar.style.setProperty('--search-w', `${Math.round(w)}px`);
    bar.style.setProperty('--tabs-max', `${Math.max(0, Math.round(x - 12 - padL - lead))}px`);
    center.classList.toggle('narrow', w < 300);
  }
  buildDocToolbar() {
    const gb = (id, label, fn) => h('button', { class: 'gb', type: 'button', data: { g: id }, onclick: fn }, label);
    const bar = $('#doc-toolbar');
    bar.append(
      ibtn('sidebar', 'Show/hide tools pane (Shift+F4)', () => this.run('toggle-left')),
      gb('all', 'All tools', () => { this.tools.closeGroup(); $('#left-panel').classList.remove('collapsed'); }),
      gb('edit', 'Edit', () => this.tools.openGroup('edit')), gb('convert', 'Convert', () => this.tools.openGroup('convert')), gb('fillsign', 'E-Sign', () => this.tools.openGroup('fillsign')),
      h('span', { class: 'spacer' }),
      this.undoBtn = ibtn('undo', 'Undo (Ctrl+Z)', () => this.run('undo')), this.redoBtn = ibtn('redo', 'Redo (Ctrl+Y)', () => this.run('redo')),
      h('span', { class: 'sep' }),
      ibtn('save', 'Save (Ctrl+S)', () => this.run('save')), ibtn('print', 'Print (Ctrl+P)', () => this.run('print')), ibtn('search', 'Find (Ctrl+F)', () => this.run('find')), ibtn('info', 'Properties (Ctrl+D)', () => this.run('properties')),
    );
  }
  syncToolbar() {
    const id = this.tools.group?.id;
    $$('#doc-toolbar .gb').forEach((b) => b.classList.toggle('active', b.dataset.g === (id || 'all')));
    this.undoBtn.disabled = !this.doc?.undoStack.length; this.redoBtn.disabled = !this.doc?.redoStack.length;
  }
  buildQuick() {
    const Q = [['select', 'arrow', 'Select (V)'], ['hand', 'hand', 'Hand (H)'], ['zoom', 'zoom', 'Marquee zoom (Z)'], null, ['note', 'comment', 'Sticky note (S)'], ['highlight', 'highlight', 'Highlight (U)'], ['ink', 'draw', 'Pencil (N)'], ['freetext', 'textbox', 'Text box (X)'], ['fillsign', 'sign', 'Fill and sign'], ['snapshot', 'snapshot', 'Snapshot']];
    $('#quick-tools').append(...Q.map((q) => {
      if (!q) return h('div', { style: { height: '1px', background: 'var(--line)', margin: '2px 4px' } });
      const [t, ic, title] = q;
      return h('button', { class: 'ib', type: 'button', title, data: { quick: t }, onclick: () => { if (t === 'fillsign') this.tools.openGroup('fillsign'); else this.tools.selectTool(t); } }, icon(ic));
    }));
    this.syncQuick();
  }
  syncQuick() { $$('#quick-tools .ib').forEach((b) => b.classList.toggle('active', b.dataset.quick === this.overlay.tool)); }
  buildPageControls() {
    this.pageInput = h('input', { type: 'text', 'aria-label': 'Page', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.gotoLabel(this.pageInput.value); this.pageInput.blur(); } }, onfocus: (e) => e.target.select() });
    this.pageOf = h('span', { class: 'of' });
    this.zoomSel = h('select', { title: 'Zoom', onchange: (e) => { const v = e.target.value; this.viewer.setZoom(isNaN(+v) ? v : +v); } }, [['width', 'Width'], ['page', 'Fit page'], ['height', 'Height'], ['actual', '100 %'], ['0.5', '50 %'], ['0.75', '75 %'], ['1.25', '125 %'], ['1.5', '150 %'], ['2', '200 %'], ['3', '300 %'], ['4', '400 %']].map(([v, l]) => h('option', { value: v }, l)));
    this.zoomLabel = h('span', { class: 'of' });
    $('#page-controls').append(ibtn('chevU', 'Previous page', () => this.viewer.prev()), this.pageInput, this.pageOf, ibtn('chevD', 'Next page', () => this.viewer.next()), h('span', { class: 'sep' }), ibtn('minus', 'Zoom out', () => this.viewer.zoomStep(-1)), this.zoomLabel, ibtn('plus', 'Zoom in', () => this.viewer.zoomStep(1)), this.zoomSel, ibtn('rotR', 'Rotate view', () => this.viewer.rotateView(90)));
  }
  gotoLabel(v) {
    const idx = this.doc.pageLabels ? this.doc.pageLabels.indexOf(v) : -1;
    if (idx >= 0) this.viewer.goto(idx); else if (/^\d+$/.test(v) && +v >= 1 && +v <= this.doc.numPages) this.viewer.goto(+v - 1); else { toast('This page does not exist.'); this.onPage(this.viewer.current); }
  }
  onPage(i) {
    if (!this.doc) return;
    if (document.activeElement !== this.pageInput) this.pageInput.value = this.doc.label(i);
    this.pageOf.textContent = `(${i + 1} of ${this.doc.numPages})`;
    this.panels.markCurrentThumb(i);
    if (this.lastPage !== undefined && this.lastPage !== i) this.scripting.pageChanged(this.lastPage, i);
    this.lastPage = i;
  }
  onZoom() {
    this.zoomLabel.textContent = `${Math.round(this.viewer.scale * 100)} %`;
    const z = String(this.viewer.zoom);
    // Custom zoom (e.g. via mouse wheel) appears as its own entry so the field is never empty.
    let custom = this.zoomSel.querySelector('option[data-custom]');
    if ([...this.zoomSel.options].some((o) => o.value === z && !o.dataset.custom)) { custom?.remove(); this.zoomSel.value = z; }
    else {
      if (!custom) { custom = h('option', { data: { custom: '1' } }); this.zoomSel.prepend(custom); }
      custom.value = z; custom.textContent = `${Math.round(this.viewer.scale * 100)} %`;
      this.zoomSel.value = z;
    }
    this.drawRulers();
  }

  renderTabs() {
    const tab = (id, label, ic, fn) => h('button', { class: `tab ${this.view === id ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(this.view === id), data: { view: id }, onclick: fn }, icon(ic), h('span', { class: 'name' }, label));
    $('#tabs').replaceChildren(
      tab('home', 'Home', 'home', () => this.showHome()),
      tab('tools', 'All tools', 'tools', () => this.showTools()),
      ...this.docs.map((d) => {
        const on = this.view === 'doc' && d === this.doc;
        return h('button', { class: `tab ${on ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(on), title: d.path || d.name, data: { doc: d.id }, onclick: () => this.activate(d), onauxclick: (e) => { if (e.button === 1) this.closeDoc(d); }, oncontextmenu: (e) => { e.preventDefault(); this.tabMenu(e, d); } },
          icon('file'), h('span', { class: 'name' }, d.name), d.dirty ? h('span', { class: 'dirty', title: 'Not saved' }) : null,
          h('span', { class: 'x', role: 'button', title: 'Close', onclick: (e) => { e.stopPropagation(); this.closeDoc(d); } }, icon('x')));
      }),
    );
    dp.setTitle(this.view === 'doc' && this.doc ? `${this.doc.dirty ? '*' : ''}${this.doc.name}` : '');
    this.fitTitlebar();
    $('#tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  /** Closes floating windows that belong to a position in the document (note, mini toolbar). */
  closeFloats() { document.querySelectorAll('.note-pop,.mini').forEach((n) => n.remove()); }
  setView(v) { if (v !== 'doc') this.closeFloats(); this.view = v; $('#view-home').hidden = v !== 'home'; $('#view-tools').hidden = v !== 'tools'; $('#view-doc').hidden = v !== 'doc'; this.renderTabs(); }
  showHome() { this.setView('home'); this.renderHome(); }
  showTools() { this.setView('tools'); }
  showDocView() { this.setView('doc'); }

  /**
   * Home page: a large area to drop or open a PDF, the recent files as pictures of their first page (the full path
   * only as a tooltip) and colored tiles of the main tools.
   */
  async renderHome() {
    const recent = await dp.recentGet();
    const open = () => this.run('open');
    const drop = h('div', { class: 'home-hero drop-zone', id: 'home-drop', role: 'button', tabindex: '0', 'aria-label': 'Drop a PDF here or open one',
      onclick: (e) => { if (!e.target.closest('button')) open(); }, onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } } },
    h('img', { class: 'logo', src: 'assets/logo.svg', alt: 'DocPilot' }),
    h('span', { class: 'dz-ic' }, icon('drop')),
    h('h1', {}, 'Drop a PDF here or open one'),
    h('p', {}, 'View, edit, comment on and sign PDFs. Everything stays on your computer.'),
    h('button', { class: 'btn primary', type: 'button', id: 'home-open', onclick: open }, icon('open'), 'Open file'));
    const head = (title, ...right) => h('div', { class: 'sec-head' }, h('h2', { class: 'sec' }, title), ...right);
    this.thumbTried ||= new Set();
    const cards = recent.map((r) => {
      if (r.exists && !r.thumb && !this.thumbTried.has(r.path)) { this.thumbTried.add(r.path); this.thumbLater(r.path); }
      return this.recentCard(r);
    });
    $('#view-home').replaceChildren(h('div', { class: 'home-wrap' },
      drop,
      head('Recent files', recent.length ? h('button', { class: 'link', type: 'button', onclick: () => this.run('recent-clear') }, 'Clear list') : null),
      recent.length ? h('div', { class: 'recent-grid' }, cards) : h('div', { class: 'recent-none' }, emptyState('file', 'No files opened yet', 'The files you open appear here with a picture of their first page.')),
      head('Tools', h('button', { class: 'link', type: 'button', onclick: () => this.showTools() }, 'All tools', icon('chevR'))),
      balanceGrid(h('div', { class: 'home-grid' }, HOME_TOOLS.map((id) => this.toolCard(id))))));
  }
  /** A recent file: picture of the first page, name and when it was opened; right-click for more. */
  recentCard(r) {
    const pic = h('span', { class: 'rc-pic' }, r.thumb ? h('img', { src: r.thumb, alt: '', draggable: 'false' }) : icon(r.exists ? 'file' : 'x'));
    const menu = (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Open', run: () => this.openPath(r.path), disabled: !r.exists },
        { label: 'Show in Explorer', run: () => dp.reveal(r.path), disabled: !r.exists },
        '-',
        { label: 'Remove from list', run: async () => { await dp.recentRemove(r.path); this.renderHome(); } },
      ]);
    };
    return h('button', { class: `recent-card ${r.exists ? '' : 'missing'}`, type: 'button', title: r.path, data: { path: r.path }, onclick: () => (r.exists ? this.openPath(r.path) : toast('The file was not found.', 'err')), oncontextmenu: menu },
      pic, h('span', { class: 'rc-name' }, r.name), h('span', { class: 'rc-meta' }, r.exists ? fmtDate(new Date(r.opened).toISOString()) : 'File not found'));
  }
  /** Makes the picture of a recent file's first page in the background, one file after the other. */
  thumbLater(path) {
    (this.thumbQueue ||= new Set()).add(path);
    if (this.thumbBusy) return;
    this.thumbBusy = (async () => {
      while (this.thumbQueue.size) {
        const [p] = this.thumbQueue; this.thumbQueue.delete(p);
        const url = await firstPagePicture(p);
        if (!url) continue;
        for (const c of $$('#view-home .recent-card')) if (c.dataset.path === p) c.querySelector('.rc-pic').replaceChildren(h('img', { src: url, alt: '', draggable: 'false' }));
      }
      this.thumbBusy = null;
    })();
  }
  toolCard(id) {
    const g = this.tools.groups.find((x) => x.id === id);
    return h('button', { class: 'tool-card tint', type: 'button', title: g.desc || g.label, data: { card: id }, style: { '--gc': g.color }, onclick: () => this.tools.openGroup(id) }, h('span', { class: 'tc-ic' }, icon(g.icon)), h('span', { class: 'tc-t' }, h('b', {}, g.label), h('small', {}, g.desc || '')));
  }
  renderToolsView() { $('#view-tools').replaceChildren(h('div', { class: 'home-wrap' }, h('div', { class: 'sec-head' }, h('h2', { class: 'sec' }, 'All tools')), balanceGrid(h('div', { class: 'home-grid' }, this.tools.groups.filter((g) => !g.hidden).map((g) => this.toolCard(g.id)))))); }

  // --- Documents -------------------------------------------------------------------------
  async openDialog() { const p = await dp.openDialog({ title: 'Open PDF', multi: true }); for (const x of p) await this.openPath(x); return p.length; }
  async openPath(path) {
    const existing = this.docs.find((d) => d.path && d.path.toLowerCase() === path.toLowerCase());
    if (existing) { this.activate(existing); return existing; }
    try {
      const bytes = await dp.readFile(path);
      const d = await this.addDoc(new Doc({ name: path.split(/[\\/]/).pop(), path, bytes }));
      if (d) {
        await dp.recentAdd(path);
        // Picture of the first page for the home page, if there is none for this version of the file yet.
        dp.recentGet().then((l) => { const r = l.find((x) => x.path.toLowerCase() === path.toLowerCase()); if (r?.exists && !r.thumb) this.thumbLater(path); }).catch(() => {});
      }
      return d;
    } catch (e) { this.openError(e, path); return null; }
  }
  openError(e, name) {
    if (e?.name === 'InvalidPDFException') toast(`"${name.split(/[\\/]/).pop()}" is not a valid PDF file or is damaged.`, 'err');
    else if (e?.name === 'PasswordException' || /destroy|Worker was/.test(e?.message || '')) toast('Opening cancelled.');
    else errToast(e);
  }
  async openBytes(bytes, name, o = {}) {
    try { return await this.addDoc(new Doc({ name, bytes, unsaved: o.unsaved }), o); } catch (e) { this.openError(e, name); return null; }
  }
  async addDoc(doc, o = {}) {
    await busy(`${doc.name} is opening`, () => doc.load());
    doc.on((type, data) => this.onDocEvent(doc, type, data));
    this.docs.push(doc);
    this.activate(doc);
    if (this.pendingGroup) { const g = this.pendingGroup; this.pendingGroup = null; this.tools.openGroup(g); }
    doc.scanCheck = this.checkScanned(doc, o).catch((e) => console.warn('Scan detection', e));
    // XFA forms: offer to convert them into normal pages and form fields.
    doc.pdf.getMetadata().then((m) => { doc.xfa = !!m?.info?.IsXFAPresent; if (doc.xfa && this.doc === doc) this.renderBanner(); }).catch(() => {});
    return doc;
  }
  /**
   * Detect scanned documents: notice with "Recognize text" or, depending on the preference, recognize right away.
   * PDFs that were just created from an image, the scanner or the clipboard are read immediately.
   */
  async checkScanned(doc, o = {}) {
    const s = this.settings;
    const auto = o.fromImage ? s.ocrOnCreate !== false : s.ocrOnOpen === 'auto';
    if (!o.fromImage && s.ocrOnOpen === 'never') return;
    const pages = await scannedPages(doc);
    if (!pages.length || !this.docs.includes(doc)) return;
    doc.scanned = true;
    if (auto && this.doc === doc) { await this.tools.recognizeText([...Array(doc.numPages).keys()], { quiet: true, skipCheck: !!o.fromImage }); return; }
    if (this.doc === doc) this.renderBanner();
  }
  onDocEvent(doc, type, data) {
    if (type === 'dirty') { this.renderTabs(); this.syncToolbar(); if (!doc.dirty) this.autosave?.drop(doc).catch(() => {}); }
    if (type === 'security') this.renderBanner();
    if (doc !== this.doc) return;
    if (type === 'reload') {
      this.viewer.reload(data);
      this.onPage(this.viewer.current);
      this.editor.invalidate();
      this.find.docChanged(data);
      this.fieldDetect.docChanged();
      if (this.editor.on && !data.pages) for (const n of this.viewer.nodes) this.editor.renderPage(n.i);
      if (this.organizer.open) this.organizer.render();
      if (this.panels.current && this.panels.current !== 'comments' && this.panels.current !== 'search') this.panels.refresh();
      this.panels.commentsChanged();
      if (this.tools.group?.id === 'form') this.tools.renderGroup();
      this.syncToolbar();
      this.scripting.refresh(doc).then(() => { if (this.scripting.active(doc)) this.viewer.invalidate(); }).catch((e) => console.warn('JavaScript', e));
    }
  }
  activate(doc) {
    if (this.doc && this.doc !== doc) { this.editor.disable(); this.organizer.hide(); if (this.tools.group) this.tools.closeGroup(); this.overlay.setTool('select'); this.find.close(); this.fieldDetect.cancel(); this.closeFloats(); }
    this.doc = doc;
    this.setView('doc');
    this.viewer.attach(doc);
    document.body.classList.toggle('no-copy', !!doc.noCopy);
    this.onPage(this.viewer.current); this.onZoom();
    this.renderBanner();
    // Sidebar on first display according to the preference or the setting in the document.
    if (!doc.view.panelSet) {
      doc.view.panelSet = true;
      const o = this.settings.openPanel;
      const want = o === 'auto' ? ({ UseOutlines: 'bookmarks', UseThumbs: 'thumbs', UseAttachments: 'attachments', UseOC: 'layers' }[doc.pageMode] || null) : (o === 'none' ? null : o);
      if (want) this.panels.show(want); else if (o === 'none' && this.panels.current) this.panels.hide();
    }
    if (this.panels.current) this.panels.render();
    this.scripting.attach(doc).then(() => { if (this.scripting.active(doc) && this.doc === doc) this.viewer.invalidate(); }).catch((e) => console.warn('JavaScript', e));
    this.syncToolbar();
    this.viewer.el.focus();
  }
  renderBanner() {
    const b = $('#doc-banner');
    const d = this.doc;
    const msg = !d ? null : d.signed ? ['info', 'This document is digitally signed.', 'Validate signatures', () => this.panels.show('signatures')]
      : d.restricted ? ['', 'This document is restricted by permissions.', 'Unlock', () => d.allowEdit()]
        : d.xfa ? ['info', 'This document is an XFA form. Convert it into normal pages and form fields to fill it in and save it here.', 'Convert form', () => this.tools.convertXfaDialog()]
        : d.scanned && !d.ocrOffered ? ['info', 'This document appears to be scanned. Recognize text to search, copy and edit it.', 'Recognize text', () => this.tools.recognizeText([...Array(d.numPages).keys()]), 'Not now', () => { d.ocrOffered = true; this.renderBanner(); }]
        : d.hasJS && !this.policy.allowJavaScript ? ['info', 'This document contains JavaScript. For security reasons it is not run.']
          : d.hasJS && !this.settings.jsEnabled ? ['info', 'This document contains JavaScript. JavaScript is turned off in Preferences.', 'Preferences', () => this.preferences('js')] : null;
    if (!msg) { b.hidden = true; return; }
    b.className = msg[0]; b.hidden = false;
    b.replaceChildren(...[h('span', {}, msg[1]), h('span', { class: 'spacer' }),
      msg[4] ? h('button', { class: 'btn', type: 'button', onclick: msg[5] }, msg[4]) : null,
      msg[2] ? h('button', { class: `btn${msg[4] ? ' primary' : ''}`, type: 'button', onclick: msg[3] }, msg[2]) : null].filter(Boolean));
  }
  async confirmClose(d) {
    if (!d.dirty) return true;
    if (d !== this.doc) this.activate(d);
    const c = await messageBox('Save changes?', `Do you want to save the changes to "${d.name}"?`, ['Save', 'Don\'t save', 'Cancel']);
    if (c === 2) return false;
    if (c === 0) return this.save(d);
    return true;
  }
  async closeDoc(d, force) {
    if (!force && !(await this.confirmClose(d))) return false;
    const i = this.docs.indexOf(d);
    if (i < 0) return true;
    this.docs.splice(i, 1);
    if (d.path) { this.closed = this.closed.filter((p) => p !== d.path); this.closed.push(d.path); }
    this.autosave?.drop(d).catch(() => {});
    if (this.doc === d) {
      this.editor.disable(); this.organizer.hide(); this.fieldDetect.cancel(); this.closeFloats(); if (this.tools.group) this.tools.closeGroup();
      this.viewer.doc = null; this.viewer.clear(); this.doc = null;
      if (this.docs.length) this.activate(this.docs[Math.min(i, this.docs.length - 1)]); else this.showHome();
    } else this.renderTabs();
    d.destroy();
    return true;
  }
  async requestQuit() {
    for (const d of [...this.docs]) if (!(await this.confirmClose(d))) return;
    this.settings.lastOpen = this.docs.filter((d) => d.path).map((d) => d.path);
    await this.saveSettings();
    await this.autosave?.dropAll().catch(() => {});
    await dp.closeOk();
  }
  async save(d = this.doc) {
    if (!d.path) return this.saveAs(d);
    return this.writeDoc(d, d.path);
  }
  async saveAs(d = this.doc) {
    const p = await dp.saveDialog({ title: 'Save as', defaultPath: d.suggestedPath() });
    if (!p) return false;
    return this.writeDoc(d, p);
  }
  async writeDoc(d, p) {
    this.editor.commitInput();
    if (!(await d.allowEdit())) return false;
    try {
      await busy('Saving document', () => d.saveTo(p));
      this.renderTabs();
      toast('Saved', 'ok');
      this.thumbLater(p);
      return true;
    } catch (e) { errToast(e); return false; }
  }

  // --- Commands ---------------------------------------------------------------------------
  async run(cmd, arg) {
    try { await this.exec(cmd, arg); } catch (e) { errToast(e); }
  }
  async exec(cmd, arg) {
    const noDoc = { open: () => this.openDialog(), quit: () => this.requestQuit(), preferences: () => this.preferences(), about: () => this.about(), shortcuts: () => this.shortcuts(), 'show-tools': () => this.showTools(), 'recent-clear': async () => { await dp.recentRemove(null); this.renderHome(); }, 'create-from-file': () => this.tools.createFromFile(), 'create-separate': () => this.tools.createSeparate(), 'create-scan': () => this.tools.createFromScanner(), 'create-clipboard': () => this.tools.createFromClipboard(), 'create-blank': () => this.tools.createBlank(), 'tool-combine': () => this.tools.combine(), 'tool-create-id': () => this.tools.createId(), 'tab-next': () => this.tabStep(1), 'reopen-closed': () => this.reopenClosed(), 'command-palette': () => openPalette(this), 'action-wizard': () => this.tools.openGroup('actions'), 'tab-prev': () => this.tabStep(-1), 'close-all': async () => { for (const d of [...this.docs]) if (!(await this.closeDoc(d))) return; } };
    if (noDoc[cmd]) { await noDoc[cmd](); return; }
    if (cmd === 'undo' || cmd === 'redo') {
      // The input field for blocks with columns or mixed fonts keeps its own steps.
      if (editing()) {
        const rich = this.editor.input?.rich;
        if (rich && document.activeElement === rich.host) rich.history(cmd); else document.execCommand(cmd);
        return;
      }
    }
    if (cmd === 'select-all' && editing()) {
      const a = document.activeElement;
      if (a.select) a.select(); else if (a.isContentEditable) window.getSelection().selectAllChildren(a);
      return;
    }
    if (cmd === 'delete' && editing()) return;
    const d = this.doc; const v = this.viewer;
    if (!d || this.view !== 'doc') { if (this.docs.length && d) this.setView('doc'); else { toast('Please open a document first.'); return; } }
    const T = this.tools;
    const cmds = {
      save: () => this.save(), 'save-as': () => this.saveAs(), reveal: () => this.reveal(d), revert: () => this.revert(), print: () => this.print(), properties: () => this.properties(), 'close-tab': () => this.closeDoc(d),
      export: () => T.exportAs(arg), 'export-images': () => T.exportImages(), undo: () => this.undoRedo('undo'), redo: () => this.undoRedo('redo'), delete: () => this.deleteSelected(), 'select-all': () => this.selectAllText(), deselect: () => { window.getSelection().removeAllRanges(); this.overlay.select(null); },
      find: () => this.find.open(), replace: () => this.find.open({ replace: true }), 'find-advanced': () => this.panels.show('search'), tool: () => T.selectTool(arg), 'tool-group': () => T.openGroup(arg), 'tool-edit': () => T.openGroup('edit'), 'tool-organize': () => T.openGroup('organize'), 'tool-compress': () => T.compress(), 'tool-pdfa': () => T.pdfa(), 'tool-encrypt': () => T.encryptDialog(), 'tool-digital-sign': () => T.openGroup('certs'), 'sign-setup': () => T.signSetup('signature'), panel: () => this.panels.show(arg),
      'view-rotate': () => v.rotateView(arg), 'first-page': () => v.goto(0), 'prev-page': () => v.prev(), 'next-page': () => v.next(), 'last-page': () => v.goto(d.numPages - 1), 'goto-page': () => this.gotoDialog(), 'nav-back': () => v.back(), 'nav-forward': () => v.forward(), layout: () => v.setLayout(arg), 'zoom-in': () => v.zoomStep(1), 'zoom-out': () => v.zoomStep(-1), zoom: () => v.setZoom(arg),
      'toggle-rulers': () => this.toggleRulers(), 'toggle-grid': () => this.toggleGrid(), 'toggle-right': () => (this.panels.current ? this.panels.hide() : this.panels.show('thumbs')), 'toggle-left': () => { $('#left-panel').classList.toggle('collapsed'); v.scheduleRender(); }, 'reading-mode': () => document.body.classList.toggle('reading'), fullscreen: () => this.presentation(), speak: () => this.speak(arg),
    };
    if (cmds[cmd]) await cmds[cmd](); else console.warn('Unknown command', cmd);
  }
  /** Reopens the last closed tab (Ctrl+Shift+T); files that were moved or deleted are skipped. */
  async reopenClosed() {
    while (this.closed.length) {
      const p = this.closed.pop();
      if (this.docs.some((d) => d.path && d.path.toLowerCase() === p.toLowerCase())) continue;
      if (await dp.fileStat(p)) { await this.openPath(p); return true; }
    }
    toast('There is no closed tab to reopen.');
    return false;
  }
  /** Shows the document's file in Explorer (Finder on a Mac). */
  reveal(d = this.doc) {
    if (!d?.path) { toast('This document has not been saved as a file yet.'); return; }
    dp.reveal(d.path);
  }
  tabMenu(e, d) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Show in Explorer', run: () => this.reveal(d), disabled: !d.path },
      { label: 'Reopen closed tab', run: () => this.reopenClosed(), disabled: !this.closed.length },
      '-',
      { label: 'Close', run: () => this.closeDoc(d) },
      { label: 'Close other tabs', run: async () => { for (const x of this.docs.filter((y) => y !== d)) if (!(await this.closeDoc(x))) return; } },
    ]);
  }
  tabStep(d) { if (!this.docs.length) return; const i = this.docs.indexOf(this.doc); this.activate(this.docs[(i + d + this.docs.length) % this.docs.length]); }
  async undoRedo(kind) { this.editor.commitInput(); const ok = await this.doc[kind](); if (!ok) toast(kind === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.'); this.overlay.select(null); this.syncToolbar(); }
  deleteSelected() { if (this.editor.on && this.editor.selected) this.editor.remove(); else if (this.overlay.selected) this.overlay.remove(this.overlay.selected); }
  selectAllText() {
    if (this.editor.on) return;
    const n = this.viewer.node(this.viewer.current);
    const t = n?.layers?.text;
    if (!t) return;
    const r = document.createRange(); r.selectNodeContents(t);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  async revert() {
    const c = await messageBox('Revert', 'Discard all changes since the last save?', ['Discard', 'Cancel'], { primary: 1 });
    if (c === 0) await this.doc.revert();
  }
  async gotoDialog() {
    const r = await formDialog('Go to page', [{ k: 'p', label: `Page (1-${this.doc.numPages})`, type: 'number', value: this.viewer.current + 1, min: 1, max: this.doc.numPages }]);
    if (r) this.viewer.goto(r.p - 1);
  }

  print(preset, o) { return printDocument(this, preset, o); }

  async properties() {
    const d = this.doc;
    const { info } = await d.pdf.getMetadata();
    const p0 = d.pages[this.viewer.current];
    const mm = (v) => (v / 2.834645669).toFixed(0);
    const stat = d.path ? await dp.fileStat(d.path) : null;
    const facts = h('table', { class: 'tbl' }, [
      ['File', d.path || d.name], ['Size', fmtSize(stat?.size ?? d.bytes.length)], ['PDF version', info.PDFFormatVersion], ['Pages', d.numPages], ['Page size', `${mm(p0.view[2] - p0.view[0])} x ${mm(p0.view[3] - p0.view[1])} mm`],
      ['Application', info.Creator || ''], ['PDF producer', info.Producer || ''], ['Security', d.security ? 'Password protection' : 'None'], ['Digitally signed', d.signed ? 'Yes' : 'No'], ['Form', info.IsAcroFormPresent ? 'Yes' : 'No'], ['Tagged', info.IsLinearized ? 'Linearized' : '-'],
    ].map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', {}, String(b ?? '')))));
    let fonts = [];
    try { fonts = listFonts(await loadForEdit(d.bytes)); } catch (e) { console.warn('Fonts', e); }
    const fontTable = h('details', { class: 'fonts-list', data: { fonts: String(fonts.length) } }, h('summary', {}, `Fonts (${fonts.length})`),
      fonts.length ? h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'Font'), h('th', {}, 'Type'), h('th', {}, 'Embedded')),
        fonts.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, fontKind(x.kind)), h('td', {}, x.embedded ? (x.subset ? 'Embedded subset' : 'Embedded') : 'Not embedded')))) : h('div', { class: 'empty' }, 'This document uses no fonts.'));
    const r = await formDialog('Document properties', [
      { type: 'node', node: facts }, { type: 'node', node: fontTable },
      { k: 'title', label: 'Title', value: info.Title || '' }, { k: 'author', label: 'Author', value: info.Author || '' }, { k: 'subject', label: 'Subject', value: info.Subject || '' }, { k: 'keywords', label: 'Keywords', value: info.Keywords || '' },
    ], { ok: 'Apply', wide: true });
    if (!r) return;
    if (r.title === (info.Title || '') && r.author === (info.Author || '') && r.subject === (info.Subject || '') && r.keywords === (info.Keywords || '')) return;
    await d.mutate((b) => setMetadata(b, r));
  }

  async preferences(startAt) {
    const before = this.settings;
    const r = await openPreferences(before, startAt, this.policy);
    if (!r) return;
    this.settings = this.enforcePolicy(r);
    await this.saveSettings();
    this.applySettings();
    // Turn JavaScript on or off immediately.
    if (!!before.jsEnabled !== !!r.jsEnabled && this.doc) {
      await this.scripting.detach();
      // Take over form values already typed in, so the scripts calculate with the current values.
      await this.doc.commitForms();
      await this.scripting.attach(this.doc);
      this.viewer.invalidate();
    }
    this.renderBanner();
    toast('Preferences saved', 'ok');
  }
  async about() {
    await messageBox('About DocPilot', h('div', { style: { textAlign: 'center' } }, h('img', { src: 'assets/logo.svg', alt: '', style: { height: '64px', margin: '8px 0 14px' } }), h('div', {}, `Version ${await dp.version()}`), h('p', { style: { color: 'var(--ink2)' } }, 'Includes PDF.js, pdf-lib, Tesseract OCR and node-forge under their respective open-source licenses.')));
  }
  async shortcuts() {
    const list = [['Ctrl+O', 'Open'], ['Ctrl+Shift+P', 'Search commands'], ['Ctrl+Shift+T', 'Reopen closed tab'], ['Ctrl+S', 'Save'], ['Ctrl+P', 'Print'], ['Ctrl+F', 'Find'], ['Ctrl+Shift+H', 'Find and replace'], ['Ctrl+Z / Y', 'Undo / Redo'], ['Ctrl+Plus / Minus', 'Zoom'], ['Ctrl+0 / 1 / 2', 'Page / 100% / Width'], ['V', 'Select'], ['H', 'Hand'], ['Z', 'Marquee zoom'], ['S', 'Sticky note'], ['U', 'Highlight'], ['N', 'Pencil'], ['X', 'Text box'], ['R', 'Rectangle'], ['Arrow keys, Page Up/Down', 'Navigation'], ['Del', 'Delete selection'], ['Esc', 'Cancel tool']];
    await messageBox('Keyboard shortcuts', h('table', { class: 'tbl' }, list.map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', {}, b)))));
  }

  // --- View ---------------------------------------------------------------------------
  toggleGrid() { this.grid = !this.grid; this.applyGrid(); }
  applyGrid() { const g = `${(Number(this.settings.gridSize) || 10) * 2.8346 * this.viewer.scale}px`; for (const n of this.viewer.nodes) { n.el.classList.toggle('grid', !!this.grid); n.el.style.setProperty('--grid', g); } }
  toggleRulers() {
    this.rulers = !this.rulers;
    $('#ruler-h').hidden = !this.rulers; $('#ruler-v').hidden = !this.rulers; this.viewer.el.classList.toggle('rulers', this.rulers);
    this.drawRulers();
  }
  drawRulers() {
    if (!this.rulers) return;
    // Tick marks depending on the unit: mm (every 10 mm), cm, inch, point (every 72 pt).
    const U = { mm: [28.3465, 10], cm: [28.3465, 1], in: [72, 1], pt: [72, 72] }[this.settings.units] || [28.3465, 10];
    const step = U[0] * this.viewer.scale;
    const mk = (el, horizontal, len) => { el.replaceChildren(); for (let i = 0; i * step < len; i++) { el.append(h('span', { style: { position: 'absolute', [horizontal ? 'left' : 'top']: `${i * step}px`, fontSize: '9px', color: 'var(--grey)', borderLeft: horizontal ? '1px solid var(--line)' : '', borderTop: horizontal ? '' : '1px solid var(--line)', paddingLeft: '2px', height: horizontal ? '22px' : '', width: horizontal ? '' : '22px' } }, String(i * U[1]))); } };
    mk($('#ruler-h'), true, innerWidth); mk($('#ruler-v'), false, innerHeight);
  }
  async presentation() {
    const on = await dp.fullscreen();
    document.body.classList.toggle('presenting', on);
    this.prevZoom = on ? { z: this.viewer.zoom, l: this.viewer.layout } : this.prevZoom;
    if (on) { this.viewer.setLayout('single'); setTimeout(() => this.viewer.setZoom('page'), 250); toast('Exit full screen with Esc or Ctrl+L'); }
    else if (this.prevZoom) { this.viewer.setLayout(this.prevZoom.l); this.viewer.setZoom(this.prevZoom.z); }
  }
  async speak(mode) {
    const S = window.speechSynthesis;
    if (mode === 'stop') { S.cancel(); return; }
    if (mode === 'pause') { if (S.paused) S.resume(); else S.pause(); return; }
    S.cancel();
    const pages = mode === 'doc' ? this.doc.pages.map((_, i) => i).slice(this.viewer.current) : [this.viewer.current];
    for (const p of pages) {
      const t = (await this.doc.pageText(p)).items.map((x) => x.str).join(' ').trim();
      if (!t) continue;
      const voice = S.getVoices().find((v) => v.name === this.settings.speechVoice);
      for (const chunk of t.match(/[\s\S]{1,1800}(\s|$)/g) || []) { const u = new SpeechSynthesisUtterance(chunk); u.lang = voice?.lang || 'en-GB'; if (voice) u.voice = voice; u.rate = Number(this.settings.speechRate) || 1; S.speak(u); }
    }
    if (!S.pending && !S.speaking) toast('There is no text on this page to read aloud.');
  }
  applyFormHighlight() { /* via CSS class on the document */ }

  // --- Input --------------------------------------------------------------------------
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.scrim')) return;
      if (e.key === 'Escape') {
        if (document.body.classList.contains('presenting')) { this.presentation(); return; }
        if (document.body.classList.contains('reading')) { document.body.classList.remove('reading'); return; }
        if (this.overlay.tool !== 'select' && this.overlay.tool !== 'edit') { this.overlay.setTool(this.editor.on ? 'edit' : 'select'); return; }
        if (this.overlay.selected) this.overlay.select(null);
        return;
      }
      if (!this.doc || this.view !== 'doc' || editing() || inForm() || e.ctrlKey || e.altKey || e.metaKey) return;
      const v = this.viewer;
      const single = /single|^double$/.test(v.layout);
      const page = v.el.clientHeight * 0.9;
      const map = {
        Delete: () => this.deleteSelected(), Backspace: () => this.deleteSelected(), Home: () => v.goto(0), End: () => v.goto(this.doc.numPages - 1),
        ArrowRight: () => v.next(), ArrowLeft: () => v.prev(),
        PageDown: () => (single ? v.next() : v.el.scrollBy(0, page)), PageUp: () => (single ? v.prev() : v.el.scrollBy(0, -page)),
        ArrowDown: () => (single ? v.next() : v.el.scrollBy(0, 60)), ArrowUp: () => (single ? v.prev() : v.el.scrollBy(0, -60)),
        ' ': () => v.el.scrollBy(0, e.shiftKey ? -page : page),
      };
      if (map[e.key]) { e.preventDefault(); map[e.key](); return; }
      const tools = { v: 'select', h: 'hand', z: 'zoom', s: 'note', u: 'highlight', n: 'ink', x: 'freetext', r: 'rect', o: 'ellipse', l: 'line', k: 'place-stamp' };
      const t = tools[e.key.toLowerCase()];
      if (t === 'place-stamp') { this.tools.openGroup('stamp'); return; }
      if (t) { this.tools.selectTool(t); }
    });
  }
  /**
   * Ctrl+V with an image on the clipboard (e.g. screenshot with Win+Shift+S): paste the image on the
   * page. In input fields, Ctrl+V stays normal text paste.
   */
  bindPaste() {
    let handled = 0;
    const run = () => { this.tools.pasteImage().then((ok) => { if (!ok) toast('There is no image on the clipboard.'); }).catch(errToast); };
    const blocked = () => !!document.querySelector('.scrim') || editing() || inForm() || this.view === 'tools';
    document.addEventListener('paste', (e) => {
      if (blocked()) return;
      const again = Date.now() - handled < 400;
      handled = Date.now();
      const types = [...(e.clipboardData?.items || [])].map((x) => x.type);
      // Only text on the clipboard: do nothing (text can be inserted with the "Add text" tool).
      if (types.length && !types.some((t) => t.startsWith('image/'))) return;
      e.preventDefault();
      if (!again) run();
    });
    // If the window reports no paste event (nothing selected), handle the key directly.
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'v' || blocked()) return;
      const at = Date.now();
      setTimeout(() => { if (handled < at) { handled = Date.now(); run(); } }, 150);
    });
  }
  bindHand() {
    const v = $('#viewer');
    v.addEventListener('pointerdown', (e) => {
      if (this.overlay.tool !== 'hand' || e.button !== 0) return;
      const sx = e.clientX; const sy = e.clientY; const l = v.scrollLeft; const t = v.scrollTop;
      document.body.classList.add('cursor-grabbing');
      const move = (m) => { v.scrollLeft = l + sx - m.clientX; v.scrollTop = t + sy - m.clientY; };
      const up = () => { document.body.classList.remove('cursor-grabbing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }
  bindDrop() {
    const stop = (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); } };
    document.addEventListener('dragover', stop);
    // While files are dragged over the window, the drop area of the home page lights up (dropping works anywhere).
    let depth = 0;
    const files = (e) => !!e.dataTransfer?.types?.includes('Files');
    const done = () => { depth = 0; document.body.classList.remove('dragging-files'); };
    document.addEventListener('dragenter', (e) => { if (files(e)) { depth++; document.body.classList.add('dragging-files'); } });
    document.addEventListener('dragleave', (e) => { if (files(e) && --depth <= 0) done(); });
    document.addEventListener('drop', done, true);
    document.addEventListener('dragend', done);
    document.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        const p = dp.pathForFile ? dp.pathForFile(f) : f.path;
        if (/\.pdf$/i.test(f.name)) {
          if (p) await this.openPath(p);
          else await this.openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
        } else if (p && /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)) {
          // Dropping an image (e.g. a photographed invoice): becomes a PDF, and the text is recognized.
          try {
            const bytes = await busy('Creating PDF', () => fileToPdf(p));
            await this.openBytes(bytes, `${f.name.replace(/\.[^.]+$/, '')}.pdf`, { unsaved: true, fromImage: true });
          } catch (err) { errToast(err); }
        }
      }
    });
  }
}

// Before the first paint: the main window has already set the appearance from Preferences
// (light, dark or same as Windows), so the interface starts in the right colors right away.
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
new App().init().catch((e) => { console.error(e); document.body.append(h('pre', { style: { padding: '20px', color: '#c00' } }, String(e.stack || e))); });

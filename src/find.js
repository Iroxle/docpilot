// Search in the document with result list and highlighting on the page.
import { h, $, ibtn, debounce } from './util.js';

const norm = (s) => s.normalize('NFC');

export class Find {
  constructor(app) { this.app = app; this.query = ''; this.matches = []; this.cur = -1; this.opts = { caseSensitive: false, wholeWord: false }; this.bar = $('#findbar'); this.buildBar(); }
  get doc() { return this.app.doc; }

  buildBar() {
    this.input = h('input', { type: 'text', placeholder: 'Search in document', spellcheck: 'false', 'aria-label': 'Search term' });
    this.count = h('span', { class: 'cnt' });
    const run = debounce(() => this.search(this.input.value), 180);
    this.input.addEventListener('input', run);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') this.close();
    });
    const chk = (label, k) => h('label', {}, h('input', { type: 'checkbox', data: { opt: k }, onchange: (e) => { this.opts[k] = e.target.checked; this.search(this.input.value, true); } }), label);
    this.bar.append(this.input, this.count, ibtn('chevU', 'Previous result', () => this.step(-1)), ibtn('chevD', 'Next result', () => this.step(1)), chk('Gross/Klein', 'caseSensitive'), chk('Whole word', 'wholeWord'), ibtn('x', 'Close', () => this.close()));
  }
  /** Default values from Preferences. */
  setDefaults(o) {
    Object.assign(this.opts, o);
    this.bar.querySelectorAll('input[data-opt]').forEach((c) => { c.checked = !!this.opts[c.dataset.opt]; });
  }
  open() { this.bar.hidden = false; this.input.focus(); this.input.select(); }
  close() { this.bar.hidden = true; this.clear(); }
  clear() { this.query = ''; this.matches = []; this.cur = -1; this.count.textContent = ''; this.paintAll(); }

  /** Returns the page text together with the mapping character -> text item. */
  async pageIndex(i) {
    const content = await this.doc.pageText(i);
    let text = ''; const map = [];
    content.items.forEach((it, idx) => {
      if (it.str === undefined) return;
      const s = norm(it.str);
      for (let k = 0; k < s.length; k++) map.push({ item: idx, off: k });
      text += s;
      if (it.hasEOL) { text += ' '; map.push({ item: idx, off: -1 }); }
    });
    return { text, map };
  }

  async collect(q, opts) {
    const out = [];
    if (!q) return out;
    const esc = norm(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc, `gu${opts.caseSensitive ? '' : 'i'}`);
    for (let i = 0; i < this.doc.numPages; i++) {
      const { text, map } = await this.pageIndex(i);
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        out.push({ page: i, start: m.index, end: m.index + m[0].length, map, text });
      }
    }
    return out;
  }

  async search(q, force) {
    if (q === this.query && !force) return;
    this.query = q;
    const token = (this.token = {});
    const found = await this.collect(q, this.opts);
    if (token !== this.token) return;
    this.matches = found; this.cur = -1;
    this.paintAll();
    if (found.length) { const c = this.app.viewer.current; const n = found.findIndex((m) => m.page >= c); this.setCur(n < 0 ? 0 : n); }
    this.updateCount();
  }
  updateCount() { this.count.textContent = this.query ? (this.matches.length ? `${this.cur + 1} of ${this.matches.length}` : 'No results') : ''; }
  step(d) {
    if (!this.matches.length) { this.search(this.input.value, true); return; }
    this.setCur((this.cur + d + this.matches.length) % this.matches.length);
  }
  setCur(n) {
    const prev = this.matches[this.cur]?.page;
    this.cur = n;
    const m = this.matches[n];
    if (prev !== undefined && prev !== m.page) this.paintPage(prev);
    this.updateCount();
    this.scrollTo(m);
  }
  scrollTo(m) {
    const v = this.app.viewer;
    const content = this.doc.textCache.get(m.page);
    const it = content?.items[m.map[m.start]?.item];
    if (it) { v.goto(m.page, { pdfY: it.transform[5] + 40, noHistory: true }); } else v.goto(m.page, { noHistory: true });
    setTimeout(() => this.paintPage(m.page), 60);
  }

  paintAll() { for (const n of this.app.viewer.nodes) if (n.layers) this.paintPage(n.i); }
  paintPage(i) {
    const n = this.app.viewer.node(i);
    if (!n?.layers) return;
    const hl = n.layers.hl;
    hl.replaceChildren();
    const list = this.matches.filter((m) => m.page === i);
    if (!list.length || !n.textLayer) return;
    const divs = n.textLayer.textDivs; const strs = n.textLayer.textContentItemsStr;
    const base = n.el.getBoundingClientRect();
    // The text layer does not skip items; the index of the elements matches the text items with content.
    const content = this.doc.textCache.get(i);
    const itemToDiv = new Map();
    let d = 0;
    content.items.forEach((it, idx) => { if (it.str !== undefined) { itemToDiv.set(idx, d); d++; } });
    void strs;
    for (const m of list) {
      const isCur = this.matches[this.cur] === m;
      const byItem = new Map();
      for (let c = m.start; c < m.end; c++) {
        const e = m.map[c];
        if (!e || e.off < 0) continue;
        const r = byItem.get(e.item) || { a: e.off, b: e.off };
        r.b = e.off; byItem.set(e.item, r);
      }
      for (const [item, r] of byItem) {
        const div = divs[itemToDiv.get(item)];
        const node = div?.firstChild;
        if (!node || node.nodeType !== 3) continue;
        const range = document.createRange();
        range.setStart(node, Math.min(r.a, node.length));
        range.setEnd(node, Math.min(r.b + 1, node.length));
        for (const c of range.getClientRects()) {
          hl.append(h('i', { class: isCur ? 'cur' : '', style: { left: `${c.left - base.left}px`, top: `${c.top - base.top}px`, width: `${c.width}px`, height: `${c.height}px` } }));
        }
      }
    }
  }
}

// Search in the document with result list and highlighting on the page.
import { h, $, ibtn, debounce, messageBox, toast, errToast, busy } from './util.js';
import { searchRegex, locator } from './pdf/replace.js';
import { newMark } from './editor.js';

const norm = (s) => s.normalize('NFC');
// Why a result cannot be replaced (see locator in pdf/replace.js).
const WHY = { 'no-text': 'text is rotated or not editable', multiple: 'text spans several paragraphs or cells', different: 'text is stored differently in the paragraph' };
/** Short excerpt around a result for messages. */
const snippet = (m) => `${m.start > 12 ? '…' : ''}${m.text.slice(Math.max(0, m.start - 12), Math.min(m.text.length, m.end + 12)).replace(/\s+/g, ' ').trim()}${m.end + 12 < m.text.length ? '…' : ''}`;

export class Find {
  constructor(app) { this.app = app; this.query = ''; this.matches = []; this.cur = -1; this.opts = { caseSensitive: false, wholeWord: false }; this.done = new Map(); this.bar = $('#findbar'); this.buildBar(); }
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
    // Second row: replace. Text is really replaced in the page content, the same way as in "Edit PDF".
    this.repInput = h('input', { type: 'text', placeholder: 'Replace with', spellcheck: 'false', 'aria-label': 'Replace with' });
    this.repInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.replaceOne(); }
      if (e.key === 'Escape') this.close();
    });
    this.repRow = h('div', { class: 'row rep', hidden: true }, this.repInput,
      h('button', { class: 'btn', type: 'button', data: { act: 'replace' }, title: 'Replace the highlighted result', onclick: () => this.replaceOne() }, 'Replace'),
      h('button', { class: 'btn', type: 'button', data: { act: 'replace-all' }, title: 'Replace all results in the document', onclick: () => this.replaceAll() }, 'Replace all'));
    this.repToggle = ibtn('replace', 'Show or hide replace', () => this.showReplace(this.repRow.hidden), { data: { act: 'toggle-replace' } });
    this.bar.append(h('div', { class: 'row' }, this.repToggle, this.input, this.count, ibtn('chevU', 'Previous result', () => this.step(-1)), ibtn('chevD', 'Next result', () => this.step(1)), chk('Match case', 'caseSensitive'), chk('Whole word', 'wholeWord'), ibtn('x', 'Close', () => this.close())), this.repRow);
  }
  showReplace(on) { this.repRow.hidden = !on; this.repToggle.classList.toggle('on', on); if (on) this.repInput.focus(); }
  /** Default values from Preferences. */
  setDefaults(o) {
    Object.assign(this.opts, o);
    this.bar.querySelectorAll('input[data-opt]').forEach((c) => { c.checked = !!this.opts[c.dataset.opt]; });
  }
  open(o = {}) { this.bar.hidden = false; if (o.replace) this.showReplace(true); this.input.focus(); this.input.select(); }
  close() { this.bar.hidden = true; this.clear(); }
  clear() { this.query = ''; this.matches = []; this.cur = -1; this.count.textContent = ''; this.done.clear(); this.paintAll(); }

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
    const re = searchRegex(q, opts);
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
    this.query = q; this.done.clear();
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

  // --- Replace ---------------------------------------------------------------------------

  /**
   * Maps results to the editor's text blocks. Per result { m, i, o, a, b } (page, block, range in the block's
   * text) or { m, reason } if the position cannot be replaced.
   */
  async locate(matches) {
    await this.app.fontsReady;
    const re = searchRegex(this.query, this.opts);
    const pages = new Map(); const out = [];
    for (const m of matches) {
      if (!pages.has(m.page)) { const blocks = await this.app.editor.objects(m.page); pages.set(m.page, { blocks, at: locator(blocks, this.opts) }); }
      const { blocks, at } = pages.get(m.page);
      const r = at(m.text, m.map, m.start, m.end, re);
      out.push(r.reason ? { m, reason: r.reason } : { m, i: m.page, o: blocks[r.block], a: r.a, b: r.b });
    }
    return out;
  }
  /** Searches again after a change. Positions that were already replaced in this search no longer count as results. */
  async research(n) {
    const token = (this.token = {});
    let found = await this.collect(this.query, this.opts);
    if (found.length && this.done.size) {
      const loc = await this.locate(found);
      found = found.filter((m, k) => { const l = loc[k]; const r = l.o?.mark ? this.done.get(l.o.mark) : null; return !(r && r.some((x) => l.a < x.b && l.b > x.a)); });
    }
    if (token !== this.token) return;
    this.matches = found; this.cur = -1;
    this.paintAll();
    if (found.length) this.setCur(Math.max(0, Math.min(n, found.length - 1)));
    this.updateCount();
  }
  /** The document was changed (edit, undo): search again so highlighting and counter are right. */
  docChanged(data) {
    if (this.own || data?.annotOnly || this.bar.hidden || !this.query) return;
    this.done.clear();
    this.research(this.cur).catch((e) => console.warn('Search', e));
  }
  async ready() {
    const q = this.input.value;
    if (!q.trim()) { this.input.focus(); return false; }
    if (q !== this.query || !this.matches.length) await this.search(q, true);
    if (!this.matches.length) { toast('No results'); return false; }
    return true;
  }

  /** Replaces the highlighted result and jumps to the next one. */
  async replaceOne() {
    if (this.own || !(await this.ready())) return;
    if (this.cur < 0) this.setCur(0);
    const n = this.cur; const m = this.matches[n];
    // Protected or signed documents: the same confirmation as for any other change.
    if (!(await this.doc.allowEdit())) return;
    const [l] = await this.locate([m]);
    if (l.reason) { toast(`This result cannot be replaced: ${WHY[l.reason]}.`); this.step(1); return; }
    const text = this.repInput.value; const mark = newMark();
    const edit = { i: l.i, o: l.o, hits: [{ a: l.a, b: l.b }], with: text, mark };
    this.own = true;
    try {
      if (!(await this.app.editor.replaceMany([edit], { skipCheck: true }))) return;
      if (edit.covered) {
        toast('The text is in an embedded object: it was covered and set again, but it is still in the file.');
        await this.research(n + 1);
        return;
      }
      // If the replacement text contains the search term, the position would otherwise be found again right away and replaced twice.
      const delta = text.length - (l.b - l.a);
      const old = (l.o.mark && this.done.get(l.o.mark)) || [];
      if (l.o.mark) this.done.delete(l.o.mark);
      this.done.set(mark, [...old.map((r) => (r.a >= l.b ? { a: r.a + delta, b: r.b + delta } : r)), { a: l.a, b: l.a + text.length }]);
      await this.research(n);
    } catch (e) { errToast(e); } finally { this.own = false; }
  }

  /** Replaces all results in one step. Shows the count first and reports afterwards what was not replaced. */
  async replaceAll() {
    if (this.own || !(await this.ready())) return;
    if (!(await this.doc.allowEdit())) return;
    const q = this.query; const text = this.repInput.value; const total = this.matches.length;
    const what = total === 1 ? '1 result' : `${total} results`;
    const c = await messageBox('Replace all', text ? `Replace ${what} for "${q}" in the whole document with "${text}"?` : `Remove ${what} for "${q}" from the whole document? The "Replace with" field is empty.`, ['Replace all', 'Cancel'], { primary: 0 });
    if (c !== 0) return;
    this.own = true;
    try {
      const loc = await this.locate(this.matches);
      const groups = new Map(); const failed = [];
      for (const l of loc) {
        if (l.reason) { failed.push(l); continue; }
        const g = groups.get(l.o) || { i: l.i, o: l.o, hits: [], with: text };
        // Two results at the same position of a block: replace only once.
        if (g.hits.some((x) => l.a < x.b && l.b > x.a)) { failed.push({ ...l, reason: 'different' }); continue; }
        g.hits.push({ a: l.a, b: l.b, m: l.m }); groups.set(l.o, g);
      }
      const edits = [...groups.values()];
      if (edits.length && !(await busy('Replacing', () => this.app.editor.replaceMany(edits, { skipCheck: true })))) return;
      const n = edits.reduce((s, e) => s + e.hits.length, 0);
      const covered = edits.filter((e) => e.covered).reduce((s, e) => s + e.hits.length, 0);
      // Search again instead of still showing the old results; the input stays.
      this.matches = []; this.cur = -1; this.query = ''; this.done.clear(); this.count.textContent = ''; this.paintAll();
      const lines = [n === total ? (total === 1 ? '1 result was replaced.' : `All ${what} were replaced.`) : `${n} of ${what} ${n === 1 ? 'was' : 'were'} replaced.`];
      if (covered) lines.push('', `${covered} of them ${covered === 1 ? 'is' : 'are'} in an embedded object: the old text was covered and set again, but it is still in the file.`);
      if (failed.length) {
        lines.push('', `Not replaced (${failed.length}):`);
        for (const f of failed.slice(0, 15)) lines.push(`Page ${this.doc.label(f.m.page)}: "${snippet(f.m)}" (${WHY[f.reason]})`);
        if (failed.length > 15) lines.push(`and ${failed.length - 15} more`);
      }
      lines.push('', n ? 'With "Undo" (Ctrl+Z) you can take back the replacement in one step.' : 'The document was not changed.');
      await messageBox('Replace all', lines.join('\n'));
    } catch (e) { errToast(e); } finally { this.own = false; }
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

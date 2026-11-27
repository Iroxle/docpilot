// Input field for a text block with columns or mixed fonts ("Edit PDF"). Every part of the text is shown in its own
// font, size, weight and color at its place, so the field looks exactly like the text after finishing.
//
// Model: rows [{ y, x0, cells: [{ text, x, style }] }] in page units, the lines of the block (see lineRuns and
// cellLayout). A cell with a place x starts a column there: it is pushed to the right when the text before it grows,
// as PageEditor.setRows in editor.js does when the block is set. A cell without x follows the one before it directly.
// The browser itself only types during a composition (input methods, accents typed with dead keys); everything else
// is applied to the model here, and the field is then built again from it.
import { cssColor } from './util.js';

const ZW = '\u200B';
const plain = (s) => s.split(ZW).join('');
const cmp = (a, b) => a.r - b.r || a.k - b.k || a.off - b.off;
const copyStyle = (s) => (s ? { ...s, color: s.color ? s.color.slice() : s.color } : s);
const copyRows = (rows) => rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, style: copyStyle(c.style) })) }));
const copySel = (s) => (s ? { a: { ...s.a }, b: { ...s.b } } : null);
// Length of the character before / after a position (2 for characters outside the basic plane, e.g. emoji).
const charBefore = (t, off) => (off >= 2 && /[\uDC00-\uDFFF]/.test(t[off - 1]) && /[\uD800-\uDBFF]/.test(t[off - 2]) ? 2 : 1);
const charAfter = (t, off) => (/[\uD800-\uDBFF]/.test(t[off] || '') && /[\uDC00-\uDFFF]/.test(t[off + 1] || '') ? 2 : 1);

let ruler = null;
/** Width of text in a CSS font, in pixels. */
function measure(text, font) {
  if (!text) return 0;
  ruler = ruler || document.createElement('canvas').getContext('2d');
  ruler.font = font;
  return ruler.measureText(text).width;
}

/** Same font, weight, slant, size (within 0.3 pt) and color. */
export function sameStyle(a, b) {
  if (!a || !b) return a === b;
  const ca = a.color || [0, 0, 0]; const cb = b.color || [0, 0, 0];
  return a.family === b.family && !!a.bold === !!b.bold && !!a.italic === !!b.italic && Math.abs(a.size - b.size) <= 0.3
    && ca.every((v, k) => Math.abs(v - (cb[k] ?? 0)) <= 0.1);
}

/**
 * Tidies the cells of a row: the first one starts a column; an empty cell that starts a column passes its place on to
 * the cell that follows it; other empty cells are dropped (except where one of the positions lies, e.g. the caret),
 * and a cell in the same style as the one before joins it. pos: positions { k, off } in this row, adjusted in place.
 */
export function normalizeRow(row, pos = []) {
  const c = row.cells;
  if (!c.length) c.push({ text: '', x: row.x0 ?? 0, style: null });
  if (c[0].x == null) c[0].x = row.x0 ?? 0;
  for (let k = 0; k < c.length;) {
    const cur = c[k]; const next = c[k + 1];
    if (cur.x != null && cur.text === '' && next && next.x == null) {
      next.x = cur.x; c.splice(k, 1);
      for (const p of pos) { if (p.k === k) p.off = 0; else if (p.k > k) p.k--; }
      continue;
    }
    if (k > 0 && cur.x == null) {
      if (cur.text === '' && !pos.some((p) => p.k === k)) { c.splice(k, 1); for (const p of pos) if (p.k > k) p.k--; continue; }
      if (sameStyle(c[k - 1].style, cur.style)) {
        const n = c[k - 1].text.length;
        c[k - 1].text += cur.text; c.splice(k, 1);
        for (const p of pos) { if (p.k === k) { p.k = k - 1; p.off += n; } else if (p.k > k) p.k--; }
        continue;
      }
    }
    k++;
  }
  row.x0 = c[0].x;
  return row;
}

/**
 * Runs of a line: its parts in the same style one after the other, [{ text, x, style }]. A run that starts a cell
 * (column) has its place x; the others follow the run before them directly (x null). What lies between two parts
 * (spaces) stays with the run before it, so the runs together read exactly as the line.
 */
export function lineRuns(l) {
  const runs = [];
  const firsts = new Map((l.cells || []).map((c) => [c.first, c]));
  (l.parts || []).forEach((p, k) => {
    const from = k === 0 ? 0 : Math.max(0, Math.min(l.text.length, p.at));
    const to = k + 1 < l.parts.length ? Math.max(from, Math.min(l.text.length, l.parts[k + 1].at)) : l.text.length;
    const text = l.text.slice(from, to);
    const cell = firsts.get(k);
    const prev = runs[runs.length - 1];
    if (prev && !cell && sameStyle(prev.style, p.style || null)) { prev.text += text; prev.p1 = k; return; }
    let x = cell ? cell.x0 : null;
    // Spaces at the start of the line are not part of its text: the text starts after them.
    const lead = k === 0 && p.at < 0 && p.str ? -p.at : 0;
    if (lead && x !== null) x += ((p.x1 - p.x0) * lead) / p.str.length;
    // p0, p1: the first and last part of the run.
    runs.push({ text, x, style: p.style || null, p0: k, p1: k });
  });
  if (!runs.length) runs.push({ text: l.text, x: l.x0, style: l.cells?.[0]?.style || null });
  return runs;
}

/**
 * Lines of a complex block after its text has changed: [{ y, cells: [{ text, x, style }] }] (the runs of each line,
 * see lineRuns). Unchanged lines keep their place and runs, changed lines keep the places and styles of their runs;
 * only the runs that changed are joined (in the style of the first one). New lines follow the line above, removed
 * lines close the gap. old: the block's lines, next: the new lines of text, lh: line height.
 */
export function cellLayout(old, next, lh) {
  // Each run remembers where it comes from (src: line li, parts p0 to p1, and how it was), so that setRows can copy
  // a run that stays as it was exactly instead of setting it again.
  const tagged = (l) => {
    const li = old.indexOf(l);
    return lineRuns(l).map(({ p0, p1, ...r }) => (p0 === undefined ? r : { ...r, src: { li, p0, p1, text: r.text, x: r.x, style: r.style } }));
  };
  const cellsOf = (l) => tagged(l);
  const changed = (l, s) => {
    const t = l.text; const runs = tagged(l);
    let p = 0; while (p < t.length && p < s.length && t[p] === s[p]) p++;
    let q = 0; while (q < t.length - p && q < s.length - p && t[t.length - 1 - q] === s[s.length - 1 - q]) q++;
    const a = p; const b = t.length - q;
    const starts = []; let pos = 0;
    for (const r of runs) { starts.push(pos); pos += r.text.length; }
    let first = 0; starts.forEach((st, k) => { if (st <= a) first = k; });
    let last = first; starts.forEach((st, k) => { if (k > first && st < b) last = k; });
    const E = starts[last] + runs[last].text.length;
    const out = [];
    runs.forEach((r, k) => {
      if (k < first || k > last) out.push({ ...r });
      else if (k === first) { const m = { ...r, text: s.slice(starts[first], E + s.length - t.length) }; delete m.src; out.push(m); }
    });
    return out;
  };
  // Pair old and new lines: equal lines as anchors (longest common subsequence), the others in order between them.
  const n = old.length; const m = next.length;
  const steps = [];
  if (n === m) for (let k = 0; k < n; k++) steps.push({ a: k, b: k });
  else {
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) L[a][b] = old[a].text === next[b] ? L[a + 1][b + 1] + 1 : Math.max(L[a + 1][b], L[a][b + 1]);
    const anchors = []; let a = 0; let b = 0;
    while (a < n && b < m) { if (old[a].text === next[b]) { anchors.push([a, b]); a++; b++; } else if (L[a + 1][b] >= L[a][b + 1]) a++; else b++; }
    let pa = 0; let pb = 0;
    for (const [ea, eb] of [...anchors, [n, m]]) {
      const k = Math.min(ea - pa, eb - pb);
      for (let j = 0; j < k; j++) steps.push({ a: pa + j, b: pb + j });
      for (let j = k; j < eb - pb; j++) steps.push({ b: pb + j });
      for (let j = k; j < ea - pa; j++) steps.push({ a: pa + j });
      if (ea < n) steps.push({ a: ea, b: eb });
      pa = ea + 1; pb = eb + 1;
    }
  }
  const rows = []; let off = 0; let prev = null; let ref = old[0];
  for (const s of steps) {
    if (s.b === undefined) { off += lh; continue; }
    if (s.a === undefined) {
      const y = prev ? prev.y - lh : old[0].y + off;
      const c0 = ref.cells[0];
      rows.push(prev = { y, cells: [{ text: next[s.b], x: c0 ? c0.x0 : ref.x0, style: c0?.style }] });
      off -= lh;
      continue;
    }
    const l = old[s.a]; ref = l;
    rows.push(prev = { y: l.y + off, cells: l.text === next[s.b] ? cellsOf(l) : l.cells.length ? changed(l, next[s.b]) : [{ text: next[s.b], x: l.x0, style: null }] });
  }
  return rows;
}

export class RichInput {
  /**
   * o: { rows, x0, top, scale, lineHeight, fallback, fontCss(style), layoutText(text) → rows, minWidth, minHeight,
   *      onLayout({ width, height, top }), onChange(), onStyle(), onFormat('bold' | 'italic') }
   * x0/top: left edge and top of the block in page units; minWidth/minHeight: its size on screen in pixels (the
   * field covers at least the block); fallback: style of cells without one. onLayout places the frame: top is where
   * the field starts relative to the top of the block.
   */
  constructor(o) {
    this.o = o;
    this.lh = o.lineHeight;
    this.rows = this.prepare(o.rows);
    this.initial = this.key();
    this.undoStack = []; this.redoStack = [];
    this.geo = [];
    const host = document.createElement('div');
    host.className = 'eb-input eb-rich';
    host.contentEditable = 'true';
    host.spellcheck = true;
    host.setAttribute('role', 'textbox'); host.setAttribute('aria-multiline', 'true');
    this.host = host;
    // Like the plain input field: value reads and sets the text (lines separated by \n).
    Object.defineProperty(host, 'value', { configurable: true, get: () => this.text(), set: (t) => this.setText(String(t)) });
    host.addEventListener('beforeinput', (e) => this.beforeInput(e));
    host.addEventListener('input', () => this.syncFromDom(!this.composing));
    host.addEventListener('compositionstart', () => { this.snapshot('type'); this.composing = true; });
    host.addEventListener('compositionend', () => { this.composing = false; setTimeout(() => { if (!this.composing) this.syncFromDom(true); }, 0); });
    host.addEventListener('keydown', (e) => this.keyDown(e));
    host.addEventListener('mousedown', () => { this.goalX = null; });
    host.addEventListener('copy', (e) => this.copy(e, false));
    host.addEventListener('cut', (e) => this.copy(e, true));
    host.addEventListener('paste', (e) => {
      e.preventDefault();
      const s = this.selection();
      if (s) this.edit('paste', () => this.replace(s, e.clipboardData?.getData('text/plain') || ''));
    });
    host.addEventListener('dragstart', (e) => e.preventDefault());
    host.addEventListener('drop', (e) => e.preventDefault());
    this.onSel = () => this.selectionChanged();
    document.addEventListener('selectionchange', this.onSel);
    this.render();
  }

  dispose() { document.removeEventListener('selectionchange', this.onSel); }

  prepare(rows) {
    const out = copyRows(rows);
    for (const r of out) { r.x0 = r.x0 ?? r.cells.find((c) => c.x != null)?.x ?? this.o.x0; normalizeRow(r); }
    return out;
  }

  /** The rows to set (copies). */
  getRows() { return copyRows(this.rows); }
  /** The text, lines separated by \n. */
  text() { return this.rows.map((r) => r.cells.map((c) => c.text).join('')).join('\n'); }
  setText(t) {
    this.snapshot('set');
    this.rows = this.prepare(this.o.layoutText(t));
    this.render();
    const e = this.end();
    this.setSelection(e, e);
    this.o.onChange?.();
  }
  /** Whether anything changed: text, places or formats (spaces at line ends and empty lines at the end do not count). */
  changed() { return this.key() !== this.initial; }
  key() {
    const n = (v) => (v == null ? null : Math.round(v * 100) / 100);
    const rows = this.rows.map((r) => [n(r.y), r.cells.map((c, k) => [k === r.cells.length - 1 ? c.text.replace(/\s+$/, '') : c.text, n(c.x),
      c.style ? [c.style.family, !!c.style.bold, !!c.style.italic, n(c.style.size), (c.style.color || []).map(n)] : null])]);
    while (rows.length > 1 && rows[rows.length - 1][1].every((c) => !c[0].trim())) rows.pop();
    return JSON.stringify(rows);
  }

  end() { return this.rowEnd(this.rows.length - 1); }
  rowEnd(r) { const c = this.rows[r].cells; return { r, k: c.length - 1, off: c[c.length - 1].text.length }; }

  // --- Showing --------------------------------------------------------------------------------------------------
  render() {
    this.host.replaceChildren(...this.rows.map((row, r) => this.rowEl(row, r)));
    this.mark = null;
    this.layout();
  }

  rowEl(row, r) {
    const line = document.createElement('div');
    line.className = 'eb-line'; line.dataset.r = String(r);
    row.cells.forEach((c, k) => {
      // Before each column a gap (not editable) that moves the column to its place.
      if (k === 0 || c.x != null) {
        const g = document.createElement('span');
        g.className = 'eb-gap'; g.contentEditable = 'false';
        line.append(g);
      }
      const st = c.style || this.o.fallback;
      const s = document.createElement('span');
      s.className = c.text ? 'eb-run' : 'eb-run empty';
      s.dataset.k = String(k);
      s.style.font = this.o.fontCss(st);
      s.style.color = cssColor(st.color || [0, 0, 0]);
      // An empty cell keeps an invisible character so the caret can stand in it.
      s.append(document.createTextNode(c.text || ZW));
      line.append(s);
    });
    return line;
  }

  /**
   * Places the columns and lines like setRows: a column at its place, or further right when the text before it
   * reaches it (with a quarter of the font size in between); each line on its baseline.
   */
  layout() {
    if (!this.host.isConnected) return;
    const sc = this.o.scale;
    const lines = [...this.host.children];
    let width = 0;
    const tops = [];
    this.geo = [];
    this.rows.forEach((row, r) => {
      const line = lines[r];
      if (!line) return;
      const gaps = [...line.children].filter((e) => e.classList.contains('eb-gap'));
      let gi = 0; let cur = 0; let end = null; let gap = 0;
      const geo = [];
      row.cells.forEach((c, k) => {
        const st = c.style || this.o.fallback;
        const font = this.o.fontCss(st);
        const nextText = row.cells.slice(k + 1).find((n) => n.text);
        const follow = !!nextText && nextText.x == null;
        const t = follow ? c.text : c.text.replace(/\s+$/, '');
        const column = k === 0 || c.x != null;
        let start = cur;
        if (column) {
          const target = Math.max(((c.x ?? row.x0) - this.o.x0) * sc, end === null ? -Infinity : end + gap);
          const w = Math.max(0, target - cur);
          const g = gaps[gi++];
          if (g) g.style.width = `${w}px`;
          cur += w; start = cur;
        }
        geo.push({ start, font });
        cur += measure(c.text, font);
        if (t && !(column && !t.trim() && !follow)) { end = start + measure(t, font); gap = st.size * 0.25 * sc; }
      });
      this.geo[r] = geo;
      width = Math.max(width, cur);
      // The first gap has no height and sits on the baseline: it tells where the baseline lies in the line.
      const base = gaps[0] ? gaps[0].offsetTop : 0;
      tops[r] = (this.o.top - row.y) * sc - base;
    });
    const top = Math.min(0, ...tops.filter((v) => Number.isFinite(v)));
    let height = this.o.minHeight - top;
    lines.forEach((line, r) => {
      if (!Number.isFinite(tops[r])) return;
      line.style.top = `${tops[r] - top}px`;
      height = Math.max(height, tops[r] - top + line.offsetHeight);
    });
    width = Math.max(width + 2, this.o.minWidth);
    this.host.style.width = `${width}px`; this.host.style.height = `${height}px`;
    this.o.onLayout?.({ width, height, top });
  }

  // --- Positions: { r, k, off } = row, cell, offset in the cell's text ---------------------------------------------
  runEl(r, k) { return this.host.children[r]?.querySelector(`:scope > .eb-run[data-k="${k}"]`) || null; }

  domPos(p) {
    const t = this.runEl(p.r, p.k)?.firstChild;
    if (!t) return { node: this.host, offset: 0 };
    if (t.data === ZW) return { node: t, offset: 1 };
    return { node: t, offset: Math.max(0, Math.min(t.data.length, p.off)) };
  }

  setSelection(a, b = a) {
    const A = this.domPos(a); const B = this.domPos(b);
    const s = window.getSelection();
    try { s.setBaseAndExtent(A.node, A.offset, B.node, B.offset); } catch { return; }
    // The browser may move the caret to an equivalent place (e.g. the end of the text before an empty cell):
    // remember where, so that typing goes into the intended cell.
    this.mark = cmp(a, b) === 0 ? { node: s.anchorNode, offset: s.anchorOffset, pos: { ...a } } : null;
    this.lastSel = { a: { ...a }, b: { ...b } };
  }

  posFromDom(node, offset) {
    const host = this.host;
    if (!node || !host.contains(node) || !this.rows.length) return null;
    if (node === host) return offset >= this.rows.length ? this.end() : { r: Math.max(0, offset), k: 0, off: 0 };
    const el = node.nodeType === 1 ? node : node.parentNode;
    const run = el.closest('.eb-run');
    if (run && host.contains(run)) {
      const r = +run.parentNode.dataset.r; const k = +run.dataset.k;
      const cell = this.rows[r]?.cells[k];
      if (!cell) return null;
      let off = 0;
      if (node.nodeType === 3) {
        for (const t of run.childNodes) { if (t === node) { off += plain(t.data.slice(0, offset)).length; break; } off += plain(t.textContent).length; }
      } else if (node === run) {
        for (let j = 0; j < offset && j < run.childNodes.length; j++) off += plain(run.childNodes[j].textContent).length;
      }
      return { r, k, off: Math.max(0, Math.min(cell.text.length, off)) };
    }
    const line = el.closest('.eb-line');
    if (!line || !host.contains(line)) return null;
    const r = +line.dataset.r;
    const row = this.rows[r];
    if (!row) return null;
    // Between the parts of a line (or on a gap): right after a cell it is that cell's end, otherwise the start of
    // the next cell.
    const kids = [...line.childNodes];
    const i = node === line ? offset : kids.indexOf(el.closest('.eb-gap') || el);
    const before = kids[i - 1];
    if (before?.nodeType === 1 && before.classList.contains('eb-run')) { const k = +before.dataset.k; return { r, k, off: row.cells[k]?.text.length ?? 0 }; }
    for (let j = Math.max(0, i); j < kids.length; j++) {
      const n = kids[j];
      if (n.nodeType === 1 && n.classList.contains('eb-run')) return { r, k: +n.dataset.k, off: 0 };
    }
    return this.rowEnd(r);
  }

  selectionFromDom() {
    const s = window.getSelection();
    if (!s.rangeCount || !this.host.contains(s.anchorNode)) return null;
    const range = s.getRangeAt(0);
    let a = this.posFromDom(range.startContainer, range.startOffset);
    let b = this.posFromDom(range.endContainer, range.endOffset);
    if (!a || !b) return null;
    if (cmp(a, b) > 0) [a, b] = [b, a];
    return { a, b };
  }

  /** The selection as { a, b } (a before b). */
  selection() {
    const s = window.getSelection();
    if (this.mark && s.isCollapsed && s.anchorNode === this.mark.node && s.anchorOffset === this.mark.offset) return { a: { ...this.mark.pos }, b: { ...this.mark.pos } };
    return this.selectionFromDom();
  }

  targetRange(e) {
    const t = e.getTargetRanges?.()[0];
    if (!t) return null;
    let a = this.posFromDom(t.startContainer, t.startOffset); let b = this.posFromDom(t.endContainer, t.endOffset);
    if (!a || !b) return null;
    if (cmp(a, b) > 0) [a, b] = [b, a];
    return { a, b };
  }

  /** Puts the caret where the mouse is (e.g. where the block was double-clicked). */
  placeAt(x, y) {
    const r = document.caretRangeFromPoint?.(x, y);
    if (!r || !this.host.contains(r.startContainer)) return false;
    const p = this.posFromDom(r.startContainer, r.startOffset);
    if (!p) return false;
    this.setSelection(p, p);
    return true;
  }
  caretToEnd() { const e = this.end(); this.setSelection(e, e); }
  focus() {
    this.host.focus({ preventScroll: true });
    if (this.lastSel) this.setSelection(this.lastSel.a, this.lastSel.b);
  }

  selectionChanged() {
    if (document.activeElement !== this.host) return;
    const s = this.selection();
    if (!s) return;
    this.lastSel = copySel(s);
    const key = JSON.stringify(this.styleAt(s.a));
    if (key !== this.shown) { this.shown = key; this.o.onStyle?.(); }
  }

  /** Format at a position (that of the text before the caret, as in a word processor). */
  styleAt(p = this.lastSel?.a) {
    const fb = this.o.fallback;
    const cells = p ? this.rows[p.r]?.cells : this.rows[0]?.cells;
    if (!cells) return fb;
    if (!p) return cells[0]?.style || fb;
    const cell = p.off === 0 && p.k > 0 && cells[p.k]?.x == null ? cells[p.k - 1] : cells[p.k];
    return cell?.style || fb;
  }

  // --- Changes --------------------------------------------------------------------------------------------------
  beforeInput(e) {
    const type = e.inputType || '';
    // Input methods and accents with dead keys: the browser types; the text is read when the composition ends.
    if (/Composition/.test(type)) return;
    e.preventDefault();
    if (this.composing) return;
    if (type === 'historyUndo' || type === 'historyRedo') { this.history(type === 'historyUndo' ? 'undo' : 'redo'); return; }
    if (type === 'formatBold' || type === 'formatItalic') { this.o.onFormat?.(type === 'formatBold' ? 'bold' : 'italic'); return; }
    // Word and line deletions and spelling corrections: the range the browser determined.
    const wide = /^delete(Word|Soft|Hard|Entire)/.test(type) || type === 'insertReplacementText';
    const sel = (wide && this.targetRange(e)) || this.selection();
    if (!sel) return;
    if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromPaste' || type === 'insertFromDrop' || type === 'insertFromYank') {
      const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      this.edit(type === 'insertText' ? 'type' : 'paste', () => this.replace(sel, text));
    } else if (type === 'insertParagraph' || type === 'insertLineBreak') this.edit('enter', () => this.replace(sel, '\n'));
    else if (type.startsWith('delete')) this.edit('delete', () => this.remove(sel, type));
  }

  keyDown(e) {
    // The shortcuts of the window do not apply while typing.
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown') this.goalX = null;
    if (mod && k === 'z') { e.preventDefault(); this.history(e.shiftKey ? 'redo' : 'undo'); return; }
    if (mod && k === 'y' && !e.shiftKey) { e.preventDefault(); this.history('redo'); return; }
    if (mod && !e.shiftKey && (k === 'b' || k === 'i')) { e.preventDefault(); this.o.onFormat?.(k === 'b' ? 'bold' : 'italic'); return; }
    if (k === 'Enter' && !mod) { e.preventDefault(); const s = this.selection(); if (s) this.edit('enter', () => this.replace(s, '\n')); return; }
    if (k === 'Tab' && !mod && !e.altKey) { e.preventDefault(); this.tab(e.shiftKey ? -1 : 1); return; }
    if ((k === 'ArrowUp' || k === 'ArrowDown') && !mod && !e.altKey && !e.shiftKey) { e.preventDefault(); this.lineStep(k === 'ArrowUp' ? -1 : 1); }
  }

  /** Applies a change (fn returns the new caret), tidies the rows and shows them again. */
  edit(kind, fn) {
    this.snapshot(kind);
    let pos = fn();
    [pos] = this.tidy([pos]);
    this.render();
    this.setSelection(pos, pos);
    this.goalX = null;
    this.o.onChange?.();
  }

  /** Tidies all rows (see normalizeRow); the positions [{ r, k, off }] are adjusted and returned. */
  tidy(list) {
    const out = list.map((p) => (p ? { ...p } : p));
    this.rows.forEach((row, r) => normalizeRow(row, out.filter((p) => p && p.r === r)));
    return out;
  }

  /** After a composition (or a change the browser made itself): the text as it is now in the field. */
  syncFromDom(final) {
    const sel = final ? this.selectionFromDom() : null;
    let changed = false;
    for (const line of this.host.querySelectorAll(':scope > .eb-line')) {
      const row = this.rows[+line.dataset.r];
      if (!row) continue;
      let last = null;
      for (const n of [...line.childNodes]) {
        if (n.nodeType === 1 && n.classList.contains('eb-gap')) continue;
        if (n.nodeType === 1 && n.classList.contains('eb-run')) {
          const cell = row.cells[+n.dataset.k];
          if (cell) { const t = plain(n.textContent); if (t !== cell.text) { cell.text = t; changed = true; } last = cell; }
          continue;
        }
        // Text the browser put next to the parts joins the part before it.
        const t = plain(n.textContent || '');
        if (t) { (last || row.cells[0]).text += t; changed = true; }
      }
    }
    if (!final) { if (changed) this.layout(); return; }
    const [pos] = this.tidy([sel ? sel.a : this.end()]);
    this.render();
    this.setSelection(pos, pos);
    if (changed) this.o.onChange?.();
  }

  replace({ a, b }, text) {
    let pos = cmp(a, b) === 0 ? { ...a } : this.deleteRange(a, b);
    const parts = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n');
    parts.forEach((p, i) => {
      if (i > 0) pos = this.split(pos);
      if (p) pos = this.insertAt(pos, p);
    });
    return pos;
  }

  insertAt(p, s) {
    const cell = this.rows[p.r].cells[p.k];
    cell.text = cell.text.slice(0, p.off) + s + cell.text.slice(p.off);
    return { ...p, off: p.off + s.length };
  }

  remove({ a, b }, type) {
    if (cmp(a, b) !== 0) return this.deleteRange(a, b);
    return /Backward/.test(type) ? this.deleteBack(a) : this.deleteForward(a);
  }

  /**
   * Backspace: the character before the caret. At the start of a column the gap before it goes (the column then
   * follows the text before it, like deleting a tab); at the start of a line it joins the line above.
   */
  deleteBack(p) {
    const c = this.rows[p.r].cells;
    if (p.off > 0) {
      const cell = c[p.k]; const n = charBefore(cell.text, p.off);
      cell.text = cell.text.slice(0, p.off - n) + cell.text.slice(p.off);
      return { ...p, off: p.off - n };
    }
    for (let j = p.k; ;) {
      if (j > 0 && c[j].x != null) { c[j].x = null; return { r: p.r, k: j, off: 0 }; }
      if (j === 0) break;
      j--;
      const t = c[j].text;
      if (t.length) { const n = charBefore(t, t.length); c[j].text = t.slice(0, t.length - n); return { r: p.r, k: j, off: t.length - n }; }
    }
    return p.r > 0 ? this.joinRows(p.r - 1) : p;
  }

  /** Delete: the character after the caret, the gap before the next column, or the line break at the end. */
  deleteForward(p) {
    const c = this.rows[p.r].cells;
    const t = c[p.k].text;
    if (p.off < t.length) { const n = charAfter(t, p.off); c[p.k].text = t.slice(0, p.off) + t.slice(p.off + n); return p; }
    for (let j = p.k + 1; j < c.length; j++) {
      if (c[j].x != null) { c[j].x = null; return p; }
      const u = c[j].text;
      if (u.length) { c[j].text = u.slice(charAfter(u, 0)); return p; }
    }
    return p.r < this.rows.length - 1 ? this.joinRows(p.r) : p;
  }

  /** Joins row r+1 to the end of row r (the line break is deleted); the rows below move up. */
  joinRows(r) {
    const A = this.rows[r]; const B = this.rows[r + 1];
    const k = A.cells.length - 1;
    const pos = { r, k, off: A.cells[k].text.length };
    A.cells.push(...B.cells.map((c, i) => (i === 0 ? { ...c, x: null } : c)));
    const dy = A.y - B.y;
    this.rows.splice(r + 1, 1);
    for (let i = r + 1; i < this.rows.length; i++) this.rows[i].y += dy;
    return pos;
  }

  /** Enter: the rest of the row goes to a new row below, starting in the column of the caret; the rows below move down. */
  split(p) {
    const row = this.rows[p.r]; const c = row.cells; const cell = c[p.k];
    let col = p.k;
    while (col > 0 && c[col].x == null) col--;
    const rest = [{ ...cell, style: copyStyle(cell.style), text: cell.text.slice(p.off), x: c[col].x ?? row.x0 }, ...c.slice(p.k + 1)];
    cell.text = cell.text.slice(0, p.off);
    row.cells = c.slice(0, p.k + 1);
    const lh = this.lh;
    this.rows.splice(p.r + 1, 0, { y: row.y - lh, x0: rest[0].x, cells: rest });
    for (let i = p.r + 2; i < this.rows.length; i++) this.rows[i].y -= lh;
    return { r: p.r + 1, k: 0, off: 0 };
  }

  /** Deletes the text from a to b. Where the range crosses into another column, that column follows the text directly. */
  deleteRange(a, b) {
    if (a.r === b.r) {
      const c = this.rows[a.r].cells;
      if (a.k === b.k) { const cell = c[a.k]; cell.text = cell.text.slice(0, a.off) + cell.text.slice(b.off); return { ...a }; }
      c[a.k].text = c[a.k].text.slice(0, a.off);
      c[b.k].text = c[b.k].text.slice(b.off); c[b.k].x = null;
      c.splice(a.k + 1, b.k - a.k - 1);
      return { ...a };
    }
    const A = this.rows[a.r]; const B = this.rows[b.r];
    A.cells[a.k].text = A.cells[a.k].text.slice(0, a.off);
    const rest = B.cells.slice(b.k).map((c, i) => (i === 0 ? { ...c, text: c.text.slice(b.off), x: null } : c));
    A.cells = [...A.cells.slice(0, a.k + 1), ...rest];
    const dy = A.y - B.y;
    this.rows.splice(a.r + 1, b.r - a.r);
    for (let i = a.r + 1; i < this.rows.length; i++) this.rows[i].y += dy;
    return { ...a };
  }

  /**
   * Format: the selected text, or the whole block when nothing is selected (a new size then also scales the line
   * spacing). st: { family, size, bold, italic, color } (any of them).
   */
  restyle(st) {
    const s = copySel(this.lastSel);
    this.snapshot('style');
    const fb = this.o.fallback;
    const set = (c) => { const old = c.style || fb; c.style = { ...old, ...st, color: (st.color || old.color || [0, 0, 0]).slice() }; };
    let a; let b;
    if (!s || cmp(s.a, s.b) === 0) {
      const first = this.rows[0]?.cells[0]?.style || fb;
      if (st.size && first.size) {
        const f = st.size / first.size; const y0 = this.rows[0].y;
        for (const r of this.rows) r.y = y0 - (y0 - r.y) * f;
        this.lh *= f;
      }
      for (const r of this.rows) for (const c of r.cells) set(c);
      a = s ? s.a : this.end(); b = a;
    } else {
      ({ a, b } = s);
      // Split the cells at the ends of the selection, so that exactly the selected text changes.
      const cut = (p) => {
        const c = this.rows[p.r].cells; const cell = c[p.k];
        if (p.off <= 0 || p.off >= cell.text.length) return false;
        c.splice(p.k + 1, 0, { ...cell, style: copyStyle(cell.style), text: cell.text.slice(p.off), x: null });
        cell.text = cell.text.slice(0, p.off);
        return true;
      };
      if (cut(b)) b = { r: b.r, k: b.k + 1, off: 0 };
      const ak = a.k;
      if (cut(a)) { a = { r: a.r, k: a.k + 1, off: 0 }; if (b.r === a.r && b.k > ak) b = { ...b, k: b.k + 1 }; }
      for (let r = a.r; r <= b.r; r++) {
        this.rows[r].cells.forEach((c, k) => {
          if (r === a.r && (k < a.k || (k === a.k && a.off > 0 && a.off >= c.text.length))) return;
          if (r === b.r && (k > b.k || (k === b.k && b.off === 0 && c.text.length > 0))) return;
          set(c);
        });
      }
    }
    [a, b] = this.tidy([a, b]);
    this.render();
    this.host.focus({ preventScroll: true });
    this.setSelection(a, b);
    this.shown = null;
    this.o.onChange?.();
  }

  // --- Moving the caret -----------------------------------------------------------------------------------------
  /** Tab: to the next (Shift: previous) column, its text selected, like moving between the fields of a form. */
  tab(dir) {
    const s = this.selection();
    if (!s) return;
    const cols = [];
    this.rows.forEach((row, r) => row.cells.forEach((c, k) => { if (k === 0 || c.x != null) cols.push({ r, k }); }));
    const p = dir > 0 ? s.b : s.a;
    let idx = -1;
    cols.forEach((c, j) => { if (c.r < p.r || (c.r === p.r && c.k <= p.k)) idx = j; });
    const j = idx + dir;
    if (j < 0 || j >= cols.length) return;
    const { r, k } = cols[j];
    const cells = this.rows[r].cells;
    let e = k;
    while (e + 1 < cells.length && cells[e + 1].x == null) e++;
    this.setSelection({ r, k, off: 0 }, { r, k: e, off: cells[e].text.length });
  }

  /** Up and down: to the line above or below, at the same height of the text as far as possible. */
  lineStep(dir) {
    const s = this.selection();
    if (!s) return;
    const p = dir < 0 ? s.a : s.b;
    const x = this.goalX ?? this.xOf(p);
    const r = p.r + dir;
    const q = r < 0 ? { r: 0, k: 0, off: 0 } : r >= this.rows.length ? this.end() : this.atX(r, x);
    this.setSelection(q, q);
    this.goalX = x;
  }
  xOf(p) {
    const g = this.geo[p.r]?.[p.k];
    return g ? g.start + measure(this.rows[p.r].cells[p.k].text.slice(0, p.off), g.font) : 0;
  }
  atX(r, x) {
    let best = { r, k: 0, off: 0 }; let bd = Infinity;
    this.rows[r].cells.forEach((c, k) => {
      const g = this.geo[r]?.[k];
      if (!g) return;
      for (let off = 0; off <= c.text.length; off++) {
        const d = Math.abs(g.start + measure(c.text.slice(0, off), g.font) - x);
        if (d < bd) { bd = d; best = { r, k, off }; }
      }
    });
    return best;
  }

  // --- Clipboard and undo ---------------------------------------------------------------------------------------
  copy(e, cut) {
    const s = this.selection();
    if (!s || cmp(s.a, s.b) === 0) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', this.textBetween(s.a, s.b));
    if (cut) this.edit('delete', () => this.deleteRange(s.a, s.b));
  }
  textBetween(a, b) {
    const out = [];
    for (let r = a.r; r <= b.r; r++) {
      let line = '';
      this.rows[r].cells.forEach((c, k) => {
        if ((r === a.r && k < a.k) || (r === b.r && k > b.k)) return;
        line += c.text.slice(r === a.r && k === a.k ? a.off : 0, r === b.r && k === b.k ? b.off : c.text.length);
      });
      out.push(line);
    }
    return out.join('\n');
  }

  /** Remembers the state before a change. Typing in a row (within 1.5 s) is undone as one step. */
  snapshot(kind) {
    const now = Date.now();
    const last = this.undoStack[this.undoStack.length - 1];
    this.redoStack = [];
    if (kind === 'type' && last?.kind === 'type' && now - last.t < 1500) { last.t = now; return; }
    this.undoStack.push({ rows: copyRows(this.rows), lh: this.lh, sel: copySel(this.lastSel), kind, t: now });
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  /** Undo or redo a change in the field (kind 'undo' or 'redo'). Returns true (the field handles it). */
  history(kind) {
    const now = performance.now();
    // The same key press can arrive twice (as a key and from the menu).
    if (now - (this.lastHistory || 0) < 60) return true;
    this.lastHistory = now;
    const from = kind === 'undo' ? this.undoStack : this.redoStack;
    const to = kind === 'undo' ? this.redoStack : this.undoStack;
    const s = from.pop();
    if (!s) return true;
    to.push({ rows: copyRows(this.rows), lh: this.lh, sel: copySel(this.lastSel), kind: 'history', t: 0 });
    this.rows = s.rows; this.lh = s.lh;
    this.render();
    const e = this.end();
    const sel = s.sel && this.rows[s.sel.a.r] && this.rows[s.sel.b.r] ? s.sel : { a: e, b: e };
    this.setSelection(sel.a, sel.b);
    this.o.onChange?.();
    return true;
  }
}

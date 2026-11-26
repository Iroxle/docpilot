// "Edit PDF": change existing text and images directly on the page.
import { h, ibtn, cssColor, rgbToHex, hexToRgb, errToast, toast, $ } from './util.js';
import { loadForEdit, saveDoc, getStyledFont, drawTextBlock, textBlockBox, fillRects, sanitizeFor, gcObjects } from './pdf/ops.js';
import { blockLines, replacedText } from './pdf/replace.js';
import { PDFDocument, PDFOperator, PDFName, PDFString, rgb } from '@cantoo/pdf-lib';
import { eraseInImages, sampleColors, insertImageRows } from './scan.js';
import { interpret, removeTextInPage, removeImageInPage, moveImage, deleteImage, imageRole, subtractRect, EDIT_TAG, blockTextItems, removeTextItems, textCopyOperators } from './pdf/content.js';
import { fixUnmapped } from './pdf/glyphs.js';
import { readFont, pdfjs, RENDER_OPTS } from './document.js';
import { startDrag } from './overlay.js';
import { mapFamily, cssFamily, cssFamilyReady, wordDefault, familyInfo } from './fonts.js';
import { fontPicker } from './fontpicker.js';

export { mapFamily };

/**
 * Groups text items into lines and paragraphs. Slightly rotated text only counts if it is recognized text of a
 * skewed scanned page, or with allowTilt (export: no text should be missing there).
 * opts.merge (editor): blocks that overlap become one block (e.g. the labels and values of a table whose value
 * column is partly a paragraph of its own), as do blocks of the same editor marker, and a line that starts below a
 * column of the line above continues that block. Each line has cells: its parts separated by a wide gap (columns).
 */
export function buildBlocks(items, allowTilt = false, opts = {}) {
  const parts = items.map((t, item) => ({ t, item })).filter(({ t }) => t.str && t.str.trim()).map(({ t, item }) => {
    const [a, b, c, d, e, f] = t.transform;
    // The font height is in the vertical axis; the horizontal one also contains a compression.
    const size = Math.hypot(c, d) || Math.hypot(a, b) || t.height;
    // item: number of the text item on the page. "Replace" uses it to find the position of a search result in the block.
    // Recognized text of a skewed scanned page is written slightly rotated (it follows the line in the image). It counts
    // like horizontal text: yEnd is the height of the baseline at its right end.
    const tilted = (allowTilt || isOcrMark(t.mark)) && Math.abs(b) >= 0.01 && a > 0 && Math.abs(b) <= a * 0.27;
    return { str: t.str, item, x0: e, x1: e + t.width, y: f, yEnd: tilted ? f + (t.width * b) / Math.hypot(a, b) : f, size, level: Math.abs(b) < 0.01 || tilted, mark: t.mark || null };
  }).filter((p) => p.level);
  parts.sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const lines = [];
  for (const p of parts) {
    // Text from different text blocks of the editor (marker "mark") is never merged.
    // The comparison uses the baseline at the nearest end of the line: for straight text this is the same
    // height everywhere, for a skewed scan line it rises or falls from item to item.
    const line = lines.find((l) => l.mark === p.mark && Math.abs((p.x0 >= l.x1 - p.size ? l.yR - p.y : p.x1 <= l.x0 + p.size ? l.yL - p.yEnd : l.y - p.y)) < p.size * 0.4
      && Math.abs(l.size - p.size) < p.size * 0.35 && p.x0 - l.x1 < p.size * 2.2 && l.x0 - p.x1 < p.size * (l.skew || p.yEnd !== p.y ? 2.2 : 1));
    if (line) {
      line.parts.push(p);
      if (p.x0 < line.x0) { line.x0 = p.x0; line.yL = p.y; }
      if (p.x1 > line.x1) { line.x1 = p.x1; line.yR = p.yEnd; }
      if (p.yEnd !== p.y) line.skew = true;
    } else lines.push({ y: p.y, yL: p.y, yR: p.yEnd, skew: p.yEnd !== p.y, size: p.size, x0: p.x0, x1: p.x1, parts: [p], mark: p.mark });
  }
  // Skewed line: its height is the baseline at the left end (newly set text starts there).
  for (const l of lines) if (l.skew) l.y = l.yL;
  for (const l of lines) finishLine(l);
  lines.sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const blocks = [];
  for (const l of lines) {
    // A recognized paragraph (marker "ocr...") always stays one block: text recognition has already formed it.
    const b = isOcrMark(l.mark) ? blocks.find((c) => c.mark === l.mark) : blocks.find((c) => {
      const prev = c.lines[c.lines.length - 1];
      const gap = prev.y - l.y;
      // A line that starts below a column of the line above continues it (e.g. a value that wraps in a table).
      const aligned = Math.abs(prev.x0 - l.x0) < l.size * 1.2 || (opts.merge && prev.cells.some((cell, k) => k > 0 && Math.abs(cell.x0 - l.x0) < l.size * 0.3));
      return c.mark === l.mark && Math.abs(prev.size - l.size) < l.size * 0.12 && gap > 0 && gap < l.size * 1.65 && aligned;
    });
    if (b) b.lines.push(l); else blocks.push({ lines: [l], mark: l.mark });
  }
  if (opts.merge) mergeBlocks(blocks);
  return blocks.map((b) => {
    const size = b.lines[0].size;
    const first = b.lines[0]; const last = b.lines[b.lines.length - 1];
    const x0 = Math.min(...b.lines.map((l) => l.x0)); const x1 = Math.max(...b.lines.map((l) => l.x1));
    const top = first.y + (opts.merge ? first.size : size) * 0.92; const bottom = last.y - (opts.merge ? last.size : size) * 0.24;
    const lineHeight = b.lines.length > 1 ? (first.y - last.y) / (b.lines.length - 1) : size * 1.2;
    // Line breaks are kept so the paragraph keeps its shape while editing.
    return {
      kind: 'text', text: b.lines.map((l) => l.text).join('\n'), rect: [x0, bottom, x1, top], size, lineHeight, baseline: first.y, mark: b.mark,
      lines: b.lines.map((l) => ({
        text: l.text, x0: l.x0, x1: l.x1, y: l.y, size: l.size, cells: l.cells.map((c) => ({ ...c })),
        parts: l.parts.map((p) => ({ item: p.item, at: p.at, x0: p.x0, x1: p.x1, size: p.size })),
      })),
    };
  });
}
const isOcrMark = (m) => typeof m === 'string' && m.startsWith('ocr');

/**
 * Text of a line from its parts (a space where there is a gap), the start of each part in it (at) and the cells:
 * parts separated by a wide gap (the columns of a table, label and value) as { first, last, x0, x1, start, end }
 * (parts first to last, start/end in the text).
 */
function finishLine(l) {
  l.parts.sort((p, q) => p.x0 - q.x0);
  l.text = '';
  let last = null;
  for (const p of l.parts) {
    if (last !== null && p.x0 - last > l.size * 0.18 && !l.text.endsWith(' ') && !p.str.startsWith(' ')) l.text += ' ';
    p.at = l.text.length;
    l.text += p.str; last = p.x1;
  }
  const lead = l.text.length - l.text.trimStart().length;
  for (const p of l.parts) p.at -= lead;
  l.text = l.text.trim();
  l.cells = [];
  l.parts.forEach((p, k) => {
    const c = l.cells[l.cells.length - 1];
    if (c && p.x0 - c.x1 < l.size * 0.6) { c.last = k; c.x1 = Math.max(c.x1, p.x1); } else l.cells.push({ first: k, last: k, x0: p.x0, x1: p.x1 });
  });
  for (const c of l.cells) {
    const a = l.parts[c.first]; const z = l.parts[c.last];
    c.start = Math.max(0, a.at + a.str.length - a.str.trimStart().length);
    c.end = Math.min(l.text.length, z.at + z.str.trimEnd().length);
  }
}

/** Joins blocks of the same editor marker, and unmarked blocks that overlap (a quarter of the smaller one or more). */
function mergeBlocks(blocks) {
  const rectOf = (b) => [Math.min(...b.lines.map((l) => l.x0)), Math.min(...b.lines.map((l) => l.y - l.size * 0.24)), Math.max(...b.lines.map((l) => l.x1)), Math.max(...b.lines.map((l) => l.y + l.size * 0.92))];
  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const fits = (A, C) => {
    if (A.mark !== C.mark || isOcrMark(A.mark)) return false;
    if (A.mark) return true;
    const ra = rectOf(A); const rc = rectOf(C);
    return overlap(ra, rc) >= Math.min(area(ra), area(rc)) * 0.25;
  };
  for (let again = true; again;) {
    again = false;
    for (let a = 0; a < blocks.length && !again; a++) {
      for (let c = a + 1; c < blocks.length && !again; c++) {
        const A = blocks[a]; const C = blocks[c];
        if (!fits(A, C)) continue;
        // Lines on the same baseline become one line (label and value side by side).
        for (const l of C.lines) {
          const t = A.lines.find((m) => Math.abs(m.y - l.y) < Math.min(m.size, l.size) * 0.4);
          if (t) { t.parts.push(...l.parts); t.x0 = Math.min(t.x0, l.x0); t.x1 = Math.max(t.x1, l.x1); finishLine(t); } else A.lines.push(l);
        }
        A.lines.sort((p, q) => q.y - p.y || p.x0 - q.x0);
        blocks.splice(c, 1);
        again = true;
      }
    }
  }
}

/**
 * Area into which a text block is set: [x0, y0, x1, y1]. A block with a fixed width wraps at it.
 * Otherwise a line runs up to the page edge; right-aligned text keeps its right edge and grows to the left.
 */
function blockArea(crop, rect, s, o) {
  const top = rect[3] + s.size * 0.08;
  if (o.fixedWidth) return [rect[0], rect[1], rect[2], top];
  if (s.align === 'right') return [Math.min(rect[0], crop.x + 18), rect[1], rect[2], top];
  return [rect[0], rect[1], Math.max(rect[2], crop.x + crop.width - 18), top];
}
/** Parts of a text block that do not lie on the image below (the image with the largest overlap). */
function outsideImage(page, box) {
  if (!box) return [];
  const imgs = interpret(page).items.filter((it) => it.kind === 'image');
  let host = null; let best = 0;
  for (const it of imgs) { const s = overlap(box, it.bbox); if (s > best) { best = s; host = it; } }
  return host ? subtractRect(box, host.bbox) : [box];
}

/**
 * Text of a recognized paragraph for editing: wrapped lines are joined into running text (when
 * edited, the paragraph reflows like in Word), intentional line breaks stay. A line ended intentionally if
 * the first word of the next line would still have fit on it.
 */
export function joinOcrLines(lines, size) {
  const W = Math.max(...lines.map((l) => l.x1 - l.x0));
  // Line break in running text: the upper line has at least three words, and the first word of the lower one
  // would no longer have fit on it. This is only certain if the lower line starts with a lowercase letter; if it starts
  // with a capital or a number, the paragraph needs a certain break as evidence. Otherwise they are separate lines
  // (table, address, list) and stay below each other when edited.
  const noRoom = []; const sure = [];
  for (let k = 1; k < lines.length; k++) {
    const prev = lines[k - 1]; const cur = lines[k];
    const first = cur.text.split(' ')[0];
    const fw = ((cur.x1 - cur.x0) * first.length) / Math.max(1, cur.text.length);
    noRoom[k] = prev.text.trim().split(/\s+/).length >= 3 && prev.x1 - prev.x0 + size * 0.28 + fw > W * 0.97;
    sure[k] = noRoom[k] && /^\p{Ll}/u.test(first);
  }
  const proven = sure.some(Boolean);
  let text = lines[0].text; const seps = [];
  for (let k = 1; k < lines.length; k++) {
    const soft = sure[k] || (proven && noRoom[k]);
    seps.push(!soft ? '\n' : /[-–]$/.test(lines[k - 1].text) ? '' : ' ');
    text += seps[k - 1] + lines[k].text;
  }
  // seps: separators between the lines as they appear in the text ('\n' = separate line, otherwise running text).
  return { text, width: W, seps, wrapped: lines.length > 1 && !text.includes('\n') ? true : text.split('\n').length < lines.length };
}

const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * Font, size and color of each cell of a block (from the text object below its first part), and whether the block
 * is "complex": columns, several fonts, sizes or colors, lines that do not start at the same place or are not
 * evenly spaced. Such a block is set again cell by cell when its text changes, so nothing of this gets lost.
 */
export function cellStyles(b, textObjs) {
  const styles = [];
  for (const l of b.lines || []) {
    for (const c of l.cells || []) {
      const p = l.parts[c.first];
      const box = [p.x0, l.y - p.size * 0.2, Math.max(p.x1, p.x0 + 0.1), l.y + p.size * 0.8];
      let o = null; let best = 0;
      for (const t of textObjs) { if ((t.mark || null) !== (b.mark || null)) continue; const v = overlap(box, t.bbox); if (v > best) { best = v; o = t; } }
      const font = o?.baseFont || '';
      c.style = { family: mapFamily(font), bold: /bold|black|heavy/i.test(font), italic: /italic|oblique/i.test(font), color: o?.color || b.color || [0, 0, 0], size: p.size };
      styles.push(c.style);
    }
  }
  const s0 = styles[0];
  const same = (s) => s.family === s0.family && s.bold === s0.bold && s.italic === s0.italic && Math.abs(s.size - s0.size) <= 0.3 && s.color.every((v, k) => Math.abs(v - s0.color[k]) <= 0.1);
  const L = b.lines || [];
  b.complex = !!s0 && (L.some((l) => l.cells.length > 1) || !styles.every(same)
    || L.some((l) => Math.abs(l.x0 - L[0].x0) > b.size * 0.5)
    || L.some((l, k) => k > 0 && Math.abs(L[k - 1].y - l.y - b.lineHeight) > b.size * 0.25));
}

/**
 * Lines of a complex block after its text has changed: [{ y, cells: [{ text, x, style }] }]. Unchanged lines keep
 * their place, changed lines keep the places and styles of their cells; only the cells that changed are joined
 * (in the style of the first one). New lines follow the line above, removed lines close the gap.
 * old: the block's lines, next: the new lines of text, lh: line height.
 */
export function cellLayout(old, next, lh) {
  const cellsOf = (l) => l.cells.map((c) => ({ text: l.text.slice(c.start, c.end), x: c.x0, style: c.style }));
  const changed = (l, s) => {
    const t = l.text; const cells = l.cells;
    let p = 0; while (p < t.length && p < s.length && t[p] === s[p]) p++;
    let q = 0; while (q < t.length - p && q < s.length - p && t[t.length - 1 - q] === s[s.length - 1 - q]) q++;
    const a = p; const b = t.length - q;
    let first = 0; cells.forEach((c, k) => { if (c.start <= a) first = k; });
    let last = first; cells.forEach((c, k) => { if (k > first && c.start < b) last = k; });
    const S = Math.min(cells[first].start, a); const E = Math.max(cells[last].end, b);
    const out = [];
    cells.forEach((c, k) => {
      if (k < first || k > last) out.push({ text: t.slice(c.start, c.end), x: c.x0, style: c.style });
      else if (k === first) out.push({ text: s.slice(S, E + s.length - t.length), x: c.x0, style: c.style });
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
/** Assigns each text item from PDF.js the marker of the text block it comes from in the page content. */
export function attachMarks(items, textObjs) {
  if (!textObjs.some((o) => o.mark)) return items;
  return items.map((t) => {
    const [a, b, c, d, e, f] = t.transform;
    const size = Math.hypot(c, d) || t.height || 1;
    const width = Math.max(t.width, 0.1);
    // A slightly rotated text item (recognized text of a skewed scanned page) is checked in sections along its
    // direction, otherwise its right end would mathematically lie on the neighboring line.
    const len = Math.hypot(a, b) || 1; const dx = a / len; const dy = b / len;
    const n = Math.abs(dy) < 0.004 || Math.abs(dy) > 0.27 || dx <= 0 ? 1 : Math.max(1, Math.ceil(width / (size * 2)));
    const pieces = [];
    for (let k = 0; k < n; k++) { const u = (width * k) / n; pieces.push([e + dx * u, f + dy * u - size * 0.2, e + dx * u + width / n, f + dy * u + size * 0.8]); }
    // Sum up the area per text block: a line of many small words belongs to its block, even if
    // a single larger text item of another block (e.g. hidden text under an image) has more area.
    const by = new Map();
    for (const o of textObjs) {
      let s = 0; for (const r of pieces) s += overlap(r, o.bbox);
      if (s <= 0) continue;
      const k = o.mark || ''; const v = by.get(k) || { s: 0, area: 0 };
      v.s += s; v.area += Math.max(1e-6, (o.bbox[2] - o.bbox[0]) * (o.bbox[3] - o.bbox[1]));
      by.set(k, v);
    }
    // Several blocks can cover the text item completely, e.g. a short new text placed on a longer line: both
    // boxes then contain it. Then the block that the item fills best wins (its own text, not the line below it).
    let best = 0;
    for (const v of by.values()) best = Math.max(best, v.s);
    let mark = ''; let fit = -1;
    for (const [m, v] of by) if (v.s >= best * 0.97 && v.s / v.area > fit) { fit = v.s / v.area; mark = m; }
    return mark ? { ...t, mark } : t;
  });
}
export const newMark = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class PageEditor {
  constructor(app) {
    this.app = app; this.on = false; this.cache = new Map(); this.selected = null;
    this.newStyle = { family: 'Arial', size: 11, color: [0.094, 0.071, 0.063], bold: false, italic: false };
  }
  /** Default font for new text like in Word (Normal.dotm), as soon as the font catalog is loaded. */
  useWordDefault() {
    const d = wordDefault();
    this.newStyle.family = d.family; this.newStyle.size = d.size;
  }
  get doc() { return this.app.doc; }
  get viewer() { return this.app.viewer; }

  async enable() {
    if (!(await this.doc.allowEdit())) return;
    // Fonts from the PDF are mapped to installed fonts: the catalog must be ready for that.
    await this.app.fontsReady;
    this.on = true; this.cache.clear();
    document.body.classList.add('pdf-editing');
    window.getSelection()?.removeAllRanges();
    this.app.overlay.setTool('edit');
    for (const n of this.viewer.nodes) this.renderPage(n.i);
    this.renderBar();
  }
  disable() {
    if (!this.on) return;
    this.commitInput();
    this.on = false; this.selected = null;
    document.body.classList.remove('pdf-editing');
    for (const n of this.viewer.nodes) [...n.el.children].filter((c) => c.classList.contains('edit')).forEach((c) => c.remove());
    const bar = $('#propbar'); bar.hidden = true; bar.replaceChildren();
  }
  invalidate() { this.cache.clear(); }

  async objects(i) {
    // The cache only applies to exactly this state of exactly this document. "Replace" and other commands
    // also query the text blocks without "Edit PDF" being open; without this check they would get the blocks
    // of the previous document after switching documents.
    if (this.cacheFor !== this.doc.bytes) { this.cache.clear(); this.cacheFor = this.doc.bytes; }
    if (this.cache.has(i)) return this.cache.get(i);
    const proxyDoc = this.doc; const stamp = proxyDoc.bytes;
    let ocrMarks = new Map(); let markProps = new Map(); let glyphs = null;
    const [content, parsed] = await Promise.all([proxyDoc.pageText(i), (async () => {
      const d = await loadForEdit(proxyDoc.bytes);
      const r = interpret(d.getPage(i), { glyphs: true });
      ocrMarks = r.ocr; markProps = r.props; glyphs = r.glyphs;
      return r.items.map(({ op, state, segments, ...x }) => x);
    })()]);
    const textObjs = parsed.filter((o) => o.kind === 'text');
    // Characters that the PDF maps to nothing (e.g. raised hyphens) come from the shape of their glyph.
    const blocks = buildBlocks(attachMarks(fixUnmapped(content.items, glyphs), textObjs), false, { merge: true });
    for (const b of blocks) {
      // Background that the editor placed behind changed text of a screenshot (outside the image).
      const bg = b.mark ? markProps.get(b.mark)?.Bg : null;
      if (Array.isArray(bg) && bg.length === 3) { b.bg = bg; b.ocrBg = bg; }
      // Right-aligned text (a changed number in a table column) stays right-aligned the next time it is edited.
      if (b.mark && markProps.get(b.mark)?.Align === 'right') b.align = 'right';
      const props = b.mark ? ocrMarks.get(b.mark) : null;
      if (props) {
        // Recognized paragraph with details from text recognition: font, bold and tracking as in the image.
        const own = textObjs.filter((o) => o.mark === b.mark);
        const fam = props.font && familyInfo(props.font)?.embeddable ? props.font : mapFamily('Arial');
        Object.assign(b, { family: fam, bold: props.bold, italic: false, color: [0, 0, 0], hscale: props.tz / 100 });
        b.order = Math.max(-1, ...own.map((o) => parsed.indexOf(o)));
        if (own.length && own.every((o) => o.invisible)) {
          b.ocr = true; b.words = own.map((o) => o.bbox);
          b.origText = b.text;
          if (b.lines.length > 1) {
            const j = joinOcrLines(b.lines, b.size);
            // Only running text gets a fixed width and reflows when edited. Separate lines stay as they are.
            if (j.wrapped) {
              b.text = j.text; b.seps = j.seps; b.fixedWidth = true;
              // A little leeway so unchanged text wraps the same way as in the image.
              b.rect = [b.rect[0], b.rect[1], b.rect[0] + j.width * 1.03, b.rect[3]];
            }
          }
        }
        continue;
      }
      const hits = (o) => o.bbox[0] < b.rect[2] && o.bbox[2] > b.rect[0] && o.bbox[1] < b.rect[3] && o.bbox[3] > b.rect[1];
      const hit = textObjs.find((o) => o.mark === b.mark && hits(o)) || textObjs.find(hits);
      b.family = mapFamily(hit?.baseFont || '');
      b.bold = /bold|black|heavy/i.test(hit?.baseFont || ''); b.italic = /italic|oblique/i.test(hit?.baseFont || '');
      b.color = hit?.color || [0, 0, 0];
      cellStyles(b, textObjs);
      // Drawing order in the page content: drawn later means on top.
      const own = textObjs.filter((o) => (b.mark ? o.mark === b.mark : !o.mark) && hits(o));
      b.order = Math.max(-1, ...(own.length ? own : textObjs.filter(hits)).map((o) => parsed.indexOf(o)));
      // Recognized text (invisible text layer over a scan): only the pixels below are visible.
      const centerIn = (o) => { const cx = (o.bbox[0] + o.bbox[2]) / 2; const cy = (o.bbox[1] + o.bbox[3]) / 2; return cx >= b.rect[0] && cx <= b.rect[2] && cy >= b.rect[1] && cy <= b.rect[3]; };
      const words = b.mark ? [] : textObjs.filter((o) => !o.mark && centerIn(o));
      if (words.length && words.every((o) => o.invisible)) { b.ocr = true; b.words = words.map((o) => o.bbox); }
    }
    // Right-aligned cells (number columns of a table): several recognized lines nearby share the right edge,
    // but not the left one. When edited, the right edge then stays in place ("15.00" instead of "5.00").
    const cells = blocks.filter((b) => b.ocr && b.lines.length === 1);
    for (const b of cells) {
      const tol = Math.max(1, b.size * 0.14);
      const near = cells.filter((c) => c !== b && Math.abs(c.baseline - b.baseline) <= b.size * 16 && Math.abs(c.size - b.size) <= b.size * 0.2);
      const right = near.filter((c) => Math.abs(c.rect[2] - b.rect[2]) <= tol).length;
      const left = near.filter((c) => Math.abs(c.rect[0] - b.rect[0]) <= tol).length;
      if (right >= 2 && right > left) b.align = 'right';
    }
    // Images: pieces of a scan and full-page scans are locked (no frame, no accidental moving).
    const vb = this.viewer.viewport(i).viewBox;
    const pageArea = Math.abs((vb[2] - vb[0]) * (vb[3] - vb[1]));
    const allImages = parsed.filter((o) => o.kind === 'image');
    const images = parsed.map((o, k) => {
      if (o.kind !== 'image') return null;
      const role = imageRole(o, allImages, pageArea);
      return { kind: 'image', rect: o.bbox, order: k, role, locked: role !== 'object' };
    }).filter(Boolean);
    // When objects overlap, a click grabs the topmost one, i.e. the one drawn last.
    // That is why the frames follow the drawing order (a later frame is on top in the window).
    const out = [...images, ...blocks].map((o, k) => ({ o, k })).sort((a, b) => (a.o.order - b.o.order) || (a.k - b.k)).map((x) => x.o);
    // Only remember it if the document has not been switched or changed in the meantime.
    if (this.cacheFor === stamp) this.cache.set(i, out);
    return out;
  }

  layer(i) {
    const n = this.viewer.node(i);
    let layer = [...n.el.children].find((c) => c.classList.contains('edit'));
    if (!layer) {
      layer = h('div', { class: 'edit' });
      // Click next to a paragraph: clear the selection. Also prevents the browser from selecting page text.
      layer.addEventListener('pointerdown', (e) => { if (e.target !== layer || e.button !== 0) return; e.preventDefault(); this.commitInput(); if (this.selected) this.select(null); });
      n.el.append(layer);
    }
    return layer;
  }

  async renderPage(i) {
    if (!this.on) return;
    const n = this.viewer.node(i);
    if (!n?.layers) return;
    const list = await this.objects(i);
    if (!this.on || !n.layers) return;
    // After moving, the object stays selected.
    const want = this.pendingSelect?.i === i ? this.pendingSelect : null;
    if (want) {
      this.pendingSelect = null;
      const hit = list.find((o) => o.kind === want.kind && o.rect.every((v, k) => Math.abs(v - want.rect[k]) < 2));
      if (hit) this.selected = { o: hit, i };
    }
    // As long as the old page is still drawn after a change, the preview of the dragged object stays
    // in place (at the new position, the old position covered). Otherwise it would briefly be visible at the old spot again.
    const layer = this.layer(i);
    let keep = [];
    if (this.hold && this.hold.i === i) {
      if (n.canvas === this.hold.canvas) keep = [...layer.children].filter((c) => c.classList.contains('dragging') || c.classList.contains('eb-mask'));
      else this.hold = null;
    }
    for (const c of keep) c.style.pointerEvents = 'none';
    layer.replaceChildren(...list.filter((o) => !o.locked).map((o) => this.blockEl(o, i)), ...keep);
    if (want) this.renderBar();
  }

  blockEl(o, i) {
    const css = this.viewer.rectToCss(i, o.rect);
    const el = h('div', { class: `eb ${o.kind === 'image' ? 'img' : ''} ${this.selected?.o === o ? 'sel' : ''}`, style: { left: `${css.left}px`, top: `${css.top}px`, width: `${css.width}px`, height: `${css.height}px` } });
    el._o = o;
    el.addEventListener('pointerdown', (e) => this.down(e, o, i, el));
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); if (o.kind === 'text') this.startText(o, i); });
    return el;
  }

  /** Only toggles the selection. The frames remain so that a double-click gets through. */
  select(o, i) {
    this.selected = o ? { o, i } : null;
    for (const n of this.viewer.nodes) {
      const layer = [...n.el.children].find((c) => c.classList.contains('edit'));
      if (layer) for (const c of layer.children) c.classList?.toggle('sel', !!o && c._o === o);
    }
    this.renderBar();
  }
  renderPageSync(i) { if (this.cache.has(i)) { const layer = [...this.viewer.node(i).el.children].find((c) => c.classList.contains('edit')); if (layer) layer.replaceChildren(...this.cache.get(i).filter((o) => !o.locked).map((o) => this.blockEl(o, i))); } }

  /**
   * Preview while dragging: only the dragged object moves, and at the old position
   * whatever lies below stays visible. For this, the page is drawn once without the object; the
   * preview only contains the pixels that differ as a result. This way overlapping
   * images or texts no longer move along.
   */
  preview(i, box, el, o, isDragging) {
    const n = this.viewer.node(i);
    if (!n.canvas) return;
    // Two pixels of margin so the anti-aliased edges of the object are captured too.
    const css = { left: box.left - 2, top: box.top - 2, width: box.width + 4, height: box.height + 4 };
    const ratio = n.canvas.width / n.el.clientWidth;
    const W = Math.max(1, Math.round(css.width * ratio)); const H = Math.max(1, Math.round(css.height * ratio));
    const sx = Math.round(css.left * ratio); const sy = Math.round(css.top * ratio);
    const original = document.createElement('canvas'); original.width = W; original.height = H;
    original.getContext('2d').drawImage(n.canvas, sx, sy, W, H, 0, 0, W, H);
    const bytes = this.doc.bytes; const viewRot = this.viewer.viewRot; const scale = this.viewer.scale * ratio;
    (async () => {
      const d = await loadForEdit(bytes);
      const page = d.getPage(i);
      if (o.kind === 'image') removeImageInPage(page, (it) => it.bbox.every((v, k) => Math.abs(v - o.rect[k]) < 1.5));
      else {
        // Recognized text: remove the letters in the image below so the preview drags them along.
        if (o.ocr) await this.eraseScanText(d, i, o);
        removeTextInPage(page, [o.rect], { mark: o.mark || null });
      }
      const one = await PDFDocument.create();
      const [copy] = await one.copyPages(d, [i]);
      one.addPage(copy);
      const pdf = await pdfjs.getDocument({ data: await one.save(), ...RENDER_OPTS }).promise;
      try {
        const p = await pdf.getPage(1);
        const vp = p.getViewport({ scale, rotation: (p.rotate + viewRot) % 360 });
        const full = document.createElement('canvas'); full.width = Math.ceil(vp.width); full.height = Math.ceil(vp.height);
        await p.render({ canvas: full, canvasContext: full.getContext('2d', { alpha: false }), viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise;
        if (!isDragging()) return;
        const under = document.createElement('canvas'); under.width = W; under.height = H;
        under.getContext('2d').drawImage(full, sx, sy, W, H, 0, 0, W, H);
        // Only differing pixels belong to the dragged object.
        const a = original.getContext('2d').getImageData(0, 0, W, H); const b = under.getContext('2d').getImageData(0, 0, W, H);
        for (let k = 0; k < a.data.length; k += 4) {
          const diff = Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1]) + Math.abs(a.data[k + 2] - b.data[k + 2]);
          if (diff < 24) a.data[k + 3] = 0;
        }
        original.getContext('2d').putImageData(a, 0, 0);
        original.className = 'eb-snap';
        Object.assign(original.style, { inset: 'auto', left: '-2px', top: '-2px', width: `${css.width}px`, height: `${css.height}px` });
        el.append(original);
        under.className = 'eb-mask';
        Object.assign(under.style, { left: `${css.left}px`, top: `${css.top}px`, width: `${css.width}px`, height: `${css.height}px` });
        el.before(under);
        el.classList.add('has-preview');
      } finally { pdf.loadingTask.destroy(); }
    })().catch((e) => console.warn('Preview', e));
  }

  /**
   * Image that a recognized paragraph belongs to, if the image is an object on the page (e.g. a pasted
   * screenshot) and not the whole page (scan). Then a click on the text grabs the image.
   */
  hostImage(o, i) {
    if (o.kind !== 'text' || !o.ocr) return null;
    const list = this.cache.get(i) || [];
    const cx = (o.rect[0] + o.rect[2]) / 2; const cy = (o.rect[1] + o.rect[3]) / 2;
    const imgs = list.filter((x) => x.kind === 'image' && x.order < o.order && cx >= x.rect[0] && cx <= x.rect[2] && cy >= x.rect[1] && cy <= x.rect[3]);
    const host = imgs[imgs.length - 1];
    return host && host.role === 'object' ? host : null;
  }

  down(e, o, i, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.commitInput();
    // Recognized text in a pasted image: dragging moves the whole image including the text.
    const host = this.hostImage(o, i);
    let live = el;
    if (host) {
      o = host;
      live = [...el.parentElement.children].find((c) => c._o === host) || el;
    }
    if (this.selected?.o !== o) this.select(o, i);
    const start = this.viewer.toPdf(i, e.clientX, e.clientY);
    let q = start; let moved = false;
    const base = this.viewer.rectToCss(i, o.rect);
    const x0 = e.clientX; const y0 = e.clientY;
    const corner = !host && o.kind === 'image' && e.offsetX > el.clientWidth - 14 && e.offsetY > el.clientHeight - 14;
    // Hide the frames of the text that moves with the image while dragging.
    const riders = o.kind === 'image' ? [...live.parentElement.children].filter((c) => c._o?.kind === 'text' && this.hostImage(c._o, i) === o) : [];
    startDrag(e, (m) => {
      q = this.viewer.toPdf(i, m.clientX, m.clientY);
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 3) return;
      if (!moved) {
        moved = true;
        if (!corner) this.preview(i, base, live, o, () => live.isConnected && live.classList.contains('dragging'));
        live.classList.add('dragging');
        for (const c of riders) c.style.visibility = 'hidden';
      }
      if (corner) { live.style.width = `${Math.max(10, base.width + m.clientX - x0)}px`; live.style.height = `${Math.max(10, base.height + m.clientY - y0)}px`; }
      else { live.style.left = `${base.left + m.clientX - x0}px`; live.style.top = `${base.top + m.clientY - y0}px`; }
    }, async () => {
      if (!moved) return;
      const dx = q[0] - start[0]; const dy = q[1] - start[1];
      const r = o.rect;
      let next = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
      if (corner) next = [r[0], Math.min(r[1] + dy, r[3] - 5), Math.max(r[2] + dx, r[0] + 5), r[3]];
      try { if (o.kind === 'image') await this.apply((b) => moveImage(b, i, o.rect, next), i, { kind: 'image', rect: next }); else await this.replaceText(o, i, o.text, next, {}); }
      catch (err) { errToast(err); this.cache.delete(i); this.renderPage(i); }
    // Input stays with the clicked element so a double-click on the text gets through.
    }, el);
  }

  /** Add text: click on the page (or drag out a box) and type directly. */
  startNewText(i, p0, rect) {
    this.commitInput();
    const s = this.newStyle;
    const top = rect ? rect[3] : p0[1];
    const left = rect ? rect[0] : p0[0];
    const baseline = top - s.size * 0.92;
    const o = { kind: 'text', isNew: true, text: '', family: s.family, size: s.size, color: s.color.slice(), bold: s.bold, italic: s.italic, lineHeight: s.size * 1.2, baseline, rect: [left, baseline - s.size * 0.24, rect ? rect[2] : left + 4, top], fixedWidth: !!rect && rect[2] - rect[0] > 20 };
    this.selected = { o, i };
    this.startText(o, i);
  }

  fontCss(o) { return `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : ''}${o.size * this.viewer.scale}px ${cssFamily(o.family)}`; }

  startText(o, i) {
    this.commitInput();
    this.selected = { o, i };
    const n = this.viewer.node(i);
    // Recognized text: take the text and background colors from the scan.
    if (o.ocr && !o.sampled) { const c = this.sampleOcr(i, o); if (c?.text) o.color = c.text; o.ocrBg = c?.bg || null; o.sampled = true; }
    const css = this.viewer.rectToCss(i, o.rect);
    const scale = this.viewer.scale;
    // The input field lies exactly over the paragraph: same font, same lines, same baseline.
    const sizePx = o.size * scale; const lineH = o.lineHeight * scale; const font = this.fontCss(o);
    const baselineCss = this.viewer.viewport(i).convertToViewportPoint(o.rect[0], o.baseline)[1];
    const topFor = () => {
      const m = Object.assign(document.createElement('canvas').getContext('2d'), { font: this.fontCss(o) }).measureText('Hg');
      const asc = m.fontBoundingBoxAscent || sizePx * 0.9; const desc = m.fontBoundingBoxDescent || sizePx * 0.25;
      return baselineCss - ((lineH - (asc + desc)) / 2 + asc);
    };
    let top = topFor();
    const lines = Math.max(1, o.text.split('\n').length);
    // Tracking as in the result (recognized text is set as wide as the font in the image).
    const hs = () => o.hscale || 1;
    const baseW = (o.fixedWidth ? css.width : Math.max(css.width + 2, o.isNew ? 24 : 0)) / hs(); const baseH = lines * lineH;
    const PAD = 6;
    const ta = h('textarea', { class: 'eb-input', spellcheck: 'true', wrap: o.fixedWidth ? 'soft' : 'off', style: { left: `${PAD}px`, top: `${PAD}px`, width: `${baseW}px`, height: `${baseH}px`, font, lineHeight: `${lineH}px`, color: cssColor(o.color), whiteSpace: o.fixedWidth ? 'pre-wrap' : 'pre', transformOrigin: '0 0', transform: `scaleX(${hs()})`, ...(o.ocrBg ? { background: cssColor(o.ocrBg) } : {}) } });
    ta.value = o.text;
    // The dashed frame is used for moving, even while typing.
    const frame = h('div', { class: 'eb-frame', title: 'Drag the frame to move', style: { left: `${css.left - PAD}px`, top: `${top - PAD}px` } }, ta);
    // Right-aligned text (number column): the right edge stays in place, the field grows to the left.
    const anchorRight = o.align === 'right' && !o.fixedWidth;
    if (anchorRight) ta.style.textAlign = 'right';
    const fit = () => {
      ta.style.transform = `scaleX(${hs()})`;
      ta.style.width = `${baseW}px`; ta.style.height = `${baseH}px`;
      if (!o.fixedWidth) ta.style.width = `${Math.max(baseW, ta.scrollWidth + 2)}px`;
      ta.style.height = `${Math.max(baseH, ta.scrollHeight)}px`;
      frame.style.width = `${ta.offsetWidth * hs() + 2 * PAD}px`; frame.style.height = `${ta.offsetHeight + 2 * PAD}px`;
      if (anchorRight) frame.style.left = `${css.left + css.width + PAD - parseFloat(frame.style.width) + input.shiftX}px`;
    };
    const input = { ta, frame, o, i, move: [0, 0], fit, shiftX: 0 };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { if (o.isNew && !ta.value.trim()) this.cancelInput(); else ta.blur(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => {
      if (this.input !== input || input.dragging) return;
      if (document.activeElement?.closest?.('#propbar')) return;
      this.commitInput();
    }, 120));
    frame.addEventListener('pointerdown', (e) => {
      if (e.target !== frame || e.button !== 0) return;
      input.dragging = true;
      const s0 = this.viewer.toPdf(i, e.clientX, e.clientY);
      const l0 = parseFloat(frame.style.left); const t0 = parseFloat(frame.style.top); const x0 = e.clientX; const y0 = e.clientY;
      startDrag(e, (mv) => { frame.style.left = `${l0 + mv.clientX - x0}px`; frame.style.top = `${t0 + mv.clientY - y0}px`; }, (up) => {
        const s1 = this.viewer.toPdf(i, up.clientX, up.clientY);
        input.move = [input.move[0] + s1[0] - s0[0], input.move[1] + s1[1] - s0[1]];
        input.shiftX += up.clientX - x0;
        input.dragging = false;
        ta.focus();
      }, n.el);
    });
    n.el.append(frame);
    this.input = input;
    fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    this.renderBar();
    // As soon as the font is loaded: realign the baseline with the real font metrics.
    cssFamilyReady(o.family).then(() => {
      if (this.input !== input) return;
      const t = topFor();
      frame.style.top = `${parseFloat(frame.style.top) + t - top}px`; top = t;
      fit();
    });
  }
  cancelInput() {
    const c = this.input;
    if (!c) return;
    this.input = null; c.frame.remove();
    if (c.o.isNew) this.selected = null;
    this.renderBar();
  }
  commitInput() {
    const c = this.input;
    if (!c) return;
    this.input = null;
    // Empty lines and trailing spaces (e.g. Enter to finish) are not set as text.
    const text = c.ta.value.replace(/\r/g, '').replace(/\s+$/, '');
    c.frame.remove();
    const [dx, dy] = c.move;
    const moved = Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2;
    const o = c.o;
    if (o.isNew) {
      this.selected = null;
      if (!text.trim()) { this.renderBar(); return; }
      const rect = [o.rect[0] + dx, o.rect[1] + dy, o.rect[2] + dx, o.rect[3] + dy];
      this.apply(async (bytes) => { const d = await loadForEdit(bytes); await this.drawInto(d, c.i, text, rect, o, o); return saveDoc(d); }, c.i).catch(errToast);
      return;
    }
    if (text === o.text && !c.styled && !moved) { this.renderBar(); return; }
    const rect = moved ? [o.rect[0] + dx, o.rect[1] + dy, o.rect[2] + dx, o.rect[3] + dy] : null;
    this.replaceText(o, c.i, text, rect, c.styled || {}).catch(errToast);
  }

  /**
   * Changes the page and rebuilds the frames right away. The page itself is only redrawn shortly afterwards;
   * until then the preview of a dragged object stays in place (see renderPage), so it does not briefly jump
   * back to the old position. select: { kind, rect } selects the object again afterwards.
   */
  async apply(fn, i, select = null) {
    this.selected = null;
    this.pendingSelect = select ? { i, ...select } : null;
    const before = this.viewer.node(i)?.canvas || null;
    let ok = false;
    try { ok = await this.doc.mutate(fn, { pages: [i], skipCheck: true }); }
    catch (e) { this.pendingSelect = null; this.hold = null; this.cache.delete(i); this.renderPage(i); throw e; }
    this.cache.delete(i);
    if (!ok) this.pendingSelect = null;
    this.hold = ok && before ? { i, canvas: before } : null;
    await this.renderPage(i);
    this.renderBar();
  }

  /** Really remove the old text and set the new text. */
  async replaceText(o, i, text, rect, style) {
    await this.apply(async (bytes) => saveDoc(await this.setBlockText(await loadForEdit(bytes), i, o, text, rect, style)), i);
  }

  /**
   * Sets the text of a block again in the loaded document d and returns the document (a reloaded one after covering
   * text in an embedded object). Core of "Edit text" and of "Replace".
   */
  async setBlockText(d, i, o, text, rect, style, info = null) {
    // Text of the page itself or of the editor (not recognized text, no background or alignment of its own), without a
    // new format: when only moved, it stays exactly as it is (same font, size and glyphs); a block with columns or mixed
    // fonts keeps the font, size and place of each cell when its text changes.
    const plain = Object.keys(style).every((k) => k === 'mark' || style[k] === undefined);
    if (plain && !o.ocr && !o.isNew && !o.bg && o.align !== 'right' && o.lines) {
      if (rect && text === o.text) { if (this.moveExact(d, i, o, rect, style.mark)) return d; }
      else if (o.complex && await this.setCells(d, i, o, text, rect, style.mark)) return d;
    }
    const s = { family: o.family, bold: o.bold, italic: o.italic, color: o.color, size: o.size, align: o.align, hscale: o.hscale || 1, ...style };
    // Recognized paragraph with unchanged text (only moved or formatted): lines stay as in the image.
    const keepLines = o.ocr && o.origText && text === o.text;
    const body = keepLines ? o.origText : text;
    const box = keepLines ? { ...o, fixedWidth: false } : o;
    const page = d.getPage(i);
    // Recognized text from a scan: really remove the old letters from the image, new text in their color.
    if (o.ocr) {
      const r = await this.eraseScanText(d, i, o);
      if (!style.color && r.color) s.color = r.color;
      // Remember the image background: text that runs beyond the image (new lines at the bottom, longer line)
      // gets the same background there. Otherwise, e.g., light text from a dark-mode screenshot would be
      // invisible on the white paper.
      const bg = o.ocrBg || r.bg || this.sampleOcr(i, o)?.bg;
      if (bg && !s.bg) s.bg = bg;
    } else if (o.bg && !s.bg) s.bg = o.bg;
    // Only remove the text of this block, not other text lying below or above it.
    const removed = removeTextInPage(page, [o.rect], { mark: o.mark || null });
    if (!removed) {
      // Text lies in an embedded object: cover instead of remove.
      const b2 = await saveDoc(d);
      const covered = await fillRects(b2, i, [o.rect]);
      const d2 = await loadForEdit(covered);
      await this.drawInto(d2, i, body, rect || o.rect, s, box);
      if (info) info.covered = true;
      return d2;
    }
    // More lines than before in a pasted image: make room there, the rest moves down.
    if (o.ocr && !keepLines && !rect) await this.makeRoom(d, i, o, body, s, box);
    await this.drawInto(d, i, body, rect || o.rect, s, box);
    return d;
  }

  /** Marker for a block that the editor writes: its own one, the one given, or a new one. */
  markOps(d, id) {
    return [PDFOperator.of('BDC', [PDFName.of(EDIT_TAG), d.context.obj({ Id: PDFString.of(id) })]), PDFOperator.of('EMC')];
  }

  /**
   * Moves a block exactly: its text operators are drawn again at the new place with the same font, size, glyphs and
   * colors, as one editor block. Returns false if the text is not in the page content (e.g. in an embedded object).
   */
  moveExact(d, i, o, rect, mark) {
    const page = d.getPage(i);
    // pdf-lib wraps the page content in q/Q before it appends anything: do that first, so the state at the end is known.
    page.node.normalize();
    const r = interpret(page);
    const items = blockTextItems(r, o.rect, o.mark || null);
    if (!items.length || items.some((it) => !it.state?.font)) return false;
    const [open, close] = this.markOps(d, mark || o.mark || newMark());
    removeTextItems(page, r, items, o.mark || null);
    page.pushOperators(open, ...textCopyOperators(d.context, items, rect[0] - o.rect[0], rect[1] - o.rect[1], r.endCtm), close);
    return true;
  }

  /**
   * Sets the text of a complex block (columns, mixed fonts or sizes) again cell by cell: each line on its baseline,
   * each cell at its place in its own font, size and color (see cellLayout). A cell that grows pushes the following
   * cells of its line to the right. Returns false (the block is then set as a whole) if a line would run over
   * the right page edge or the text is not in the page content.
   */
  async setCells(d, i, o, text, rect, mark) {
    const page = d.getPage(i);
    page.node.normalize();
    const r = interpret(page);
    const items = blockTextItems(r, o.rect, o.mark || null);
    if (!items.length) return false;
    const dx = rect ? rect[0] - o.rect[0] : 0; const dy = rect ? rect[1] - o.rect[1] : 0;
    const crop = page.getCropBox();
    const fallback = { family: o.family, bold: o.bold, italic: o.italic, color: o.color, size: o.size };
    const draw = [];
    for (const row of cellLayout(o.lines, text.split('\n'), o.lineHeight || o.size * 1.2)) {
      let next = -Infinity;
      for (const c of row.cells) {
        const t = c.text.replace(/\s+$/, '');
        if (!t.trim()) continue;
        const st = c.style || fallback;
        const { font, fakeBold, fakeItalic } = await getStyledFont(d, st.family, st, t, readFont);
        const x = Math.max(c.x + dx, next);
        const w = font.widthOfTextAtSize(sanitizeFor(font, t), st.size);
        if (x + w > crop.x + crop.width + 0.5) return false;
        draw.push({ t, x, y: row.y + dy, font, fakeBold, fakeItalic, st });
        next = x + w + st.size * 0.25;
      }
    }
    const [open, close] = this.markOps(d, mark || o.mark || newMark());
    removeTextItems(page, r, items, o.mark || null);
    page.pushOperators(open);
    for (const c of draw) drawTextBlock(page, c.font, c.t, [c.x, c.y - c.st.size, c.x + 1e5, c.y + c.st.size], { size: c.st.size, color: c.st.color, lineHeight: c.st.size * 1.2, fakeBold: c.fakeBold, fakeItalic: c.fakeItalic });
    page.pushOperators(close);
    return true;
  }

  /**
   * Find and replace: changes the text of several blocks in one step (one step for "Undo").
   * edits: [{ i, o, hits: [{ a, b }], with, mark? }] (page, text block from objects(), ranges in the block's text,
   * replacement text, marker for the new block). Returns false if the document may not be changed.
   * If old text could only be covered instead of removed, the entry carries covered: true afterwards.
   * opts.skipCheck: the confirmation for protected or signed documents has already been asked.
   */
  async replaceMany(edits, opts = {}) {
    if (!edits.length) return false;
    this.commitInput();
    await this.app.fontsReady;
    // Per page from bottom to top: if room is made in a pasted image, only what lies below it moves.
    const order = [...edits].sort((p, q) => p.i - q.i || p.o.rect[1] - q.o.rect[1]);
    const pages = [...new Set(order.map((e) => e.i))];
    // Measure widths in a separate document (see makeRoom).
    const ruler = await PDFDocument.create();
    for (const e of order) {
      const o = e.o;
      const flow = !o.fixedWidth && o.lines.length > 1 ? joinOcrLines(o.lines, o.size) : null;
      const { font } = await getStyledFont(ruler, o.family, o, blockLines(o).text + e.with, readFont);
      const hs = o.hscale || 1;
      e.text = replacedText(o, e.hits, e.with, flow && { soft: flow.seps.map((x) => x !== '\n'), width: flow.width }, (t) => font.widthOfTextAtSize(sanitizeFor(font, t), o.size) * hs).replace(/\s+$/, '');
    }
    this.selected = null;
    const ok = await this.doc.mutate(async (bytes) => {
      let d = await loadForEdit(bytes);
      for (const e of order) d = await this.setBlockText(d, e.i, e.o, e.text, null, e.mark ? { mark: e.mark } : {}, e);
      // Remove old versions of the page content (with the replaced text) and outdated font subsets from the file.
      await d.flush();
      gcObjects(d);
      return saveDoc(d);
    }, { pages, skipCheck: !!opts.skipCheck });
    this.cache.clear();
    if (ok && this.on) for (const i of pages) this.renderPage(i);
    this.renderBar();
    return ok;
  }

  /**
   * If changed text of a recognized paragraph needs more height than the paragraph in the image, the image is
   * extended below the paragraph by the missing height: following items move down instead of being covered.
   * Only for images that are an object on the page (pasted screenshot), not for full scanned pages.
   */
  async makeRoom(d, i, o, text, s, box) {
    if (!text.trim()) return;
    const page = d.getPage(i);
    const crop = page.getCropBox();
    const cx = (o.rect[0] + o.rect[2]) / 2; const cy = (o.rect[1] + o.rect[3]) / 2;
    const all = interpret(page).items.filter((it) => it.kind === 'image');
    const imgs = all.filter((it) => cx >= it.bbox[0] && cx <= it.bbox[2] && cy >= it.bbox[1] && cy <= it.bbox[3]);
    const img = imgs[imgs.length - 1];
    if (!img || imageRole(img, all, crop.width * crop.height) !== 'object') return;
    // Measure in a separate document: extending the image copies the page, and pdf-lib finalizes all
    // open fonts of d while doing so. A font that has not been written with yet would be unusable afterwards.
    const { font } = await getStyledFont(await PDFDocument.create(), s.family, s, text, readFont);
    const lineHeight = box.lineHeight * (s.size / box.size);
    const tb = textBlockBox(font, text, blockArea(crop, o.rect, s, box), { size: s.size, align: s.align, lineHeight, hscale: s.hscale });
    if (!tb) return;
    // New last baseline (calculated back from the area) compared with the last baseline in the image.
    const newLast = tb[1] + s.size * 0.55;
    const oldLast = o.rect[1] + box.size * 0.24;
    const need = oldLast - newLast;
    if (need < s.size * 0.3) return;
    const bbox = img.bbox.slice();
    await insertImageRows(d, i, (it) => it.name === img.name && it.bbox.every((v, k) => Math.abs(v - bbox[k]) < 0.5), o.rect[1], need, s.size);
  }
  /**
   * Removes the letters of a recognized paragraph from the image below. If there is no image below
   * (text stored as graphics), the words are covered with the background color.
   */
  async eraseScanText(d, i, o) {
    const r = await eraseInImages(d, i, o.words);
    if (r.done) return r;
    const c = this.sampleOcr(i, o);
    const bg = c?.bg || [1, 1, 1];
    const page = d.getPage(i);
    for (const w of o.words) {
      const pad = (w[3] - w[1]) * 0.08;
      page.drawRectangle({ x: w[0] - pad, y: w[1] - pad, width: w[2] - w[0] + 2 * pad, height: w[3] - w[1] + 2 * pad, color: rgb(...bg) });
    }
    return { done: true, color: c?.text || null, bg };
  }
  /** Text and background color of a recognized paragraph, taken from the rendered page. */
  sampleOcr(i, o) {
    const n = this.viewer.node(i);
    if (!n?.canvas) return null;
    return sampleColors(n.canvas, this.viewer.rectToCss(i, o.rect), n.canvas.width / n.el.clientWidth);
  }

  async drawInto(d, i, text, rect, s, o) {
    if (!text.trim()) return;
    const { font, fakeBold, fakeItalic } = await getStyledFont(d, s.family, s, text, readFont);
    // Lines stay as they are in the input field. Text is only wrapped where it would go beyond the page edge,
    // or at the width of a dragged-out text box.
    const page = d.getPage(i);
    const crop = page.getCropBox();
    const lineHeight = o.lineHeight * (s.size / o.size);
    const area = blockArea(crop, rect, s, o);
    const opts = { size: s.size, color: s.color, align: s.align, lineHeight, fakeBold, fakeItalic, hscale: s.hscale };
    // Background only where the text does not lie on the image it comes from (and only if it is not white).
    const bg = Array.isArray(s.bg) && s.bg.length === 3 && Math.min(...s.bg) < 0.94 ? s.bg : null;
    const pieces = bg ? outsideImage(page, textBlockBox(font, text, area, opts)) : [];
    // Marked as its own block so it does not merge with other text when moved later.
    const props = { Id: PDFString.of(s.mark || newMark()) };
    if (bg) props.Bg = bg.map((v) => Math.round(v * 1000) / 1000);
    if (s.align === 'right') props.Align = PDFString.of('right');
    page.pushOperators(PDFOperator.of('BDC', [PDFName.of(EDIT_TAG), d.context.obj(props)]));
    for (const p of pieces) page.drawRectangle({ x: p[0], y: p[1], width: p[2] - p[0], height: p[3] - p[1], color: rgb(...bg) });
    drawTextBlock(page, font, text, area, opts);
    page.pushOperators(PDFOperator.of('EMC'));
  }

  async remove() {
    const sel = this.selected;
    if (!sel) return;
    if (this.input) { this.cancelInput(); if (sel.o.isNew) return; }
    const { o, i } = sel;
    try {
      if (o.kind === 'image') await this.apply((b) => deleteImage(b, i, o.rect), i);
      else await this.replaceText(o, i, '', null, {});
      toast('Deleted');
    } catch (e) { errToast(e); }
  }

  /** Format change: visible immediately while typing, applied when finishing. */
  restyle(st) {
    const sel = this.selected;
    if (!sel) return;
    const { o, i } = sel;
    // The tracking was tuned to the recognized font; a different font runs normally.
    if (st.family && o.hscale && o.hscale !== 1) st = { ...st, hscale: 1 };
    if (o.isNew) Object.assign(this.newStyle, st);
    if (this.input && this.input.o === o) {
      if (st.size && !o.isNew) this.input.styled = { ...(this.input.styled || {}), size: st.size };
      if (st.size) o.lineHeight *= st.size / o.size;
      Object.assign(o, st);
      if (!o.isNew) this.input.styled = { ...(this.input.styled || {}), ...st };
      const ta = this.input.ta;
      ta.style.font = this.fontCss(o); ta.style.lineHeight = `${o.lineHeight * this.viewer.scale}px`; ta.style.color = cssColor(o.color);
      this.input.fit();
      const input = this.input;
      if (st.family) cssFamilyReady(o.family).then(() => { if (this.input === input) input.fit(); });
      ta.focus();
      this.renderBar();
      return;
    }
    this.replaceText({ ...o }, i, o.text, null, st).catch(errToast);
  }

  renderBar() {
    if (!this.on) return;
    const bar = $('#propbar');
    const sel = this.selected;
    const items = [];
    if (!sel) items.push(h('span', { style: { color: 'var(--ink2)' } }, 'Click and drag a paragraph or image to move it. Double-click text to edit it.'));
    else if (sel.o.kind === 'image') {
      items.push(h('b', {}, 'Image'), h('span', { style: { color: 'var(--ink2)' } }, 'Drag to move; drag the bottom-right corner to resize.'), h('span', { class: 'spacer' }), ibtn('trash', 'Delete image', () => this.remove()));
    } else {
      const { o, i } = sel;
      const keep = (e) => e.preventDefault();
      if (o.ocr) items.push(h('span', { class: 'ocr-tag', title: 'This text was recognized in a scan. When you edit it, the old letters are removed from the image and the text is set again.' }, 'Recognized text'));
      items.push(
        fontPicker(o.family, (family) => this.restyle({ family })),
        h('label', {}, 'Size', h('input', { type: 'number', min: 4, max: 200, step: 0.5, value: Math.round(o.size * 10) / 10, style: { width: '60px' }, onchange: (e) => { const v = parseFloat(e.target.value); if (v >= 4 && v <= 200) this.restyle({ size: v }); } })),
        h('button', { class: `ib ${o.bold ? 'active' : ''}`, type: 'button', title: 'Bold', onpointerdown: keep, onclick: () => this.restyle({ bold: !o.bold }) }, h('b', {}, 'B')),
        h('button', { class: `ib ${o.italic ? 'active' : ''}`, type: 'button', title: 'Italic', onpointerdown: keep, onclick: () => this.restyle({ italic: !o.italic }) }, h('i', {}, 'I')),
        h('label', {}, 'Color', h('input', { type: 'color', value: rgbToHex(o.color), onchange: (e) => this.restyle({ color: hexToRgb(e.target.value) }) })),
        this.input ? h('button', { class: 'btn primary', type: 'button', onpointerdown: keep, onclick: () => this.commitInput() }, 'Done') : h('button', { class: 'btn', type: 'button', onclick: () => this.startText(o, i) }, 'Edit text'),
        h('span', { class: 'spacer' }), ibtn('trash', o.isNew ? 'Discard' : 'Delete text', () => this.remove()),
      );
    }
    bar.replaceChildren(...items);
    bar.hidden = false;
  }
}

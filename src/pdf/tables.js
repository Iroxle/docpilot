// Detect tables for the export to Word, Excel and PowerPoint: logic without interface.
// Two ways: from the drawn lines (grid with cells, also merged cells) and from the alignment
// of the text (tables without lines: columns are separated by continuous white space).
import { lineGrid } from './formdetect.js';

const centerIn = (r, c) => { const x = (r[0] + r[2]) / 2; const y = (r[1] + r[3]) / 2; return x > c[0] && x < c[2] && y > c[1] && y < c[3]; };
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

/**
 * Text lines of a page: words on the same baseline from left to right, from top to bottom. Each line is
 * split into sections that are separated by a large gap (columns of a table, tabs).
 * words: [{ text, rect: [x0, y0, x1, y1], y (baseline), height }].
 * Returns [{ y, height, x0, x1, words, segs: [{ x0, x1, text, words }] }].
 */
export function textRows(words) {
  const rows = [];
  for (const w of [...words].sort((p, q) => q.y - p.y || p.rect[0] - q.rect[0])) {
    const r = rows.find((v) => Math.abs(v.y - w.y) <= Math.max(1.5, Math.min(v.height, w.height) * 0.4));
    if (r) { r.words.push(w); r.height = Math.max(r.height, w.height); } else rows.push({ y: w.y, height: w.height, words: [w] });
  }
  rows.sort((p, q) => q.y - p.y);
  for (const r of rows) {
    r.words.sort((p, q) => p.rect[0] - q.rect[0]);
    r.x0 = r.words[0].rect[0]; r.x1 = Math.max(...r.words.map((w) => w.rect[2]));
    // From a gap of about three spaces on, a new section starts.
    const gap = Math.max(r.height * 1.0, 7);
    r.segs = [];
    for (const w of r.words) {
      const s = r.segs[r.segs.length - 1];
      if (s && w.rect[0] - s.x1 <= gap) { s.x1 = Math.max(s.x1, w.rect[2]); s.text += ` ${w.text}`; s.words.push(w); }
      else r.segs.push({ x0: w.rect[0], x1: w.rect[2], text: w.text, words: [w] });
    }
  }
  return rows;
}

/** Text of the words of a cell: lines from top to bottom. Wrapped lines (almost as wide as the cell) are joined. */
function cellText(words, width) {
  const rows = textRows(words);
  let out = '';
  rows.forEach((r, k) => {
    const t = r.words.map((w) => w.text).join(' ');
    if (!k) { out = t; return; }
    const prev = rows[k - 1];
    out += (width > 0 && prev.x1 - prev.x0 >= width * 0.6 ? ' ' : '\n') + t;
  });
  return out;
}

const CUR = '(CHF|SFr\\.?|Fr\\.?|EUR|USD|GBP|€|\\$|£)';
const CUR_START = new RegExp(`^${CUR}\\s*`, 'i'); const CUR_END = new RegExp(`\\s*${CUR}$`, 'i');

/**
 * Value of a table cell for Excel: number, date or text.
 * Numbers in Swiss, German and English notation (1'250.00, 1 250,50, 1.250,00, 1,250.00), with
 * currency (CHF 12.50, 12.50 EUR, 12.-), percent and minus (also in parentheses or trailing). Dates as
 * 12.11.2026, 2026-11-12 or 12/11/2026 (day/month). Anything starting with a zero (PO box 0041, item 007),
 * phone numbers and very long digit sequences stay text.
 * Returns { value, numFmt?, type: 'number' | 'date' | 'text' }.
 */
export function parseValue(raw) {
  const text = String(raw ?? '').trim();
  const asText = { value: text, type: 'text' };
  if (!text || /\n/.test(text)) return asText;
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/.exec(text) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  let ymd = m ? [m[3].length === 2 ? (Number(m[3]) < 70 ? 2000 : 1900) + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1])] : null;
  if (!ymd && (m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) ymd = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ymd) {
    const d = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]));
    if (ymd[0] >= 1900 && d.getUTCFullYear() === ymd[0] && d.getUTCMonth() === ymd[1] - 1 && d.getUTCDate() === ymd[2]) return { value: d, numFmt: 'dd.mm.yyyy', type: 'date' };
    return asText;
  }
  let s = text.replace(/[−–]/g, '-').replace(/[   ]/g, ' ');
  let cur = null; let curEnd = false; let pct = false; let neg = false;
  if ((m = CUR_START.exec(s))) { cur = m[1]; s = s.slice(m[0].length); } else if ((m = CUR_END.exec(s))) { cur = m[1]; curEnd = true; s = s.slice(0, s.length - m[0].length); }
  if (/%$/.test(s)) { pct = true; s = s.replace(/\s*%$/, ''); }
  if (/^\(.+\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  // "12.-" (Swiss notation for whole francs)
  s = s.replace(/\.-+$/, '.00');
  if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1).trim(); }
  if (/^[-+]/.test(s)) { if (s[0] === '-') neg = !neg; s = s.slice(1).trim(); }
  let int; let frac = ''; let grouped = false;
  if ((m = /^(\d{1,3}(?:['’ ]\d{3})+)(?:[.,](\d+))?$/.exec(s))) { int = m[1].replace(/['’ ]/g, ''); frac = m[2] || ''; grouped = true; }
  else if ((m = /^(\d{1,3}(?:\.\d{3})+),(\d+)$/.exec(s)) || (m = /^(\d{1,3}(?:,\d{3})+)\.(\d+)$/.exec(s))) { int = m[1].replace(/[.,]/g, ''); frac = m[2]; grouped = true; }
  else if ((m = /^(\d{1,3}(?:,\d{3})+)$/.exec(s)) || (m = /^(\d{1,3}(?:\.\d{3}){2,})$/.exec(s))) { int = m[1].replace(/[.,]/g, ''); grouped = true; }
  else if ((m = /^(\d+)[.,](\d+)$/.exec(s))) { int = m[1]; frac = m[2]; }
  else if ((m = /^(\d+)$/.exec(s))) { int = m[1]; }
  else return asText;
  if ((int.length > 1 && int[0] === '0') || int.length + frac.length > 15) return asText;
  let value = Number(`${int}${frac ? `.${frac}` : ''}`);
  if (neg) value = -value;
  let fmt = `${grouped || cur ? '#,##0' : '0'}${frac ? `.${'0'.repeat(frac.length)}` : ''}`;
  if (pct) { value = Math.round(value * 1e10) / 1e12; fmt = `0${frac ? `.${'0'.repeat(frac.length)}` : ''}%`; }
  if (cur) fmt = curEnd ? `${fmt} "${cur}"` : `"${cur}" ${fmt}`;
  return { value, type: 'number', ...(fmt === '0' ? {} : { numFmt: fmt }) };
}
const isNumeric = (t) => { const v = parseValue(t); return v.type !== 'text'; };

/** Alignment of a column from the edges of its cells: [{ x0, x1, text }] -> 'left' | 'right' | 'center'. */
function columnAlign(cells) {
  const c = cells.filter((x) => x.text);
  if (!c.length) return 'left';
  const L = spread(c.map((x) => x.x0)); const R = spread(c.map((x) => x.x1)); const C = spread(c.map((x) => (x.x0 + x.x1) / 2));
  const numeric = c.filter((x) => isNumeric(x.text)).length >= c.length * 0.6;
  if (c.length >= 2) {
    if (R <= 1.5 && L > 2.5) return 'right';
    if (C <= 1.5 && L > 2.5 && R > 2.5) return 'center';
    if (numeric && R <= L) return 'right';
    return 'left';
  }
  return 'left';
}

/** Tables from the line grid. */
function ruledTables(words, lines, tol) {
  const g = lineGrid(lines, tol);
  if (g.drawing) return [];
  const cells = g.cells.filter((c) => c[2] - c[0] >= 8 && c[3] - c[1] >= 6);
  // Cells that share an edge belong to the same table.
  const parent = cells.map((_, k) => k);
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const share = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 2;
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i]; const b = cells[j];
    const side = (Math.abs(a[2] - b[0]) <= tol || Math.abs(a[0] - b[2]) <= tol) && share(a[1], a[3], b[1], b[3]);
    const stack = (Math.abs(a[1] - b[3]) <= tol || Math.abs(a[3] - b[1]) <= tol) && share(a[0], a[2], b[0], b[2]);
    if (side || stack) parent[find(i)] = find(j);
  }
  const groups = new Map();
  cells.forEach((c, k) => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const uniq = (vals) => { const o = []; for (const v of [...vals].sort((p, q) => p - q)) if (!o.length || v - o[o.length - 1] > tol) o.push(v); return o; };
    const colX = uniq(list.flatMap((c) => [c[0], c[2]])); const rowY = uniq(list.flatMap((c) => [c[1], c[3]])).reverse();
    const nc = colX.length - 1; const nr = rowY.length - 1;
    // Only one column (e.g. a frame with horizontal separators): the columns then result from the text.
    if (nc < 2 || nr < 1) continue;
    const ix = (arr, v) => arr.reduce((best, x, k) => (Math.abs(x - v) < Math.abs(arr[best] - v) ? k : best), 0);
    const grid = Array.from({ length: nr }, () => new Array(nc).fill(null));
    const tcells = [];
    for (const c of list) {
      const c0 = ix(colX, c[0]); const c1 = ix(colX, c[2]); const r0 = ix(rowY, c[3]); const r1 = ix(rowY, c[1]);
      if (c1 <= c0 || r1 <= r0) continue;
      const inside = words.filter((w) => centerIn(w.rect, c));
      const cell = { r: r0, c: c0, rowSpan: r1 - r0, colSpan: c1 - c0, rect: c, words: inside, text: cellText(inside, c[2] - c[0] - 6) };
      // Alignment in the cell: distance of the text to the left and right edge.
      if (inside.length) {
        const l = Math.min(...inside.map((w) => w.rect[0])) - c[0]; const r = c[2] - Math.max(...inside.map((w) => w.rect[2]));
        cell.gapL = l; cell.gapR = r;
      }
      tcells.push(cell);
      for (let r = r0; r < r1; r++) for (let k = c0; k < c1; k++) grid[r][k] = cell;
    }
    if (tcells.filter((c) => c.text).length < 2) continue;
    // Gaps in the grid (a line is missing there): empty cells without a border so the table stays rectangular.
    for (let r = 0; r < nr; r++) for (let k = 0; k < nc; k++) if (!grid[r][k]) { const cell = { r, c: k, rowSpan: 1, colSpan: 1, rect: [colX[k], rowY[r + 1], colX[k + 1], rowY[r]], words: [], text: '', open: true }; grid[r][k] = cell; tcells.push(cell); }
    // Alignment per column (single-column cells), otherwise per cell.
    for (let k = 0; k < nc; k++) {
      const col = tcells.filter((c) => c.c === k && c.colSpan === 1 && c.text);
      const R = spread(col.map((c) => c.gapR)); const L = spread(col.map((c) => c.gapL));
      const numeric = col.filter((c) => isNumeric(c.text)).length >= col.length * 0.6;
      let align = 'left';
      if (col.length >= 2) { if ((R <= 1.5 && L > 2.5) || (numeric && R <= L && median(col.map((c) => c.gapR)) < median(col.map((c) => c.gapL)))) align = 'right'; else if (spread(col.map((c) => c.gapL - c.gapR)) <= 2 && L > 2.5 && R > 2.5) align = 'center'; }
      for (const c of col) c.align = align;
    }
    for (const c of tcells) {
      if (c.align || !c.text) { c.align = c.align || 'left'; continue; }
      c.align = c.gapR < c.gapL * 0.5 && c.gapL > 6 ? 'right' : Math.abs(c.gapL - c.gapR) <= Math.max(2, (c.rect[2] - c.rect[0]) * 0.08) && c.gapL > 6 ? 'center' : 'left';
    }
    tcells.sort((p, q) => p.r - q.r || p.c - q.c);
    out.push({ ruled: true, rect: [colX[0], rowY[nr], colX[nc], rowY[0]], colX, rowY, rows: nr, cols: nc, cells: tcells });
  }
  return out;
}

/** Tables without lines: consecutive lines whose sections are in the same columns. */
function alignedTables(words) {
  const rows = textRows(words);
  const out = [];
  // Columns of a block: connected areas that any line occupies. In between there is continuous white space.
  const columns = (block) => {
    const h = median(block.map((r) => r.height));
    const iv = block.flatMap((r) => r.segs.map((s) => [s.x0, s.x1])).sort((p, q) => p[0] - q[0]);
    const cols = [];
    for (const v of iv) { const last = cols[cols.length - 1]; if (last && v[0] - last[1] < Math.max(h * 0.6, 5)) last[1] = Math.max(last[1], v[1]); else cols.push(v.slice()); }
    return cols;
  };
  let i = 0;
  while (i < rows.length) {
    if (rows[i].segs.length < 2) { i++; continue; }
    const block = [rows[i]]; let j = i + 1;
    while (j < rows.length) {
      const prev = block[block.length - 1]; const r = rows[j];
      if (prev.y - r.y > Math.max(prev.height, r.height) * 3.2) break;
      const now = columns(block); const next = columns([...block, r]);
      // A line that runs across columns is running text: the table ends before it.
      if (next.length < now.length || next.length < 2) break;
      block.push(r); j++;
    }
    // At the end, do not keep lines that fill only one column and come after the last full line
    // (short line of a paragraph below the table).
    while (block.length > 1 && block[block.length - 1].segs.length < 2) { block.pop(); j--; }
    const colsNow = columns(block);
    if (block.length < 2 || colsNow.length < 2 || block.filter((r) => r.segs.length >= 2).length < 2) { i++; continue; }
    // Two text columns side by side (newspaper layout) are not a table: many lines with long texts in both columns.
    const textOf = (r, c) => r.segs.filter((s) => (s.x0 + s.x1) / 2 >= c[0] - 1 && (s.x0 + s.x1) / 2 <= c[1] + 1);
    if (colsNow.length === 2 && block.length >= 6 && colsNow.every((c) => block.reduce((n, r) => n + textOf(r, c).reduce((q, s) => q + s.text.length, 0), 0) / block.length >= 30)) { i = j; continue; }
    // Column boundaries: middle of the white space between the columns.
    const nc = colsNow.length;
    const colX = [colsNow[0][0] - 2]; for (let k = 1; k < nc; k++) colX.push((colsNow[k - 1][1] + colsNow[k][0]) / 2); colX.push(colsNow[nc - 1][1] + 2);
    // Continuation lines: the first column is empty and the line sits close below the previous one (wrapped cell).
    const pitch = median(block.slice(1).map((r, k) => block[k].y - r.y));
    const groups = [];
    for (const r of block) {
      const first = textOf(r, colsNow[0]).length > 0;
      const prev = groups[groups.length - 1];
      if (prev && !first && prev.rows[prev.rows.length - 1].y - r.y < r.height * 1.35 && pitch > r.height * 1.5) prev.rows.push(r); else groups.push({ rows: [r] });
    }
    const nr = groups.length;
    const rowY = [groups[0].rows[0].y + groups[0].rows[0].height];
    for (let r = 1; r < nr; r++) { const up = groups[r - 1].rows[groups[r - 1].rows.length - 1]; const dn = groups[r].rows[0]; rowY.push((up.y - up.height * 0.25 + dn.y + dn.height) / 2); }
    const lastRow = groups[nr - 1].rows[groups[nr - 1].rows.length - 1]; rowY.push(lastRow.y - lastRow.height * 0.3);
    const tcells = [];
    for (let r = 0; r < nr; r++) for (let k = 0; k < nc; k++) {
      const segs = groups[r].rows.flatMap((row) => textOf(row, colsNow[k]));
      const ws = segs.flatMap((s) => s.words);
      tcells.push({ r, c: k, rowSpan: 1, colSpan: 1, rect: [colX[k], rowY[r + 1], colX[k + 1], rowY[r]], words: ws, text: groups[r].rows.map((row) => textOf(row, colsNow[k]).map((s) => s.text).join(' ')).filter(Boolean).join('\n'), x0: ws.length ? Math.min(...ws.map((w) => w.rect[0])) : 0, x1: ws.length ? Math.max(...ws.map((w) => w.rect[2])) : 0 });
    }
    for (let k = 0; k < nc; k++) { const align = columnAlign(tcells.filter((c) => c.c === k)); for (const c of tcells) if (c.c === k) c.align = align; }
    out.push({ ruled: false, rect: [colX[0], rowY[nr], colX[nc], rowY[0]], colX, rowY, rows: nr, cols: nc, cells: tcells });
    i = j;
  }
  return out;
}

/**
 * Detects the tables of a page.
 * input: { words: [{ text, rect, y, height }], lines: [{ x0, y0, x1, y1 }], tol? }. Coordinates: y upwards.
 * Returns tables from top to bottom: [{ ruled, rect, colX, rowY, rows, cols, cells }], cells as
 * { r, c, rowSpan, colSpan, text, align, rect, words, open? } in reading order. rowY runs from top to bottom.
 * Merged cells only result from lines (ruled); open: cell without a border (a line is missing there).
 */
export function detectTables(input) {
  const words = input.words || []; const tol = input.tol || 1.5;
  const ruled = ruledTables(words, input.lines || [], tol);
  const inRuled = (w) => ruled.some((t) => centerIn(w.rect, [t.rect[0] - 1, t.rect[1] - 1, t.rect[2] + 1, t.rect[3] + 1]));
  const loose = alignedTables(words.filter((w) => !inRuled(w)));
  return [...ruled, ...loose].sort((p, q) => q.rect[3] - p.rect[3] || p.rect[0] - q.rect[0]);
}

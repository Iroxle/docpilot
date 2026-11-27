// Detect form fields automatically: logic without interface.
// From the drawn lines, boxes and circles of a page and from its text, positions to fill in are
// derived: lines and underscores (text fields), empty boxes and table cells (text fields), small
// squares (check boxes), circles (radio buttons) and signature lines (signature fields).
import { tokenize, pageContentBytes, apply, mul } from './content.js';

const lumOf = (n) => (n.length === 1 ? n[0] : n.length === 3 ? 0.299 * n[0] + 0.587 * n[1] + 0.114 * n[2] : n.length === 4 ? 1 - Math.min(1, 0.3 * n[0] + 0.59 * n[1] + 0.11 * n[2] + n[3]) : 0.5);

/**
 * Reads the vector graphics of a page from the content stream: horizontal and vertical lines (also the edges of
 * rectangles and very thin filled rectangles) and circles. Coordinates as in the page content.
 * Content in embedded objects (form XObjects) is not read.
 * Returns { lines: [{ x0, y0, x1, y1 }], circles: [{ rect }] }.
 */
export function pageGraphics(page) {
  const ops = tokenize(pageContentBytes(page));
  let ctm = [1, 0, 0, 1, 0, 0];
  let gs = { fill: 0, stroke: 0 };
  const stack = [];
  let subs = []; let cur = null;
  const lines = []; const circles = [];
  const P = (x, y) => apply(ctm, x, y);
  const seg = (a, b) => {
    if (Math.abs(a[1] - b[1]) <= 0.7 && Math.abs(a[0] - b[0]) >= 2) lines.push({ x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: (a[1] + b[1]) / 2, y1: (a[1] + b[1]) / 2 });
    else if (Math.abs(a[0] - b[0]) <= 0.7 && Math.abs(a[1] - b[1]) >= 2) lines.push({ x0: (a[0] + b[0]) / 2, x1: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
  };
  const box = (x0, y0, x1, y1) => { seg([x0, y0], [x1, y0]); seg([x0, y1], [x1, y1]); seg([x0, y0], [x0, y1]); seg([x1, y0], [x1, y1]); };
  const paint = (stroke, fill) => {
    for (const s of subs) {
      if (s.pts.length < 2) continue;
      const xs = s.pts.map((p) => p[0]); const ys = s.pts.map((p) => p[1]);
      const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
      const w = x1 - x0; const h = y1 - y0;
      if (s.curves >= 4 && s.straight <= 1) {
        // Circle: only as an outline. A filled dark dot is a bullet.
        if ((stroke || (fill && gs.fill > 0.8)) && Math.abs(w - h) <= 0.2 * Math.max(w, h) && w >= 5 && w <= 26) circles.push({ rect: [x0, y0, x1, y1] });
        continue;
      }
      // Very thin rectangle (a line drawn as an area, e.g. an underline from Word): a line.
      if (Math.min(w, h) <= 2.5 && !s.curves && s.pts.length >= 4) {
        if (stroke || (fill && gs.fill < 0.985)) { if (w >= h) seg([x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]); else seg([(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]); }
        continue;
      }
      // Rectangle (also with rounded corners): all points lie on the edge of the bounding area.
      const edge = (p) => Math.min(Math.abs(p[0] - x0), Math.abs(p[0] - x1)) <= 0.7 || Math.min(Math.abs(p[1] - y0), Math.abs(p[1] - y1)) <= 0.7;
      const rectLike = (s.closed || s.pts.length >= 5) && s.pts.length >= 4 && s.pts.every(edge);
      if (rectLike && !s.curves) {
        const corners = new Set(s.pts.map((p) => `${Math.abs(p[0] - x0) <= 0.7 ? 0 : Math.abs(p[0] - x1) <= 0.7 ? 1 : 2}${Math.abs(p[1] - y0) <= 0.7 ? 0 : Math.abs(p[1] - y1) <= 0.7 ? 1 : 2}`));
        if (!['00', '01', '10', '11'].every((c) => corners.has(c))) { if (stroke) for (let k = 1; k < s.pts.length; k++) seg(s.pts[k - 1], s.pts[k]); continue; }
      }
      if (rectLike) {
        if (stroke) box(x0, y0, x1, y1);
        // Lightly filled rectangle of field size without a border: an input box. Dark areas are bars.
        else if (fill && gs.fill < 0.985 && gs.fill >= 0.8 && h >= 9 && h <= 60 && w >= 24) box(x0, y0, x1, y1);
        continue;
      }
      if (s.curves) continue;
      if (stroke) { for (let k = 1; k < s.pts.length; k++) seg(s.pts[k - 1], s.pts[k]); if (s.closed) seg(s.pts[s.pts.length - 1], s.pts[0]); }
    }
    subs = []; cur = null;
  };
  for (const o of ops) {
    const n = o.args.map((x) => x.v);
    switch (o.op) {
      case 'q': stack.push({ ctm, gs: { ...gs } }); break;
      case 'Q': { const s = stack.pop(); if (s) { ctm = s.ctm; gs = s.gs; } break; }
      case 'cm': ctm = mul(n, ctm); break;
      case 'm': cur = { pts: [P(n[0], n[1])], closed: false, curves: 0, straight: 0 }; subs.push(cur); break;
      case 'l': if (cur) { cur.pts.push(P(n[0], n[1])); cur.straight++; } break;
      case 'c': if (cur) { cur.pts.push(P(n[4], n[5])); cur.curves++; } break;
      case 'v': case 'y': if (cur) { cur.pts.push(P(n[2], n[3])); cur.curves++; } break;
      case 'h': if (cur) cur.closed = true; break;
      case 're': {
        const [x, y, w, h] = n;
        cur = { pts: [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)], closed: true, curves: 0, straight: 4 }; subs.push(cur); cur = null; break;
      }
      case 'S': paint(true, false); break;
      case 's': if (cur) cur.closed = true; paint(true, false); break;
      case 'f': case 'F': case 'f*': paint(false, true); break;
      case 'B': case 'B*': paint(true, true); break;
      case 'b': case 'b*': if (cur) cur.closed = true; paint(true, true); break;
      case 'n': subs = []; cur = null; break;
      case 'g': case 'rg': case 'k': gs.fill = lumOf(n); break;
      case 'G': case 'RG': case 'K': gs.stroke = lumOf(n); break;
      case 'sc': case 'scn': gs.fill = n.every((v) => typeof v === 'number') ? lumOf(n) : 0.5; break;
      case 'SC': case 'SCN': gs.stroke = n.every((v) => typeof v === 'number') ? lumOf(n) : 0.5; break;
      default: break;
    }
  }
  return { lines, circles };
}

/**
 * Lines in a grayscale image (scanned form): long, thin, dark runs, horizontal and vertical.
 * G: { g, width, height }, o: { minLen, maxThick, dark? } in pixels. Returns [{ x0, y0, x1, y1 }] in pixels.
 * Areas (photos, bars) drop out because they are thicker than maxThick.
 */
export function rasterLines(G, o) {
  const { g, width: W, height: H } = G; const T = o.dark || 150;
  const out = [];
  const pass = (na, nb, sa, sb, emit) => {
    let open = [];
    const done = (q) => { const len = q.a1 - q.a0; if (q.b1 - q.b0 + 1 <= o.maxThick + len * 0.012) emit(q.a0, q.a1, (q.b0 + q.b1 + 1) / 2); };
    for (let b = 0; b < nb; b++) {
      const next = [];
      let a = 0;
      while (a < na) {
        if (g[a * sa + b * sb] >= T) { a++; continue; }
        const a0 = a; let last = a;
        while (a < na && a - last <= 1) { if (g[a * sa + b * sb] < T) last = a; a++; }
        a = last + 1;
        if (a - a0 < o.minLen) continue;
        // The same stroke as in the row before (overlaps in length): continue it.
        const m = open.find((q) => !q.hit && q.a0 < a && q.a1 > a0);
        if (m) { m.hit = true; m.a0 = Math.min(m.a0, a0); m.a1 = Math.max(m.a1, a); m.b1 = b; next.push(m); }
        else next.push({ a0, a1: a, b0: b, b1: b, hit: true });
      }
      for (const q of open) if (!q.hit) done(q);
      for (const q of next) q.hit = false;
      open = next;
    }
    for (const q of open) done(q);
  };
  pass(W, H, 1, W, (a0, a1, b) => out.push({ x0: a0, x1: a1, y0: b, y1: b }));
  pass(H, W, W, 1, (a0, a1, b) => out.push({ x0: b, x1: b, y0: a0, y1: a1 }));
  return out;
}

/**
 * Arranges lines into a grid: horizontal (H) and vertical (V) lines, pieces of the same line joined, and
 * from them the smallest closed rectangles (cells: [x0, y0, x1, y1]), i.e. boxes and table cells.
 * lines: [{ x0, y0, x1, y1 }], tol: tolerance for lines meeting.
 */
export function lineGrid(lines, tol = 1.5) {
  // 2. Arrange lines: horizontal (H) and vertical (V), join pieces of the same line (dashed, drawn twice).
  const merge = (list) => {
    list.sort((p, q) => p.pos - q.pos || p.a - q.a);
    const out = [];
    for (const l of list) {
      const m = out.find((q) => Math.abs(q.pos - l.pos) <= tol * 0.7 && l.a <= q.b + 3 && l.b >= q.a - 3);
      if (m) { m.a = Math.min(m.a, l.a); m.b = Math.max(m.b, l.b); } else out.push({ ...l });
    }
    return out;
  };
  let Hl = []; let Vl = [];
  for (const l of lines) {
    if (Math.abs(l.y1 - l.y0) <= 0.9) Hl.push({ pos: (l.y0 + l.y1) / 2, a: Math.min(l.x0, l.x1), b: Math.max(l.x0, l.x1) });
    else if (Math.abs(l.x1 - l.x0) <= 0.9) Vl.push({ pos: (l.x0 + l.x1) / 2, a: Math.min(l.y0, l.y1), b: Math.max(l.y0, l.y1) });
  }
  Hl = merge(Hl); Vl = merge(Vl);
  // Very many lines: a drawing or a diagram, not a form. Then only evaluate underscores and characters.
  const drawing = Hl.length + Vl.length > 2500;

  // 3. Cells: smallest closed rectangles from the lines (boxes, table cells).
  const cells = [];
  if (!drawing) {
    const uniq = (list) => { const o = []; for (const v of [...list].sort((p, q) => p - q)) if (!o.length || v - o[o.length - 1] > tol) o.push(v); return o; };
    const xs = uniq(Vl.map((l) => l.pos)); const ys = uniq(Hl.map((l) => l.pos)).reverse();
    const hAt = (y, x0, x1) => Hl.some((l) => Math.abs(l.pos - y) <= tol && l.a <= x0 + tol && l.b >= x1 - tol);
    const vAt = (x, y0, y1) => Vl.some((l) => Math.abs(l.pos - x) <= tol && l.a <= y0 + tol && l.b >= y1 - tol);
    const descends = (x, y) => Vl.some((l) => Math.abs(l.pos - x) <= tol && l.b >= y - tol && l.a <= y - 4);
    for (const yt of ys) {
      for (let i = 0; i < xs.length - 1; i++) {
        const xl = xs[i];
        if (!descends(xl, yt)) continue;
        let xr = null;
        for (let j = i + 1; j < xs.length; j++) {
          const x = xs[j];
          if (x - xl < 4) continue;
          if (!hAt(yt, xl, x)) break;
          if (descends(x, yt)) { xr = x; break; }
        }
        if (xr === null) continue;
        for (const y of ys) {
          if (y > yt - 4) continue;
          if (!vAt(xl, y, yt) || !vAt(xr, y, yt)) break;
          if (hAt(y, xl, xr)) { cells.push([xl, y, xr, yt]); break; }
        }
      }
    }
  }
  return { H: Hl, V: Vl, cells, drawing };
}

// Boxes and circles as characters (also the boxes from Wingdings that Word uses for forms).
const BOX_CH = /[☐□▢❏❐❑❒⬜◻]/u;
const RING_CH = /[○◯⚪]/u;
const SPECIAL = /_{3,}|\.{5,}|…{2,}|[☐□▢❏❐❑❒⬜◻○◯⚪]/gu;
const SIGN = /unterschrift|unterzeichn|signatur|signature|visum|gezeichnet/i;

const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const xOverlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
const yOverlap = (a, b) => Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const centerIn = (r, c) => { const x = (r[0] + r[2]) / 2; const y = (r[1] + r[3]) / 2; return x > c[0] && x < c[2] && y > c[1] && y < c[3]; };

/** Field name from a label: without colon, underscores and dots (a dot separates levels in PDF field names). */
export function fieldName(label, fallback = 'Field') {
  const s = String(label || '').replace(/[_…]+/g, ' ').replace(/\./g, ' ').replace(/[:*\s]+$/g, '').replace(/^[\s:*•◦▪□☐○-]+/, '').replace(/\s+/g, ' ').trim();
  return (s.length > 40 ? s.slice(0, 40).replace(/\s+\S*$/, '') : s) || fallback;
}
const LETTER = /^\p{L}$/u;
const LETTER_END = /^\p{L}[:*.]?$/u;
/**
 * Text of the words of a label, left to right. Letter-spaced text ("F U L L   N A M E") arrives as single letters: in a
 * run of three or more single letters on one line, letters whose gap is not wider than the narrowest gap of the run
 * (plus a little) belong to one word, so the label reads "FULL NAME". parts: [{ text, rect, y }].
 */
export function joinWords(parts) {
  const glue = parts.map(() => false);
  const sameLine = (a, b) => a.y === undefined || b.y === undefined || Math.abs(a.y - b.y) <= Math.max(1.5, (a.rect[3] - a.rect[1]) * 0.25);
  for (let a = 0; a < parts.length;) {
    if (!LETTER_END.test(parts[a].text)) { a++; continue; }
    let b = a;
    while (b + 1 < parts.length && LETTER.test(parts[b].text) && LETTER_END.test(parts[b + 1].text) && sameLine(parts[b], parts[b + 1])) b++;
    if (b - a >= 2) {
      const gap = (k) => parts[k].rect[0] - parts[k - 1].rect[2];
      let min = Infinity; let high = 0;
      for (let k = a + 1; k <= b; k++) min = Math.min(min, gap(k));
      for (let k = a; k <= b; k++) high = Math.max(high, parts[k].rect[3] - parts[k].rect[1]);
      for (let k = a + 1; k <= b; k++) glue[k] = gap(k) <= min + Math.max(0.8, high * 0.12);
    }
    a = b + 1;
  }
  return parts.map((w, k) => (k && !glue[k] ? ` ${w.text}` : w.text)).join('');
}
/** Makes a name unique: "Name", "Name 2", "Name 3". taken: set of the names in use (lowercase). */
export function uniqueName(name, taken) {
  let out = name; let n = 2;
  while (taken.has(out.toLowerCase())) out = `${name} ${n++}`;
  taken.add(out.toLowerCase());
  return out;
}

/**
 * Detects form positions on a page.
 * input:
 *   words     words of the page: [{ text, rect: [x0, y0, x1, y1], x, y (baseline), width, height }]
 *   lines     horizontal and vertical lines: [{ x0, y0, x1, y1 }]
 *   circles   circles: [{ rect }]
 *   images    areas with images: [[x0, y0, x1, y1]] (a box with an image in it is not a field)
 *   page      { width, height }
 *   existing  areas of existing fields on the page: [[x0, y0, x1, y1]]
 *   taken     field names in use (Set, lowercase); the new names are added to it
 *   tol       tolerance for lines meeting (scan: larger)
 *   scan      true: lines come from an image (words lie above it as recognized text)
 *   ratio     (text, i) => fraction of the word width up to character i
 * Coordinates: origin bottom left, y upwards, in points.
 * Returns [{ type: 'text'|'multiline'|'checkbox'|'radio'|'signature', rect, name, label, value?, source }].
 */
export function detectFields(input) {
  const { page, existing = [], images = [] } = input;
  const tol = input.tol || 1.5;
  const taken = input.taken || new Set();
  const ratio = input.ratio || ((s, i) => i / Math.max(1, s.length));
  const cands = []; const words = [];

  // 1. Words: extract underscores, rows of dots and box characters. The rest are labels.
  for (const w of input.words || []) {
    const text = w.text; const W = w.rect[2] - w.rect[0];
    const sub = (a, b) => ({ x0: w.rect[0] + ratio(text, a) * W, x1: w.rect[0] + ratio(text, b) * W });
    let last = 0; let m; let special = false;
    const plain = (a, b) => { const t = text.slice(a, b); if (!t.trim()) return; const p = sub(a, b); words.push({ text: t, rect: [p.x0, w.rect[1], p.x1, w.rect[3]], y: w.y, height: w.height }); };
    SPECIAL.lastIndex = 0;
    while ((m = SPECIAL.exec(text))) {
      special = true;
      plain(last, m.index); last = m.index + m[0].length;
      const p = sub(m.index, last);
      if (BOX_CH.test(m[0]) || RING_CH.test(m[0])) {
        const s = Math.min(Math.max(p.x1 - p.x0, w.height * 0.55), w.height * 0.95);
        const cx = (p.x0 + p.x1) / 2; const y0 = w.y - w.height * 0.08;
        cands.push({ kind: RING_CH.test(m[0]) ? 'radio' : 'checkbox', rect: [cx - s / 2, y0, cx + s / 2, y0 + s], source: 'character', prio: 0 });
      } else cands.push({ kind: 'blank', rect: [p.x0, w.y - 2, p.x1, w.y + Math.max(10, w.height * 1.1)], y: w.y, h: w.height, source: 'underscores', prio: 2 });
    }
    if (special) plain(last, text.length); else words.push({ text, rect: w.rect, y: w.y, height: w.height });
  }
  // Underscores on the same baseline that adjoin each other are one position.
  const blanks = cands.filter((c) => c.kind === 'blank').sort((a, b) => b.y - a.y || a.rect[0] - b.rect[0]);
  for (let k = blanks.length - 1; k > 0; k--) {
    const a = blanks[k - 1]; const b = blanks[k];
    if (Math.abs(a.y - b.y) <= 1.5 && b.rect[0] - a.rect[2] <= a.h * 0.6 && b.rect[0] >= a.rect[0]) { a.rect[2] = Math.max(a.rect[2], b.rect[2]); cands.splice(cands.indexOf(b), 1); }
  }
  for (const c of [...cands]) if (c.kind === 'blank' && c.rect[2] - c.rect[0] < 18) cands.splice(cands.indexOf(c), 1);

  // 2./3. Arrange lines and form cells (boxes, table cells).
  const { H: Hl, V: Vl, cells, drawing } = lineGrid(input.lines || [], tol);
  const smallSquare = (c) => { const w = c[2] - c[0]; const h = c[3] - c[1]; return w >= 5 && h >= 5 && w <= 22 && h <= 22 && Math.abs(w - h) <= 0.3 * Math.max(w, h); };
  // Scanned form: text recognition often reads a box itself as a character ("▪", "O", "[]"). Such
  // words belong to the box and not to the label.
  if (input.scan) {
    const squares = cells.filter(smallSquare);
    for (let k = words.length - 1; k >= 0; k--) { const w = words[k]; if (w.text.length <= 3 && squares.some((c) => inter(w.rect, c) >= 0.4 * area(w.rect))) words.splice(k, 1); }
  }
  // A "box" in the middle of a word, much smaller than its font, is the counter of a letter.
  const inLetter = (c) => words.some((w) => w.text.length >= 3 && inter(w.rect, c) > 0.5 * area(c) && c[3] - c[1] < 0.7 * w.height);
  const wordsIn = (c) => words.filter((w) => centerIn(w.rect, c));
  const circles = (input.circles || []).filter((c) => !words.some((w) => centerIn(w.rect, c.rect)));
  for (const c of cells) {
    const w = c[2] - c[0]; const h = c[3] - c[1];
    const inside = wordsIn(c);
    if (smallSquare(c)) { if (!inside.length && !inLetter(c)) cands.push({ kind: 'checkbox', rect: c.slice(), source: 'box', prio: 0 }); continue; }
    if (w < 22 || h < 8) continue;
    if (w > page.width * 0.5 && h > page.height * 0.5) continue;
    if (images.some((r) => inter(r, c) > 0.2 * Math.min(area(r), area(c)))) continue;
    // A box with something else drawn inside it (boxes, circles, lines) is a frame and not a field.
    const inner = [c[0] + 2, c[1] + 2, c[2] - 2, c[3] - 2];
    if (cells.some((o) => o !== c && centerIn(o, inner) && area(o) < area(c)) || circles.some((o) => centerIn(o.rect, inner)) || cands.some((o) => centerIn(o.rect, inner))) continue;
    if (Hl.some((l) => l.pos > inner[1] && l.pos < inner[3] && l.a < inner[2] && l.b > inner[0]) || Vl.some((l) => l.pos > inner[0] && l.pos < inner[2] && l.a < inner[3] && l.b > inner[1])) continue;
    if (!inside.length) { cands.push({ kind: 'cell', rect: [c[0] + 1, c[1] + 1, c[2] - 1, c[3] - 1], source: 'box', prio: 4 }); continue; }
    // Label inside the box ("Name:" at the top left, the rest is free): field in the free part.
    const bx = [Math.min(...inside.map((x) => x.rect[0])), Math.min(...inside.map((x) => x.rect[1])), Math.max(...inside.map((x) => x.rect[2])), Math.max(...inside.map((x) => x.rect[3]))];
    const label = joinWords(inside.sort((p, q) => q.y - p.y || p.rect[0] - q.rect[0]));
    const oneLine = Math.max(...inside.map((x) => x.y)) - Math.min(...inside.map((x) => x.y)) < 3;
    if (!oneLine || !/:\s*$/.test(label)) continue;
    if (c[2] - bx[2] >= Math.max(40, w * 0.4)) cands.push({ kind: 'cell', rect: [bx[2] + 3, c[1] + 1, c[2] - 1, c[3] - 1], label, source: 'box', prio: 4 });
    else if (bx[1] - c[1] >= 12 && c[3] - bx[3] <= 8) cands.push({ kind: 'cell', rect: [c[0] + 1, c[1] + 1, c[2] - 1, bx[1] - 1], label, source: 'box', prio: 4 });
  }
  for (const c of circles) cands.push({ kind: 'radio', rect: c.rect.slice(), source: 'circle', prio: 0 });

  // 4. Labels: words on the same line with normal word spacing form a label. A box,
  //    a circle or a gap in between separates them ("[ ] Yes [ ] No").
  const breakers = cands.filter((c) => c.kind !== 'cell').map((c) => c.rect);
  const sorted = [...words].sort((p, q) => q.y - p.y || p.rect[0] - q.rect[0]);
  const phrases = [];
  for (const w of sorted) {
    const p = phrases.find((q) => Math.abs(q.y - w.y) <= Math.max(1.5, w.height * 0.25) && w.rect[0] - q.rect[2] <= Math.max(q.height, w.height) * 0.9 && w.rect[0] >= q.rect[2] - 1
      && !breakers.some((b) => (b[0] + b[2]) / 2 > q.rect[2] - 1 && (b[0] + b[2]) / 2 < w.rect[0] + 1 && yOverlap(b, q.rect) > 0));
    if (p) { p.parts.push(w); p.rect = [p.rect[0], Math.min(p.rect[1], w.rect[1]), w.rect[2], Math.max(p.rect[3], w.rect[3])]; }
    else phrases.push({ text: w.text, rect: w.rect.slice(), y: w.y, height: w.height, parts: [w] });
  }
  for (const p of phrases) p.text = joinWords(p.parts);
  const blocked = (a, b, band) => cands.some((c) => c.rect[0] >= a - 1 && c.rect[2] <= b + 1 && yOverlap(c.rect, band) > 0);
  /** Label to the left: at the same height, nothing in between (direct) or across other fields. */
  const leftOf = (r, maxGap, direct = true) => {
    let best = null;
    for (const p of phrases) {
      if (p.rect[2] > r[0] + 2 || r[0] - p.rect[2] > maxGap) continue;
      if (yOverlap(p.rect, r) < Math.min(p.rect[3] - p.rect[1], r[3] - r[1]) * 0.35) continue;
      if (direct && blocked(p.rect[2], r[0], r)) continue;
      if (!best || p.rect[2] > best.rect[2]) best = p;
    }
    return best;
  };
  const rightOf = (r, maxGap) => {
    let best = null;
    for (const p of phrases) {
      if (p.rect[0] < r[2] - 2 || p.rect[0] - r[2] > maxGap) continue;
      if (yOverlap(p.rect, r) < Math.min(p.rect[3] - p.rect[1], r[3] - r[1]) * 0.35) continue;
      if (!best || p.rect[0] < best.rect[0]) best = p;
    }
    return best;
  };
  /** Label above: the nearest line above the area that belongs to it horizontally. */
  const above = (r, maxGap) => {
    let best = null;
    for (const p of phrases) {
      const gap = p.rect[1] - r[3];
      if (gap < -3 || gap > maxGap) continue;
      if (xOverlap(p.rect, r) < Math.min(p.rect[2] - p.rect[0], r[2] - r[0]) * 0.4 && !(p.rect[0] >= r[0] - 4 && p.rect[0] <= r[0] + (r[2] - r[0]) * 0.3)) continue;
      if (!best || gap < best.rect[1] - r[3]) best = p;
    }
    return best;
  };

  // 5. Lines to fill in: the space above the line is free. Whether a label belongs to it is decided in step 8.
  /** Free height above a line up to the next text or the next line, at most limit. */
  const freeAbove = (l, limit) => {
    let free = limit;
    for (const w of words) if (xOverlap(w.rect, [l.a, 0, l.b, 0]) > 0 && w.rect[1] > l.pos) free = Math.min(free, w.rect[1] - l.pos - 1);
    for (const o of Hl) if (o !== l && o.pos > l.pos + 3 && o.a < l.b && o.b > l.a) free = Math.min(free, o.pos - l.pos - 1);
    return free;
  };
  if (!drawing) {
    const touchesV = (x, y) => Vl.some((l) => Math.abs(l.pos - x) <= tol + 0.5 && l.a <= y + tol && l.b >= y - tol);
    for (const l of Hl) {
      const len = l.b - l.a;
      if (len < 28) continue;
      // Edge of a box or a table (vertical line at the end): not a writing line.
      if (touchesV(l.a, l.pos) || touchesV(l.b, l.pos)) continue;
      if (cells.some((c) => (Math.abs(c[1] - l.pos) <= tol || Math.abs(c[3] - l.pos) <= tol) && l.a < c[2] && l.b > c[0])) continue;
      const band = [l.a, l.pos - 2, l.b, l.pos + 11];
      // Text on or directly above the line: underlined text or the row of a table.
      if (words.some((w) => xOverlap(w.rect, band) > (w.rect[2] - w.rect[0]) * 0.3 && w.y >= l.pos - 2.5 && w.y <= l.pos + 11)) continue;
      if (freeAbove(l, 14) < 8) continue;
      cands.push({ kind: 'line', l, rect: [l.a, l.pos + 1, l.b, l.pos + freeAbove(l, 14)], source: 'line', prio: 3 });
    }
  }

  // 6. Existing fields and overlaps: what is already a field is not created again.
  const overl = (a, b) => inter(a, b) > 0.3 * Math.min(area(a), area(b));
  let list = cands.filter((c) => area(c.rect) > 0 && !existing.some((r) => overl(r, c.rect)));
  list.sort((p, q) => p.prio - q.prio);
  const kept = [];
  for (const c of list) if (!kept.some((k) => overl(k.rect, c.rect))) kept.push(c);
  list = kept;

  // 7. Group radio buttons: circles in a row or below each other belong to one choice.
  const radios = list.filter((c) => c.kind === 'radio');
  const groups = [];
  for (const r of radios.sort((p, q) => q.rect[1] - p.rect[1] || p.rect[0] - q.rect[0])) {
    const s = r.rect[3] - r.rect[1];
    const g = groups.find((x) => x.some((o) => (Math.abs(o.rect[1] - r.rect[1]) <= s * 0.6 && Math.abs(o.rect[0] - r.rect[0]) <= 220) || (Math.abs(o.rect[0] - r.rect[0]) <= 3 && Math.abs(o.rect[1] - r.rect[1]) <= s * 3.2)));
    if (g) g.push(r); else groups.push([r]);
  }

  // 8. Names from the labels, in reading order, unique.
  const out = [];
  list.sort((p, q) => (Math.abs(q.rect[3] - p.rect[3]) > 6 ? q.rect[3] - p.rect[3] : p.rect[0] - q.rect[0]));
  const groupName = new Map();
  for (const c of list) {
    const r = c.rect; const h = r[3] - r[1];
    if (c.kind === 'checkbox' || c.kind === 'radio') {
      const right = rightOf(r, h * 2.2 + 6);
      const own = right || leftOf(r, h * 2.2 + 6) || above(r, 14);
      if (c.kind === 'checkbox') { out.push({ type: 'checkbox', rect: r, label: own?.text || '', name: uniqueName(fieldName(own?.text, 'Check box'), taken), source: c.source }); continue; }
      const g = groups.find((x) => x.includes(c));
      if (!groupName.has(g)) {
        // Name of the choice: the question to the left of the first option or above it.
        const first = g[0].rect; const all = [Math.min(...g.map((o) => o.rect[0])), Math.min(...g.map((o) => o.rect[1])), Math.max(...g.map((o) => o.rect[2])), Math.max(...g.map((o) => o.rect[3]))];
        const optionLabels = new Set(g.map((o) => rightOf(o.rect, (o.rect[3] - o.rect[1]) * 2.2 + 6)).filter(Boolean));
        const q = [leftOf(first, 200, false), above(all, 22)].find((p) => p && !optionLabels.has(p));
        groupName.set(g, { name: uniqueName(fieldName(q?.text, 'Choice'), taken), values: new Set() });
      }
      const G = groupName.get(g);
      let value = fieldName(right?.text, `Option ${G.values.size + 1}`); let n = 2;
      const base = value; while (G.values.has(value.toLowerCase())) value = `${base} ${n++}`;
      G.values.add(value.toLowerCase());
      out.push({ type: 'radio', rect: r, label: right?.text || '', name: G.name, value, source: c.source });
      continue;
    }
    let label = c.label || '';
    if (c.kind === 'line') {
      // Writing line: label to the left at the same height, small below it ("Place, date", "Signature") or
      // above it. A line without a label is a separator and not a field.
      const l = c.l;
      let lab = leftOf([l.a, l.pos - 3, l.b, l.pos + 9], 150);
      if (!lab && l.b - l.a <= page.width * 0.62) {
        lab = phrases.filter((p) => l.pos - p.rect[3] >= -1 && l.pos - p.rect[3] <= 9 && xOverlap(p.rect, [l.a, 0, l.b, 0]) >= (p.rect[2] - p.rect[0]) * 0.5).sort((p, q) => q.rect[3] - p.rect[3])[0] || null;
      }
      if (!lab) lab = above([l.a, l.pos, l.b, l.pos + 12], 20);
      if (!lab) continue;
      label = lab.text;
      if (SIGN.test(label)) c.rect = [l.a, l.pos + 1, l.b, l.pos + Math.max(c.rect[3] - l.pos, freeAbove(l, 30))];
    } else if (!label) {
      if (c.kind === 'blank') label = (leftOf(r, 150) || above(r, 16))?.text || '';
      else {
        // Boxes and table cells: label directly to the left, otherwise the column header above (with the row header).
        const direct = leftOf(r, 150);
        if (direct) label = direct.text;
        else {
          const top = above(r, 400); const row = leftOf(r, page.width, false);
          label = top ? (row && row.text.length <= 12 ? `${top.text} ${row.text}` : top.text) : (row?.text || '');
        }
      }
    }
    const sig = SIGN.test(label);
    const type = sig ? 'signature' : (c.rect[3] - c.rect[1] >= 38 ? 'multiline' : 'text');
    out.push({ type, rect: c.rect, label, name: uniqueName(fieldName(label, sig ? 'Signature' : 'Text field'), taken), source: c.source });
  }
  return out;
}

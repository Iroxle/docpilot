// Measuring: the drawn geometry of a page for snapping, and the measurements as CSV.
//
// The paths of the page content (and of the forms it draws, with their matrices) are read in user space as straight
// segments; curves are split into a few segments. Snap targets are each edge's or curve's two ends and its middle.
// A snap looks only near the pointer (a grid index) and prefers, within the tolerance: an endpoint, then a midpoint,
// then an intersection of two segments, then the nearest point on a segment. Extraction stops at a limit for very
// large drawings; what was read is used.
// The CSV export lists each measurement with page, type, value and unit; fields that a spreadsheet would read as a
// formula get a leading apostrophe.
//
// Ported from PdfCraft's measure crate (snap, csv) (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors,
// MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFArray, PDFDict, PDFStream, PDFRawStream, PDFRef, PDFContentStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { tokenize } from './content.js';

const N = (s) => PDFName.of(s);
const look = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const LIMITS = { segments: 200000, bytes: 64 << 20, depth: 12 };
const CELL = 24;

function data(s) {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFContentStream) return s.getUnencodedContents();
  if (s instanceof PDFStream) return s.getContents();
  return new Uint8Array(0);
}

/** The geometry of a page: {segs: [[ax, ay, bx, by]], targets: [{p, kind}], truncated} in user space, with a grid index. */
export function pageGeometry(page, limits = LIMITS) {
  const ctx = page.node.context;
  const g = { segs: [], targets: [], truncated: false, bytes: 0 };
  const addSeg = (a, b, mid) => {
    if (g.segs.length >= limits.segments) { g.truncated = true; return; }
    g.segs.push([a[0], a[1], b[0], b[1]]);
    if (mid !== false) g.targets.push({ p: a, kind: 'endpoint' }, { p: b, kind: 'endpoint' }, { p: mid || [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind: 'midpoint' });
  };
  const run = (bytes, res, ctm0, depth) => {
    g.bytes += bytes.length;
    if (g.bytes > limits.bytes) { g.truncated = true; return; }
    let ctm = ctm0; const stack = [];
    let cur = null; let start = null;
    const at = (x, y) => ap(ctm, x, y);
    for (const op of tokenize(bytes)) {
      const v = op.args.map((a) => a.v);
      switch (op.op) {
        case 'q': stack.push(ctm); break;
        case 'Q': if (stack.length) ctm = stack.pop(); break;
        case 'cm': if (v.length === 6) ctm = mul(v, ctm); break;
        case 'm': cur = at(v[0], v[1]); start = cur; break;
        case 'l': { const p = at(v[0], v[1]); if (cur) addSeg(cur, p); cur = p; break; }
        case 'c': case 'v': case 'y': {
          if (!cur) break;
          const [c1, c2, e] = op.op === 'c' ? [at(v[0], v[1]), at(v[2], v[3]), at(v[4], v[5])] : op.op === 'v' ? [cur, at(v[0], v[1]), at(v[2], v[3])] : [at(v[0], v[1]), at(v[2], v[3]), at(v[2], v[3])];
          const bez = (t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * cur[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * e[k]); };
          const pts = [cur, bez(0.25), bez(0.5), bez(0.75), e];
          for (let k = 1; k < pts.length; k++) addSeg(pts[k - 1], pts[k], false);
          g.targets.push({ p: cur, kind: 'endpoint' }, { p: e, kind: 'endpoint' }, { p: pts[2], kind: 'midpoint' });
          cur = e;
          break;
        }
        case 're': {
          const [x, y, w, hgt] = v;
          const c = [at(x, y), at(x + w, y), at(x + w, y + hgt), at(x, y + hgt)];
          for (let k = 0; k < 4; k++) addSeg(c[k], c[(k + 1) % 4]);
          cur = c[0]; start = c[0];
          break;
        }
        case 'h': if (cur && start && Math.hypot(cur[0] - start[0], cur[1] - start[1]) > 1e-9) addSeg(cur, start); cur = start; break;
        case 'Do': {
          if (depth >= limits.depth) { g.truncated = true; break; }
          const xo = res instanceof PDFDict ? look(ctx, res.get(N('XObject'))) : null;
          const s = xo instanceof PDFDict && v[0] ? look(ctx, xo.get(N(v[0]))) : null;
          if (!(s instanceof PDFStream) || look(ctx, s.dict.get(N('Subtype'))) !== N('Form')) break;
          const mt = look(ctx, s.dict.get(N('Matrix')));
          const fm = mt instanceof PDFArray ? mt.asArray().map((x) => look(ctx, x).asNumber()) : [1, 0, 0, 1, 0, 0];
          run(data(s), look(ctx, s.dict.get(N('Resources'))) || res, mul(fm, ctm), depth + 1);
          break;
        }
        default:
      }
      if (g.truncated && g.segs.length >= limits.segments) return;
    }
  };
  const c = page.node.get(N('Contents'));
  const v = look(ctx, c);
  const list = v instanceof PDFArray ? v.asArray().map((r) => look(ctx, r)) : v ? [v] : [];
  const parts = list.map(data);
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; all[o++] = 10; }
  run(all, page.node.Resources(), [1, 0, 0, 1, 0, 0], 0);
  // Grid index: segment and target numbers by cell.
  g.grid = new Map();
  const put = (key, kind, idx) => { let b = g.grid.get(key); if (!b) { b = { s: [], t: [] }; g.grid.set(key, b); } b[kind].push(idx); };
  g.segs.forEach((s, k) => {
    const x0 = Math.floor(Math.min(s[0], s[2]) / CELL); const x1 = Math.floor(Math.max(s[0], s[2]) / CELL);
    const y0 = Math.floor(Math.min(s[1], s[3]) / CELL); const y1 = Math.floor(Math.max(s[1], s[3]) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) put(`${x},${y}`, 's', k);
  });
  g.targets.forEach((t, k) => put(`${Math.floor(t.p[0] / CELL)},${Math.floor(t.p[1] / CELL)}`, 't', k));
  delete g.bytes;
  return g;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
/** The intersection of segments ab and cd, or null. */
export function intersection(a, b, c, d) {
  const r = sub(b, a); const s = sub(d, c);
  const den = cross(r, s);
  if (!Number.isFinite(den) || Math.abs(den) < 1e-12) return null;
  const t = cross(sub(c, a), s) / den; const u = cross(sub(c, a), r) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}
function nearest(p, a, b) {
  const v = sub(b, a); const len = dot(v, v);
  if (len < 1e-18) return a;
  const t = Math.min(1, Math.max(0, dot(sub(p, a), v) / len));
  return [a[0] + v[0] * t, a[1] + v[1] * t];
}

/**
 * The snap for point p (user space) within tolerance (user space units): {point, kind: 'endpoint'|'midpoint'|
 * 'intersection'|'path', distance} or null. o: {endpoints, midpoints, intersections, paths} (all on by default).
 */
export function snapPoint(g, p, tol, o = {}) {
  if (!g || !(tol >= 0)) return null;
  const cells = [];
  const cx0 = Math.floor((p[0] - tol) / CELL); const cx1 = Math.floor((p[0] + tol) / CELL);
  const cy0 = Math.floor((p[1] - tol) / CELL); const cy1 = Math.floor((p[1] + tol) / CELL);
  for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) { const b = g.grid.get(`${x},${y}`); if (b) cells.push(b); }
  const segIdx = [...new Set(cells.flatMap((b) => b.s))];
  const tgtIdx = [...new Set(cells.flatMap((b) => b.t))];
  const best = (kind, pts) => {
    let r = null;
    for (const q of pts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d <= tol && (!r || d < r.distance)) r = { point: q, kind, distance: d }; }
    return r;
  };
  const targets = tgtIdx.map((k) => g.targets[k]);
  if (o.endpoints !== false) { const r = best('endpoint', targets.filter((t) => t.kind === 'endpoint').map((t) => t.p)); if (r) return r; }
  if (o.midpoints !== false) { const r = best('midpoint', targets.filter((t) => t.kind === 'midpoint').map((t) => t.p)); if (r) return r; }
  const near = segIdx.map((k) => g.segs[k]).filter((s) => { const q = nearest(p, [s[0], s[1]], [s[2], s[3]]); return Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol; }).slice(0, 400);
  if (o.intersections !== false) {
    const xs = [];
    for (let a = 0; a < near.length; a++) for (let b = a + 1; b < near.length; b++) {
      const q = intersection([near[a][0], near[a][1]], [near[a][2], near[a][3]], [near[b][0], near[b][1]], [near[b][2], near[b][3]]);
      if (q) xs.push(q);
    }
    const r = best('intersection', xs); if (r) return r;
  }
  if (o.paths !== false) { const r = best('path', near.map((s) => nearest(p, [s[0], s[1]], [s[2], s[3]]))); if (r) return r; }
  return null;
}

/** A CSV field: quoted, quotes doubled, and a leading apostrophe for text a spreadsheet would run as a formula. */
export function csvField(s) {
  const t = String(s ?? '');
  const prefix = /^\s*[=+\-@]/.test(t) || /^[\t\r]/.test(t) ? '\'' : '';
  return `"${prefix}${t.replace(/"/g, '""')}"`;
}
/** Measurements as CSV: rows [{page (0-based), index, type, value, unit, label, author}]. */
export function measurementsCsv(rows) {
  let out = 'Page,Index,Type,Value,Unit,Label,Author\r\n';
  for (const m of rows) out += `${m.page + 1},${m.index + 1},${m.type},${m.value},${csvField(m.unit)},${csvField(m.label)},${csvField(m.author)}\r\n`;
  return out;
}
/** Reads the value and unit from a measurement label such as "Distance: 1,234.5 mm" or "12 m²". */
export function parseMeasurement(text) {
  const m = /(-?[\d,]*\.?\d+)\s*([a-zA-Z]+²?)/.exec(String(text || ''));
  return m ? { value: Number(m[1].replace(/,/g, '')), unit: m[2] } : null;
}

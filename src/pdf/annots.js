// Comments: exchange between the editing model and real PDF annotations.
import { PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFNumber, PDFRef, StandardFonts } from '@cantoo/pdf-lib';
import { getFont, sanitizeFor, wrapText, loadForEdit, saveDoc, isWinAnsi, gcObjects } from './ops.js';

const N = (s) => PDFName.of(s);
const SUBTYPES = {
  Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly', Text: 'note', FreeText: 'freetext',
  Square: 'rect', Circle: 'ellipse', Line: 'line', PolyLine: 'polyline', Polygon: 'polygon', Ink: 'ink', Caret: 'caret', Redact: 'redact', Stamp: 'stamp',
};
const SUBTYPE_OF = Object.fromEntries(Object.entries(SUBTYPES).map(([k, v]) => [v, k]));
Object.assign(SUBTYPE_OF, { arrow: 'Line', cloud: 'Polygon', callout: 'FreeText' });
export const SUBJECT = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikethrough', squiggly: 'Squiggly', note: 'Sticky note', freetext: 'Text box', callout: 'Callout',
  rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', polyline: 'Polyline', polygon: 'Polygon', cloud: 'Cloud', ink: 'Pencil', caret: 'Insert text', redact: 'Redaction', stamp: 'Stamp',
};
const round = (v) => Math.round(v * 1000) / 1000;
export const newId = () => `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

const pdfDate = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
};
function parseDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+\-Z])?(\d{2})?'?(\d{2})?/.exec(s || '');
  if (!m) return null;
  let t = Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
  if (m[7] === '+' || m[7] === '-') t -= (m[7] === '+' ? 1 : -1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000;
  return new Date(t).toISOString();
}
const text = (d, k) => { const v = d.lookup(N(k)); return v && v.decodeText ? v.decodeText() : ''; };
const nums = (d, k) => {
  const a = d.lookupMaybe(N(k), PDFArray);
  if (!a) return null;
  return a.asArray().map((o) => { const n = d.context.lookup(o); return n instanceof PDFNumber ? n.asNumber() : 0; });
};
const num = (d, k, def) => { const v = d.lookupMaybe(N(k), PDFNumber); return v ? v.asNumber() : def; };
function colorArr(a) {
  if (!a || !a.length) return null;
  if (a.length === 1) return [a[0], a[0], a[0]];
  if (a.length === 4) return [(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3])];
  return a.slice(0, 3);
}

function borderWidth(d) {
  const bs = d.lookupMaybe(N('BS'), PDFDict);
  if (bs) return num(bs, 'W', 1);
  const b = nums(d, 'Border');
  return b && b.length >= 3 ? b[2] : 1;
}
function dashOf(d) {
  const bs = d.lookupMaybe(N('BS'), PDFDict);
  if (bs && bs.lookupMaybe(N('S'), PDFName) === N('D')) return nums(bs, 'D') || [3];
  return null;
}
function parseDA(s) {
  const out = { fontSize: 12, textColor: [0, 0, 0] };
  const f = /([\d.]+)\s+Tf/.exec(s || ''); if (f && +f[1] > 0) out.fontSize = +f[1];
  const c = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(s || ''); if (c) out.textColor = [+c[1], +c[2], +c[3]];
  else { const g = /([\d.]+)\s+g\b/.exec(s || ''); if (g) out.textColor = [+g[1], +g[1], +g[1]]; }
  return out;
}

function dictToModel(d, pageIndex) {
  const sub = d.lookupMaybe(N('Subtype'), PDFName);
  const name = sub ? sub.toString().slice(1) : '';
  const type = SUBTYPES[name];
  if (!type) return null;
  const rect = nums(d, 'Rect');
  if (!rect) return null;
  const dp = text(d, 'DPData');
  let extra = {};
  if (dp) { try { extra = JSON.parse(dp); } catch { extra = {}; } }
  if (type === 'stamp' && !dp) return null;
  const a = {
    id: text(d, 'NM') || newId(), type, page: pageIndex,
    rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
    color: colorArr(nums(d, 'C')) || (type === 'freetext' ? null : [1, 0.82, 0]),
    opacity: num(d, 'CA', 1), width: borderWidth(d), contents: text(d, 'Contents'), author: text(d, 'T'), subject: text(d, 'Subj'),
    created: parseDate(text(d, 'CreationDate')), modified: parseDate(text(d, 'M')), replies: [], status: null,
  };
  const dash = dashOf(d); if (dash) a.dash = dash;
  const ic = colorArr(nums(d, 'IC')); if (ic) a.fill = ic;
  const q = nums(d, 'QuadPoints'); if (q) { a.quads = []; for (let i = 0; i + 8 <= q.length; i += 8) a.quads.push(q.slice(i, i + 8)); }
  if (type === 'note') a.icon = (d.lookupMaybe(N('Name'), PDFName) || N('Comment')).toString().slice(1);
  if (type === 'freetext') {
    Object.assign(a, parseDA(text(d, 'DA')));
    a.fill = colorArr(nums(d, 'C'));
    a.color = null;
    const cl = nums(d, 'CL');
    if (cl) { a.type = 'callout'; a.points = []; for (let i = 0; i + 2 <= cl.length; i += 2) a.points.push([cl[i], cl[i + 1]]); }
  }
  if (type === 'line') {
    const l = nums(d, 'L');
    if (l) a.points = [[l[0], l[1]], [l[2], l[3]]];
    const le = d.lookupMaybe(N('LE'), PDFArray);
    if (le && le.size() === 2 && le.lookup(1).toString() !== '/None') a.type = 'arrow';
  }
  if (type === 'polyline' || type === 'polygon') {
    const v = nums(d, 'Vertices');
    if (v) { a.points = []; for (let i = 0; i + 2 <= v.length; i += 2) a.points.push([v[i], v[i + 1]]); }
    if (d.lookupMaybe(N('BE'), PDFDict)) a.type = 'cloud';
  }
  if (type === 'ink') {
    const lists = d.lookupMaybe(N('InkList'), PDFArray);
    a.strokes = lists ? lists.asArray().map((arr) => {
      const v = d.context.lookup(arr, PDFArray).asArray().map((o) => d.context.lookup(o).asNumber());
      const pts = []; for (let i = 0; i + 2 <= v.length; i += 2) pts.push([v[i], v[i + 1]]);
      return pts;
    }) : [];
  }
  return Object.assign(a, extra);
}

/** Gets all editable comments from the document. The entries are removed from the pages in the process. */
export function importAnnotations(doc) {
  const out = new Map();
  const ctx = doc.context;
  const byRef = new Map();
  const replies = [];
  let changed = false;
  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const keep = [];
    const raw = annots.asArray();
    const removedParents = new Set();
    for (const ref of raw) {
      let d;
      try { d = ctx.lookup(ref); } catch { continue; }
      if (!(d instanceof PDFDict)) { continue; }
      const irt = d.get(N('IRT'));
      const sub = d.lookupMaybe(N('Subtype'), PDFName);
      if (irt && sub === N('Text')) {
        replies.push({ irt, d }); changed = true; continue;
      }
      const m = dictToModel(d, pi);
      if (m) {
        if (!out.has(pi)) out.set(pi, []);
        out.get(pi).push(m);
        if (ref instanceof PDFRef) { byRef.set(ref.tag, m); removedParents.add(ref.tag); }
        changed = true;
      } else keep.push(ref);
    }
    const remaining = keep.filter((ref) => {
      const d = ctx.lookup(ref);
      if (d instanceof PDFDict && d.lookupMaybe(N('Subtype'), PDFName) === N('Popup')) {
        const parent = d.get(N('Parent'));
        return !(parent instanceof PDFRef && removedParents.has(parent.tag));
      }
      return true;
    });
    if (remaining.length !== raw.length) {
      if (remaining.length) page.node.set(N('Annots'), ctx.obj(remaining));
      else page.node.delete(N('Annots'));
    }
  });
  const stateReplies = [];
  for (const { irt, d } of replies) {
    const parent = irt instanceof PDFRef ? byRef.get(irt.tag) : null;
    if (!parent) continue;
    const state = text(d, 'State') || (d.lookupMaybe(N('State'), PDFName) || '').toString().slice?.(1);
    if (state) stateReplies.push({ parent, state });
    else parent.replies.push({ id: text(d, 'NM') || newId(), author: text(d, 'T'), contents: text(d, 'Contents'), modified: parseDate(text(d, 'M')) });
  }
  for (const { parent, state } of stateReplies) parent.status = state;
  return { annots: out, changed };
}

export async function stripAndImport(bytes) {
  const doc = await loadForEdit(bytes);
  const { annots, changed } = importAnnotations(doc);
  if (!changed) return { bytes, annots };
  gcObjects(doc);
  return { bytes: await saveDoc(doc), annots };
}

// --- Erscheinungsbilder ------------------------------------------------------------------
const f = (v) => (Number.isFinite(v) ? (Math.round(v * 1000) / 1000).toString() : '0');
const rg = (c) => `${f(c[0])} ${f(c[1])} ${f(c[2])} rg`;
const RG = (c) => `${f(c[0])} ${f(c[1])} ${f(c[2])} RG`;

export function ellipsePath([x0, y0, x1, y1]) {
  const k = 0.5522847498; const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2; const rx = (x1 - x0) / 2; const ry = (y1 - y0) / 2;
  return `${f(cx + rx)} ${f(cy)} m ${f(cx + rx)} ${f(cy + k * ry)} ${f(cx + k * rx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c `
    + `${f(cx - k * rx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + k * ry)} ${f(cx - rx)} ${f(cy)} c `
    + `${f(cx - rx)} ${f(cy - k * ry)} ${f(cx - k * rx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c `
    + `${f(cx + k * rx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - k * ry)} ${f(cx + rx)} ${f(cy)} c h`;
}
/** Cloud border as a list of arcs. Shared by the display and the PDF. */
export function cloudSegments(points, bump = 8) {
  const segs = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i]; const [bx, by] = points[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    const count = Math.max(1, Math.round(len / (bump * 2)));
    const ux = (bx - ax) / count; const uy = (by - ay) / count;
    const nx = -uy; const ny = ux;
    for (let k = 0; k < count; k++) {
      const sx = ax + ux * k; const sy = ay + uy * k;
      segs.push({ from: [sx, sy], c1: [sx + nx * 0.7, sy + ny * 0.7], c2: [sx + ux + nx * 0.7, sy + uy + ny * 0.7], to: [sx + ux, sy + uy] });
    }
  }
  return segs;
}
export function arrowHead([ax, ay], [bx, by], w) {
  const L = Math.max(8, w * 5); const a = Math.atan2(by - ay, bx - ax); const s = 0.45;
  return [[bx - L * Math.cos(a - s), by - L * Math.sin(a - s)], [bx, by], [bx - L * Math.cos(a + s), by - L * Math.sin(a + s)]];
}
const dashOp = (a) => (a.dash ? `[${a.dash.map(f).join(' ')}] 0 d` : '');

function shapeOps(a) {
  const w = a.width ?? 1; const c = a.color || [1, 0, 0];
  const head = `${RG(c)} ${f(w)} w 1 J 1 j ${dashOp(a)}`;
  const paint = (close) => (a.fill ? (close ? 'B' : 'B') : (close ? 'S' : 'S'));
  const fillOp = a.fill ? rg(a.fill) : '';
  switch (a.type) {
    case 'rect': { const [x0, y0, x1, y1] = a.rect; const i = w / 2; return `${head} ${fillOp} ${f(x0 + i)} ${f(y0 + i)} ${f(x1 - x0 - w)} ${f(y1 - y0 - w)} re ${paint(true)}`; }
    case 'ellipse': { const [x0, y0, x1, y1] = a.rect; const i = w / 2; return `${head} ${fillOp} ${ellipsePath([x0 + i, y0 + i, x1 - i, y1 - i])} ${paint(true)}`; }
    case 'line': case 'arrow': {
      const [p0, p1] = a.points;
      let s = `${head} ${f(p0[0])} ${f(p0[1])} m ${f(p1[0])} ${f(p1[1])} l S`;
      if (a.type === 'arrow') { const h = arrowHead(p0, p1, w); s += ` ${f(h[0][0])} ${f(h[0][1])} m ${f(h[1][0])} ${f(h[1][1])} l ${f(h[2][0])} ${f(h[2][1])} l S`; }
      return s;
    }
    case 'polyline': case 'polygon': {
      const body = a.points.map((p, i) => `${f(p[0])} ${f(p[1])} ${i ? 'l' : 'm'}`).join(' ');
      return a.type === 'polygon' ? `${head} ${fillOp} ${body} h ${paint(true)}` : `${head} ${body} S`;
    }
    case 'cloud': {
      const segs = cloudSegments(a.points);
      const body = segs.map((s) => `${f(s.c1[0])} ${f(s.c1[1])} ${f(s.c2[0])} ${f(s.c2[1])} ${f(s.to[0])} ${f(s.to[1])} c`).join(' ');
      return `${head} ${fillOp} ${f(segs[0].from[0])} ${f(segs[0].from[1])} m ${body} h ${paint(true)}`;
    }
    case 'ink':
      return `${head} ${a.strokes.map((st) => st.map((p, i) => `${f(p[0])} ${f(p[1])} ${i ? 'l' : 'm'}`).join(' ') + (st.length === 1 ? ` ${f(st[0][0] + 0.01)} ${f(st[0][1])} l` : '') + ' S').join(' ')}`;
    default: return '';
  }
}
function markupOps(a) {
  const c = a.color || [1, 0.82, 0];
  return a.quads.map((q) => {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = q;
    switch (a.type) {
      case 'highlight': return `${rg(c)} ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l ${f(x4)} ${f(y4)} l ${f(x3)} ${f(y3)} l h f`;
      case 'underline': return `${RG(c)} 1 w ${f(x3)} ${f(y3 + 1)} m ${f(x4)} ${f(y4 + 1)} l S`;
      case 'strikeout': return `${RG(c)} 1 w ${f((x1 + x3) / 2)} ${f((y1 + y3) / 2)} m ${f((x2 + x4) / 2)} ${f((y2 + y4) / 2)} l S`;
      case 'squiggly': {
        let s = `${RG(c)} 0.8 w ${f(x3)} ${f(y3 + 1)} m`; let x = x3; let up = true;
        while (x < x4) { x = Math.min(x + 2, x4); s += ` ${f(x)} ${f(y3 + (up ? 3 : 1))} l`; up = !up; }
        return `${s} S`;
      }
      case 'redact': return `${RG([0.85, 0, 0])} 1 w ${f(x3)} ${f(y3)} ${f(x4 - x3)} ${f(y1 - y3)} re S`;
      default: return '';
    }
  }).join(' ');
}
const NOTE_ICON = (c, [x0, y0]) => `${rg(c)} 0.2 0.2 0.2 RG 0.6 w ${f(x0 + 1)} ${f(y0 + 5)} 18 13 re B ${f(x0 + 5)} ${f(y0 + 5)} m ${f(x0 + 5)} ${f(y0 + 1)} l ${f(x0 + 10)} ${f(y0 + 5)} l h B 0.2 0.2 0.2 rg ${f(x0 + 4)} ${f(y0 + 13)} 12 1 re f ${f(x0 + 4)} ${f(y0 + 10)} 12 1 re f ${f(x0 + 4)} ${f(y0 + 7)} 8 1 re f`;

function textOps(font, fontKey, lines, x, yTop, size, color, lh) {
  let s = `BT /${fontKey} ${f(size)} Tf ${rg(color)} `;
  let y = yTop - size;
  for (const line of lines) {
    s += `1 0 0 1 ${f(x)} ${f(y)} Tm ${font.encodeText(line).toString()} Tj `;
    y -= lh;
  }
  return `${s}ET`;
}

/** Writes the model into the document as real annotations. */
export async function writeAnnotations(doc, annotsByPage, readFont) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const gsMultiply = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 1, CA: 1 }));
  for (const [pi, list] of annotsByPage) {
    const page = pages[pi];
    if (!page) continue;
    for (const a of list) {
      const pad = (a.width ?? 1) + 2;
      let r = a.rect.slice();
      const resources = {};
      let ops = '';
      const opacity = a.opacity ?? 1;
      const gsName = 'GSa';
      const gsAlpha = ctx.register(ctx.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
      const dict = ctx.obj({
        Type: 'Annot', Subtype: SUBTYPE_OF[a.type], F: 4, NM: PDFHexString.fromText(a.id), P: page.ref,
        T: PDFHexString.fromText(a.author || ''), Contents: PDFHexString.fromText(a.contents || ''), Subj: PDFHexString.fromText(a.subject || SUBJECT[a.type] || ''),
        M: PDFString.of(pdfDate(a.modified)), CreationDate: PDFString.of(pdfDate(a.created || a.modified)),
      });
      const setNums = (k, arr) => dict.set(N(k), ctx.obj(arr.map(round)));
      if (a.color) setNums('C', a.color);
      if (opacity !== 1) dict.set(N('CA'), PDFNumber.of(opacity));
      if (a.fill && a.type !== 'freetext' && a.type !== 'callout') setNums('IC', a.fill);
      const bs = ctx.obj({ W: a.width ?? 1, S: a.dash ? 'D' : 'S' });
      if (a.dash) bs.set(N('D'), ctx.obj(a.dash));
      switch (a.type) {
        case 'highlight': case 'underline': case 'strikeout': case 'squiggly': case 'redact': {
          setNums('QuadPoints', a.quads.flat());
          const xs = a.quads.flatMap((q) => [q[0], q[2], q[4], q[6]]); const ys = a.quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
          r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          ops = markupOps(a);
          if (a.type === 'highlight') { resources.ExtGState = { GSm: gsMultiply }; ops = `/GSm gs ${ops}`; }
          break;
        }
        case 'note':
          dict.set(N('Name'), N(a.icon || 'Comment')); dict.set(N('F'), PDFNumber.of(28));
          r = [r[0], r[1], r[0] + 20, r[1] + 20];
          ops = NOTE_ICON(a.color || [1, 0.82, 0], r);
          break;
        case 'caret':
          ops = `${rg(a.color || [0.1, 0.3, 0.8])} ${f(r[0])} ${f(r[1])} m ${f(r[2])} ${f(r[1])} l ${f((r[0] + r[2]) / 2)} ${f(r[3])} l h f`;
          break;
        case 'rect': case 'ellipse':
          dict.set(N('BS'), bs); ops = shapeOps(a);
          break;
        case 'line': case 'arrow': {
          dict.set(N('BS'), bs); setNums('L', a.points.flat());
          if (a.type === 'arrow') dict.set(N('LE'), ctx.obj([N('None'), N('OpenArrow')]));
          const xs = a.points.map((p) => p[0]); const ys = a.points.map((p) => p[1]);
          const extra = a.type === 'arrow' ? Math.max(8, (a.width ?? 1) * 5) : 0;
          r = [Math.min(...xs) - pad - extra, Math.min(...ys) - pad - extra, Math.max(...xs) + pad + extra, Math.max(...ys) + pad + extra];
          ops = shapeOps(a);
          break;
        }
        case 'polyline': case 'polygon': case 'cloud': {
          dict.set(N('BS'), bs); setNums('Vertices', a.points.flat());
          if (a.type === 'cloud') dict.set(N('BE'), ctx.obj({ S: 'C', I: 1 }));
          const xs = a.points.map((p) => p[0]); const ys = a.points.map((p) => p[1]);
          const e = a.type === 'cloud' ? 12 : 0;
          r = [Math.min(...xs) - pad - e, Math.min(...ys) - pad - e, Math.max(...xs) + pad + e, Math.max(...ys) + pad + e];
          ops = shapeOps(a);
          break;
        }
        case 'ink': {
          dict.set(N('BS'), bs);
          dict.set(N('InkList'), ctx.obj(a.strokes.map((s) => s.flat().map(round))));
          const pts = a.strokes.flat(); const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
          r = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
          ops = shapeOps(a);
          break;
        }
        case 'freetext': case 'callout': {
          const size = a.fontSize || 12; const col = a.textColor || [0, 0, 0];
          const content = a.contents || '';
          const font = await getFont(doc, a.fontFamily || (isWinAnsi(content) ? 'Helvetica' : 'Arial'), { bold: a.bold, italic: a.italic }, content, readFont);
          const key = 'Fbm';
          resources.Font = { [key]: font.ref };
          dict.set(N('DA'), PDFString.of(`/Helv ${f(size)} Tf ${rg(col)}`));
          if (a.fill) setNums('C', a.fill); else dict.delete(N('C'));
          const bw = a.borderColor ? (a.width ?? 1) : 0;
          dict.set(N('BS'), ctx.obj({ W: bw, S: 'S' }));
          const [x0, y0, x1, y1] = a.rect;
          let pre = '';
          if (a.type === 'callout' && a.points) {
            setNums('CL', a.points.flat());
            dict.set(N('IT'), N('FreeTextCallout'));
            const c = a.borderColor || [0, 0, 0];
            pre = `${RG(c)} 1 w ${a.points.map((p, i) => `${f(p[0])} ${f(p[1])} ${i ? 'l' : 'm'}`).join(' ')} S `;
            const xs = [x0, x1, ...a.points.map((p) => p[0])]; const ys = [y0, y1, ...a.points.map((p) => p[1])];
            r = [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2];
          }
          const boxOps = a.fill || bw ? `${a.fill ? rg(a.fill) : ''} ${bw ? `${RG(a.borderColor)} ${f(bw)} w` : ''} ${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)} re ${a.fill && bw ? 'B' : a.fill ? 'f' : 'S'}` : '';
          const lines = wrapText(font, sanitizeFor(font, content), size, Math.max(10, x1 - x0 - 6));
          ops = `${pre}${boxOps} q ${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)} re W n ${textOps(font, key, lines, x0 + 3, y1 - 3, size, col, size * 1.2)} Q`;
          break;
        }
        case 'stamp': {
          dict.set(N('Name'), N('Custom'));
          const [x0, y0, x1, y1] = a.rect; const w = x1 - x0; const h = y1 - y0;
          const data = { type: 'stamp', stamp: a.stamp };
          dict.set(N('DPData'), PDFHexString.fromText(JSON.stringify(data)));
          const s = a.stamp || {};
          if (s.image) {
            const bin = Uint8Array.from(atob(s.image), (c) => c.charCodeAt(0));
            const img = s.mime === 'image/png' ? await doc.embedPng(bin) : await doc.embedJpg(bin);
            resources.XObject = { Im0: img.ref };
            ops = `q ${f(w)} 0 0 ${f(h)} ${f(x0)} ${f(y0)} cm /Im0 Do Q`;
          } else {
            const font = await doc.embedFont(StandardFonts.HelveticaBold);
            const sub = await doc.embedFont(StandardFonts.Helvetica);
            resources.Font = { Fbs: font.ref, Fbt: sub.ref };
            const col = s.color || [0.8, 0, 0];
            const title = sanitizeFor(font, s.text || 'STAMP');
            const line2 = s.sub ? sanitizeFor(sub, s.sub) : '';
            const titleH = line2 ? h * 0.46 : h * 0.6;
            let size = titleH;
            size = Math.min(size, (w - 12) / Math.max(0.1, font.widthOfTextAtSize(title, 1)));
            const tx = x0 + (w - font.widthOfTextAtSize(title, size)) / 2;
            const ty = line2 ? y0 + h * 0.46 : y0 + (h - size * 0.72) / 2;
            const lw = Math.max(1, h * 0.04); const inset = lw;
            const ro = Math.min(6, h / 5);
            const rr = (X0, Y0, X1, Y1, R) => `${f(X0 + R)} ${f(Y0)} m ${f(X1 - R)} ${f(Y0)} l ${f(X1)} ${f(Y0)} ${f(X1)} ${f(Y0)} ${f(X1)} ${f(Y0 + R)} c ${f(X1)} ${f(Y1 - R)} l ${f(X1)} ${f(Y1)} ${f(X1)} ${f(Y1)} ${f(X1 - R)} ${f(Y1)} c ${f(X0 + R)} ${f(Y1)} l ${f(X0)} ${f(Y1)} ${f(X0)} ${f(Y1)} ${f(X0)} ${f(Y1 - R)} c ${f(X0)} ${f(Y0 + R)} l ${f(X0)} ${f(Y0)} ${f(X0)} ${f(Y0)} ${f(X0 + R)} ${f(Y0)} c h`;
            ops = `${RG(col)} ${f(lw)} w ${rr(x0 + inset, y0 + inset, x1 - inset, y1 - inset, ro)} S BT /Fbs ${f(size)} Tf ${rg(col)} 1 0 0 1 ${f(tx)} ${f(ty)} Tm ${font.encodeText(title).toString()} Tj ET`;
            if (line2) {
              let s2 = Math.min(h * 0.2, (w - 12) / Math.max(0.1, sub.widthOfTextAtSize(line2, 1)));
              s2 = Math.max(4, s2);
              const t2 = x0 + (w - sub.widthOfTextAtSize(line2, s2)) / 2;
              ops += ` BT /Fbt ${f(s2)} Tf ${rg(col)} 1 0 0 1 ${f(t2)} ${f(y0 + h * 0.16)} Tm ${sub.encodeText(line2).toString()} Tj ET`;
            }
          }
          break;
        }
        default: break;
      }
      if (opacity !== 1 && a.type !== 'highlight') { resources.ExtGState = { ...(resources.ExtGState || {}), [gsName]: gsAlpha }; ops = `/${gsName} gs ${ops}`; }
      else if (opacity !== 1 && a.type === 'highlight') {
        const gs = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'Multiply', ca: opacity, CA: opacity }));
        resources.ExtGState = { GSm: gs };
      }
      setNums('Rect', r);
      const bbox = r.map(round);
      const ap = ctx.flateStream(ops, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox, Resources: resources });
      dict.set(N('AP'), ctx.obj({ N: ctx.register(ap) }));
      const ref = ctx.register(dict);
      page.node.addAnnot(ref);
      for (const rep of a.replies || []) {
        page.node.addAnnot(ctx.register(ctx.obj({
          Type: 'Annot', Subtype: 'Text', Rect: bbox, F: 28, IRT: ref, RT: 'R', NM: PDFHexString.fromText(rep.id),
          T: PDFHexString.fromText(rep.author || ''), Contents: PDFHexString.fromText(rep.contents || ''), M: PDFString.of(pdfDate(rep.modified)), Name: 'Comment',
        })));
      }
      if (a.status) {
        page.node.addAnnot(ctx.register(ctx.obj({
          Type: 'Annot', Subtype: 'Text', Rect: bbox, F: 28, IRT: ref, NM: PDFHexString.fromText(newId()),
          T: PDFHexString.fromText(a.author || ''), Contents: PDFHexString.fromText(''), State: PDFHexString.fromText(a.status), StateModel: PDFHexString.fromText('Review'),
        })));
      }
    }
  }
}

/** Draws the appearances of the comments permanently into the page content. */
export function flattenAnnotationsInDoc(doc) {
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const res = page.node.normalizedEntries().Resources;
    let xo = res.lookupMaybe(N('XObject'), PDFDict);
    if (!xo) { xo = ctx.obj({}); res.set(N('XObject'), xo); }
    let k = 0;
    const keep = [];
    let ops = 'q\n';
    let drew = false;
    for (const ref of annots.asArray()) {
      const d = ctx.lookup(ref);
      const sub = d.lookupMaybe(N('Subtype'), PDFName);
      if (sub === N('Link') || sub === N('Widget') || sub === N('Popup')) { if (sub !== N('Popup')) keep.push(ref); continue; }
      if (d.has(N('IRT'))) continue;
      const ap = d.lookupMaybe(N('AP'), PDFDict);
      const nRef = ap && ap.get(N('N'));
      const st = nRef && ctx.lookup(nRef);
      if (!st || !st.dict) continue;
      const name = `Fl${k++}`;
      xo.set(N(name), nRef);
      const rect = nums(d, 'Rect'); const bbox = nums(st.dict, 'BBox') || rect;
      const m = nums(st.dict, 'Matrix') || [1, 0, 0, 1, 0, 0];
      const cx = [bbox[0], bbox[2], bbox[0], bbox[2]].map((x, i) => m[0] * x + m[2] * [bbox[1], bbox[1], bbox[3], bbox[3]][i] + m[4]);
      const cy = [bbox[0], bbox[2], bbox[0], bbox[2]].map((x, i) => m[1] * x + m[3] * [bbox[1], bbox[1], bbox[3], bbox[3]][i] + m[5]);
      const bx0 = Math.min(...cx); const by0 = Math.min(...cy); const bx1 = Math.max(...cx); const by1 = Math.max(...cy);
      const sx = (rect[2] - rect[0]) / Math.max(0.001, bx1 - bx0); const sy = (rect[3] - rect[1]) / Math.max(0.001, by1 - by0);
      ops += `q ${f(sx)} 0 0 ${f(sy)} ${f(rect[0] - bx0 * sx)} ${f(rect[1] - by0 * sy)} cm /${name} Do Q\n`;
      drew = true;
    }
    ops += 'Q\n';
    if (drew) page.node.addContentStream(ctx.register(ctx.flateStream(ops, {})));
    if (keep.length) page.node.set(N('Annots'), ctx.obj(keep)); else page.node.delete(N('Annots'));
  }
}

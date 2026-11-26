// Interpreter for page content streams: finds text and image operators and can really remove or move them.
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream, PDFStream, PDFOperator, PDFHexString, StandardFontEmbedder } from '@cantoo/pdf-lib';
import { loadForEdit, saveDoc } from './ops.js';
import { unmappedChars } from './glyphs.js';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

export const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
export const inv = (m) => {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
};
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return s;
}
function fromLatin1(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

export function tokenize(b) {
  const ops = [];
  let i = 0; let args = []; let opStart = -1;
  const skip = () => {
    for (;;) {
      if (i < b.length && WS.has(b[i])) i++;
      else if (b[i] === 37) { while (i < b.length && b[i] !== 10 && b[i] !== 13) i++; }
      else return;
    }
  };
  const readString = () => {
    const out = []; let depth = 1; i++;
    while (i < b.length && depth > 0) {
      let c = b[i++];
      if (c === 92) {
        c = b[i++];
        if (c >= 48 && c <= 55) {
          let v = c - 48;
          for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48;
          out.push(v & 255);
        } else if (c === 13) { if (b[i] === 10) i++; } else if (c !== 10) {
          out.push({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[c] ?? c);
        }
      } else if (c === 40) { depth++; out.push(c); } else if (c === 41) { depth--; if (depth) out.push(c); } else out.push(c);
    }
    return { t: 'str', v: out };
  };
  const readHex = () => {
    i++; const d = [];
    while (i < b.length && b[i] !== 62) { if (!WS.has(b[i])) d.push(b[i]); i++; }
    i++;
    if (d.length % 2) d.push(48);
    const out = [];
    for (let k = 0; k < d.length; k += 2) out.push(parseInt(String.fromCharCode(d[k], d[k + 1]), 16));
    return { t: 'str', v: out };
  };
  const readValue = () => {
    skip();
    const c = b[i];
    if (c === 40) return readString();
    if (c === 47) {
      const s = ++i; while (i < b.length && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      return { t: 'name', v: decodeName(latin1(b.subarray(s, i))) };
    }
    if (c === 91) {
      i++; const arr = [];
      for (;;) { skip(); if (i >= b.length) break; if (b[i] === 93) { i++; break; } arr.push(readValue()); }
      return { t: 'arr', v: arr };
    }
    if (c === 60) {
      if (b[i + 1] === 60) {
        i += 2; const arr = [];
        for (;;) { skip(); if (i >= b.length) break; if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; } arr.push(readValue()); }
        return { t: 'dict', v: arr };
      }
      return readHex();
    }
    const s = i;
    while (i < b.length && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === s) { i++; return { t: 'op', v: '' }; }
    const w = latin1(b.subarray(s, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { t: 'num', v: parseFloat(w) };
    return { t: 'op', v: w };
  };
  while (i < b.length) {
    skip();
    if (i >= b.length) break;
    const s = i;
    const v = readValue();
    if (opStart < 0) opStart = s;
    if (v.t !== 'op') { args.push(v); continue; }
    if (v.v === 'BI') {
      // skip inline image
      for (;;) {
        skip();
        if (i >= b.length) break;
        const t = readValue();
        if (t.t === 'op' && t.v === 'ID') break;
      }
      i++;
      while (i < b.length) {
        if (b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= b.length || WS.has(b[i + 2]))) { i += 2; break; }
        i++;
      }
      ops.push({ op: 'BI', args: [], start: opStart, end: i });
    } else ops.push({ op: v.v, args, start: opStart, end: i });
    args = []; opStart = -1;
  }
  return ops;
}
const decodeName = (s) => s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function streamBytes(s) {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  // Content that pdf-lib itself wrote in this session (not saved yet): read it uncompressed.
  if (s && typeof s.getUnencodedContents === 'function') return s.getUnencodedContents();
  if (s instanceof PDFStream) return s.getContents();
  return new Uint8Array(0);
}
export function pageContentBytes(page) {
  const ctx = page.node.context;
  const c = page.node.Contents();
  const parts = [];
  if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) parts.push(streamBytes(ctx.lookup(c.get(i))));
  else if (c) parts.push(streamBytes(c));
  const len = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}

export function fontMetrics(fontDict) {
  if (!fontDict) return { cid: false, width: () => 500, base: '' };
  const sub = fontDict.lookup(PDFName.of('Subtype'));
  const baseObj = fontDict.lookup(PDFName.of('BaseFont'));
  const base = baseObj ? baseObj.toString().slice(1).replace(/^[A-Z]{6}\+/, '') : '';
  if (sub === PDFName.of('Type0')) {
    const df = fontDict.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    const dw = df.lookupMaybe(PDFName.of('DW'), PDFNumber);
    const dflt = dw ? dw.asNumber() : 1000;
    const widths = new Map();
    const w = df.lookupMaybe(PDFName.of('W'), PDFArray);
    if (w) {
      const a = w.asArray().map((o) => df.context.lookup(o));
      for (let i = 0; i < a.length;) {
        const c = a[i].asNumber();
        if (a[i + 1] instanceof PDFArray) { a[i + 1].asArray().forEach((x, k) => widths.set(c + k, df.context.lookup(x).asNumber())); i += 2; }
        else { const e = a[i + 1].asNumber(); const v = a[i + 2].asNumber(); for (let k = c; k <= e && k - c < 70000; k++) widths.set(k, v); i += 3; }
      }
    }
    return { cid: true, width: (c) => widths.get(c) ?? dflt, base };
  }
  const first = fontDict.lookupMaybe(PDFName.of('FirstChar'), PDFNumber);
  const arr = fontDict.lookupMaybe(PDFName.of('Widths'), PDFArray);
  // The 14 standard fonts may come without widths: take them from their font metrics.
  const std = arr ? null : standardWidths(base);
  if (std) return { cid: false, width: (c) => std.get(c) ?? 250, base };
  const list = arr ? arr.asArray().map((o) => { const n = fontDict.context.lookup(o); return n && n.asNumber ? n.asNumber() : 0; }) : null;
  const f0 = first ? first.asNumber() : 0;
  const desc = fontDict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  const mw = desc ? desc.lookupMaybe(PDFName.of('MissingWidth'), PDFNumber) : undefined;
  const dflt = mw ? mw.asNumber() : (/Courier/i.test(base) ? 600 : 500);
  return { cid: false, width: (c) => (list && list[c - f0] !== undefined ? list[c - f0] : dflt), base };
}

const STD14 = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats']);
const stdWidths = new Map();
/** Widths per code of a standard font (WinAnsi; Symbol and ZapfDingbats in their own encoding), or null. */
function standardWidths(base) {
  if (!STD14.has(base)) return null;
  if (!stdWidths.has(base)) {
    let w = null;
    try {
      const e = new StandardFontEmbedder(base);
      w = new Map();
      for (const [code, glyph] of Object.values(e.encoding.unicodeMappings)) if (!w.has(code)) w.set(code, e.font.getWidthOfGlyph(glyph) ?? 250);
    } catch { w = null; }
    stdWidths.set(base, w);
  }
  return stdWidths.get(base);
}

function colorOf(args, space) {
  const n = args.map((a) => a.v);
  if (space === 'g') return [n[0], n[0], n[0]];
  if (space === 'rg') return n.slice(0, 3);
  if (space === 'k') return [(1 - n[0]) * (1 - n[3]), (1 - n[1]) * (1 - n[3]), (1 - n[2]) * (1 - n[3])];
  return [0, 0, 0];
}

/**
 * Marker for text that the editor writes: /DPEdit <</Id (...)>> BDC ... EMC.
 * This way every moved or new text block stays its own object, even if it lies over other text.
 * Other PDF programs ignore unknown markers.
 */
export const EDIT_TAG = 'DPEdit';
/**
 * Marker for an image that was placed on the page as an object (e.g. a screenshot pasted with Ctrl+V):
 * /DPPaste BMC ... Do ... EMC. Such images behave as a whole in the editor, together with their recognized text.
 * Images without the marker can be pieces of a scan (scanners often split pages into strips).
 */
export const PASTE_TAG = 'DPPaste';
function editIdOf(props) {
  if (!props || props.t !== 'dict') return null;
  for (let k = 0; k + 1 < props.v.length; k += 2) {
    if (props.v[k].t === 'name' && props.v[k].v === 'Id' && props.v[k + 1].t === 'str') return String.fromCharCode(...props.v[k + 1].v);
  }
  return null;
}
/**
 * Details about a recognized paragraph (text recognition): /Ocr 1 /Font (Segoe UI) /Bold 1 /Tz 98.5.
 * This tells the editor which font the paragraph has in the image.
 */
function markPropsOf(props) {
  const o = {};
  if (!props || props.t !== 'dict') return o;
  for (let k = 0; k + 1 < props.v.length; k += 2) {
    const key = props.v[k].v; const val = props.v[k + 1];
    if (val.t === 'str') o[key] = String.fromCharCode(...val.v);
    else if (val.t === 'num') o[key] = val.v;
    else if (val.t === 'arr' && val.v.every((x) => x.t === 'num')) o[key] = val.v.map((x) => x.v);
  }
  return o;
}
function ocrPropsOf(o) {
  return o.Ocr ? { font: o.Font || null, bold: !!o.Bold, tz: o.Tz > 0 ? o.Tz : 100 } : null;
}

/**
 * Reads a page and returns text and image objects together with their position in the stream.
 * Each text item also carries the state it is drawn with (state, segments, adv), so that it can be copied exactly
 * (see textCopyOperators). With opts.glyphs, glyphs: [{ x, y, ch }] lists the glyphs that the font maps to no
 * character, with the character recognized from their shape (see glyphs.js).
 */
export function interpret(page, opts = {}) {
  const bytes = pageContentBytes(page);
  const ops = tokenize(bytes);
  const res = page.node.Resources();
  const fontsDict = res ? res.lookupMaybe(PDFName.of('Font'), PDFDict) : null;
  const xobjDict = res ? res.lookupMaybe(PDFName.of('XObject'), PDFDict) : null;
  const glyphs = opts.glyphs ? [] : null;
  const metricsCache = new Map();
  const metrics = (name) => {
    if (!metricsCache.has(name)) {
      let d = null;
      try { d = fontsDict ? fontsDict.lookupMaybe(PDFName.of(name), PDFDict) : null; } catch { /* defekt */ }
      const m = fontMetrics(d);
      if (glyphs && d) m.recover = unmappedChars(d);
      metricsCache.set(name, m);
    }
    return metricsCache.get(name);
  };
  let ctm = [1, 0, 0, 1, 0, 0];
  // fillOps/strokeOps/lw/gs: the operators that set the colors, line width and graphics state, for exact copies.
  let st = { fill: [0, 0, 0], font: null, size: 0, leading: 0, tc: 0, tw: 0, th: 1, rise: 0, tr: 0, fillOps: [], strokeOps: [], lw: null, gs: [] };
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0]; let tlm = tm;
  const items = [];
  // Marked content: text that the editor writes carries its own marker (see EDIT_TAG).
  const marks = [];
  const mark = () => (marks.length ? marks[marks.length - 1] : null);
  const ocr = new Map();
  // Details per editor text block (e.g. background color /Bg) and its location in the stream (BDC to EMC).
  const props = new Map();
  const spans = []; const open = []; const pasted = [];

  const nextLine = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
  const showText = (segments, op) => {
    const m = st.font ? metrics(st.font) : { cid: false, width: () => 500, base: '' };
    const start = mul(mul([st.size * st.th, 0, 0, st.size, 0, st.rise], tm), ctm);
    const x0 = apply(start, 0, 0);
    let adv = 0;
    for (const seg of segments) {
      if (typeof seg === 'number') { adv += (-seg / 1000) * st.size * st.th; continue; }
      const step = m.cid ? 2 : 1;
      for (let i = 0; i + step <= seg.length; i += step) {
        const code = m.cid ? seg[i] * 256 + seg[i + 1] : seg[i];
        if (m.recover?.has(code)) { const p = apply(mul(tm, ctm), adv, st.rise); glyphs.push({ x: p[0], y: p[1], ch: m.recover.get(code) }); }
        adv += ((m.width(code) / 1000) * st.size + st.tc + (!m.cid && code === 32 ? st.tw : 0)) * st.th;
      }
    }
    const end = mul(mul([1, 0, 0, 1, adv, 0], tm), ctm);
    const x1 = [end[4], end[5]];
    const h = mul(mul([st.size * st.th, 0, 0, st.size, 0, st.rise], tm), ctm);
    const top = apply(h, 0, 1);
    const up = [top[0] - x0[0], top[1] - x0[1]];
    const pts = [x0, x1, [x0[0] + up[0], x0[1] + up[1]], [x1[0] + up[0], x1[1] + up[1]]];
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    items.push({
      kind: 'text', op, bbox: [Math.min(...xs), Math.min(...ys) - Math.hypot(...up) * 0.2, Math.max(...xs), Math.max(...ys)],
      font: st.font, baseFont: m.base, fontSize: Math.hypot(up[0], up[1]), color: st.fill, mark: mark(),
      // Invisible text (render mode 3 or 7), e.g. from text recognition over a scan.
      invisible: st.tr === 3 || st.tr === 7,
      // Everything needed to draw the item again elsewhere (matrices and arrays are replaced, never changed).
      state: { ctm, tm, font: st.font, size: st.size, tc: st.tc, tw: st.tw, th: st.th, rise: st.rise, tr: st.tr, fillOps: st.fillOps, strokeOps: st.strokeOps, lw: st.lw, gs: st.gs },
      segments, adv,
    });
    tm = mul([1, 0, 0, 1, adv, 0], tm);
  };
  const strVals = (a) => a.t === 'str' ? [a.v] : a.v.map((e) => (e.t === 'str' ? e.v : e.v));

  for (const o of ops) {
    const a = o.args; const n = a.map((x) => x.v);
    switch (o.op) {
      case 'q': stack.push({ ctm, st: { ...st } }); break;
      case 'Q': { const s = stack.pop(); if (s) { ctm = s.ctm; st = s.st; } break; }
      case 'cm': ctm = mul(n, ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
      case 'Tf': st.font = n[0]; st.size = n[1]; break;
      case 'Tc': st.tc = n[0]; break;
      case 'Tw': st.tw = n[0]; break;
      case 'Tz': st.th = n[0] / 100; break;
      case 'TL': st.leading = n[0]; break;
      case 'Ts': st.rise = n[0]; break;
      case 'Tr': st.tr = n[0]; break;
      case 'Td': nextLine(n[0], n[1]); break;
      case 'TD': st.leading = -n[1]; nextLine(n[0], n[1]); break;
      case 'Tm': tlm = n.slice(0, 6); tm = tlm; break;
      case 'T*': nextLine(0, -st.leading); break;
      case 'Tj': showText([a[0].v], o); break;
      case 'TJ': showText(strVals(a[0]), o); break;
      case "'": nextLine(0, -st.leading); showText([a[0].v], o); break;
      case '"': st.tw = n[0]; st.tc = n[1]; nextLine(0, -st.leading); showText([a[2].v], o); break;
      case 'BMC': marks.push(mark()); open.push(null); pasted.push(a[0]?.v === PASTE_TAG); break;
      case 'BDC': {
        const id = a[0]?.v === EDIT_TAG ? editIdOf(a[1]) : null;
        if (id) { const all = markPropsOf(a[1]); props.set(id, all); const p = ocrPropsOf(all); if (p) ocr.set(id, p); }
        marks.push(id ?? mark());
        open.push(id ? { id, start: o.start, ctm: ctm.slice() } : null); pasted.push(false);
        break;
      }
      case 'EMC': { marks.pop(); pasted.pop(); const s = open.pop(); if (s) spans.push({ ...s, end: o.end }); break; }
      case 'g': st.fill = colorOf(a, 'g'); st.fillOps = [o]; break;
      case 'rg': st.fill = colorOf(a, 'rg'); st.fillOps = [o]; break;
      case 'k': st.fill = colorOf(a, 'k'); st.fillOps = [o]; break;
      case 'cs': st.fillOps = [o]; break;
      case 'sc': case 'scn':
        if (a.length === 1) st.fill = colorOf(a, 'g'); else if (a.length === 3) st.fill = colorOf(a, 'rg'); else if (a.length === 4 && a[3].t === 'num') st.fill = colorOf(a, 'k');
        st.fillOps = [...st.fillOps.filter((x) => x.op === 'cs'), o];
        break;
      case 'G': case 'RG': case 'K': case 'CS': st.strokeOps = [o]; break;
      case 'SC': case 'SCN': st.strokeOps = [...st.strokeOps.filter((x) => x.op === 'CS'), o]; break;
      case 'w': st.lw = o; break;
      case 'gs': st.gs = [...st.gs, o]; break;
      case 'Do': {
        let isImage = false;
        try { const x = xobjDict && xobjDict.lookupMaybe(PDFName.of(n[0]), PDFStream); isImage = !!x && x.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'); } catch { /* defekt */ }
        if (isImage) {
          const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
          const xs = corners.map((p) => p[0]); const ys = corners.map((p) => p[1]);
          items.push({ kind: 'image', op: o, name: n[0], ctm: ctm.slice(), bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pasted: pasted.includes(true) });
        }
        break;
      }
      default: break;
    }
  }
  // endCtm: the transformation that is still in effect after the content (if it does not restore it), for what is appended.
  return { bytes, ops, items, ocr, props, spans, glyphs, endCtm: ctm };
}

const num = (v) => PDFNumber.of(Math.abs(v) < 1e-7 ? 0 : Math.round(v * 1e6) / 1e6);
const hexOf = (bytes) => PDFHexString.of(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
function pdfArg(ctx, a) {
  if (a.t === 'num') return num(a.v);
  if (a.t === 'name') return PDFName.of(a.v);
  if (a.t === 'str') return hexOf(a.v);
  if (a.t === 'arr') return ctx.obj(a.v.map((x) => pdfArg(ctx, x)));
  return null;
}
const copyOp = (ctx, o) => PDFOperator.of(o.op, o.args.map((a) => pdfArg(ctx, a)));

/**
 * Operators that draw the text items (from interpret) once more, moved by dx/dy in page space: same font, size,
 * glyphs, spacing and colors as the original. endCtm: transformation in effect where the operators are appended.
 */
export function textCopyOperators(ctx, items, dx = 0, dy = 0, endCtm = [1, 0, 0, 1, 0, 0]) {
  const out = [];
  const P = (op, args = []) => out.push(PDFOperator.of(op, args));
  const back = inv(endCtm);
  for (const it of items) {
    const s = it.state;
    if (!s?.font || !it.segments) continue;
    if (it.segments.some((x) => typeof x !== 'number' && !x)) continue;
    P('q');
    P('cm', mul(mul(s.ctm, [1, 0, 0, 1, dx, dy]), back).map(num));
    for (const g of s.gs) out.push(copyOp(ctx, g));
    P('w', [s.lw ? pdfArg(ctx, s.lw.args[0] || { t: 'num', v: 1 }) : num(1)]);
    if (s.fillOps.length) for (const o of s.fillOps) out.push(copyOp(ctx, o)); else P('g', [num(0)]);
    if (s.strokeOps.length) for (const o of s.strokeOps) out.push(copyOp(ctx, o)); else P('G', [num(0)]);
    P('BT');
    P('Tf', [PDFName.of(s.font), num(s.size)]);
    P('Tc', [num(s.tc)]); P('Tw', [num(s.tw)]); P('Tz', [num(s.th * 100)]); P('Ts', [num(s.rise)]); P('Tr', [num(s.tr)]);
    P('Tm', s.tm.map(num));
    const segs = it.segments;
    if (segs.length === 1 && typeof segs[0] !== 'number') P('Tj', [hexOf(segs[0])]);
    else P('TJ', [ctx.obj(segs.map((x) => (typeof x === 'number' ? num(x) : hexOf(x))))]);
    P('ET');
    P('Q');
  }
  return out;
}

/**
 * Removes text items (from interpret(page) = r) from the page content. A shown text is replaced by the same
 * advance without glyphs, so that text which follows in the same text object stays exactly where it is.
 * Editor blocks (spans with marker id mark) whose text is removed entirely are removed as a whole.
 */
export function removeTextItems(page, r, items, mark = null) {
  const set = new Set(items);
  const edits = [];
  const whole = mark ? r.spans.filter((s) => s.id === mark && r.items.every((it) => it.kind !== 'text' || it.mark !== mark || set.has(it))) : [];
  const inWhole = (it) => whole.some((s) => it.op.start >= s.start && it.op.end <= s.end);
  for (const s of whole) edits.push({ start: s.start, end: s.end, text: ' ' });
  for (const it of items) {
    if (inWhole(it)) continue;
    const st = it.state; const scale = st ? st.size * st.th : 0;
    const shift = scale && st.tr < 4 ? ` [${((-it.adv * 1000) / scale).toFixed(3)}] TJ ` : ' ';
    const o = it.op;
    if (o.op === "'") edits.push({ start: o.start, end: o.end, text: ` T*${shift}` });
    else if (o.op === '"') edits.push({ start: o.start, end: o.end, text: ` ${o.args[0]?.v ?? 0} Tw ${o.args[1]?.v ?? 0} Tc T*${shift}` });
    else edits.push({ start: o.start, end: o.end, text: shift });
  }
  if (edits.length) rewrite(page, r.bytes, edits);
  return edits.length;
}

/** Text items of a block: those of its editor marker, or the unmarked ones that lie mostly within rect. */
export function blockTextItems(r, rect, mark) {
  return r.items.filter((it) => it.kind === 'text' && (mark ? it.mark === mark : !it.mark && overlapShare(it.bbox, rect) >= 0.5));
}

/** Parts of a rectangle a outside of b (up to four rectangles). */
export function subtractRect(a, b) {
  const ix0 = Math.max(a[0], b[0]); const iy0 = Math.max(a[1], b[1]); const ix1 = Math.min(a[2], b[2]); const iy1 = Math.min(a[3], b[3]);
  if (ix0 >= ix1 || iy0 >= iy1) return [a];
  const out = [];
  if (a[1] < iy0) out.push([a[0], a[1], a[2], iy0]);
  if (iy1 < a[3]) out.push([a[0], iy1, a[2], a[3]]);
  if (a[0] < ix0) out.push([a[0], iy0, ix0, iy1]);
  if (ix1 < a[2]) out.push([ix1, iy0, a[2], iy1]);
  return out.filter((r) => r[2] - r[0] > 0.3 && r[3] - r[1] > 0.3);
}

/**
 * Role of an image on the page:
 * - 'object': an image on its own (pasted screenshot, logo, photo). Text recognized in it belongs to it.
 * - 'page':   fills the page (scan). Recognized paragraphs on it are independent, the image stays in place.
 * - 'piece':  piece of a split scan (scanners and printer drivers often store pages as strips or
 *             tiles that adjoin without gaps). Like 'page'.
 * images: all images on the page ({ bbox, pasted }), pageArea: area of the page.
 */
export function imageRole(img, images, pageArea) {
  if (img.pasted) return 'object';
  const b = img.bbox;
  if ((b[2] - b[0]) * (b[3] - b[1]) >= pageArea * 0.85) return 'page';
  const share = (a0, a1, c0, c1) => (Math.min(a1, c1) - Math.max(a0, c0)) / Math.max(0.01, Math.min(a1 - a0, c1 - c0));
  const touches = (c) => (Math.min(Math.abs(b[1] - c[3]), Math.abs(b[3] - c[1])) <= 2 && share(b[0], b[2], c[0], c[2]) >= 0.5)
    || (Math.min(Math.abs(b[0] - c[2]), Math.abs(b[2] - c[0])) <= 2 && share(b[1], b[3], c[1], c[3]) >= 0.5);
  return images.some((o) => o !== img && !o.pasted && touches(o.bbox)) ? 'piece' : 'object';
}

/**
 * Editor text blocks that lie on an image and belong to it: drawn after the image, and each of their
 * text items has its center inside the image (e.g. the recognized text of a pasted screenshot).
 */
function spansOnImage(r, target) {
  const inside = (b) => { const cx = (b[0] + b[2]) / 2; const cy = (b[1] + b[3]) / 2; return cx >= target.bbox[0] && cx <= target.bbox[2] && cy >= target.bbox[1] && cy <= target.bbox[3]; };
  return r.spans.filter((s) => s.start >= target.op.end).map((s) => ({ ...s, items: r.items.filter((it) => it.kind === 'text' && it.mark === s.id) }))
    .filter((s) => s.items.length > 0 && s.items.every((it) => inside(it.bbox)));
}

/**
 * Extends an image downwards (the image itself was previously extended by the corresponding number of rows) and
 * moves the editor text blocks on the image below splitY down by amount.
 * This way, when typing in a screenshot, everything below moves down, like in Word.
 */
export function growImageInPage(page, match, splitY, amount) {
  const r = interpret(page);
  const target = r.items.find((it) => it.kind === 'image' && match(it));
  if (!target) return false;
  const [, y0, , y1] = target.bbox;
  const sy = (y1 - (y0 - amount)) / Math.max(0.01, y1 - y0);
  const local = (ctm, m) => mul(mul(ctm, m), inv(ctm));
  const f = (v) => (Math.abs(v) < 1e-7 ? '0' : v.toFixed(6));
  const original = latin1(r.bytes.subarray(target.op.start, target.op.end));
  const edits = [{ start: target.op.start, end: target.op.end, text: ` q ${local(target.ctm, [1, 0, 0, sy, 0, y1 - y1 * sy]).map(f).join(' ')} cm ${original} Q ` }];
  for (const s of spansOnImage(r, target)) {
    if (!s.items.every((it) => (it.bbox[1] + it.bbox[3]) / 2 < splitY)) continue;
    edits.push({ start: s.start, end: s.start, text: ` q ${local(s.ctm, [1, 0, 0, 1, 0, -amount]).map(f).join(' ')} cm ` }, { start: s.end, end: s.end, text: ' Q ' });
  }
  rewrite(page, r.bytes, edits);
  return true;
}

function rewrite(page, bytes, edits) {
  const s = latin1(bytes);
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = ''; let pos = 0;
  for (const e of sorted) { out += s.slice(pos, e.start) + e.text; pos = e.end; }
  out += s.slice(pos);
  const ctx = page.node.context;
  const stream = ctx.flateStream(fromLatin1(out), {});
  // As a list, the way pdf-lib expects it after the first drawing (it appends further streams).
  page.node.set(PDFName.of('Contents'), ctx.obj([ctx.register(stream)]));
  // pdf-lib remembers per page the stream it draws into. That one is now replaced: whatever is drawn afterwards
  // must go into a new stream, otherwise it would be lost (e.g. changing several paragraphs of a page in a row).
  page.contentStream = undefined; page.contentStreamRef = undefined;
}

const overlapShare = (b, r) => {
  const w = Math.min(b[2], r[2]) - Math.max(b[0], r[0]);
  const h = Math.min(b[3], r[3]) - Math.max(b[1], r[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = Math.max(0.01, (b[2] - b[0]) * (b[3] - b[1]));
  return (w * h) / area;
};

/**
 * Removes text whose area lies mostly within the rectangles. Returns the number of removed operators.
 * With opts.mark only a specific text block is removed: a marker removes exactly the text marked with it
 * (regardless of what lies below), null only removes unmarked text in the rectangle.
 */
export function removeTextInPage(page, rects, opts = {}) {
  const { bytes, items, spans } = interpret(page);
  const byMark = 'mark' in opts;
  // An editor text block is removed entirely (BDC to EMC), including its background.
  if (byMark && opts.mark) {
    const own = spans.filter((s) => s.id === opts.mark);
    const n = items.filter((it) => it.kind === 'text' && it.mark === opts.mark).length;
    if (own.length && n) { rewrite(page, bytes, own.map((s) => ({ start: s.start, end: s.end, text: ' ' }))); return n; }
  }
  const edits = [];
  for (const it of items) {
    if (it.kind !== 'text') continue;
    if (byMark && opts.mark) { if (it.mark !== opts.mark) continue; }
    else {
      if (byMark && it.mark) continue;
      if (!rects.some((r) => overlapShare(it.bbox, r) >= 0.5)) continue;
    }
    const repl = (it.op.op === "'" || it.op.op === '"') ? ' T* ' : ' ';
    edits.push({ start: it.op.start, end: it.op.end, text: repl });
  }
  if (edits.length) rewrite(page, bytes, edits);
  return edits.length;
}

/**
 * Removes the recognized text (invisible text layer from text recognition) from the pages so it can be
 * recognized again. Visible text stays, including text that was changed by hand in a scan.
 * Returns { bytes, count } (number of removed text items).
 */
export async function removeRecognizedText(bytes, pages) {
  const d = await loadForEdit(bytes);
  let count = 0;
  for (const i of pages) {
    const page = d.getPage(i);
    const r = interpret(page);
    const hidden = r.items.filter((it) => it.kind === 'text' && it.invisible);
    if (!hidden.length) continue;
    // Recognized paragraphs entirely (including their marker), other invisible text item by item.
    const whole = r.spans.filter((s) => r.ocr.has(s.id) && hidden.some((it) => it.mark === s.id) && !r.items.some((it) => it.kind === 'text' && it.mark === s.id && !it.invisible));
    const ids = new Set(whole.map((s) => s.id));
    const edits = whole.map((s) => ({ start: s.start, end: s.end, text: ' ' }));
    for (const it of hidden) if (!ids.has(it.mark)) edits.push({ start: it.op.start, end: it.op.end, text: (it.op.op === "'" || it.op.op === '"') ? ' T* ' : ' ' });
    rewrite(page, r.bytes, edits);
    count += hidden.length;
  }
  return { bytes: await saveDoc(d), count };
}

export function removeImageInPage(page, match) {
  const { bytes, items } = interpret(page);
  const edits = items.filter((it) => it.kind === 'image' && match(it)).map((it) => ({ start: it.op.start, end: it.op.end, text: ' ' }));
  if (edits.length) rewrite(page, bytes, edits);
  return edits.length;
}

/**
 * Moves an image to a new target rectangle. With opts.withText, editor text blocks that lie on the image
 * (recognized text of a screenshot, text changed in it) move along and are scaled the same way.
 */
export function transformImageInPage(page, match, newRect, opts = {}) {
  const r = interpret(page);
  const { bytes, items } = r;
  const target = items.find((it) => it.kind === 'image' && match(it));
  if (!target) return false;
  const [x0, y0, x1, y1] = target.bbox;
  const sx = (newRect[2] - newRect[0]) / Math.max(0.01, x1 - x0);
  const sy = (newRect[3] - newRect[1]) / Math.max(0.01, y1 - y0);
  // Offset in page space, converted into the space that applies at that point in the stream.
  const delta = [sx, 0, 0, sy, newRect[0] - x0 * sx, newRect[1] - y0 * sy];
  const local = (ctm) => mul(mul(ctm, delta), inv(ctm));
  const f = (v) => (Math.abs(v) < 1e-7 ? '0' : v.toFixed(6));
  const original = latin1(bytes.subarray(target.op.start, target.op.end));
  const edits = [{ start: target.op.start, end: target.op.end, text: ` q ${local(target.ctm).map(f).join(' ')} cm ${original} Q ` }];
  if (opts.withText) {
    for (const s of spansOnImage(r, target)) {
      edits.push({ start: s.start, end: s.start, text: ` q ${local(s.ctm).map(f).join(' ')} cm ` }, { start: s.end, end: s.end, text: ' Q ' });
    }
  }
  rewrite(page, bytes, edits);
  return true;
}

export async function listPageObjects(bytes, pageIdx) {
  const d = await loadForEdit(bytes);
  const { items } = interpret(d.getPage(pageIdx));
  return items.map(({ op, ...rest }) => rest);
}

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1.5);

/** Deletes an image; with opts.withText (default) also the editor text blocks that belong to it. */
export async function deleteImage(bytes, pageIdx, bbox, opts = { withText: true }) {
  const d = await loadForEdit(bytes);
  const page = d.getPage(pageIdx);
  const r = interpret(page);
  const target = r.items.find((it) => it.kind === 'image' && near(it.bbox, bbox));
  if (!target) throw new Error('The image was not found in the page content.');
  const edits = [{ start: target.op.start, end: target.op.end, text: ' ' }];
  if (opts.withText) for (const s of spansOnImage(r, target)) edits.push({ start: s.start, end: s.end, text: ' ' });
  rewrite(page, r.bytes, edits);
  return saveDoc(d);
}
/** Moves or scales an image; with opts.withText (default) together with the text that belongs to it. */
export async function moveImage(bytes, pageIdx, bbox, newRect, opts = { withText: true }) {
  const d = await loadForEdit(bytes);
  const page = d.getPage(pageIdx);
  if (!transformImageInPage(page, (it) => near(it.bbox, bbox), newRect, opts)) throw new Error('The image was not found in the page content.');
  return saveDoc(d);
}

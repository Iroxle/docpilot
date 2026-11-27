// Print production: convert colours to grayscale, fix hairlines and add printer marks.
//
// - Convert to grayscale: every colour operator in the page content and in the forms it draws is rewritten as a
//   gray by the standard device formula (luminance 0.299 R + 0.587 G + 0.114 B; CMYK through RGB; pure black stays
//   black). Spaces with a known number of components (device, calibrated, ICC based) are converted; Lab, indexed,
//   Separation, DeviceN and patterns stay. Images are decoded and stored again as gray when they can be (8 bits or
//   fewer per component, RGB, gray or CMYK; JPEG images through the caller's codec); the others are counted.
//   No ICC profile is used, so the result is not calibrated for a press.
// - Fix hairlines: strokes thinner than a printer holds (zero-width lines and lines whose width on the page, after
//   every transformation, is below a threshold) get a chosen width. The width is set just before the path and put
//   back after the stroke, so nothing else changes. Forms are rewritten as a copy for the scale they are drawn at.
// - Printer marks: trim and bleed marks, registration targets, colour bars and a page information line outside the
//   trim box, in registration colour (the /All Separation, so they print on every plate), as a page mark that can be
//   removed like a header. The page is widened when the marks would not fit; the trim box stays where it was.
// Content streams are changed in place: only the operators that change are replaced, every other byte stays.
//
// Ported from PdfCraft's edit crate (convert_colours, hairlines, printer_marks) (Copyright (c) 2026 ArtCraft Team
// and the PdfCraft contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFStream, PDFRawStream, PDFRef, PDFContentStream, PDFHexString, decodePDFRawStream } from '@cantoo/pdf-lib';
import { tokenize } from './content.js';
import { decodeImage, componentsOf, sampleAt, deflate } from './imagedata.js';
import { pageBoxes } from './boxes.js';
import { removeMarks } from './marks.js';

const N = (s) => PDFName.of(s);
const look = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : null);
/** A number as PDF content writes it: up to 4 decimals, no trailing zeros. */
export const n = (v) => { const s = (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return s; };
const bytesOf = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };

function streamData(s) {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFContentStream) return s.getUnencodedContents();
  if (s instanceof PDFStream) return s.getContents();
  return new Uint8Array(0);
}
/** A new stream with the content and the dictionary entries of the old one (tags stay), compressed. */
function restream(ctx, old, bytes) {
  const s = ctx.flateStream(bytes);
  for (const [k, v] of old.dict.entries()) if (!['Filter', 'DecodeParms', 'Length', 'DL'].includes(k.decodeText())) s.dict.set(k, v);
  return s;
}
/** Replaces token ranges in a content stream: edits [{start, end, text}] sorted by start. */
function splice(data, edits) {
  if (!edits.length) return null;
  const parts = []; let at = 0;
  for (const e of edits.sort((a, b) => a.start - b.start || a.order - b.order)) {
    parts.push(latin1(data.subarray(at, e.start)), e.text);
    at = e.end;
  }
  parts.push(latin1(data.subarray(at)));
  return bytesOf(parts.join(''));
}
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const resDict = (ctx, res, key) => { const d = res instanceof PDFDict ? look(ctx, res.get(N(key))) : null; return d instanceof PDFDict ? d : null; };
const pageStreams = (page) => {
  const ctx = page.node.context; const c = page.node.get(N('Contents'));
  const v = look(ctx, c);
  if (v instanceof PDFArray) return v.asArray().map((r) => ({ ref: r, s: look(ctx, r) }));
  return c ? [{ ref: c, s: v, single: true }] : [];
};
/** Writes changed page streams back: each changed stream becomes a new object, the list keeps its order. */
function writeBack(page, list, changed) {
  const ctx = page.node.context;
  if (!changed.size) return;
  const refs = list.map((x, i) => (changed.has(i) ? ctx.register(restream(ctx, x.s, changed.get(i))) : x.ref));
  page.node.set(N('Contents'), list.length === 1 && list[0].single ? refs[0] : ctx.obj(refs));
}

/** Form XObjects drawn by a stream get a copy where they change; the copy is added to the resources under a new name. */
function formCopy(ctx, res, name, newStream, tag) {
  const xo = resDict(ctx, res, 'XObject');
  const ref = ctx.register(newStream);
  let k = 1; while (xo.get(N(`${name}_${tag}${k}`))) k++;
  const nn = `${name}_${tag}${k}`;
  xo.set(N(nn), ref);
  return nn;
}

// --- Grayscale ---------------------------------------------------------------------------------------------
const luma = (r, g, b) => Math.min(1, Math.max(0, 0.299 * r + 0.587 * g + 0.114 * b));
export function toGray(comps) {
  if (comps.length === 1) return comps[0];
  if (comps.length === 3) return comps.every((v) => v < 0.02) ? 0 : luma(...comps);
  if (comps.length === 4) {
    const [c, m, y, k] = comps;
    if (k > 0.98 || (c > 0.98 && m > 0.98 && y > 0.98)) return 0;
    return luma((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
  }
  return null;
}
/** Number of components of a colour space operand (name or resource), or null when it is not converted. */
function spaceComps(ctx, res, operand) {
  if (!operand || operand.t !== 'name') return null;
  const v = operand.v;
  if (['DeviceGray', 'G', 'CalGray'].includes(v)) return 1;
  if (['DeviceRGB', 'RGB'].includes(v)) return 3;
  if (['DeviceCMYK', 'CMYK'].includes(v)) return 4;
  if (v === 'Pattern') return null;
  const cs = resDict(ctx, res, 'ColorSpace');
  const o = cs ? look(ctx, cs.get(N(v))) : null;
  if (!o) return null;
  const first = o instanceof PDFArray ? nameOf(look(ctx, o.get(0))) : nameOf(o);
  if (['Indexed', 'I', 'Separation', 'DeviceN', 'Lab', 'Pattern'].includes(first)) return null;
  return componentsOf(ctx, o);
}

function grayStream(ctx, data, res, state, out, forms) {
  const edits = [];
  const ops = tokenize(data);
  const nums = (args) => args.filter((a) => a.t === 'num').map((a) => a.v);
  for (const op of ops) {
    const set = (text) => { edits.push({ start: op.start, end: op.end, text, order: 0 }); out.colours++; };
    switch (op.op) {
      case 'q': state.stack.push([state.fill, state.stroke]); break;
      case 'Q': if (state.stack.length) [state.fill, state.stroke] = state.stack.pop(); break;
      case 'rg': case 'RG': case 'k': case 'K': {
        const g = toGray(nums(op.args));
        if (g !== null) set(`${n(g)} ${op.op === 'rg' || op.op === 'k' ? 'g' : 'G'}`);
        break;
      }
      case 'cs': case 'CS': {
        const c = spaceComps(ctx, res, op.args[0]);
        const key = op.op === 'cs' ? 'fill' : 'stroke';
        state[key] = c;
        if (c && c !== 1) set(`/DeviceGray ${op.op}`);
        else if (c === 1 && op.args[0].v !== 'DeviceGray') set(`/DeviceGray ${op.op}`);
        break;
      }
      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const c = op.op === 'sc' || op.op === 'scn' ? state.fill : state.stroke;
        const v = nums(op.args);
        if (c && v.length === c && op.args.every((a) => a.t === 'num')) {
          const g = toGray(v);
          if (g !== null && c !== 1) set(`${n(g)} ${op.op}`);
        }
        break;
      }
      case 'Do': {
        const nm = op.args[0]?.v;
        const xo = resDict(ctx, res, 'XObject');
        const ref = xo && nm ? xo.get(N(nm)) : null;
        const s = ref ? look(ctx, ref) : null;
        if (s instanceof PDFStream && nameOf(look(ctx, s.dict.get(N('Subtype')))) === 'Form') forms.push({ ref, s });
        else if (s instanceof PDFStream) out.imageRefs.add(ref);
        break;
      }
      default:
    }
  }
  return splice(data, edits);
}

/** Converts the pages (0-based) of a loaded document to grayscale. Returns {colours, images, imagesLeft, pages}. */
export async function convertToGray(doc, pages = doc.getPageIndices(), o = {}) {
  const ctx = doc.context;
  const out = { colours: 0, images: 0, imagesLeft: 0, pages: 0, imageRefs: new Set() };
  const doneForms = new Set();
  const convertForms = (forms, depth) => {
    for (const f of forms) {
      const key = f.ref.toString();
      if (doneForms.has(key) || depth > 16) continue;
      doneForms.add(key);
      const res = look(ctx, f.s.dict.get(N('Resources')));
      const inner = [];
      const st = { fill: 1, stroke: 1, stack: [] };
      const nb = grayStream(ctx, streamData(f.s), res, st, out, inner);
      // Forms are shared; gray is the same wherever they are drawn, so they change in place.
      if (nb) ctx.assign(f.ref, restream(ctx, f.s, nb));
      convertForms(inner, depth + 1);
    }
  };
  for (const i of pages) {
    const page = doc.getPage(i);
    const before = out.colours;
    const res = page.node.Resources();
    const list = pageStreams(page);
    const st = { fill: 1, stroke: 1, stack: [] };
    const changed = new Map(); const forms = [];
    list.forEach((x, k) => { if (!(x.s instanceof PDFStream)) return; const nb = grayStream(ctx, streamData(x.s), res, st, out, forms); if (nb) changed.set(k, nb); });
    writeBack(page, list, changed);
    convertForms(forms, 0);
    if (o.annotations !== false) {
      const annots = page.node.lookup(N('Annots'));
      if (annots instanceof PDFArray) for (const a of annots.asArray()) {
        const ap = look(ctx, look(ctx, a)?.get?.(N('AP')));
        const nAp = ap instanceof PDFDict ? ap.get(N('N')) : null;
        const s = nAp ? look(ctx, nAp) : null;
        if (s instanceof PDFStream) convertForms([{ ref: nAp, s }], 0);
      }
    }
    if (out.colours > before) out.pages++;
  }
  if (o.images !== false) {
    for (const ref of out.imageRefs) {
      const s = look(ctx, ref);
      if (!(s instanceof PDFRawStream) || nameOf(look(ctx, s.dict.get(N('Subtype')))) !== 'Image') continue;
      const csObj = look(ctx, s.dict.get(N('ColorSpace')));
      const family = csObj instanceof PDFArray ? nameOf(look(ctx, csObj.get(0))) : nameOf(csObj);
      const comps = componentsOf(ctx, csObj);
      if (look(ctx, s.dict.get(N('ImageMask')))?.asBoolean?.() || (comps === 1 && !['Indexed', 'I', 'Separation'].includes(family))) continue;
      try {
        if (['Indexed', 'I', 'Separation', 'DeviceN', 'Lab'].includes(family)) throw new Error('not convertible');
        const img = await decodeImage(ctx, s, o.codec);
        if (img.bpc > 8 || !(img.comps === 3 || img.comps === 4)) throw new Error('not convertible');
        const gray = new Uint8Array(img.width * img.height);
        for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
          const v = []; for (let c = 0; c < img.comps; c++) v.push(sampleAt(img, x, y, c));
          gray[y * img.width + x] = Math.round((toGray(v) ?? 0) * 255);
        }
        const dict = s.dict.clone(ctx);
        for (const k of ['Filter', 'DecodeParms', 'DP', 'Length', 'Decode']) dict.delete(N(k));
        dict.set(N('ColorSpace'), N('DeviceGray')); dict.set(N('BitsPerComponent'), PDFNumber.of(8));
        dict.set(N('Width'), PDFNumber.of(img.width)); dict.set(N('Height'), PDFNumber.of(img.height));
        dict.set(N('Filter'), N('FlateDecode'));
        ctx.assign(ref, PDFRawStream.of(dict, deflate(ctx, gray)));
        out.images++;
      } catch { out.imagesLeft++; }
    }
  }
  delete out.imageRefs;
  return out;
}

// --- Hairlines -------------------------------------------------------------------------------------------
function hairlineStream(ctx, data, res, state, h, out, depth) {
  const edits = [];
  const ops = tokenize(data);
  let pathStart = null;
  for (const op of ops) {
    switch (op.op) {
      case 'q': state.stack.push([state.ctm, state.width]); break;
      case 'Q': if (state.stack.length) [state.ctm, state.width] = state.stack.pop(); break;
      case 'cm': if (op.args.length === 6) state.ctm = mul(op.args.map((a) => a.v), state.ctm); break;
      case 'w': if (op.args[0]?.t === 'num') state.width = op.args[0].v; break;
      case 'gs': {
        const gs = resDict(ctx, res, 'ExtGState');
        const d = gs && op.args[0] ? look(ctx, gs.get(N(op.args[0].v))) : null;
        const lw = d instanceof PDFDict ? look(ctx, d.get(N('LW'))) : null;
        if (lw instanceof PDFNumber) state.width = lw.asNumber();
        break;
      }
      case 'm': case 're': if (!state.inPath) { state.inPath = true; pathStart = op.start; } break;
      case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': {
        const scale = scaleOf(state.ctm);
        const thin = state.width <= 0 || (scale > 0 && state.width * scale < h.narrowerThan);
        const at = pathStart !== null ? pathStart : (!state.inPath ? op.start : null);
        state.inPath = false; pathStart = null;
        if (thin && scale > 0 && at !== null) {
          edits.push({ start: at, end: at, text: `${n(h.width / scale)} w `, order: 0 });
          edits.push({ start: op.end, end: op.end, text: ` ${n(state.width)} w`, order: 1 });
          out.lines++;
        }
        break;
      }
      case 'f': case 'F': case 'f*': case 'n': state.inPath = false; pathStart = null; break;
      case 'Do': {
        if (depth > 16) break;
        const nm = op.args[0]?.v;
        const xo = resDict(ctx, res, 'XObject');
        const ref = xo && nm ? xo.get(N(nm)) : null;
        const s = ref ? look(ctx, ref) : null;
        if (!(s instanceof PDFStream) || nameOf(look(ctx, s.dict.get(N('Subtype')))) !== 'Form') break;
        const mt = look(ctx, s.dict.get(N('Matrix')));
        const fm = mt instanceof PDFArray ? mt.asArray().map((x) => look(ctx, x).asNumber()) : [1, 0, 0, 1, 0, 0];
        const inner = { ctm: mul(fm, state.ctm), width: state.width, stack: [], inPath: false };
        const fres = look(ctx, s.dict.get(N('Resources'))) || res;
        const key = `${ref.toString()}|${scaleOf(inner.ctm).toFixed(6)}|${state.width}`;
        let copy = out.formCache.get(key);
        if (copy === undefined) {
          const nb = hairlineStream(ctx, streamData(s), fres, inner, h, out, depth + 1);
          copy = nb ? formCopy(ctx, res, nm, restream(ctx, s, nb), 'hl') : null;
          out.formCache.set(key, copy);
        }
        if (copy) edits.push({ start: op.start, end: op.end, text: `/${copy} Do`, order: 0 });
        break;
      }
      default:
    }
  }
  return splice(data, edits);
}

/**
 * Fixes hairlines on the pages (0-based) of a loaded document. h: {narrowerThan, width} in points on the page
 * (defaults 0.216 and 0.72, as 0.003 in and 0.01 in). Returns {lines, pages}.
 */
export function fixHairlines(doc, pages = doc.getPageIndices(), h = {}) {
  const ctx = doc.context;
  const set = { narrowerThan: h.narrowerThan ?? 0.216, width: h.width ?? 0.72 };
  if (!(set.width > 0 && set.width <= 10 && set.narrowerThan >= 0 && set.narrowerThan <= 10)) throw new Error('The line widths must be from 0 to 10 points.');
  const out = { lines: 0, pages: 0, formCache: new Map() };
  for (const i of pages) {
    const page = doc.getPage(i);
    const before = out.lines;
    const res = page.node.Resources();
    const list = pageStreams(page);
    const state = { ctm: [1, 0, 0, 1, 0, 0], width: 1, stack: [], inPath: false };
    const changed = new Map();
    out.formCache = new Map();
    list.forEach((x, k) => { if (!(x.s instanceof PDFStream)) return; const nb = hairlineStream(ctx, streamData(x.s), res, state, set, out, 0); if (nb) changed.set(k, nb); });
    writeBack(page, list, changed);
    if (out.lines > before) out.pages++;
  }
  return { lines: out.lines, pages: out.pages };
}

// --- Printer marks ---------------------------------------------------------------------------------------
const GAP = 6; const LENGTH = 18; const TARGET_OFFSET = 16; const TARGET_RADIUS = 4; const BAR = 10; const INFO_SIZE = 7;
/** How far the chosen marks reach beyond the trim box. */
export function marksReach(m) {
  let r = 0;
  if (m.trim || m.bleed) r = Math.max(r, GAP + LENGTH);
  if (m.registration) r = Math.max(r, TARGET_OFFSET + TARGET_RADIUS + 2);
  if (m.colorBars || m.pageInfo) r = Math.max(r, GAP + BAR + 6);
  return r;
}
const winAnsiText = (s) => [...s].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).join('').replace(/[\\()]/g, '\\$&');

/** The marks' content for a page with trim box and bleed box (user space), page of count (1-based). */
export function marksContent(m, trim, bleed, page, count) {
  const w = Math.min(4, Math.max(0.1, m.lineWeight || 0.25));
  let c = `/DPReg CS 1 SCN /DPReg cs 1 scn ${n(w)} w 0 J\n`;
  const line = (ax, ay, bx, by) => { c += `${n(ax)} ${n(ay)} m ${n(bx)} ${n(by)} l S\n`; };
  const corners = (b) => {
    const [bx0, by0, bx1, by1] = b;
    for (const [x, dir] of [[bx0, -1], [bx1, 1]]) for (const y of [by0, by1]) {
      const [ya, yb] = y === by0 ? [y - GAP, y - GAP - LENGTH] : [y + GAP, y + GAP + LENGTH];
      line(x, ya, x, yb);
      line(x + dir * GAP, y, x + dir * (GAP + LENGTH), y);
    }
  };
  const [x0, y0, x1, y1] = trim;
  if (m.trim) corners(trim);
  if (m.bleed && bleed.some((v, i) => Math.abs(v - trim[i]) > 0.01)) { c += `[${n(w * 4)} ${n(w * 4)}] 0 d\n`; corners(bleed); c += '[] 0 d\n'; }
  if (m.registration) {
    const r = TARGET_RADIUS; const k = 0.5523 * r;
    const target = (cx, cy) => {
      c += `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c S\n`;
      line(cx - r * 1.6, cy, cx + r * 1.6, cy); line(cx, cy - r * 1.6, cx, cy + r * 1.6);
    };
    const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
    target(mx, y1 + TARGET_OFFSET); target(mx, y0 - TARGET_OFFSET); target(x0 - TARGET_OFFSET, my); target(x1 + TARGET_OFFSET, my);
  }
  if (m.colorBars) {
    const y = y1 + GAP + 2; const x = x0 + LENGTH + GAP + 12;
    [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0, 0, 0, 0.75], [0, 0, 0, 0.5], [0, 0, 0, 0.25]].forEach((s, i) => { c += `${s.map(n).join(' ')} k ${n(x + i * BAR)} ${n(y)} ${n(BAR)} ${n(BAR)} re f\n`; });
    c += '/DPReg cs 1 scn\n';
  }
  if (m.pageInfo) {
    const info = [m.label?.trim(), `${page} of ${count}`, m.date?.trim()].filter(Boolean).join('  ');
    c += `BT /DPHelv ${n(INFO_SIZE)} Tf 1 0 0 1 ${n(x0 + LENGTH + GAP + 12)} ${n(y0 - GAP - BAR)} Tm (${winAnsiText(info)}) Tj ET\n`;
  }
  return c;
}

/**
 * Adds printer marks to the pages (0-based) of a loaded document. m: {trim, bleed, registration, colorBars,
 * pageInfo, lineWeight, makeRoom (points or null), label, date, replace}. Returns the pages that were widened.
 */
export function addPrinterMarks(doc, pages = doc.getPageIndices(), m = {}) {
  const ctx = doc.context;
  if (!(m.trim || m.bleed || m.registration || m.colorBars || m.pageInfo)) throw new Error('Please choose at least one kind of mark.');
  if (m.replace) removeMarks(doc, 'PrinterMarks', pages);
  const count = doc.getPageCount();
  const room = m.makeRoom === undefined ? 36 : m.makeRoom;
  const reg = ctx.obj([N('Separation'), N('All'), N('DeviceCMYK'), ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 })]);
  const helv = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const widened = [];
  for (const i of pages) {
    const page = doc.getPage(i);
    const b = pageBoxes(page);
    const trim = b.TrimBox; const bleed = b.BleedBox;
    const r = marksReach(m);
    const beyond = (be, te) => Math.max(r, Math.abs(te - be) + GAP + LENGTH);
    const side = m.bleed ? [beyond(bleed[0], trim[0]), beyond(bleed[1], trim[1]), beyond(bleed[2], trim[2]), beyond(bleed[3], trim[3])] : [r, r, r, r];
    const need = [trim[0] - side[0], trim[1] - side[1], trim[2] + side[2], trim[3] + side[3]];
    const within = (x) => x[0] <= need[0] && x[1] <= need[1] && x[2] >= need[2] && x[3] >= need[3];
    if (!within(b.CropBox) && room !== null) {
      // The trim box stays where it is: write it down before the page grows.
      const node = page.node;
      if (!node.get(N('TrimBox'))) node.set(N('TrimBox'), ctx.obj(trim));
      const big = [Math.min(b.MediaBox[0], trim[0] - Math.max(room, side[0])), Math.min(b.MediaBox[1], trim[1] - Math.max(room, side[1])), Math.max(b.MediaBox[2], trim[2] + Math.max(room, side[2])), Math.max(b.MediaBox[3], trim[3] + Math.max(room, side[3]))];
      node.set(N('MediaBox'), ctx.obj(big));
      node.set(N('CropBox'), ctx.obj(big));
      widened.push(i);
    }
    const content = `q\n/Artifact <</Type /Page /DPMark /PrinterMarks>> BDC\n${marksContent(m, trim, bleed, i + 1, count)}EMC\nQ\n`;
    const entries = page.node.normalizedEntries();
    let cs = look(ctx, entries.Resources.get(N('ColorSpace')));
    if (!(cs instanceof PDFDict)) { cs = ctx.obj({}); entries.Resources.set(N('ColorSpace'), cs); }
    cs.set(N('DPReg'), reg);
    entries.Font.set(N('DPHelv'), helv);
    const stream = ctx.flateStream(content, { DPMark: 'PrinterMarks' });
    if (m.settings) stream.dict.set(N('DPSettings'), PDFHexString.fromText(JSON.stringify(m.settings)));
    page.node.addContentStream(ctx.register(stream));
  }
  return widened;
}

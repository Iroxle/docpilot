// Reduce file size and Advanced optimization.
// - Images: each image's effective resolution is measured where the pages draw it (the smallest over its
//   uses, through form XObjects); colour and grey images above a threshold are resampled (Catmull-Rom) to a
//   target resolution and stored as JPEG or Flate; a new image replaces the old one only if it is smaller.
//   Images that may be drawn elsewhere too (comments, patterns), masked by colour keys, with decode arrays or
//   in other colour spaces stay as they are. Black-and-white images are averaged down and stored as CCITT
//   Group 4 or 1-bit Flate, whichever is smaller.
// - Discard objects: page thumbnails and alternate images; on request tags, form actions, print settings,
//   links to other documents and embedded search indexes.
// - Clean up: images and forms that pages list but never draw, links to pages that do not exist, streams
//   without compression are Flate-compressed, LZW and an outer ASCII85/ASCIIHex layer become Flate.
//
// Ported from PdfCraft's optimize crate (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors, MIT
// license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFNumber, decodePDFRawStream } from '@cantoo/pdf-lib';
import { tokenize, mul, pageContentBytes } from './content.js';
import { loadForEdit, saveDoc } from './ops.js';
import { decodeImage, filtersOf, componentsOf, deflate } from './imagedata.js';
import { encodeG4 } from './ccitt.js';
import { collectGarbage, pruneUnusedXObjects } from './organize.js';

const N = (s) => PDFName.of(s);
const lookup = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const dictOf = (ctx, v) => { const d = lookup(ctx, v); return d instanceof PDFDict ? d : null; };
const nameOf = (ctx, v) => { const o = lookup(ctx, v); return o instanceof PDFName ? o.decodeText() : undefined; };
const numOf = (ctx, v, d = undefined) => { const o = lookup(ctx, v); return o instanceof PDFNumber ? o.asNumber() : d; };
const MAX_PIXELS = 120e6;

const image = (target, above, quality) => ({ downsample: true, target, above, compression: 'jpeg', quality });
const BASE = {
  mono: { downsample: true, target: 300, above: 450, compression: 'g4' },
  discardThumbnails: true, discardAlternates: true, discardTags: false, discardFormActions: false, discardPrintSettings: false,
  discardExternalRefs: false, discardSearchIndex: false, flateUnencoded: true, lzwToFlate: true, removeUnused: true, removeInvalidLinks: true,
};
/** The ready-made settings: Standard (Reduce file size), Mobile (reading on a screen) and High quality (printing). */
export const PRESETS = {
  standard: { ...BASE, color: image(150, 225, 60), gray: image(150, 225, 60) },
  mobile: { ...BASE, color: image(96, 144, 80), gray: image(96, 144, 80) },
  high: { ...BASE, color: image(300, 450, 80), gray: image(300, 450, 80), mono: { downsample: true, target: 600, above: 900, compression: 'g4' } },
};

/** Each image's effective resolution (ppi) where the pages draw it: the smallest over its uses. */
export function effectiveResolutions(doc) {
  const ctx = doc.context;
  const out = new Map(); // image tag -> {ref, ppi}
  const walked = new Set(); // XObject dictionaries read
  let budget = 20000;
  const walk = (bytes, res, ctm, depth) => {
    if (depth > 32 || budget-- <= 0) return false;
    const xo = dictOf(ctx, res?.get(N('XObject')));
    if (xo) walked.add(xo);
    let ops;
    try { ops = tokenize(bytes); } catch { return false; }
    const stack = []; let m = ctm; let ok = true;
    for (const o of ops) {
      if (o.op === 'q') stack.push(m);
      else if (o.op === 'Q') m = stack.pop() || m;
      else if (o.op === 'cm' && o.args.length === 6) m = mul(o.args.map((a) => a.v), m);
      else if (o.op === 'Do' && xo && o.args[0]?.t === 'name') {
        const ref = xo.get(N(o.args[0].v));
        const s = lookup(ctx, ref);
        if (!(s instanceof PDFStream)) continue;
        const sub = nameOf(ctx, s.dict.get(N('Subtype')));
        if (sub === 'Image' && ref instanceof PDFRef) {
          const w = numOf(ctx, s.dict.get(N('Width')), 0); const h = numOf(ctx, s.dict.get(N('Height')), 0);
          const ux = Math.hypot(m[0], m[1]) / 72; const uy = Math.hypot(m[2], m[3]) / 72;
          const ppi = Math.min(ux > 0 ? w / ux : Infinity, uy > 0 ? h / uy : Infinity);
          const e = out.get(ref.tag);
          out.set(ref.tag, { ref, ppi: e ? Math.min(e.ppi, ppi) : ppi });
        } else if (sub === 'Form') {
          let b; try { b = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents(); } catch { ok = false; continue; }
          const fm = lookup(ctx, s.dict.get(N('Matrix')));
          const matrix = fm instanceof PDFArray && fm.size() === 6 ? fm.asArray().map((x) => numOf(ctx, x, 0)) : [1, 0, 0, 1, 0, 0];
          if (!walk(b, dictOf(ctx, s.dict.get(N('Resources'))) || res, mul(matrix, m), depth + 1)) ok = false;
        }
      }
    }
    return ok;
  };
  let complete = true;
  for (const page of doc.getPages()) {
    let bytes; try { bytes = pageContentBytes(page); } catch { complete = false; continue; }
    if (!walk(bytes, page.node.Resources(), [1, 0, 0, 1, 0, 0], 0)) complete = false;
  }
  // A use may have been missed: nothing is resampled then.
  if (!complete) for (const e of out.values()) e.ppi = Infinity;
  // Images that something else refers to (a comment's appearance, a pattern, alternates) may be drawn larger there.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const visit = (o) => {
      if (o instanceof PDFDict) { for (const [, v] of o.entries()) { if (v instanceof PDFRef) { const e = out.get(v.tag); if (e && !walked.has(o)) e.ppi = Infinity; } else visit(v); } }
      else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) { const v = o.get(i); if (v instanceof PDFRef) { const e = out.get(v.tag); if (e) e.ppi = Infinity; } else visit(v); }
    };
    if (obj instanceof PDFDict && !walked.has(obj)) visit(obj);
    else if (obj instanceof PDFArray) visit(obj);
    else if (obj instanceof PDFStream) visit(obj.dict);
  }
  return out;
}

/** Catmull-Rom weights for resampling one axis from n to m samples. */
function weights(n, m) {
  const scale = m / n; const support = scale < 1 ? 2 / scale : 2;
  const k = (x) => { x = Math.abs(x); return x < 1 ? 1.5 * x ** 3 - 2.5 * x ** 2 + 1 : x < 2 ? -0.5 * x ** 3 + 2.5 * x ** 2 - 4 * x + 2 : 0; };
  const out = [];
  for (let i = 0; i < m; i++) {
    const c = (i + 0.5) / scale - 0.5;
    const lo = Math.max(0, Math.floor(c - support)); const hi = Math.min(n - 1, Math.ceil(c + support));
    const idx = []; const w = []; let sum = 0;
    for (let j = lo; j <= hi; j++) { const v = k((j - c) * Math.min(1, scale)); if (v) { idx.push(j); w.push(v); sum += v; } }
    out.push({ idx, w: w.map((v) => v / (sum || 1)) });
  }
  return out;
}

/** Resamples 8-bit pixels with n components from w x h to nw x nh (separable Catmull-Rom). */
export function resample(px, n, w, h, nw, nh) {
  const wx = weights(w, nw); const wy = weights(h, nh);
  const mid = new Float32Array(nw * h * n);
  for (let y = 0; y < h; y++) for (let x = 0; x < nw; x++) {
    const { idx, w: ws } = wx[x];
    for (let c = 0; c < n; c++) { let s = 0; for (let k = 0; k < idx.length; k++) s += px[(y * w + idx[k]) * n + c] * ws[k]; mid[(y * nw + x) * n + c] = s; }
  }
  const out = new Uint8Array(nw * nh * n);
  for (let y = 0; y < nh; y++) {
    const { idx, w: ws } = wy[y];
    for (let x = 0; x < nw; x++) for (let c = 0; c < n; c++) {
      let s = 0; for (let k = 0; k < idx.length; k++) s += mid[(idx[k] * nw + x) * n + c] * ws[k];
      out[(y * nw + x) * n + c] = s < 0 ? 0 : s > 255 ? 255 : Math.round(s);
    }
  }
  return out;
}

const isIdentityDecode = (ctx, v, n) => { const a = lookup(ctx, v); return a instanceof PDFArray && a.size() === 2 * n && a.asArray().every((x, i) => numOf(ctx, x) === (i % 2 ? 1 : 0)); };
const storedLength = (s) => (s instanceof PDFRawStream ? s.contents.length : s.getContents().length);

/** A colour or grey image resampled and/or recompressed per settings, or null when that is not smaller. */
async function processImage(ctx, s, ppi, settings, n, codec) {
  const d = s.dict;
  if ((d.get(N('Decode')) && !isIdentityDecode(ctx, d.get(N('Decode')), n)) || (d.get(N('Mask')) && !(lookup(ctx, d.get(N('Mask'))) instanceof PDFStream))) return null;
  if (numOf(ctx, d.get(N('BitsPerComponent'))) !== 8) return null;
  const filters = filtersOf(ctx, d);
  const dct = filters.length && filters[filters.length - 1].name === 'DCTDecode';
  const w = numOf(ctx, d.get(N('Width')), 0); const h = numOf(ctx, d.get(N('Height')), 0);
  if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) return null;
  const jpeg = settings.compression === 'jpeg' && !!codec?.encodeJpeg;
  let resize = settings.downsample && Number.isFinite(ppi) && ppi > settings.above && settings.target > 0;
  const k = resize ? Math.min(1, settings.target / ppi) : 1;
  const nw = Math.max(1, Math.round(w * k)); const nh = Math.max(1, Math.round(h * k));
  resize = resize && (nw !== w || nh !== h);
  const recompress = jpeg || (settings.compression === 'flate' && dct);
  if (!resize && !recompress) return null;
  if (!resize && w * h < 64 * 64) return null;
  if (dct && !codec?.decodeJpeg) return null;
  let img;
  try { img = await decodeImage(ctx, s, codec); } catch { return null; }
  let px = img.data; let comps = img.comps;
  if (img.jpeg && n === 1) { const g = new Uint8Array(img.width * img.height); for (let i = 0; i < g.length; i++) g[i] = Math.round((px[i * 3] + px[i * 3 + 1] + px[i * 3 + 2]) / 3); px = g; comps = 1; }
  if (resize) px = resample(px, comps, img.width, img.height, nw, nh);
  const W = resize ? nw : img.width; const H = resize ? nh : img.height;
  const dict = d.clone(ctx);
  for (const key of ['Filter', 'DecodeParms', 'DP', 'Decode', 'Length', 'DL']) dict.delete(N(key));
  dict.set(N('Width'), PDFNumber.of(W)); dict.set(N('Height'), PDFNumber.of(H)); dict.set(N('BitsPerComponent'), PDFNumber.of(8));
  let stream;
  if (jpeg || (settings.compression === 'retain' && dct && codec?.encodeJpeg)) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { const o = i * comps; rgba[i * 4] = px[o]; rgba[i * 4 + 1] = px[o + (comps > 1 ? 1 : 0)]; rgba[i * 4 + 2] = px[o + (comps > 1 ? 2 : 0)]; rgba[i * 4 + 3] = 255; }
    const bytes = await codec.encodeJpeg(rgba, W, H, (settings.quality || 60) / 100);
    dict.set(N('Filter'), N('DCTDecode'));
    if (comps === 1) dict.set(N('ColorSpace'), N('DeviceRGB'));
    stream = PDFRawStream.of(dict, bytes);
  } else {
    dict.set(N('Filter'), N('FlateDecode'));
    stream = PDFRawStream.of(dict, deflate(ctx, px));
  }
  // A soft mask keeps the image's size: resampled with it, losslessly.
  let smask = null;
  const mref = d.get(N('SMask'));
  if (resize && mref instanceof PDFRef) {
    const m = ctx.lookup(mref);
    if (!(m instanceof PDFStream) || numOf(ctx, m.dict.get(N('BitsPerComponent'))) !== 8 || m.dict.has(N('Matte')) || m.dict.has(N('Decode'))) return null;
    let mi; try { mi = await decodeImage(ctx, m, codec); } catch { return null; }
    const mpx = resample(mi.data, 1, mi.width, mi.height, W, H);
    const md = m.dict.clone(ctx);
    for (const key of ['Filter', 'DecodeParms', 'DP', 'Length']) md.delete(N(key));
    md.set(N('Width'), PDFNumber.of(W)); md.set(N('Height'), PDFNumber.of(H)); md.set(N('Filter'), N('FlateDecode'));
    smask = { ref: mref, stream: PDFRawStream.of(md, deflate(ctx, mpx)) };
  }
  const before = storedLength(s) + (smask ? storedLength(ctx.lookup(smask.ref)) : 0);
  const after = storedLength(stream) + (smask ? storedLength(smask.stream) : 0);
  return after < before ? { stream, smask, resized: resize, before, after } : null;
}

/** Packs one-byte-per-pixel black/white values (0 black, 1 white) into rows of bits. */
function packBits(v, w, h) {
  const rowBytes = Math.ceil(w / 8); const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (v[y * w + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  return out;
}

/** A black-and-white image averaged down and/or stored as CCITT Group 4 or 1-bit Flate, or null when that is not smaller. */
async function processMono(ctx, s, ppi, settings) {
  const d = s.dict;
  const mask = lookup(ctx, d.get(N('ImageMask')))?.asBoolean?.() === true;
  if (!mask && (numOf(ctx, d.get(N('BitsPerComponent'))) !== 1 || componentsOf(ctx, d.get(N('ColorSpace'))) !== 1)) return null;
  const filters = filtersOf(ctx, d);
  if (filters.some((f) => f.name === 'CCITTFaxDecode' || f.name === 'JBIG2Decode') && !(settings.downsample && ppi > settings.above)) return null;
  let img;
  try { img = await decodeImage(ctx, s, null); } catch { return null; }
  if (img.width * img.height > MAX_PIXELS * 8) return null;
  let { width: w, height: h, data } = img;
  let resized = false;
  if (settings.downsample && Number.isFinite(ppi) && ppi > settings.above && settings.target > 0) {
    const k = Math.min(1, settings.target / ppi);
    const nw = Math.max(1, Math.round(w * k)); const nh = Math.max(1, Math.round(h * k));
    if (nw !== w || nh !== h) {
      // Averaging: a pixel turns black when at least half of the area it covers is black.
      const v = new Uint8Array(nw * nh);
      const rowBytes = img.rowBytes;
      for (let y = 0; y < nh; y++) {
        const y0 = Math.floor((y * h) / nh); const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
        for (let x = 0; x < nw; x++) {
          const x0 = Math.floor((x * w) / nw); const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
          let white = 0;
          for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) white += (data[yy * rowBytes + (xx >> 3)] >> (7 - (xx & 7))) & 1;
          v[y * nw + x] = white * 2 > (y1 - y0) * (x1 - x0) ? 1 : 0;
        }
      }
      data = packBits(v, nw, nh); w = nw; h = nh; resized = true;
    }
  }
  const dict = d.clone(ctx);
  for (const key of ['Filter', 'DecodeParms', 'DP', 'Length', 'DL']) dict.delete(N(key));
  dict.set(N('Width'), PDFNumber.of(w)); dict.set(N('Height'), PDFNumber.of(h));
  if (!mask) dict.set(N('BitsPerComponent'), PDFNumber.of(1));
  const candidates = [];
  if (settings.compression === 'g4') {
    const g4 = dict.clone(ctx);
    g4.set(N('Filter'), N('CCITTFaxDecode'));
    g4.set(N('DecodeParms'), ctx.obj({ K: -1, Columns: w, Rows: h, BlackIs1: false }));
    candidates.push(PDFRawStream.of(g4, encodeG4(data, w, h)));
  }
  const fl = dict.clone(ctx); fl.set(N('Filter'), N('FlateDecode'));
  candidates.push(PDFRawStream.of(fl, deflate(ctx, data)));
  const best = candidates.reduce((a, b) => (storedLength(b) < storedLength(a) ? b : a));
  const before = storedLength(s);
  return storedLength(best) < before ? { stream: best, resized, before, after: storedLength(best) } : null;
}

/** Streams stored without a filter become Flate; LZW becomes Flate; an outer ASCII85/ASCIIHex layer goes. */
function recompressStreams(doc, settings, report) {
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    const type = nameOf(ctx, d.get(N('Type')));
    if (type === 'XRef' || type === 'ObjStm' || type === 'Metadata') continue;
    const filters = filtersOf(ctx, d);
    try {
      if (!filters.length && settings.flateUnencoded && obj.contents.length > 32) {
        const z = deflate(ctx, obj.contents);
        if (z.length < obj.contents.length) { const nd = d.clone(ctx); nd.set(N('Filter'), N('FlateDecode')); nd.delete(N('Length')); ctx.assign(ref, PDFRawStream.of(nd, z)); report.streamsCompressed++; }
      } else if (filters.length && (filters[0].name === 'ASCII85Decode' || filters[0].name === 'ASCIIHexDecode') && settings.flateUnencoded) {
        const one = d.clone(ctx); one.set(N('Filter'), N(filters[0].name)); one.delete(N('DecodeParms'));
        const inner = decodePDFRawStream(PDFRawStream.of(one, obj.contents)).decode();
        const nd = d.clone(ctx); nd.delete(N('Length'));
        const rest = filters.slice(1);
        const parms = lookup(ctx, d.get(N('DecodeParms')));
        if (rest.length) {
          nd.set(N('Filter'), rest.length === 1 ? N(rest[0].name) : ctx.obj(rest.map((f) => N(f.name))));
          if (parms instanceof PDFArray) nd.set(N('DecodeParms'), rest.length === 1 ? parms.get(1) : ctx.obj(parms.asArray().slice(1)));
          ctx.assign(ref, PDFRawStream.of(nd, inner));
        } else { nd.set(N('Filter'), N('FlateDecode')); nd.delete(N('DecodeParms')); ctx.assign(ref, PDFRawStream.of(nd, deflate(ctx, inner))); }
        report.streamsCompressed++;
      } else if (filters.length === 1 && filters[0].name === 'LZWDecode' && settings.lzwToFlate) {
        // The predictor (if any) stays: it applies after the compression, whichever it is.
        const data = decodePDFRawStream(PDFRawStream.of(d, obj.contents)).decode();
        const nd = d.clone(ctx); nd.set(N('Filter'), N('FlateDecode')); nd.delete(N('Length'));
        const p = dictOf(ctx, d.get(N('DecodeParms')));
        if (p) { const np = p.clone(ctx); np.delete(N('EarlyChange')); nd.set(N('DecodeParms'), np); }
        ctx.assign(ref, PDFRawStream.of(nd, deflate(ctx, data)));
        report.lzwConverted++;
      }
    } catch { /* a stream that does not decode stays as it is */ }
  }
}

/** Removes links whose destination is a page this document does not have. */
function removeInvalidLinks(doc, report) {
  const ctx = doc.context;
  const pages = new Set(doc.getPages().map((p) => p.ref.tag));
  for (const page of doc.getPages()) {
    const annots = lookup(ctx, page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = dictOf(ctx, annots.get(i));
      if (!a || nameOf(ctx, a.get(N('Subtype'))) !== 'Link') continue;
      let dest = a.get(N('Dest'));
      const act = dictOf(ctx, a.get(N('A')));
      if (!dest && act && nameOf(ctx, act.get(N('S'))) === 'GoTo') dest = act.get(N('D'));
      const arr = lookup(ctx, dest);
      if (!(arr instanceof PDFArray)) continue;
      const target = arr.get(0);
      if (target instanceof PDFRef && !pages.has(target.tag)) { annots.remove(i); report.invalidLinks++; }
    }
  }
}

/** Removes form submission, import and reset actions (the fields and links that ran them stay). */
function discardFormActions(doc, report) {
  const ctx = doc.context;
  const bad = (a) => ['SubmitForm', 'ResetForm', 'ImportData'].includes(nameOf(ctx, dictOf(ctx, a)?.get(N('S'))));
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(N('A')) && bad(obj.get(N('A')))) { obj.delete(N('A')); report.formActions++; }
    const aa = dictOf(ctx, obj.get(N('AA')));
    if (aa) for (const [k, v] of aa.entries()) if (bad(v)) { aa.delete(k); report.formActions++; }
  }
}

/** Removes actions that open other documents or files from links and bookmarks. */
function discardExternalRefs(doc, report) {
  const ctx = doc.context;
  const external = (a) => { const d = dictOf(ctx, a); const s = nameOf(ctx, d?.get(N('S'))); return ['GoToR', 'GoToE', 'Launch', 'ImportData'].includes(s) || (s === 'Thread' && d.has(N('F'))); };
  for (const [, obj] of ctx.enumerateIndirectObjects()) if (obj instanceof PDFDict && obj.get(N('A')) && external(obj.get(N('A')))) { obj.delete(N('A')); report.externalRefs++; }
}

/**
 * Optimizes a PDF. settings: a preset (PRESETS.standard...) or own settings in the same shape.
 * o: {codec (JPEG decode/encode), progress(fraction, text)}. Returns {bytes, report}.
 */
export async function optimizePdf(bytes, settings = PRESETS.standard, o = {}) {
  const doc = await loadForEdit(bytes);
  const ctx = doc.context;
  const report = { images: 0, resampled: 0, recompressed: 0, imageBytesBefore: 0, imageBytesAfter: 0, thumbnails: 0, alternates: 0, unused: 0, invalidLinks: 0, streamsCompressed: 0, lzwConverted: 0, formActions: 0, externalRefs: 0, tags: false, before: bytes.length, after: 0 };
  // Objects only thumbnails and alternate images use go before images are measured.
  if (settings.discardThumbnails) for (const p of doc.getPages()) if (p.node.has(N('Thumb'))) { p.node.delete(N('Thumb')); report.thumbnails++; }
  if (settings.discardAlternates) for (const [, obj] of ctx.enumerateIndirectObjects()) if (obj instanceof PDFStream && obj.dict.has(N('Alternates'))) { obj.dict.delete(N('Alternates')); report.alternates++; }
  if (settings.removeUnused) report.unused = pruneUnusedXObjects(doc);
  const images = [...effectiveResolutions(doc).values()];
  report.images = images.length;
  for (let i = 0; i < images.length; i++) {
    o.progress?.(i / images.length, `Image ${i + 1} of ${images.length}`);
    const { ref, ppi } = images[i];
    const s = ctx.lookup(ref);
    if (!(s instanceof PDFRawStream)) continue;
    const d = s.dict;
    let res = null;
    try {
      const mono = lookup(ctx, d.get(N('ImageMask')))?.asBoolean?.() === true || numOf(ctx, d.get(N('BitsPerComponent'))) === 1;
      if (mono) res = await processMono(ctx, s, ppi, settings.mono);
      else {
        const n = componentsOf(ctx, d.get(N('ColorSpace')));
        const cs = lookup(ctx, d.get(N('ColorSpace')));
        const indexed = cs instanceof PDFArray && ['Indexed', 'I'].includes(nameOf(ctx, cs.get(0)));
        if ((n === 1 || n === 3) && !indexed) res = await processImage(ctx, s, ppi, n === 1 ? settings.gray : settings.color, n, o.codec);
      }
    } catch { res = null; }
    if (!res) continue;
    ctx.assign(ref, res.stream);
    if (res.smask) ctx.assign(res.smask.ref, res.smask.stream);
    if (res.resized) report.resampled++; else report.recompressed++;
    report.imageBytesBefore += res.before; report.imageBytesAfter += res.after;
  }
  o.progress?.(1, 'Cleaning up');
  if (settings.discardTags) {
    const c = doc.catalog;
    if (c.has(N('StructTreeRoot'))) { c.delete(N('StructTreeRoot')); c.delete(N('MarkInfo')); report.tags = true; }
    for (const p of doc.getPages()) p.node.delete(N('StructParents'));
  }
  if (settings.discardFormActions) discardFormActions(doc, report);
  if (settings.discardExternalRefs) discardExternalRefs(doc, report);
  if (settings.discardPrintSettings) { const vp = dictOf(ctx, doc.catalog.get(N('ViewerPreferences'))); if (vp) for (const k of ['PrintScaling', 'Duplex', 'PickTrayByPDFSize', 'PrintPageRange', 'NumCopies', 'PrintArea', 'PrintClip']) vp.delete(N(k)); }
  if (settings.discardSearchIndex) {
    const pi = dictOf(ctx, doc.catalog.get(N('PieceInfo')));
    if (pi) { for (const [k] of pi.entries()) if (/index/i.test(k.decodeText())) pi.delete(k); if (!pi.entries().length) doc.catalog.delete(N('PieceInfo')); }
  }
  if (settings.removeInvalidLinks) removeInvalidLinks(doc, report);
  recompressStreams(doc, settings, report);
  collectGarbage(doc);
  const out = await saveDoc(doc);
  report.after = out.length;
  return { bytes: out, report };
}


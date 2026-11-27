// Export all images: the images the pages use, as files. JPEG images are written unchanged; other images, and JPEG
// images with transparency or with CMYK samples a viewer would read inverted, are decoded and written as PNG with
// their soft mask, stencil mask or colour key as alpha. JPEG 2000 images are written as .jp2. Images that cannot be
// decoded are reported, never silently left out. Each image is exported once, on the first page that uses it,
// also when it is inside a form XObject.
//
// Ported from PdfCraft's create crate (extract) (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors,
// MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFStream, PDFRawStream, PDFRef, PDFString, PDFHexString, PDFBool, decodePDFRawStream } from '@cantoo/pdf-lib';
import { decodeImage, filtersOf, componentsOf, sampleAt, deflate } from './imagedata.js';

const N = (s) => PDFName.of(s);
const look = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const num = (ctx, d, k, dflt) => { const v = look(ctx, d.get(N(k))); return v instanceof PDFNumber ? v.asNumber() : dflt; };
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : null);

/** The image XObjects reachable from a resource dictionary, through form XObjects, in resource order. */
function collect(ctx, res, depth, forms, out) {
  if (!(res instanceof PDFDict) || depth > 12) return;
  const xo = look(ctx, res.get(N('XObject')));
  if (!(xo instanceof PDFDict)) return;
  for (const [, v] of xo.entries()) {
    if (!(v instanceof PDFRef)) continue;
    const s = ctx.lookup(v);
    if (!(s instanceof PDFStream)) continue;
    const sub = nameOf(look(ctx, s.dict.get(N('Subtype'))));
    if (sub === 'Image') out.push(v);
    else if (sub === 'Form' && !forms.has(v)) { forms.add(v); collect(ctx, look(ctx, s.dict.get(N('Resources'))), depth + 1, forms, out); }
  }
}

/** The images of the pages (0-based): [{ref, page, width, height}], each once, skipping images below minSide pixels. */
export function listImages(doc, pages = doc.getPageIndices(), minSide = 1) {
  const ctx = doc.context;
  const seen = new Set(); const out = [];
  for (const p of pages) {
    const refs = [];
    collect(ctx, doc.getPage(p).node.Resources(), 0, new Set(), refs);
    for (const r of refs) {
      const key = r.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const s = ctx.lookup(r);
      const width = num(ctx, s.dict, 'Width', 0); const height = num(ctx, s.dict, 'Height', 0);
      if (width <= 0 || height <= 0 || Math.min(width, height) < minSide) continue;
      out.push({ ref: r, page: p, width, height });
    }
  }
  return out;
}

// --- PNG ------------------------------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes, start, end) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
/** A PNG file from 8-bit pixels: channels 1 (gray), 2 (gray + alpha), 3 (RGB) or 4 (RGBA). */
export function encodePng(ctx, width, height, channels, pixels) {
  const type = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const row = width * channels;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (row + 1)] = 0; raw.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1); }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = 8; ihdr[9] = type;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflate(ctx, raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// --- Colours -----------------------------------------------------------------------------------------
/** The colour space of an image as {kind: 'gray'|'rgb'|'cmyk'|'indexed'|'lab', base, hival, lookup}. */
function colourSpace(ctx, cs) {
  const o = look(ctx, cs);
  const name = o instanceof PDFName ? nameOf(o) : o instanceof PDFArray ? nameOf(look(ctx, o.get(0))) : null;
  if (name === 'Indexed' || name === 'I') {
    const base = colourSpace(ctx, o.get(1));
    const hival = look(ctx, o.get(2)).asNumber();
    const lt = look(ctx, o.get(3));
    let table;
    if (lt instanceof PDFString || lt instanceof PDFHexString) table = lt.asBytes();
    else if (lt instanceof PDFRawStream) table = decodeStream(ctx, lt);
    else table = new Uint8Array(0);
    return { kind: 'indexed', base, hival, table };
  }
  if (name === 'Lab') return { kind: 'lab' };
  const n = componentsOf(ctx, o);
  return { kind: n === 4 ? 'cmyk' : n === 3 ? 'rgb' : 'gray', n: n || 1 };
}
/** A stream's decoded bytes (lookup tables). */
const decodeStream = (ctx, s) => (s.dict.get(N('Filter')) ? decodePDFRawStream(s).decode() : s.contents);

const cmykToRgb = (c, m, y, k) => [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];

/**
 * Decoded image samples to 8-bit pixels: {channels: 1 or 3, data}. Applies the colour space (indexed, CMYK, Lab)
 * and the /Decode array of stencil masks.
 */
function toPixels(ctx, dict, img) {
  const { width, height } = img;
  const n = width * height;
  if (img.jpeg) return { channels: 3, data: img.data };
  if (img.mask) {
    // Stencil mask: 1 bits are not painted (default /Decode [0 1]) -> as opaque black on transparent.
    const dec = look(ctx, dict.get(N('Decode')));
    const invert = dec instanceof PDFArray && look(ctx, dec.get(0))?.asNumber?.() === 1;
    const data = new Uint8Array(n * 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const bit = sampleAt(img, x, y, 0) > 0.5;
      const paint = invert ? bit : !bit;
      data[(y * width + x) * 2 + 1] = paint ? 255 : 0;
    }
    return { channels: 2, data, alphaDone: true };
  }
  const cs = colourSpace(ctx, dict.get(N('ColorSpace')));
  const max = (2 ** img.bpc) - 1;
  if (cs.kind === 'indexed') {
    const base = cs.base; const bn = base.kind === 'cmyk' ? 4 : base.kind === 'rgb' || base.kind === 'lab' ? 3 : 1;
    const out = new Uint8Array(n * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const idx = Math.min(cs.hival, Math.round(sampleAt(img, x, y, 0) * max));
      const e = cs.table.subarray(idx * bn, idx * bn + bn);
      const rgb = bn === 4 ? cmykToRgb(e[0] / 255, e[1] / 255, e[2] / 255, e[3] / 255) : bn === 3 ? [e[0], e[1], e[2]] : [e[0], e[0], e[0]];
      out.set(rgb.map((v) => Math.round(v || 0)), (y * width + x) * 3);
    }
    return { channels: 3, data: out };
  }
  const comps = img.comps;
  if (cs.kind === 'gray' && comps === 1) {
    const out = new Uint8Array(n);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = Math.round(sampleAt(img, x, y, 0) * 255);
    return { channels: 1, data: out };
  }
  const out = new Uint8Array(n * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (c) => sampleAt(img, x, y, c);
    let rgb;
    if (comps >= 4) rgb = cmykToRgb(s(0), s(1), s(2), s(3));
    else if (cs.kind === 'lab') rgb = [s(0) * 255, s(0) * 255, s(0) * 255];
    else if (comps === 3) rgb = [s(0) * 255, s(1) * 255, s(2) * 255];
    else rgb = [s(0) * 255, s(0) * 255, s(0) * 255];
    out.set(rgb.map(Math.round), (y * width + x) * 3);
  }
  return { channels: 3, data: out };
}

/** Alpha (0-255 per pixel) from the soft mask, an explicit mask or a colour key; null when the image is opaque. */
async function alphaOf(ctx, dict, img, codec) {
  const { width, height } = img;
  const sm = look(ctx, dict.get(N('SMask')));
  const mk = look(ctx, dict.get(N('Mask')));
  const fromMask = async (s, stencil) => {
    const m = await decodeImage(ctx, s, codec);
    const a = new Uint8Array(width * height);
    const dec = look(ctx, s.dict.get(N('Decode')));
    const invert = dec instanceof PDFArray && look(ctx, dec.get(0))?.asNumber?.() === 1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const mx = Math.min(m.width - 1, Math.floor((x * m.width) / width)); const my = Math.min(m.height - 1, Math.floor((y * m.height) / height));
      const v = sampleAt(m, mx, my, 0);
      // A stencil mask paints where the sample is 0 (masked out where 1); a soft mask is the alpha itself.
      a[y * width + x] = stencil ? ((invert ? v > 0.5 : v <= 0.5) ? 255 : 0) : Math.round(v * 255);
    }
    return a;
  };
  if (sm instanceof PDFStream) return fromMask(sm, false);
  if (mk instanceof PDFStream) return fromMask(mk, true);
  if (mk instanceof PDFArray && !img.jpeg) {
    const r = mk.asArray().map((v) => look(ctx, v).asNumber());
    const max = (2 ** img.bpc) - 1;
    const a = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let keyed = true;
      for (let c = 0; c < img.comps && keyed; c++) { const v = Math.round(sampleAt(img, x, y, c) * max); if (v < r[c * 2] || v > r[c * 2 + 1]) keyed = false; }
      a[y * width + x] = keyed ? 0 : 255;
    }
    return a;
  }
  return null;
}

/**
 * One image XObject as a file: {ext: 'jpg'|'png'|'jp2', data}. codec: {decodeJpeg} for JPEG images that need
 * decoding (transparency, CMYK). Throws with the reason when the image cannot be exported.
 */
export async function imageFile(ctx, stream, codec) {
  if (!(stream instanceof PDFRawStream)) throw new Error('The image cannot be read.');
  const dict = stream.dict;
  const filters = filtersOf(ctx, dict);
  const last = filters[filters.length - 1]?.name;
  const cs = componentsOf(ctx, dict.get(N('ColorSpace')));
  const transparent = !!dict.get(N('SMask')) || look(ctx, dict.get(N('Mask'))) instanceof PDFStream;
  if (last === 'JPXDecode' && filters.length === 1) return { ext: 'jp2', data: stream.contents };
  if (last === 'DCTDecode' && filters.length === 1 && cs !== 4 && !transparent) return { ext: 'jpg', data: stream.contents };
  if (['JBIG2Decode', 'CCITTFaxDecode', 'JPXDecode'].includes(last)) throw new Error(`Images stored as ${last.replace('Decode', '')} cannot be exported yet.`);
  const img = await decodeImage(ctx, stream, codec);
  if (look(ctx, dict.get(N('ImageMask'))) === PDFBool.True) img.mask = true;
  const px = toPixels(ctx, dict, img);
  let { channels, data } = px;
  const alpha = px.alphaDone ? null : await alphaOf(ctx, dict, img, codec);
  if (alpha) {
    const out = new Uint8Array(img.width * img.height * (channels + 1));
    for (let i = 0, n = img.width * img.height; i < n; i++) {
      for (let c = 0; c < channels; c++) out[i * (channels + 1) + c] = data[i * channels + c];
      out[i * (channels + 1) + channels] = alpha[i];
    }
    data = out; channels += 1;
  }
  return { ext: 'png', data: encodePng(ctx, img.width, img.height, channels, data) };
}

/**
 * All images of the pages as files: {images: [{page, width, height, ext, data}], skipped: [{page, reason}]}.
 * progress(k, n) is called after each image.
 */
export async function exportImages(doc, pages, o = {}) {
  const ctx = doc.context;
  const list = listImages(doc, pages, o.minSide || 1);
  const images = []; const skipped = [];
  for (let k = 0; k < list.length; k++) {
    const it = list[k];
    try { images.push({ page: it.page, width: it.width, height: it.height, ...(await imageFile(ctx, ctx.lookup(it.ref), o.codec)) }); }
    catch (e) { skipped.push({ page: it.page, reason: e.message }); }
    o.progress?.(k + 1, list.length);
  }
  return { images, skipped };
}

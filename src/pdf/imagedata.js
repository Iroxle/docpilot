// The samples of image XObjects: decoding (filters, predictors, bit depths), changing pixels and storing again.
// Used by redaction (clearing the pixels under a mark) and by compression (resampling images).
// JPEG (DCTDecode) needs a codec from the caller: decodeJpeg(bytes) -> {width, height, data: RGBA} and
// encodeJpeg(rgba, width, height, quality) -> bytes (in the app through the browser's image decoder and canvas).
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFStream, PDFRawStream, PDFBool, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';

const N = (s) => PDFName.of(s);
const DECODABLE = new Set(['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx', 'RunLengthDecode', 'RL']);
const SHORT = { Fl: 'FlateDecode', LZW: 'LZWDecode', A85: 'ASCII85Decode', AHx: 'ASCIIHexDecode', RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode' };

const lookup = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const num = (ctx, d, k, dflt) => { const v = lookup(ctx, d.get(N(k))); return v instanceof PDFNumber ? v.asNumber() : dflt; };

/** The filters of a stream as names (short forms expanded) and their parameters. */
export function filtersOf(ctx, dict) {
  const f = lookup(ctx, dict.get(N('Filter')));
  const p = lookup(ctx, dict.get(N('DecodeParms')) || dict.get(N('DP')));
  const names = f instanceof PDFName ? [f] : f instanceof PDFArray ? f.asArray().map((x) => lookup(ctx, x)) : [];
  const params = p instanceof PDFArray ? p.asArray().map((x) => lookup(ctx, x)) : [p];
  return names.map((x, i) => { const n = x instanceof PDFName ? x.decodeText() : ''; return { name: SHORT[n] || n, params: params[i] instanceof PDFDict ? params[i] : null }; });
}

/** Number of colour components of an image colour space (null when unknown). */
export function componentsOf(ctx, cs) {
  const o = lookup(ctx, cs);
  const name = o instanceof PDFName ? o.decodeText() : o instanceof PDFArray ? lookup(ctx, o.get(0))?.decodeText?.() : null;
  switch (name) {
    case 'DeviceGray': case 'G': case 'CalGray': case 'Indexed': case 'I': case 'Separation': return 1;
    case 'DeviceRGB': case 'RGB': case 'CalRGB': case 'Lab': return 3;
    case 'DeviceCMYK': case 'CMYK': return 4;
    case 'ICCBased': { const s = lookup(ctx, o.get(1)); const n = s instanceof PDFStream ? num(ctx, s.dict, 'N', 0) : 0; return [1, 3, 4].includes(n) ? n : null; }
    case 'DeviceN': { const names = lookup(ctx, o.get(1)); return names instanceof PDFArray ? names.size() : null; }
    default: return null;
  }
}

/** Undoes a PNG or TIFF predictor. */
function unpredict(data, params, ctx) {
  const predictor = params ? num(ctx, params, 'Predictor', 1) : 1;
  if (predictor <= 1) return data;
  const colors = num(ctx, params, 'Colors', 1); const bpc = num(ctx, params, 'BitsPerComponent', 8); const columns = num(ctx, params, 'Columns', 1);
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  if (predictor === 2) {
    if (bpc !== 8) throw new Error('TIFF predictor with this bit depth is not supported.');
    const out = new Uint8Array(data);
    for (let r = 0; r + rowBytes <= out.length; r += rowBytes) for (let i = bpp; i < rowBytes; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = data.subarray(r * (rowBytes + 1) + 1, (r + 1) * (rowBytes + 1));
    const row = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? row[i - bpp] : 0; const up = prev[i]; const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) { const p = left + up - ul; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      row[i] = v & 255;
    }
    prev = row;
  }
  return out;
}

/** Decodes a stream's filters except the last n. Returns the bytes. */
function decodeFilters(ctx, stream, filters) {
  if (!filters.length) return stream.contents;
  if (!filters.every((f) => DECODABLE.has(f.name))) throw new Error(`The filter ${filters.find((f) => !DECODABLE.has(f.name)).name} is not supported.`);
  const dict = PDFDict.withContext(ctx);
  dict.set(N('Filter'), ctx.obj(filters.map((f) => N(f.name))));
  let data = decodePDFRawStream(PDFRawStream.of(dict, stream.contents)).decode();
  const last = filters[filters.length - 1];
  if (last.params && (last.name === 'FlateDecode' || last.name === 'LZWDecode')) data = unpredict(data, last.params, ctx);
  return data;
}

/**
 * The samples of an image XObject: {width, height, bpc, comps, rowBytes, data, jpeg} with data the packed rows
 * (one byte per component at 8 bits; at 1, 2 and 4 bits packed, rows padded to whole bytes). JPEG images are
 * decoded with the codec to 8-bit RGB (jpeg: true). Throws for codecs that cannot be decoded (JPEG 2000, JBIG2, CCITT).
 */
export async function decodeImage(ctx, stream, codec) {
  if (!(stream instanceof PDFRawStream)) throw new Error('The image cannot be read.');
  const d = stream.dict;
  const width = num(ctx, d, 'Width', 0); const height = num(ctx, d, 'Height', 0);
  if (!(width > 0 && height > 0)) throw new Error('The image has no size.');
  const mask = lookup(ctx, d.get(N('ImageMask'))) === PDFBool.True;
  const filters = filtersOf(ctx, d);
  const last = filters[filters.length - 1];
  if (last && last.name === 'DCTDecode') {
    if (!codec?.decodeJpeg) throw new Error('JPEG images cannot be decoded here.');
    const jpeg = decodeFilters(ctx, stream, filters.slice(0, -1));
    const img = await codec.decodeJpeg(jpeg);
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0, k = 0; i < img.data.length; i += 4) { rgb[k++] = img.data[i]; rgb[k++] = img.data[i + 1]; rgb[k++] = img.data[i + 2]; }
    return { width: img.width, height: img.height, bpc: 8, comps: 3, rowBytes: img.width * 3, data: rgb, jpeg: true, mask: false };
  }
  const bpc = mask ? 1 : num(ctx, d, 'BitsPerComponent', 8);
  const comps = mask ? 1 : componentsOf(ctx, d.get(N('ColorSpace')));
  if (!comps || ![1, 2, 4, 8, 16].includes(bpc)) throw new Error('The image colour space is not supported.');
  const data = decodeFilters(ctx, stream, filters);
  const rowBytes = Math.ceil((width * comps * bpc) / 8);
  if (data.length < rowBytes * height) throw new Error('The image data is incomplete.');
  return { width, height, bpc, comps, rowBytes, data: data.length === rowBytes * height ? data : data.slice(0, rowBytes * height), jpeg: false, mask };
}

/** Sets sample values (one per component) for the pixels in [x0, x1) x [y0, y1) of decoded image data. */
export function fillPixels(img, x0, y0, x1, y1, values) {
  const { bpc, comps, rowBytes, data } = img;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(img.width, x1); y1 = Math.min(img.height, y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  for (let y = y0; y < y1; y++) {
    const row = y * rowBytes;
    for (let x = x0; x < x1; x++) {
      for (let c = 0; c < comps; c++) {
        const v = values[c] ?? values[0];
        if (bpc === 8) data[row + x * comps + c] = v;
        else if (bpc === 16) { const o = row + (x * comps + c) * 2; data[o] = v >> 8; data[o + 1] = v & 255; }
        else {
          const bit = (x * comps + c) * bpc; const o = row + (bit >> 3); const shift = 8 - bpc - (bit & 7); const m = ((1 << bpc) - 1) << shift;
          data[o] = (data[o] & ~m) | ((v << shift) & m);
        }
      }
    }
  }
  return (x1 - x0) * (y1 - y0);
}

/** One sample of decoded image data as a value between 0 and 1. */
export function sampleAt(img, x, y, c) {
  const { bpc, comps, rowBytes, data } = img;
  const max = (2 ** bpc) - 1;
  if (bpc === 8) return data[y * rowBytes + x * comps + c] / 255;
  if (bpc === 16) { const o = y * rowBytes + (x * comps + c) * 2; return ((data[o] << 8) | data[o + 1]) / 65535; }
  const bit = (x * comps + c) * bpc; const o = y * rowBytes + (bit >> 3);
  return ((data[o] >> (8 - bpc - (bit & 7))) & max) / max;
}

/** Stores image data as a new stream with the dictionary entries of the original (Flate, or JPEG for decoded JPEGs). */
export async function encodeImage(ctx, original, img, codec, quality = 0.85) {
  const dict = original.dict.clone(ctx);
  for (const k of ['Filter', 'DecodeParms', 'DP', 'Length']) dict.delete(N(k));
  if (img.jpeg) {
    if (!codec?.encodeJpeg) throw new Error('JPEG images cannot be stored here.');
    const rgba = new Uint8ClampedArray(img.width * img.height * 4);
    for (let i = 0, k = 0; k < rgba.length; i += 3) { rgba[k++] = img.data[i]; rgba[k++] = img.data[i + 1]; rgba[k++] = img.data[i + 2]; rgba[k++] = 255; }
    const bytes = await codec.encodeJpeg(rgba, img.width, img.height, quality);
    dict.set(N('Filter'), N('DCTDecode'));
    dict.set(N('ColorSpace'), N('DeviceRGB'));
    dict.set(N('BitsPerComponent'), PDFNumber.of(8));
    dict.set(N('Width'), PDFNumber.of(img.width)); dict.set(N('Height'), PDFNumber.of(img.height));
    dict.delete(N('Decode'));
    return PDFRawStream.of(dict, bytes);
  }
  const bytes = deflate(ctx, img.data);
  dict.set(N('Filter'), N('FlateDecode'));
  dict.set(N('Width'), PDFNumber.of(img.width)); dict.set(N('Height'), PDFNumber.of(img.height));
  if (!img.mask) dict.set(N('BitsPerComponent'), PDFNumber.of(img.bpc));
  return PDFRawStream.of(dict, bytes);
}

/** Compresses bytes with Flate (zlib), as pdf-lib does. */
export const deflate = (ctx, bytes) => ctx.flateStream(bytes).contents;

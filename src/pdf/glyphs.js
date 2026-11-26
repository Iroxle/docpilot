// Characters that a PDF maps to nothing. Some fonts have alternate shapes of punctuation, e.g. Inter raises the
// hyphen, dashes, colon and parentheses between capitals and digits ("CH-6275", "VAT: CHE-"). PDF producers
// (e.g. Chrome) cannot name a character for such a glyph and map it to code 0, so the text reads "CH\u00006275"
// and setting it again would print "CH?6275". The shape of the glyph in the embedded font shows which character it is.
import fontkit from '@cantoo/fontkit';
import { PDFName, PDFDict, PDFArray, PDFRawStream, PDFStream, decodePDFRawStream } from '@cantoo/pdf-lib';

function streamBytes(s) {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s && typeof s.getUnencodedContents === 'function') return s.getUnencodedContents();
  if (s instanceof PDFStream) return s.getContents();
  return new Uint8Array(0);
}
const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return s; };

/** Codes that a ToUnicode CMap maps to U+0000. */
export function zeroCodes(cmap) {
  const out = new Set();
  const isZero = (d) => /^0+$/.test(d);
  for (const m of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) if (isZero(p[2])) out.add(parseInt(p[1], 16));
  }
  for (const m of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16); const hi = parseInt(p[2], 16);
      if (p[3].startsWith('[')) [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((d, k) => { if (isZero(d[1]) && lo + k <= hi) out.add(lo + k); });
      else if (isZero(p[3].slice(1, -1))) out.add(lo);
    }
  }
  return out;
}

/**
 * Character for the outline of a glyph (fontkit path, font units), or null. Recognizes the punctuation that fonts
 * draw in alternate forms: hyphen and dashes (a flat bar), colon and semicolon (two marks above each other),
 * parentheses and square brackets (a tall narrow shape), vertical bar and equals sign.
 */
export function glyphChar(path, upm) {
  const contours = []; let cur = null;
  for (const c of path?.commands || []) {
    if (c.command === 'moveTo') { cur = { pts: [[c.args[0], c.args[1]]], curved: false }; contours.push(cur); continue; }
    if (!cur || c.command === 'closePath') continue;
    for (let k = 0; k + 1 < c.args.length; k += 2) cur.pts.push([c.args[k], c.args[k + 1]]);
    if (c.command !== 'lineTo') cur.curved = true;
  }
  if (!contours.length || !(upm > 0)) return null;
  for (const c of contours) {
    const xs = c.pts.map((p) => p[0]); const ys = c.pts.map((p) => p[1]);
    Object.assign(c, { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    c.w = c.x1 - c.x0; c.h = c.y1 - c.y0;
  }
  const bar = (c) => !c.curved && c.h <= upm * 0.15 && c.w >= c.h * 1.5;
  if (contours.length === 1) {
    const c = contours[0];
    if (bar(c)) {
      if (c.y1 <= upm * 0.02) return '_';
      const w = c.w / upm;
      return w >= 0.8 ? '—' : w >= 0.42 ? '–' : '-';
    }
    if (c.h >= upm * 0.6 && c.w <= upm * 0.45) {
      const mid = (c.y0 + c.y1) / 2; const tol = c.h * 0.2;
      const at = (x) => c.pts.filter((p) => Math.abs(p[0] - x) <= upm * 0.02);
      if (c.curved) {
        // Parenthesis: the bulge (the extreme point in the middle of the height) is on the left for "(".
        const left = at(c.x0).some((p) => Math.abs(p[1] - mid) <= tol); const right = at(c.x1).some((p) => Math.abs(p[1] - mid) <= tol);
        if (left && !right) return '(';
        if (right && !left) return ')';
        return null;
      }
      if (c.w <= upm * 0.12) return '|';
      // Square bracket: the stem runs over the whole height on the left for "[".
      const stem = (x) => { const ys = at(x).map((p) => p[1]); return ys.length >= 2 && Math.max(...ys) - Math.min(...ys) >= c.h * 0.9; };
      if (stem(c.x0) && !stem(c.x1)) return '[';
      if (stem(c.x1) && !stem(c.x0)) return ']';
    }
    return null;
  }
  if (contours.length === 2) {
    const [low, high] = [...contours].sort((p, q) => p.y0 - q.y0);
    const overlapX = Math.min(low.x1, high.x1) - Math.max(low.x0, high.x0);
    if (high.y0 <= low.y1 || overlapX < Math.min(low.w, high.w) * 0.3) return null;
    if (bar(low) && bar(high) && Math.abs(low.w - high.w) <= upm * 0.05) return '=';
    const small = (c) => Math.max(c.w, c.h) <= upm * 0.3;
    if (small(high) && Math.max(low.w, low.h) <= upm * 0.4) return low.h > high.h * 1.4 ? ';' : ':';
  }
  return null;
}

/** Glyph number for a code of a Type0 font with Identity encoding (CIDToGIDMap: Identity or a table). */
function gidMapper(df) {
  const map = df.lookup(PDFName.of('CIDToGIDMap'));
  if (!map || map === PDFName.of('Identity')) return (cid) => cid;
  if (!(map instanceof PDFStream)) return null;
  const b = streamBytes(map);
  return (cid) => (cid * 2 + 1 < b.length ? b[cid * 2] * 256 + b[cid * 2 + 1] : 0);
}

function compute(fontDict) {
  if (fontDict.lookup(PDFName.of('Subtype')) !== PDFName.of('Type0')) return null;
  const tu = fontDict.lookup(PDFName.of('ToUnicode'));
  if (!(tu instanceof PDFStream)) return null;
  const zero = zeroCodes(latin1(streamBytes(tu)));
  if (!zero.size) return null;
  const enc = fontDict.lookup(PDFName.of('Encoding'));
  if (enc !== PDFName.of('Identity-H') && enc !== PDFName.of('Identity-V')) return null;
  const df = fontDict.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
  if (df.lookup(PDFName.of('Subtype')) !== PDFName.of('CIDFontType2')) return null;
  const fd = df.lookup(PDFName.of('FontDescriptor'), PDFDict);
  const file = fd.lookup(PDFName.of('FontFile2'));
  const gid = gidMapper(df);
  if (!(file instanceof PDFStream) || !gid) return null;
  const font = fontkit.create(streamBytes(file));
  const out = new Map();
  for (const code of zero) {
    const g = gid(code);
    if (!g || g >= font.numGlyphs) continue;
    const ch = glyphChar(font.getGlyph(g).path, font.unitsPerEm);
    if (ch) out.set(code, ch);
  }
  return out.size ? out : null;
}

const cache = new WeakMap();
/** Characters for the codes of a font that its ToUnicode map leaves empty: Map(code -> character) or null. */
export function unmappedChars(fontDict) {
  if (!fontDict) return null;
  if (cache.has(fontDict)) return cache.get(fontDict);
  let out = null;
  try { out = compute(fontDict); } catch { out = null; }
  cache.set(fontDict, out);
  return out;
}

/**
 * Puts the recognized characters into PDF.js text items that contain U+0000. glyphs: [{ x, y, ch }] from
 * interpret(page, { glyphs: true }), the positions of such glyphs on the page. Items without them stay as they are.
 */
export function fixUnmapped(items, glyphs) {
  if (!glyphs?.length) return items;
  return items.map((t) => {
    if (!t.str || !t.str.includes('\u0000') || !t.transform) return t;
    const [, b, c, d, e, f] = t.transform;
    if (Math.abs(b) > 0.01 * Math.max(1, Math.abs(d))) return t;
    const size = Math.hypot(c, d) || t.height || 1;
    const near = glyphs.filter((g) => Math.abs(g.y - f) < size * 0.3 && g.x > e - size * 0.3 && g.x < e + (t.width || 0) + size * 0.1).sort((p, q) => p.x - q.x);
    if (!near.length) return t;
    const n = t.str.split('\u0000').length - 1;
    const same = near.every((g) => g.ch === near[0].ch);
    if (near.length !== n && !same) return t;
    let k = 0;
    return { ...t, str: t.str.replace(/\u0000/g, () => (near.length === n ? near[k++].ch : near[0].ch)) };
  });
}

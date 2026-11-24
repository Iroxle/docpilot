// Pure PDF operations at byte level (without DOM, so they can be tested independently).
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFNumber, PDFRef, PDFRawStream,
  StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  beginText, endText, setFontAndSize, showText, setTextMatrix, setTextRenderingMode, TextRenderingMode,
  PDFBool, PDFNull, setLineWidth, setStrokingColor, setCharacterSqueeze, PDFOperator,
} from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export async function loadDoc(bytes, password) {
  const opts = { updateMetadata: false, throwOnInvalidObject: false };
  if (password !== undefined && password !== null) opts.password = password;
  const doc = await PDFDocument.load(bytes, opts);
  doc.registerFontkit(fontkit);
  return doc;
}
export async function loadForEdit(bytes) {
  try { return await loadDoc(bytes); }
  catch (e) { if (/encrypt/i.test(e.message || '') || e.name === 'EncryptedPDFError') return loadDoc(bytes, ''); throw e; }
}
export const saveDoc = (doc, o = {}) => doc.save({ updateFieldAppearances: false, objectsPerTick: 2000, useObjectStreams: true, ...o });

async function edit(bytes, fn) {
  const doc = await loadForEdit(bytes);
  const extra = await fn(doc);
  const out = await saveDoc(doc);
  return extra === undefined ? out : { bytes: out, ...extra };
}

const identityMap = (n) => Array.from({ length: n }, (_, i) => i);

/** Returns a matrix that converts display coordinates (origin at the bottom left of the visible page) into page coordinates. */
export function displayMatrix(page) {
  const { x, y, width: w, height: h } = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  switch (rot) {
    case 90: return { m: [0, 1, -1, 0, x + w, y], width: h, height: w };
    case 180: return { m: [-1, 0, 0, -1, x + w, y + h], width: w, height: h };
    case 270: return { m: [0, -1, 1, 0, x, y + h], width: h, height: w };
    default: return { m: [1, 0, 0, 1, x, y], width: w, height: h };
  }
}
export function inDisplaySpace(page, fn) {
  const { m, width, height } = displayMatrix(page);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
  fn(width, height);
  page.pushOperators(popGraphicsState());
}

export function parseRange(text, numPages) {
  const out = [];
  for (const raw of String(text || '').split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)?\s*-\s*(\d+)?$/);
    if (m) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : numPages;
      if (a < 1 || b > numPages || a > b) throw new Error(`Invalid page range: ${part}`);
      for (let i = a; i <= b; i++) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      if (+part < 1 || +part > numPages) throw new Error(`Page ${part} does not exist.`);
      out.push(+part - 1);
    } else throw new Error(`Invalid page range: ${part}`);
  }
  return out;
}

// --- Organize pages ------------------------------------------------------------------
export const rotatePages = (bytes, idx, delta) => edit(bytes, (d) => {
  for (const i of idx) { const p = d.getPage(i); p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360)); }
});

export function deletePages(bytes, idx) {
  return edit(bytes, (d) => {
    const n = d.getPageCount();
    const del = new Set(idx);
    if (del.size >= n) throw new Error('At least one page must remain in the document.');
    [...del].sort((a, b) => b - a).forEach((i) => d.removePage(i));
    return { pageMap: identityMap(n).filter((i) => !del.has(i)) };
  });
}

/** order: new order as a list of old indices. Page objects are kept, and therefore bookmarks too. */
export function reorderPages(bytes, order) {
  return edit(bytes, (d) => {
    const pages = d.getPages();
    if (order.length !== pages.length) throw new Error('Page order is incomplete.');
    // Rebuild the page tree flat; inherited attributes are copied to the page first.
    const ctx = d.context;
    const rootRef = d.catalog.get(PDFName.of('Pages'));
    for (const p of pages) {
      const n = p.node;
      const m = p.getMediaBox(); const c = p.getCropBox();
      n.set(PDFName.of('MediaBox'), ctx.obj([m.x, m.y, m.x + m.width, m.y + m.height]));
      n.set(PDFName.of('CropBox'), ctx.obj([c.x, c.y, c.x + c.width, c.y + c.height]));
      n.set(PDFName.of('Rotate'), PDFNumber.of(p.getRotation().angle));
      const res = n.Resources();
      if (res) n.set(PDFName.of('Resources'), res);
      n.set(PDFName.of('Parent'), rootRef);
    }
    const root = ctx.lookup(rootRef, PDFDict);
    root.set(PDFName.of('Kids'), ctx.obj(order.map((i) => pages[i].ref)));
    root.set(PDFName.of('Count'), PDFNumber.of(order.length));
    return { pageMap: order.slice() };
  });
}

export function insertBlank(bytes, at, size) {
  return edit(bytes, (d) => {
    const n = d.getPageCount();
    const ref = size || (n ? d.getPage(clamp(at - 1, 0, n - 1)).getSize() : { width: 595.28, height: 841.89 });
    d.insertPage(at, [ref.width, ref.height]);
    const map = identityMap(n); map.splice(at, 0, -1);
    return { pageMap: map };
  });
}

export function duplicatePages(bytes, idx) {
  return edit(bytes, async (d) => {
    const n = d.getPageCount();
    const sorted = [...new Set(idx)].sort((a, b) => b - a);
    const map = identityMap(n);
    const copies = await d.copyPages(d, sorted);
    sorted.forEach((i, k) => { d.insertPage(i + 1, copies[k]); map.splice(i + 1, 0, i); });
    return { pageMap: map };
  });
}

export function insertPdf(bytes, other, at, pages, otherPassword) {
  return edit(bytes, async (d) => {
    const src = await loadDoc(other, otherPassword === undefined ? '' : otherPassword);
    const idx = pages || src.getPageIndices();
    const copied = await d.copyPages(src, idx);
    const map = identityMap(d.getPageCount());
    copied.forEach((p, k) => { d.insertPage(at + k, p); map.splice(at + k, 0, -1); });
    return { pageMap: map };
  });
}

export function replacePages(bytes, startIdx, count, other, otherPages) {
  return edit(bytes, async (d) => {
    const src = await loadDoc(other, '');
    const idx = otherPages || src.getPageIndices();
    const copied = await d.copyPages(src, idx);
    const n = d.getPageCount();
    for (let i = 0; i < count; i++) d.removePage(startIdx);
    copied.forEach((p, k) => d.insertPage(startIdx + k, p));
    const map = identityMap(n); map.splice(startIdx, count, ...copied.map(() => -1));
    return { pageMap: map };
  });
}

export async function extractPages(bytes, idx) {
  const src = await loadForEdit(bytes);
  const d = await PDFDocument.create();
  (await d.copyPages(src, idx)).forEach((p) => d.addPage(p));
  return saveDoc(d);
}

export async function mergePdfs(list) {
  const d = await PDFDocument.create();
  d.registerFontkit(fontkit);
  for (const item of list) {
    const src = await loadDoc(item.bytes, item.password === undefined ? '' : item.password);
    const idx = item.pages || src.getPageIndices();
    (await d.copyPages(src, idx)).forEach((p) => d.addPage(p));
  }
  return saveDoc(d);
}

/** ranges: array of page lists, one output file each */
export async function splitPdf(bytes, ranges) {
  const out = [];
  for (const r of ranges) out.push(await extractPages(bytes, r));
  return out;
}
export function chunkRanges(n, size) {
  const r = [];
  for (let i = 0; i < n; i += size) r.push(identityMap(n).slice(i, i + size));
  return r;
}

export const cropPages = (bytes, idx, margins) => edit(bytes, (d) => {
  for (const i of idx) {
    const p = d.getPage(i);
    const b = p.getCropBox();
    let m = margins;
    if (margins.rect) { const [x0, y0, x1, y1] = margins.rect; p.setCropBox(x0, y0, x1 - x0, y1 - y0); continue; }
    const w = b.width - m.left - m.right; const h = b.height - m.top - m.bottom;
    if (w < 10 || h < 10) throw new Error('The margins are larger than the page.');
    p.setCropBox(b.x + m.left, b.y + m.bottom, w, h);
  }
});

export const resizePages = (bytes, idx, size) => edit(bytes, (d) => {
  for (const i of idx) {
    const p = d.getPage(i);
    const b = p.getCropBox();
    const s = Math.min(size.width / b.width, size.height / b.height);
    p.scaleContent(s, s);
    p.setMediaBox(b.x * s, b.y * s, size.width, size.height);
    p.setCropBox(b.x * s, b.y * s, size.width, size.height);
  }
});

// --- Add content ---------------------------------------------------------------------
const hex = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '#000000');
  const n = parseInt(m ? m[1] : '000000', 16);
  return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
};
export const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export const isWinAnsi = (s) => [...s].every((c) => {
  const o = c.codePointAt(0);
  return o === 10 || o === 13 || o === 9 || (o >= 32 && o <= 126) || (o >= 160 && o <= 255) || WIN_ANSI_EXTRA.includes(c);
});
const STD = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};
export const SYSTEM_FONTS = {
  Arial: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Times New Roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  'Courier New': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  Calibri: ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
  Verdana: ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
  Tahoma: ['tahoma.ttf', 'tahomabd.ttf', 'tahoma.ttf', 'tahomabd.ttf'],
  Georgia: ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
  'Segoe UI': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
};
/**
 * Some Windows fonts (e.g. Calibri, Courier New) cannot be written as a subset by fontkit.
 * These are embedded in full. The result is remembered per file.
 */
const subsetOk = new Map();
export function canSubset(name, data) {
  if (!subsetOk.has(name)) {
    let ok = true;
    try { const f = fontkit.create(data); const s = f.createSubset(); s.includeGlyph(f.glyphForCodePoint(65)); s.encode(); } catch { ok = false; }
    subsetOk.set(name, ok);
  }
  return subsetOk.get(name);
}
/**
 * Font catalog like in Word (set by the host). Four faces per family [Regular, Bold, Italic, Bold Italic];
 * an entry is what readFont() understands (number in the catalog or file name in the Windows fonts folder).
 * Without a catalog (tests, errors), the known Windows fonts apply.
 */
let catalog = null;
export function setFontCatalog(families) {
  catalog = new Map();
  for (const f of families || []) if (f.embeddable && f.faces.some((x) => x !== null && x !== undefined)) catalog.set(f.name.toLowerCase(), { name: f.name, faces: f.faces, symbol: !!f.symbol });
}
export const hasFontCatalog = () => !!catalog && catalog.size > 0;
function lookupFamily(family) {
  const key = String(family || '').toLowerCase();
  if (catalog?.has(key)) return catalog.get(key);
  const sys = Object.keys(SYSTEM_FONTS).find((n) => n.toLowerCase() === key);
  return sys ? { name: sys, faces: SYSTEM_FONTS[sys] } : null;
}
/** Names of all usable fonts (for picker lists). */
export function fontFamilies() {
  return catalog?.size ? [...catalog.values()].map((f) => f.name) : Object.keys(SYSTEM_FONTS);
}
/** Does the font exist? Returns the correctly spelled name or null. */
export const resolveFamily = (family) => lookupFamily(family)?.name || null;

// ccmp off: otherwise some fonts (e.g. Cambria) split "ä" into "a" + dots, and the text would read back wrongly.
const FEATURES = { liga: false, clig: false, dlig: false, rlig: false, calt: false, ccmp: false };
/**
 * Returns an embeddable font together with whether bold or italic must be synthesized
 * (like Word, when a font has no bold or italic face of its own).
 * readFont(entry) is provided by the host (Electron or test environment).
 */
export async function getStyledFont(doc, family, style, text, readFont) {
  const want = (style.bold ? 1 : 0) + (style.italic ? 2 : 0);
  doc.__fonts = doc.__fonts || new Map();
  const needsUnicode = !isWinAnsi(text || '');
  let fam = lookupFamily(family);
  // Unknown font with special characters: Arial instead of a standard font without these characters.
  if (!fam && needsUnicode) fam = lookupFamily('Arial');
  let k = want;
  if (fam) {
    const order = [want, want & 1, want & 2, 0].filter((x, i, a) => a.indexOf(x) === i);
    k = order.find((x) => fam.faces[x] !== null && fam.faces[x] !== undefined) ?? 0;
  }
  const synth = { fakeBold: !!(want & 1) && !(k & 1), fakeItalic: !!(want & 2) && !(k & 2) };
  const key = `${fam ? fam.name : family}/${k}`;
  if (doc.__fonts.has(key)) {
    const cached = doc.__fonts.get(key);
    // pdf-lib embeds a font only once. If the document has been finalized since the last text (e.g. because
    // a page was copied to read an image), newly added characters would be missing from the font subset and
    // would no longer be readable afterwards. So have it embedded again when saving.
    if (cached.alreadyEmbedded && cached.embedder?.subset) cached.alreadyEmbedded = false;
    return { font: cached, ...synth };
  }
  let font = null;
  if (fam && readFont) {
    const src = fam.faces[k];
    try {
      const data = await readFont(src);
      if (data) doc.registerFontkit(fontkit);
      // Ligatures off: otherwise e.g. 'ti' in Calibri is written as one glyph with the wrong text mapping.
      if (data) font = await doc.embedFont(data, { subset: canSubset(String(src), data), features: FEATURES });
    } catch { font = null; }
  }
  if (!font) {
    const stdName = STD[fam ? fam.name : family] ? (fam ? fam.name : family) : 'Helvetica';
    const stdKey = `std:${stdName}/${want}`;
    if (!doc.__fonts.has(stdKey)) doc.__fonts.set(stdKey, await doc.embedFont(STD[stdName][want]));
    return { font: doc.__fonts.get(stdKey), fakeBold: false, fakeItalic: false };
  }
  doc.__fonts.set(key, font);
  return { font, ...synth };
}
export async function getFont(doc, family, style, text, readFont) {
  return (await getStyledFont(doc, family, style, text, readFont)).font;
}
/**
 * Replaces characters that the font does not contain. Checks against the character set instead of encodeText,
 * because encodeText would add missing characters to the subset as glyph 0 and make saving fail.
 */
export function sanitizeFor(font, text) {
  if (!font.__chars) { try { font.__chars = new Set(font.getCharacterSet()); } catch { font.__chars = null; } }
  const set = font.__chars;
  return [...String(text).replace(/\t/g, '    ')].map((c) => {
    if (c === '\n' || c === '\r') return c;
    if (set) {
      const cp = c.codePointAt(0);
      if (set.has(cp)) return c;
      // Symbol fonts (Wingdings, Symbol ...) lie in the range F000-F0FF; Word types into that range.
      if (cp < 256 && set.has(0xF000 + cp)) return String.fromCodePoint(0xF000 + cp);
      for (const alt of [63, 0xF03F, 32, 0xF020]) if (set.has(alt)) return String.fromCodePoint(alt);
      return '';
    }
    try { font.encodeText(c); return c; } catch { return '?'; }
  }).join('');
}
export function wrapText(font, text, size, maxWidth) {
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    let cur = '';
    for (const word of para.split(/(\s+)/)) {
      const test = cur + word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && cur.trim()) { lines.push(cur.trimEnd()); cur = word.trimStart(); }
      else cur = test;
    }
    lines.push(cur);
  }
  return lines;
}

function placeAnchor(pos, W, H, bw, bh, margin) {
  const x = /left/.test(pos) ? margin : /right/.test(pos) ? W - bw - margin : (W - bw) / 2;
  const y = /top/.test(pos) ? H - bh - margin : /bottom/.test(pos) ? margin : (H - bh) / 2;
  return { x, y };
}

/** o: {text|image, mime, font, size, color, opacity, rotation, position, margin, scale, behind, pages} */
export function addWatermark(bytes, o, readFont) {
  return edit(bytes, async (d) => {
    const pages = o.pages || d.getPageIndices();
    let img = null;
    if (o.image) img = o.mime === 'image/png' ? await d.embedPng(o.image) : await d.embedJpg(o.image);
    const font = o.text ? await getFont(d, o.font || 'Helvetica', { bold: !!o.bold }, o.text, readFont) : null;
    for (const i of pages) {
      const p = d.getPage(i);
      inDisplaySpace(p, (W, H) => {
        const a = (o.rotation || 0) * Math.PI / 180;
        const bw = img ? img.width * (o.scale || 1) : font.widthOfTextAtSize(sanitizeFor(font, o.text), o.size || 48);
        const bh = img ? img.height * (o.scale || 1) : font.heightAtSize(o.size || 48, { descender: false });
        const { x: cx0, y: cy0 } = placeAnchor(o.position || 'center', W, H, bw, bh, o.margin ?? 36);
        const cx = cx0 + bw / 2; const cy = cy0 + bh / 2;
        const x = cx - (bw / 2) * Math.cos(a) + (bh / 2) * Math.sin(a);
        const y = cy - (bw / 2) * Math.sin(a) - (bh / 2) * Math.cos(a);
        if (img) p.drawImage(img, { x, y, width: bw, height: bh, rotate: degrees(o.rotation || 0), opacity: o.opacity ?? 0.5 });
        else p.drawText(sanitizeFor(font, o.text), { x, y, size: o.size || 48, font, color: hex(o.color), rotate: degrees(o.rotation || 0), opacity: o.opacity ?? 0.5 });
      });
    }
  });
}

export const addBackground = (bytes, o) => edit(bytes, (d) => {
  for (const i of o.pages || d.getPageIndices()) {
    const p = d.getPage(i);
    const { x, y, width, height } = p.getCropBox();
    const op = [pushGraphicsState()];
    p.pushOperators(...op);
    p.drawRectangle({ x, y, width, height, color: hex(o.color), opacity: o.opacity ?? 1 });
    p.pushOperators(popGraphicsState());
    // Move the background to the start of the content array so it lies behind the content.
    const c = p.node.Contents();
    if (c instanceof PDFArray && c.size() > 1) {
      const last = c.get(c.size() - 1);
      c.remove(c.size() - 1);
      c.insert(0, last);
    }
  }
});

/** o: {left,center,right,footLeft,footCenter,footRight,size,color,margin,pages,startNumber} with {page},{pages},{date},{file} */
export function addHeaderFooter(bytes, o, readFont) {
  return edit(bytes, async (d) => {
    const pages = o.pages || d.getPageIndices();
    const total = pages.length;
    const all = [o.left, o.center, o.right, o.footLeft, o.footCenter, o.footRight].filter(Boolean).join('');
    const font = await getFont(d, o.font || 'Helvetica', {}, all, readFont);
    const size = o.size || 10; const margin = o.margin ?? 28; const color = hex(o.color);
    const fill = (t, n) => sanitizeFor(font, t.replace(/\{page\}/g, n).replace(/\{pages\}/g, total)
      .replace(/\{date\}/g, new Date().toLocaleDateString('en-GB')).replace(/\{file\}/g, o.fileName || ''));
    pages.forEach((i, k) => {
      const p = d.getPage(i);
      const n = (o.startNumber || 1) + k;
      inDisplaySpace(p, (W, H) => {
        const put = (t, pos, y) => {
          if (!t) return;
          const s = fill(t, n);
          const w = font.widthOfTextAtSize(s, size);
          const x = pos === 0 ? margin : pos === 1 ? (W - w) / 2 : W - margin - w;
          p.drawText(s, { x, y, size, font, color });
        };
        put(o.left, 0, H - margin - size); put(o.center, 1, H - margin - size); put(o.right, 2, H - margin - size);
        put(o.footLeft, 0, margin); put(o.footCenter, 1, margin); put(o.footRight, 2, margin);
      });
    });
  });
}

export const addBates = (bytes, o, readFont) => addHeaderFooterBates(bytes, o, readFont);
function addHeaderFooterBates(bytes, o, readFont) {
  return edit(bytes, async (d) => {
    const font = await getFont(d, 'Helvetica', { bold: true }, '', readFont);
    const size = o.size || 10; const margin = o.margin ?? 24;
    let n = o.start || 1;
    for (const i of o.pages || d.getPageIndices()) {
      const label = `${o.prefix || ''}${String(n).padStart(o.digits || 6, '0')}${o.suffix || ''}`;
      const p = d.getPage(i);
      inDisplaySpace(p, (W, H) => {
        const w = font.widthOfTextAtSize(label, size);
        const { x, y } = placeAnchor(o.position || 'bottom-right', W, H, w, size, margin);
        p.drawText(sanitizeFor(font, label), { x, y, size, font, color: hex(o.color) });
      });
      n++;
    }
  });
}

/** New text block in the PDF content. rect in page coordinates. */
export function drawTextBlock(page, font, text, rect, o) {
  const [x0, y0, x1, y1] = rect;
  const lh = o.lineHeight || o.size * 1.2;
  // Horizontal scaling (Tz), e.g. so newly set text runs as wide as the font in the scan.
  const hs = o.hscale > 0 && Math.abs(o.hscale - 1) > 0.002 ? o.hscale : 1;
  const lines = wrapText(font, sanitizeFor(font, text), o.size, Math.max(10, x1 - x0) / hs);
  let y = y1 - o.size;
  const color = Array.isArray(o.color) ? rgb(...o.color) : hex(o.color);
  if (hs !== 1) page.pushOperators(pushGraphicsState(), setCharacterSqueeze(Math.round(hs * 1000) / 10));
  // Synthesized bold (outline in text color) and italic (12° slant), the way Word does it.
  if (o.fakeBold) page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(o.size * 0.03), setStrokingColor(color));
  for (const line of lines) {
    const w = font.widthOfTextAtSize(line, o.size) * hs;
    const x = o.align === 'center' ? (x0 + x1 - w) / 2 : o.align === 'right' ? x1 - w : x0;
    if (line) page.drawText(line, { x, y, size: o.size, font, color, ...(o.fakeItalic ? { ySkew: degrees(12) } : {}) });
    y -= lh;
  }
  if (o.fakeBold) page.pushOperators(popGraphicsState());
  if (hs !== 1) page.pushOperators(popGraphicsState());
  return y1 - y - lh;
}

/** Area that drawTextBlock prints with the same details (with some margin): [x0, y0, x1, y1]. */
export function textBlockBox(font, text, rect, o) {
  const [x0, , x1, y1] = rect;
  const lh = o.lineHeight || o.size * 1.2;
  const hs = o.hscale > 0 && Math.abs(o.hscale - 1) > 0.002 ? o.hscale : 1;
  const lines = wrapText(font, sanitizeFor(font, text), o.size, Math.max(10, x1 - x0) / hs);
  let left = Infinity; let right = -Infinity;
  for (const line of lines) {
    if (!line) continue;
    const w = font.widthOfTextAtSize(line, o.size) * hs;
    const x = o.align === 'center' ? (x0 + x1 - w) / 2 : o.align === 'right' ? x1 - w : x0;
    left = Math.min(left, x); right = Math.max(right, x + w);
  }
  if (!Number.isFinite(left)) return null;
  const pad = o.size * 0.25;
  const lastBase = y1 - o.size - (lines.length - 1) * lh;
  return [left - pad, lastBase - o.size * 0.3 - pad, right + pad, y1 + pad];
}

export function addTextBlock(bytes, pageIdx, rect, text, o, readFont) {
  return edit(bytes, async (d) => {
    const { font, fakeBold, fakeItalic } = await getStyledFont(d, o.family || 'Arial', o, text, readFont);
    drawTextBlock(d.getPage(pageIdx), font, text, rect, { ...o, fakeBold, fakeItalic });
  });
}

/**
 * Places an image with its center at (cx, cy). On rotated pages it is rotated too, so that it is upright
 * in the view. width/height: size as displayed, rotate: page rotation in degrees.
 */
export function placeImage(bytes, pageIdx, { cx, cy, width, height, rotate = 0 }, image, mime) {
  return edit(bytes, async (d) => {
    const img = mime === 'image/png' ? await d.embedPng(image) : await d.embedJpg(image);
    const t = (((rotate % 360) + 360) % 360) * Math.PI / 180;
    const c = Math.cos(t); const s = Math.sin(t);
    const x = cx - (width / 2 * c - height / 2 * s); const y = cy - (width / 2 * s + height / 2 * c);
    drawObjectImage(d.getPage(pageIdx), img, { x, y, width, height, rotate: degrees((((rotate % 360) + 360) % 360)) });
  });
}

/**
 * Draws an image as an object of the page, marked with /DPPaste (see PASTE_TAG in content.js): the
 * editor treats it as a whole together with the text recognized in it, unlike the pieces of a scan.
 */
function drawObjectImage(page, img, o) {
  page.pushOperators(PDFOperator.of('BMC', [PDFName.of('DPPaste')]));
  page.drawImage(img, o);
  page.pushOperators(PDFOperator.of('EMC'));
}

export function addImage(bytes, pageIdx, rect, image, mime) {
  return edit(bytes, async (d) => {
    const img = mime === 'image/png' ? await d.embedPng(image) : await d.embedJpg(image);
    const [x0, y0, x1, y1] = rect;
    drawObjectImage(d.getPage(pageIdx), img, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  });
}

export function addLink(bytes, pageIdx, rect, target) {
  return edit(bytes, (d) => {
    const ctx = d.context;
    const page = d.getPage(pageIdx);
    const annot = ctx.obj({
      Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], F: 4,
      ...(target.page !== undefined ? { Dest: [d.getPage(target.page).ref, PDFName.of('Fit')] } : {}),
    });
    if (target.url) annot.set(PDFName.of('A'), ctx.obj({ S: 'URI', URI: PDFString.of(target.url) }));
    page.node.addAnnot(ctx.register(annot));
  });
}

export const removeLinks = (bytes, pageIdx, rect) => edit(bytes, (d) => {
  const page = d.getPage(pageIdx);
  const annots = page.node.Annots();
  if (!annots) return;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const a = annots.lookup(i, PDFDict);
    if (a.lookup(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
    const r = a.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => a.context.lookup(n).asNumber());
    if (!rect || (r[0] < rect[2] && r[2] > rect[0] && r[1] < rect[3] && r[3] > rect[1])) annots.remove(i);
  }
});

// --- Lesezeichen -----------------------------------------------------------------------
/** tree: [{title, page, top, children, open}] */
export const setOutline = (bytes, tree) => edit(bytes, (d) => {
  const ctx = d.context;
  const pages = d.getPages();
  const build = (items, parentRef) => {
    const refs = items.map(() => ctx.nextRef());
    let total = 0;
    items.forEach((it, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parentRef });
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < items.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      if (it.page !== undefined && it.page !== null && pages[it.page]) {
        const p = pages[it.page];
        const top = it.top ?? p.getCropBox().y + p.getCropBox().height;
        dict.set(PDFName.of('Dest'), ctx.obj([p.ref, PDFName.of('XYZ'), PDFNull, PDFNumber.of(top), PDFNull]));
      }
      if (it.url && it.page === undefined) dict.set(PDFName.of('A'), ctx.obj({ S: 'URI', URI: PDFString.of(it.url) }));
      total += 1;
      if (it.children && it.children.length) {
        const sub = build(it.children, refs[i]);
        dict.set(PDFName.of('First'), sub.refs[0]);
        dict.set(PDFName.of('Last'), sub.refs[sub.refs.length - 1]);
        dict.set(PDFName.of('Count'), PDFNumber.of(it.open === false ? -sub.total : sub.total));
        total += it.open === false ? 0 : sub.total;
      }
      ctx.assign(refs[i], dict);
    });
    return { refs, total };
  };
  const catalog = d.catalog;
  if (!tree.length) { catalog.delete(PDFName.of('Outlines')); return; }
  const rootRef = ctx.nextRef();
  const { refs, total } = build(tree, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: total }));
  catalog.set(PDFName.of('Outlines'), rootRef);
});

// --- Dokumenteigenschaften -------------------------------------------------------------
export const setMetadata = (bytes, m) => edit(bytes, (d) => {
  if (m.title !== undefined) d.setTitle(m.title);
  if (m.author !== undefined) d.setAuthor(m.author);
  if (m.subject !== undefined) d.setSubject(m.subject);
  if (m.keywords !== undefined) d.setKeywords(m.keywords ? m.keywords.split(/[,;]\s*/) : []);
  if (m.creator !== undefined) d.setCreator(m.creator);
  d.setModificationDate(new Date());
});

/** o: {layout, mode, page, fit, title(bool)} */
export const setInitialView = (bytes, o) => edit(bytes, (d) => {
  const c = d.catalog; const ctx = d.context;
  const set = (k, v) => (v ? c.set(PDFName.of(k), PDFName.of(v)) : c.delete(PDFName.of(k)));
  set('PageLayout', o.layout); set('PageMode', o.mode);
  if (o.page !== undefined) c.set(PDFName.of('OpenAction'), ctx.obj([d.getPage(o.page).ref, PDFName.of(o.fit || 'Fit')]));
  const vp = c.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict) || ctx.obj({});
  vp.set(PDFName.of('DisplayDocTitle'), o.showTitle ? PDFBool.True : PDFBool.False);
  c.set(PDFName.of('ViewerPreferences'), vp);
});

export const setLanguage = (bytes, lang) => edit(bytes, (d) => { d.setLanguage(lang); });

/** ranges: [{from, style:'D'|'r'|'R'|'a'|'A', prefix, start}] */
export const setPageLabels = (bytes, ranges) => edit(bytes, (d) => {
  const ctx = d.context;
  const nums = [];
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    const dict = ctx.obj({});
    if (r.style) dict.set(PDFName.of('S'), PDFName.of(r.style));
    if (r.prefix) dict.set(PDFName.of('P'), PDFHexString.fromText(r.prefix));
    if (r.start && r.start !== 1) dict.set(PDFName.of('St'), PDFNumber.of(r.start));
    nums.push(PDFNumber.of(r.from), dict);
  }
  d.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: nums }));
});

export const addAttachment = (bytes, name, data, mime, description) => edit(bytes, async (d) => {
  await d.attach(data, name, { mimeType: mime || 'application/octet-stream', description: description || '', creationDate: new Date(), modificationDate: new Date() });
});

function nameTreeEntries(ctx, node, out) {
  const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) for (let i = 0; i + 1 < names.size(); i += 2) out.push([names.get(i), names.get(i + 1)]);
  const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) for (let i = 0; i < kids.size(); i++) nameTreeEntries(ctx, kids.lookup(i, PDFDict), out);
  return out;
}
const decodeName = (ctx, o) => { const v = ctx.lookup(o); return v.decodeText ? v.decodeText() : String(v); };

function embeddedFilesNode(d) {
  const names = d.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  return names ? names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict) : undefined;
}
export const removeAttachment = (bytes, name) => edit(bytes, (d) => {
  const ef = embeddedFilesNode(d);
  if (!ef) return;
  const all = nameTreeEntries(d.context, ef, []).filter(([k]) => name !== null && decodeName(d.context, k) !== name);
  ef.delete(PDFName.of('Kids')); ef.delete(PDFName.of('Limits'));
  ef.set(PDFName.of('Names'), d.context.obj(all.flat()));
  // update /AF entries
  const af = d.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (af) d.catalog.set(PDFName.of('AF'), d.context.obj(all.map(([, v]) => v)));
});

// --- Dokument-JavaScript ---------------------------------------------------------------
export const setDocumentJavascript = (bytes, name, code) => edit(bytes, (d) => {
  const ctx = d.context;
  let names = d.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (!names) { names = ctx.obj({}); d.catalog.set(PDFName.of('Names'), names); }
  let js = names.lookupMaybe(PDFName.of('JavaScript'), PDFDict);
  if (!js) { js = ctx.obj({ Names: [] }); names.set(PDFName.of('JavaScript'), js); }
  const entries = nameTreeEntries(ctx, js, []).filter(([k]) => decodeName(ctx, k) !== name);
  if (code) entries.push([PDFHexString.fromText(name), ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFHexString.fromText(code) }))]);
  js.delete(PDFName.of('Kids')); js.delete(PDFName.of('Limits'));
  js.set(PDFName.of('Names'), ctx.obj(entries.flat()));
});
export async function listDocumentJavascript(bytes) {
  const d = await loadForEdit(bytes);
  const names = d.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const js = names && names.lookupMaybe(PDFName.of('JavaScript'), PDFDict);
  if (!js) return [];
  return nameTreeEntries(d.context, js, []).map(([k, v]) => {
    const act = d.context.lookup(v);
    const code = act.lookup(PDFName.of('JS'));
    let text = '';
    if (code && code.decodeText) text = code.decodeText();
    return { name: decodeName(d.context, k), code: text };
  });
}

// --- Bereinigen, Optimieren ------------------------------------------------------------
/** o: {metadata, attachments, comments, javascript, forms, links, hiddenLayers, thumbs} */
export const sanitizeDocument = (bytes, o) => edit(bytes, (d) => {
  const c = d.catalog; const ctx = d.context;
  if (o.metadata) {
    c.delete(PDFName.of('Metadata'));
    const infoRef = ctx.trailerInfo.Info;
    if (infoRef) { ctx.delete(infoRef); ctx.trailerInfo.Info = undefined; }
    d.getInfoDict();
    for (const p of d.getPages()) p.node.delete(PDFName.of('Metadata'));
  }
  const names = c.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (o.attachments) { if (names) names.delete(PDFName.of('EmbeddedFiles')); c.delete(PDFName.of('AF')); }
  if (o.javascript) { if (names) names.delete(PDFName.of('JavaScript')); c.delete(PDFName.of('OpenAction')); c.delete(PDFName.of('AA')); }
  if (o.forms) { try { d.getForm().flatten(); } catch { /* no fields */ } c.delete(PDFName.of('AcroForm')); }
  for (const p of d.getPages()) {
    if (o.thumbs) p.node.delete(PDFName.of('Thumb'));
    if (o.javascript) p.node.delete(PDFName.of('AA'));
    const annots = p.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (!a) continue;
      const st = a.lookup(PDFName.of('Subtype')); const name = st ? st.toString() : '';
      if ((name === '/Link' && o.links) || (name !== '/Link' && name !== '/Widget' && o.comments) || (name === '/Widget' && o.forms)) annots.remove(i);
    }
  }
  gcObjects(d);
});

/** Removes objects that are no longer referenced (after deleting pages, redacting, sanitizing). */
export function gcObjects(d) {
  const ctx = d.context;
  const seen = new Set();
  const visit = (o) => {
    if (!o) return;
    if (o instanceof PDFRef) { if (seen.has(o.tag)) return; seen.add(o.tag); visit(ctx.lookup(o)); return; }
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) visit(o.get(i)); return; }
    if (o instanceof PDFDict) { for (const [, v] of o.entries()) visit(v); return; }
    if (o.dict instanceof PDFDict) visit(o.dict);
  };
  visit(ctx.trailerInfo.Root); visit(ctx.trailerInfo.Info); visit(ctx.trailerInfo.Encrypt);
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

/**
 * recompress(info) -> Promise<{bytes,width,height,gray}|null>; info: {bytes,filter,width,height,bpc,components}
 */
export async function optimize(bytes, o, recompress) {
  const d = await loadForEdit(bytes);
  let imagesDone = 0;
  if (recompress) {
    const items = d.context.enumerateIndirectObjects();
    for (const [, obj] of items) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
      if (dict.has(PDFName.of('Mask')) || dict.lookup(PDFName.of('ImageMask')) === PDFBool.True) continue;
      const filter = dict.lookup(PDFName.of('Filter'));
      const fname = filter instanceof PDFArray ? (filter.size() === 1 ? filter.lookup(0).toString() : '') : (filter ? filter.toString() : '');
      if (fname !== '/DCTDecode') continue;
      const res = await recompress({ bytes: obj.contents, width: dict.lookup(PDFName.of('Width')).asNumber(), height: dict.lookup(PDFName.of('Height')).asNumber() });
      if (!res || res.bytes.length >= obj.contents.length) continue;
      obj.contents = res.bytes;
      dict.set(PDFName.of('Width'), PDFNumber.of(res.width));
      dict.set(PDFName.of('Height'), PDFNumber.of(res.height));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.delete(PDFName.of('DecodeParms'));
      dict.set(PDFName.of('Length'), PDFNumber.of(res.bytes.length));
      imagesDone++;
    }
  }
  for (const p of d.getPages()) p.node.delete(PDFName.of('Thumb'));
  if (o && o.removeMetadataStream) d.catalog.delete(PDFName.of('Metadata'));
  gcObjects(d);
  const out = await saveDoc(d);
  return { bytes: out, images: imagesDone };
}

export const encrypt = (bytes, o) => edit(bytes, (d) => {
  d.encrypt({
    userPassword: o.userPassword || '', ownerPassword: o.ownerPassword || o.userPassword || cryptoRandom(),
    permissions: o.permissions || { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
  });
});
export function cryptoRandom() {
  const a = new Uint8Array(24); globalThis.crypto.getRandomValues(a);
  return Array.from(a, (v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Invisible text over rasterized or scanned pages. words: [{text,x,y,width,height,line?,par?,angle?}] in
 * page coordinates. Words on the same line get a space up to the next word, so search and
 * copy find the words separately. pars: details per paragraph ({font, bold, tz}); each paragraph is marked as
 * its own block (like editor text), with the font that was recognized in the image.
 */
export function drawInvisibleWords(page, font, words, pars, ctx) {
  const fontKey = page.node.newFontDictionary(font.name, font.ref);
  const groups = new Map();
  for (const w of words) { const k = pars && w.par !== undefined ? w.par : -1; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); }
  const stamp = Date.now().toString(36);
  for (const [k, list] of groups) {
    const props = k >= 0 ? pars[k] : null;
    if (props) {
      const dict = { Id: PDFString.of(`ocr${stamp}${Math.random().toString(36).slice(2, 8)}`), Ocr: 1, Tz: Math.round((props.tz || 100) * 10) / 10 };
      if (props.font) dict.Font = PDFString.of(props.font);
      if (props.bold) dict.Bold = 1;
      page.pushOperators(PDFOperator.of('BDC', [PDFName.of('DPEdit'), ctx.obj(dict)]));
    }
    list.forEach((w, j) => {
      const next = list[j + 1];
      const sameLine = next && w.line !== undefined && next.line === w.line && next.x > w.x;
      // Word of a skewed line (angle: direction of the line in the image, in radians): write it rotated.
      const co = w.angle ? Math.cos(w.angle) : 1; const si = w.angle ? Math.sin(w.angle) : 0;
      const text = sanitizeFor(font, w.text) + (sameLine ? ' ' : '');
      if (!text.trim()) return;
      const size = Math.max(1, w.height);
      const natural = font.widthOfTextAtSize(text, size);
      const target = sameLine ? (w.angle ? Math.hypot(next.x - w.x, next.y - w.y) : next.x - w.x) : w.width;
      const stretch = natural > 0 && target > 0 ? target / natural : 1;
      // In q/Q so the invisible render mode does not carry over to text drawn later.
      page.pushOperators(
        pushGraphicsState(), beginText(), setFontAndSize(fontKey, size), setTextRenderingMode(TextRenderingMode.Invisible),
        setTextMatrix(stretch * co, stretch * si, -si, co, w.x, w.y), showText(font.encodeText(text)), endText(), popGraphicsState(),
      );
    });
    if (props) page.pushOperators(PDFOperator.of('EMC'));
  }
}
export async function addInvisibleText(bytes, pagesWords, readFont) {
  return edit(bytes, async (d) => {
    const all = pagesWords.flatMap((p) => p.words.map((w) => w.text)).join('');
    const font = await getFont(d, 'Arial', {}, `${all} `, readFont);
    for (const { page, words, pars } of pagesWords) drawInvisibleWords(d.getPage(page), font, words, pars, d.context);
  });
}

/** Replaces a page with an image (for secure redaction). */
export function replacePageWithImage(bytes, pageIdx, jpeg) {
  return edit(bytes, async (d) => {
    const p = d.getPage(pageIdx);
    const img = await d.embedJpg(jpeg);
    const rot = p.getRotation();
    const { x, y, width, height } = p.getCropBox();
    const annots = p.node.Annots();
    const fresh = d.insertPage(pageIdx + 1, [width, height]);
    fresh.setMediaBox(x, y, width, height);
    fresh.setRotation(degrees(0));
    if (rot.angle % 180 !== 0) { fresh.setMediaBox(0, 0, height, width); fresh.drawImage(img, { x: 0, y: 0, width: height, height: width }); }
    else fresh.drawImage(img, { x, y, width, height });
    if (annots && rot.angle % 180 === 0) {
      const keep = d.context.obj([]);
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookupMaybe(i, PDFDict);
        if (a && a.lookup(PDFName.of('Subtype')) === PDFName.of('Link')) keep.push(annots.get(i));
      }
      if (keep.size()) fresh.node.set(PDFName.of('Annots'), keep);
    }
    d.removePage(pageIdx);
    gcObjects(d);
  });
}

/**
 * Replaces the content of pages with one page-sized image each (straightened scan). list: [{ page, jpeg }].
 * The page itself stays (size, rotation, form fields, links); its previous content including recognized text
 * is removed.
 */
export function setPageImages(bytes, list) {
  return edit(bytes, async (d) => {
    for (const { page, jpeg } of list) {
      const p = d.getPage(page);
      const img = await d.embedJpg(jpeg);
      const { x, y, width, height } = p.getCropBox();
      p.node.set(PDFName.of('Contents'), d.context.obj([]));
      p.node.set(PDFName.of('Resources'), d.context.obj({}));
      p.contentStream = undefined; p.contentStreamRef = undefined; p.fontKey = undefined; p.font = undefined;
      p.drawImage(img, { x, y, width, height });
    }
    gcObjects(d);
  });
}

/** Simple rectangle fill on a page in page coordinates. */
export const fillRects = (bytes, pageIdx, rects, color = [1, 1, 1]) => edit(bytes, (d) => {
  const p = d.getPage(pageIdx);
  for (const [x0, y0, x1, y1] of rects) p.drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: rgb(...color) });
});

/** Resolution from the image data (JPEG: JFIF, PNG: pHYs) in dpi, otherwise null. */
export function imageDpi(bytes, mime) {
  const b = bytes;
  if (mime === 'image/png') {
    for (let p = 8; p + 12 <= b.length;) {
      const len = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (type === 'pHYs' && len >= 9) {
        const ppm = (b[p + 8] << 24 | b[p + 9] << 16 | b[p + 10] << 8 | b[p + 11]) >>> 0;
        return b[p + 16] === 1 && ppm > 0 ? ppm * 0.0254 : null;
      }
      if (type === 'IDAT' || type === 'IEND') return null;
      p += 12 + len;
    }
    return null;
  }
  // JPEG: APP0 segment "JFIF" with density in dpi (unit 1) or dpcm (unit 2).
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] === 0xe0 && String.fromCharCode(b[6], b[7], b[8], b[9]) === 'JFIF') {
    const unit = b[13]; const x = b[14] << 8 | b[15];
    if (unit === 1 && x > 0) return x;
    if (unit === 2 && x > 0) return x * 2.54;
  }
  return null;
}
/**
 * Page size for an image: from the resolution in the image. If it is missing, a large image with
 * an A4 aspect ratio (scan or photo of a document) is set to A4, otherwise screen resolution (96 dpi) applies.
 */
export function imagePageSize(px, py, dpi) {
  if (dpi && dpi >= 50 && dpi <= 2400) return [px * 72 / dpi, py * 72 / dpi];
  const ratio = Math.max(px, py) / Math.min(px, py);
  if (Math.min(px, py) >= 1000 && Math.abs(ratio - Math.SQRT2) < 0.06) {
    const s = 595.28 / Math.min(px, py);
    return [px * s, py * s];
  }
  return [px * 0.75, py * 0.75];
}

export async function imagesToPdf(images, o = {}) {
  const d = await PDFDocument.create();
  for (const im of images) {
    const img = im.mime === 'image/png' ? await d.embedPng(im.bytes) : await d.embedJpg(im.bytes);
    let [w, h] = imagePageSize(img.width, img.height, imageDpi(im.bytes, im.mime));
    if (o.pageSize) {
      const s = Math.min(o.pageSize.width / w, o.pageSize.height / h, 1);
      w *= s; h *= s;
      const page = d.addPage([o.pageSize.width, o.pageSize.height]);
      page.drawImage(img, { x: (o.pageSize.width - w) / 2, y: (o.pageSize.height - h) / 2, width: w, height: h });
    } else d.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return saveDoc(d);
}

export async function blankPdf(size = { width: 595.28, height: 841.89 }, count = 1) {
  const d = await PDFDocument.create();
  for (let i = 0; i < count; i++) d.addPage([size.width, size.height]);
  return saveDoc(d);
}

/** Basisumsetzung PDF/A-2b: XMP-Kennung, sRGB-Ausgabeabsicht, Dokumenttitel. */
export function toPdfA(bytes, icc, title) {
  return edit(bytes, (d) => {
    const ctx = d.context; const c = d.catalog;
    d.setTitle(title || d.getTitle() || 'Document');
    const now = new Date().toISOString();
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(d.getTitle())}</rdf:li></rdf:Alt></dc:title><xmp:ModifyDate>${now}</xmp:ModifyDate></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const meta = ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
    c.set(PDFName.of('Metadata'), ctx.register(meta));
    if (icc) {
      const prof = ctx.flateStream(icc, { N: 3 });
      const intent = ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB'), DestOutputProfile: ctx.register(prof) });
      c.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));
    }
    const names = c.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (names) names.delete(PDFName.of('JavaScript'));
    c.delete(PDFName.of('OpenAction'));
  });
}

/** Preflight-artige Analyse eines Dokuments. */
export async function analyze(bytes) {
  const d = await loadForEdit(bytes);
  const ctx = d.context;
  const fonts = new Map(); let images = 0; let tagged = false; let hasForms = false;
  const colorSpaces = new Set(); let transparency = false;
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const dict = o instanceof PDFDict ? o : (o.dict instanceof PDFDict ? o.dict : null);
    if (!dict) continue;
    const type = dict.lookupMaybe(PDFName.of('Type'), PDFName);
    const sub = dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (type === PDFName.of('Font') && dict.has(PDFName.of('BaseFont'))) {
      const name = dict.lookup(PDFName.of('BaseFont')).toString().slice(1);
      const st = sub ? sub.toString().slice(1) : '';
      if (st === 'CIDFontType0' || st === 'CIDFontType2' || !dict.has(PDFName.of('DescendantFonts'))) {
        const desc = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
        const embedded = !!desc && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.has(PDFName.of(k)));
        fonts.set(name, { name, type: st, embedded });
      }
    }
    if (sub === PDFName.of('Image')) {
      images++;
      const cs = dict.lookup(PDFName.of('ColorSpace'));
      if (cs instanceof PDFName) colorSpaces.add(cs.toString().slice(1));
      else if (cs instanceof PDFArray) { const f = cs.lookup(0); if (f instanceof PDFName) colorSpaces.add(f.toString().slice(1)); }
      if (dict.has(PDFName.of('SMask'))) transparency = true;
    }
    if (type === PDFName.of('ExtGState')) {
      const ca = dict.lookupMaybe(PDFName.of('ca'), PDFNumber);
      if (ca && ca.asNumber() < 1) transparency = true;
    }
  }
  const mark = d.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict);
  if (mark) tagged = mark.lookup(PDFName.of('Marked')) === PDFBool.True;
  hasForms = d.catalog.has(PDFName.of('AcroForm'));
  const pageBoxes = d.getPages().map((p) => ({ media: p.getMediaBox(), crop: p.getCropBox(), rotation: p.getRotation().angle }));
  return {
    fonts: [...fonts.values()], images, colorSpaces: [...colorSpaces], transparency, tagged, hasForms, pageBoxes,
    title: d.getTitle() || '', lang: d.catalog.has(PDFName.of('Lang')), outlines: d.catalog.has(PDFName.of('Outlines')),
    version: new TextDecoder('latin1').decode(bytes.subarray(0, 8)),
    xmpPdfA: (() => { const m = d.catalog.lookupMaybe(PDFName.of('Metadata')); return !!m; })(),
  };
}

// --- Formulare -------------------------------------------------------------------------
/** type: text|multiline|checkbox|radio|dropdown|list|button|signature */
export function addFormField(bytes, pageIdx, rect, o) {
  return edit(bytes, async (d) => placeField(d, await d.embedFont(StandardFonts.Helvetica), pageIdx, rect, o));
}
/**
 * Creates several fields in one step (automatic detection). list: [{ page, rect, type, name, value? }].
 * The fields get neither border nor background: the line or box is already on the page.
 */
export function addFormFields(bytes, list) {
  return edit(bytes, async (d) => {
    const font = await d.embedFont(StandardFonts.Helvetica);
    for (const o of list) placeField(d, font, o.page, o.rect, { ...o, plain: true });
  });
}
function placeField(d, font, pageIdx, rect, o) {
  {
    // (Block only so the indentation of the existing code stays.)
    const form = d.getForm();
    const page = d.getPage(pageIdx);
    const [x0, y0, x1, y1] = rect;
    const box = o.plain ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderWidth: 0 }
      : { x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderWidth: 1, borderColor: rgb(0.57, 0.56, 0.56), backgroundColor: rgb(1, 1, 1) };
    const name = o.name;
    if (form.getFieldMaybe(name) && o.type !== 'radio') throw new Error(`A field named "${name}" already exists.`);
    let f;
    switch (o.type) {
      case 'text': case 'multiline':
        f = form.createTextField(name);
        if (o.type === 'multiline') f.enableMultiline();
        if (o.value) f.setText(o.value);
        f.addToPage(page, box);
        // Detected fields: fixed font size matching the height instead of a font that fills a tall box.
        if (o.plain) { try { f.setFontSize(Math.max(7, Math.min(11, Math.round((y1 - y0) * 0.62)))); } catch { /* stays automatic */ } }
        f.updateAppearances(font); break;
      case 'checkbox':
        f = form.createCheckBox(name); f.addToPage(page, box); break;
      case 'radio': {
        const existing = form.getFieldMaybe(name);
        f = existing || form.createRadioGroup(name);
        f.addOptionToPage(o.value || `Option${f.getOptions().length + 1}`, page, box); break;
      }
      case 'dropdown':
        f = form.createDropdown(name); f.addOptions(o.options || []);
        f.addToPage(page, box); f.updateAppearances(font); break;
      case 'list':
        f = form.createOptionList(name); f.addOptions(o.options || []);
        f.addToPage(page, box); f.updateAppearances(font); break;
      case 'button':
        f = form.createButton(name); f.addToPage(o.value || name, page, { ...box, backgroundColor: rgb(0.87, 0.92, 0.97) }); break;
      case 'signature': {
        const ctx = d.context;
        const widget = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect, T: PDFHexString.fromText(name), F: 4, P: page.ref }));
        page.node.addAnnot(widget);
        form.acroForm.addField(widget);
        return;
      }
      default: throw new Error('Unknown field type');
    }
    if (o.required && f.enableRequired) f.enableRequired();
    if (o.readOnly && f.enableReadOnly) f.enableReadOnly();
  }
}

/** All field names and the areas of all field widgets per page: { names, widgets: [{ page, rect }] }. */
export async function listFieldWidgets(bytes) {
  const d = await loadForEdit(bytes);
  const pages = d.getPages();
  const names = []; const widgets = [];
  for (const f of d.getForm().getFields()) {
    names.push(f.getName());
    for (const w of widgetsOf(f)) {
      const pref = w.P();
      let page = pref ? pages.findIndex((p) => p.ref === pref) : -1;
      if (page < 0) page = pages.findIndex((p) => { const a = p.node.Annots(); return a && a.asArray().some((r) => d.context.lookup(r) === w.dict); });
      const r = w.getRectangle();
      if (page >= 0 && r) widgets.push({ page, rect: [r.x, r.y, r.x + r.width, r.y + r.height] });
    }
  }
  return { names, widgets };
}

function widgetsOf(field) { return field.acroField.getWidgets(); }

export const removeFormField = (bytes, name) => edit(bytes, (d) => { d.getForm().removeField(d.getForm().getField(name)); });

export async function listFormFields(bytes) {
  const d = await loadForEdit(bytes);
  const form = d.getForm();
  const pages = d.getPages();
  return form.getFields().map((f) => {
    const type = f.constructor.name.replace('PDF', '');
    const w = widgetsOf(f)[0];
    let page = -1;
    if (w) {
      const pref = w.P();
      page = pref ? pages.findIndex((p) => p.ref === pref) : -1;
      if (page < 0) page = pages.findIndex((p) => { const a = p.node.Annots(); return a && a.asArray().some((r) => d.context.lookup(r) === w.dict); });
    }
    const r = w ? w.getRectangle() : null;
    return { name: f.getName(), type, page, rect: r ? [r.x, r.y, r.x + r.width, r.y + r.height] : null, required: f.isRequired(), readOnly: f.isReadOnly() };
  });
}

export const setFieldFlags = (bytes, name, o) => edit(bytes, (d) => {
  const f = d.getForm().getField(name);
  if (o.required !== undefined) (o.required ? f.enableRequired() : f.disableRequired());
  if (o.readOnly !== undefined) (o.readOnly ? f.enableReadOnly() : f.disableReadOnly());
});

export const flattenForms = (bytes) => edit(bytes, async (d) => {
  const form = d.getForm();
  form.updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica));
  form.flatten();
});

export async function exportFormData(bytes) {
  const d = await loadForEdit(bytes);
  const out = {};
  for (const f of d.getForm().getFields()) {
    const t = f.constructor.name;
    if (t === 'PDFTextField') out[f.getName()] = f.getText() || '';
    else if (t === 'PDFCheckBox') out[f.getName()] = f.isChecked();
    else if (t === 'PDFRadioGroup') out[f.getName()] = f.getSelected() || '';
    else if (t === 'PDFDropdown' || t === 'PDFOptionList') out[f.getName()] = f.getSelected();
  }
  return out;
}
export const importFormData = (bytes, data) => edit(bytes, async (d) => {
  const form = d.getForm();
  for (const [k, v] of Object.entries(data)) {
    const f = form.getFieldMaybe(k);
    if (!f) continue;
    const t = f.constructor.name;
    if (t === 'PDFTextField') f.setText(String(v ?? ''));
    else if (t === 'PDFCheckBox') (v === true || v === 'true' || v === 'Yes' ? f.check() : f.uncheck());
    else if (t === 'PDFRadioGroup') { if (v) f.select(String(v)); else f.clear(); }
    else if (t === 'PDFDropdown' || t === 'PDFOptionList') { const a = [].concat(v).filter(Boolean); if (a.length) f.select(a); else f.clear(); }
  }
  form.updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica));
});
export const resetForm = (bytes) => edit(bytes, async (d) => {
  const form = d.getForm();
  for (const f of form.getFields()) {
    const t = f.constructor.name;
    if (t === 'PDFTextField') f.setText('');
    else if (t === 'PDFCheckBox') f.uncheck();
    else if (t === 'PDFRadioGroup' || t === 'PDFDropdown' || t === 'PDFOptionList') f.clear();
  }
  form.updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica));
});

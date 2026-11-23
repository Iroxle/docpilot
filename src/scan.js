// Scanned pages: recognize text (offline with Tesseract) and make recognized text in the image editable.
import { PDFDocument, PDFName, PDFDict, PDFStream, degrees } from '@cantoo/pdf-lib';
import { pdfjs, RENDER_OPTS } from './document.js';
import { interpret, inv, apply, growImageInPage, subtractRect, imageRole } from './pdf/content.js';
import { loadForEdit } from './pdf/ops.js';
import { eraseText, classify } from './pdf/inpaint.js';
import { normalizeForOcr, removeRules, grayToRgba, findBullet, isPlusMinus, stopKind, strokeWidth, isMarker, groupParagraphs, inkBox, hasDot, hasUmlaut } from './pdf/ocrlayout.js';
import { familyInfo, cssFamily, cssFamilyReady } from './fonts.js';

export const OCR_LANGS = [['deu+eng', 'German + English'], ['deu', 'German'], ['fra', 'French'], ['ita', 'Italian'], ['eng', 'English'], ['deu+fra+ita+eng', 'All four languages']];

/**
 * Font size from the height above the baseline: capitals, digits and ascenders (h, l, d ...) reach about
 * 0.71 font sizes high in common fonts. The line height from text recognition is too
 * unreliable for this (in tables, lines count too).
 */
export const ASCENT = 0.71;

const textBoxes = (content) => content.items.filter((t) => t.str && t.str.trim()).map((t) => {
  const [, , , d, e, f] = t.transform;
  const hgt = Math.abs(d) || t.height || 1;
  return [e, f - hgt * 0.25, e + t.width, f + hgt];
});
const inside = (p, r) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];

/** What is on the page? Text (including invisible text), images, drawn shapes. */
export async function pageInfo(doc, i, edit) {
  const content = await doc.pageText(i);
  const boxes = textBoxes(content);
  let images = []; let items = [];
  try { items = interpret(edit.getPage(i)).items; } catch { /* defekter Inhalt */ }
  const [x0, y0, x1, y1] = doc.page(i).view;
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  // Small images (logos, icons) do not count. Pieces of a split scan always count, even narrow
  // strips: together they are the scanned page.
  const all = items.filter((o) => o.kind === 'image');
  const big = items.map((o, k) => ({ o, k })).filter(({ o }) => o.kind === 'image'
    && ((o.bbox[2] - o.bbox[0]) * (o.bbox[3] - o.bbox[1]) >= area * 0.03 || imageRole(o, all, area) === 'piece'));
  images = big.map(({ o }) => o.bbox);
  // Resolution of the largest image (pixels per inch on the page), e.g. 96 for a screenshot.
  let dpi = null;
  const largest = big.map(({ o }) => o).sort((a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]))[0];
  if (largest) {
    const dims = imageDims(edit.getPage(i), largest.name);
    const inch2 = ((largest.bbox[2] - largest.bbox[0]) * (largest.bbox[3] - largest.bbox[1])) / 5184;
    if (dims?.width && dims?.height && inch2 > 0) dpi = Math.sqrt((dims.width * dims.height) / inch2);
  }
  const imageShare = images.reduce((s, b) => s + Math.max(0, (b[2] - b[0]) * (b[3] - b[1])), 0) / area;
  // Only count drawn shapes where necessary (page without text and without a large image): it takes time.
  let paths = 0;
  if (!boxes.length && imageShare < 0.2) {
    try { const ol = await doc.page(i).getOperatorList(); paths = ol.fnArray.filter((f) => f === pdfjs.OPS.constructPath).length; } catch { /* egal */ }
  }
  // For the duplicate text check: which text lies above which image (drawing order).
  const layers = { images: big, texts: items.map((o, k) => ({ o, k })).filter(({ o }) => o.kind === 'text') };
  return { boxes, images, imageShare, paths, hasText: boxes.length > 0, dpi, layers };
}

/**
 * Resolution for text recognition. Recognition works best when an image is enlarged to about double
 * if it is coarse (screenshots at 96 dpi), and at its own resolution if it is fine
 * (scans at 200 to 300 dpi). Enlarging more smears the letters ("rn" becomes "m").
 */
export function ocrDpi(imageDpi, factor = 2) {
  if (!imageDpi) return 300;
  if (imageDpi < 200) return Math.round(Math.min(300, Math.max(144, imageDpi * factor)));
  // Scans and photos: at least 300 dpi; below that, Tesseract recognizes small text less well.
  return Math.round(Math.min(400, Math.max(300, imageDpi)));
}

/**
 * Pages that look like a scan: no text, but a large image or many drawn shapes
 * (e.g. invoices whose text is stored as graphics).
 */
export async function scannedPages(doc, limit = 3) {
  const edit = await loadForEdit(doc.bytes);
  const out = [];
  for (let i = 0; i < Math.min(doc.numPages, limit); i++) {
    const p = await pageInfo(doc, i, edit);
    if (!p.hasText && (p.imageShare >= 0.2 || p.paths >= 30)) out.push(i);
  }
  return out;
}

/**
 * Recognizes text on the pages. Existing text is not recognized twice; on pages with text only
 * images and graphics are read. Returns [{ page, words: [{ text, x, y (baseline), width, height (font size) }] }].
 */
export async function recognize(app, pages, { lang = 'deu+eng', dpi = 'auto', progress } = {}) {
  const doc = app.doc;
  const edit = await loadForEdit(doc.bytes);
  const tess = await import('tesseract.js');
  const createWorker = tess.createWorker || tess.default.createWorker;
  const base = new URL('tesseract/', location.href).href;
  const worker = await createWorker(lang, 1, { workerPath: `${base}worker.min.js`, corePath: `${base}core/`, langPath: `${base}lang`, gzip: true, cacheMethod: 'none', workerBlobURL: false });
  const result = [];
  try {
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k];
      progress?.(k / pages.length, `Page ${p + 1} (${k + 1} of ${pages.length})`);
      const info = await pageInfo(doc, p, edit);
      // Page with text: only read it if there is an image on it (e.g. a pasted screenshot). Skip empty pages.
      if (info.hasText ? !info.images.length : (!info.images.length && info.paths < 5)) continue;
      const res = dpi === 'auto' || !dpi ? ocrDpi(info.dpi) : dpi;
      const { canvas, viewport } = await app.viewer.renderToCanvas(p, res, { noAnnots: true });
      // Dark text on a white background for text recognition, also for dark-mode screenshots.
      const ctx = canvas.getContext('2d');
      const G = normalizeForOcr(ctx.getImageData(0, 0, canvas.width, canvas.height));
      // Table lines and separators disturb the recognition of the lines next to them: remove them first.
      removeRules(G, { minLen: Math.round(res * 0.2), minLenV: Math.round(res * 0.6), maxThick: Math.max(3, Math.round(res * 0.03)), gap: Math.round(res * 0.045) });
      ctx.putImageData(new ImageData(grayToRgba(G), G.width, G.height), 0, 0);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      canvas.width = 0;
      const { words, pars } = await layoutPage(data, viewport, G);
      const keep = words.filter((w) => isNew(info, [w.x + w.width / 2, w.y + w.height * 0.3]));
      if (keep.length) result.push({ page: p, words: keep, pars });
    }
  } finally { await worker.terminate(); }
  return result;
}

/**
 * Is a recognized word new? Always on pages without text. On pages with text only words in an image above
 * which no text lies that was drawn after the image (otherwise it would be a duplicate). Text under the image is
 * hidden and does not count, e.g. for a pasted screenshot over a letter.
 */
function isNew(info, c) {
  if (!info.hasText) return true;
  const { images, texts } = info.layers;
  // Only PDF.js knows text in embedded objects (without order): there, avoid all text as before.
  if (!texts.length) return images.some(({ o }) => inside(c, o.bbox)) && !info.boxes.some((b) => inside(c, b));
  const img = images.filter(({ o }) => inside(c, o.bbox)).pop();
  if (!img) return false;
  return !texts.some(({ o, k }) => k > img.k && inside(c, o.bbox));
}

const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
/**
 * Minimum confidence of a word (0 to 100). In tests with scans, correctly read text was at 82 to 96,
 * misread text and noise from logos at 14 to 56.
 */
const MIN_CONF = 55;
const LINE_JUNK = /^([.\-_–—=~·:,;'"`´^°*|\\/]{2,}|[|\\_~^`´¦]+)$/;
const TALL = /[A-ZÄÖÜ0-9bdfhklt]/;
/** Fonts that come into question for screenshots and documents; the matching one is detected by width. */
const CANDIDATES = ['Arial', 'Segoe UI', 'Calibri', 'Aptos', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Cambria', 'Courier New', 'Consolas'];

/** Measures text in a font (the same font files that later go into the PDF). */
function measurer() {
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (family, bold, text, px) => {
    const key = `${family}|${bold}|${px}|${text}`;
    if (!cache.has(key)) {
      ctx.font = `${bold ? '700 ' : ''}${px}px ${cssFamily(family)}`;
      const m = ctx.measureText(text);
      cache.set(key, { asc: m.actualBoundingBoxAscent, ink: m.actualBoundingBoxLeft + m.actualBoundingBoxRight });
    }
    return cache.get(key);
  };
}

/**
 * Evaluates the text recognition result together with the pixels: baseline, bullets, punctuation,
 * bold text, the font itself and its size, paragraphs. Returns words in page coordinates
 * ({ text, x, y (baseline), width, height (font size), line, par }) and details per paragraph.
 */
export async function layoutPage(data, viewport, G) {
  // 1. Lines, split at large gaps (table columns).
  const segs = [];
  for (const b of data.blocks || []) for (const pa of b.paragraphs) for (const l of pa.lines) {
    let ws = l.words.filter((w) => w.text.trim()).map((w) => ({
      text: w.text.trim(), conf: w.confidence, symbols: w.symbols || [],
      box: inkBox(G, [w.bbox.x0 - 1, w.bbox.y0 - 1, w.bbox.x1 + 1, w.bbox.y1 + 1]) || [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1],
    }));
    // Remnants of lines (rows of dots and dashes) are not text.
    ws = ws.filter((w) => !LINE_JUNK.test(w.text));
    if (!ws.length) continue;
    // Leave out uncertain words, except a short character at the start of the line (maybe a bullet),
    // a punctuation mark directly after the previous word, and words in an otherwise reliably read line. What
    // recognition thinks it reads in logos and graphics is uncertain (below 40 of 100) and so stays out.
    const sure = median(ws.map((w) => w.conf));
    const h0 = median(ws.map((w) => w.box[3] - w.box[1]));
    // Words below MIN_CONF in a reliable line stay for now and are checked by their width below.
    ws = ws.filter((w, k) => {
      if (w.conf >= MIN_CONF || (k > 0 && /^[.,:;!?]$/.test(w.text) && w.box[0] - ws[k - 1].box[2] < 0.3 * h0)
        || (sure >= 75 && w.conf >= 8 && /[\p{L}\p{N}]/u.test(w.text))) return true;
      // Keep only as a possible bullet: dropped if it is not one.
      w.onlyBullet = k === 0 && w.text.length <= 2;
      return w.onlyBullet;
    });
    // A line needs at least one reliably read word or one reliably read number.
    if (!ws.some((w) => (w.conf >= 60 && (w.text.match(/[\p{L}\p{N}]/gu) || []).length >= 2) || (w.conf >= 75 && /[\p{L}\p{N}]/u.test(w.text)))) continue;
    const tallH = ws.filter((w) => TALL.test(w.text)).map((w) => w.box[3] - w.box[1]);
    const s0 = tallH.length ? median(tallH) / 0.71 : median(ws.map((w) => w.box[3] - w.box[1])) / 0.5;
    let cur = [ws[0]];
    for (let k = 1; k < ws.length; k++) {
      if (ws[k].box[0] - ws[k - 1].box[2] > 2 * s0) { segs.push(cur); cur = []; }
      cur.push(ws[k]);
    }
    segs.push(cur);
  }

  // 2. Baseline, height, bullets and punctuation per line.
  let lines = [];
  for (let ws of segs) {
    // Baseline from the words themselves: words without descenders end exactly on it. The baseline from
    // text recognition is unreliable in tables (lines below the text pull it down).
    // A single character also counts if it is a letter or digit (e.g. the "Code" column of a table
    // with "1", "6"); only punctuation and bullets on their own say nothing about the baseline.
    const solid = (w) => w.text.length > 1 || /[\p{L}\p{N}]/u.test(w.text);
    const flat = ws.filter((w) => !/[gjpqyQ,;()[\]{}|µ]/.test(w.text) && solid(w));
    const base = flat.length ? median(flat.map((w) => w.box[3])) : median(ws.map((w) => w.box[3] - (w.box[3] - w.box[1]) * 0.23));
    const tall = ws.filter((w) => TALL.test(w.text) && solid(w));
    const ascent = median((tall.length ? tall : ws).map((w) => base - w.box[1]));
    const s = Math.max(4, tall.length ? ascent / 0.71 : ascent / 0.5);
    let marker = null;
    const w0 = ws[0];
    if (w0.text.length <= 2) { const bu = findBullet(G, w0.box, base, s); if (bu) marker = { text: bu.kind, box: bu.box }; }
    if (!marker && ws.length > 1 && isMarker(w0.text) && w0.conf >= 25 && ws[1].box[0] - w0.box[2] >= 0.3 * s) marker = { text: w0.text, box: w0.box };
    if (marker) ws = ws.slice(1);
    else {
      if (w0.onlyBullet) ws = ws.slice(1);
      if (!ws.length) continue;
      // Bullet that text recognition did not read at all: to the left of the first word.
      const bu = findBullet(G, [ws[0].box[0] - 2.5 * s, base - 0.9 * s, ws[0].box[0] - 0.12 * s, base + 0.05 * s], base, s);
      if (bu) marker = { text: bu.kind, box: bu.box };
    }
    if (!ws.length) continue;
    for (const w of ws) fixSymbols(G, w, base, s);
    const x0 = ws[0].box[0]; const x1 = ws[ws.length - 1].box[2];
    const stroke = strokeWidth(G, [x0, base - ascent * 0.6, x1, base - ascent * 0.1]);
    const line = { words: ws, base, ascent, s, x0, x1, ratio: stroke / s, list: !!marker, markerX: marker ? marker.box[0] : undefined };
    lines.push(line);
    if (marker) lines.push({ words: [{ text: marker.text, box: marker.box }], base, ascent, s, x0: marker.box[0], x1: marker.box[2], marker: true, of: line });
  }

  // 3. Bold lines: clearly thicker strokes than the rest of the page.
  const ratios = lines.filter((l) => !l.marker && l.ratio > 0).map((l) => l.ratio);
  const usual = ratios.length ? median(ratios) : 0;
  for (const l of lines) l.bold = !l.marker && usual > 0 && l.ratio > usual * 1.28 && l.ratio - usual > 0.018;
  for (const l of lines) if (l.marker) l.bold = l.of.bold;

  // 4. Font: the font whose width at the same height best matches the image.
  const textOf = (l) => l.words.map((w) => w.text).join(' ');
  const measure = measurer();
  const fams = CANDIDATES.filter((n) => familyInfo(n)?.embeddable);
  await Promise.all(fams.map((n) => cssFamilyReady(n).catch(() => null)));
  const sizeIn = (fam, l) => {
    const ws = l.words.filter((w) => (w.text.match(/[\p{L}\p{N}]/gu) || []).length >= 2);
    const vals = (ws.length ? ws : l.words).map((w) => { const r = measure(fam, l.bold, w.text, 100).asc / 100; return r > 0.2 ? (l.base - w.box[1]) / r : null; }).filter(Boolean);
    return vals.length ? median(vals) : l.s;
  };
  let family = null;
  {
    let best = Infinity;
    const sample = lines.filter((l) => !l.marker && textOf(l).length >= 10);
    for (const fam of fams) {
      let err = 0; let n = 0; let werr = 0; let wn = 0;
      for (const l of sample) {
        const px = sizeIn(fam, l);
        const pred = measure(fam, l.bold, textOf(l), Math.round(px * 10) / 10).ink;
        const t = textOf(l).length;
        if (pred > 0) { err += Math.abs(Math.log(pred / (l.x1 - l.x0))) * t; n += t; }
        // Ratio of the word widths to each other (independent of the size).
        const rs = l.words.filter((w) => w.text.length >= 3).map((w) => [(w.box[2] - w.box[0]) / Math.max(1, measure(fam, l.bold, w.text, 100).ink), w.text.length]);
        if (rs.length >= 3) { const k = median(rs.map((r) => r[0])); for (const [r, len] of rs) { werr += Math.abs(Math.log(r / k)) * len; wn += len; } }
      }
      // What matters is whether the words relate in width to each other as in the image: that is independent of the
      // size, which varies by a few percent at screen resolution. The line width only breaks close ties.
      const score = wn >= 30 ? werr / wn + 0.1 * (err / n) : n ? err / n : Infinity;
      if (score < best) { best = score; family = fam; }
    }
  }

  // Check uncertainly read words by their width: set in the recognized font and height, the word must be
  // about as wide as in the image. What recognition reads into logos and graphics (e.g. "hi" above a
  // bold lettering) does not fit and is dropped; a correctly read word fits even with moderate confidence.
  for (const l of lines) {
    if (l.marker) continue;
    const px = family ? sizeIn(family, l) : l.s;
    l.words = l.words.filter((w) => {
      if (!(w.conf < 75) || !/[\p{L}\p{N}]/u.test(w.text)) return true;
      const ink = measure(family || 'Arial', l.bold, w.text, Math.round(px * 10) / 10).ink;
      const r = ink > 0 ? (w.box[2] - w.box[0]) / ink : 1;
      // The less certain, the more exactly the width must match.
      return w.conf < MIN_CONF ? r >= 0.78 && r <= 1.28 : r >= 0.55 && r <= 1.8;
    });
    if (l.words.length) { l.x0 = l.words[0].box[0]; l.x1 = l.words[l.words.length - 1].box[2]; }
  }
  lines = lines.filter((l) => (l.marker ? l.of.words.length : l.words.length));

  // 5. Paragraphs, size and tracking per paragraph.
  const groups = groupParagraphs(lines.map((l) => ({
    x0: l.x0, x1: l.x1, base: l.base, size: l.s, bold: l.bold, marker: !!l.marker, list: l.list, markerX: l.markerX,
    n: l.words.length, first: l.words[0].box[2] - l.words[0].box[0], lower: /^\p{Ll}/u.test(l.words[0].text),
  })));
  const words = []; const pars = [];
  const measured = groups.map((g) => median(g.map((k) => lines[k]).map((l) => (l.marker ? sizeIn(family || 'Arial', l.of) : family ? sizeIn(family, l) : l.s))));
  // Text of the same size is measured a few percent differently per line (blur, noise). Paragraphs
  // whose sizes differ by at most 6 % get the same size: changed text looks the same everywhere.
  const sizeOf = measured.map((px) => median(measured.filter((q) => Math.abs(q / px - 1) <= 0.06)));
  groups.forEach((g, gi) => {
    const ls = g.map((k) => lines[k]);
    const px = sizeOf[gi];
    const fits = family ? ls.filter((l) => !l.marker && textOf(l).length >= 8).map((l) => (l.x1 - l.x0) / measure(family, l.bold, textOf(l), Math.round(px * 10) / 10).ink) : [];
    const tz = fits.length ? Math.min(1.12, Math.max(0.88, median(fits))) : 1;
    const bold = ls.filter((l) => l.bold).length * 2 > ls.length;
    const par = pars.length;
    pars.push({ font: family, bold, tz: Math.round(tz * 1000) / 10 });
    for (const k of g) {
      const l = lines[k];
      for (const w of l.words) {
        const a = viewport.convertToPdfPoint(w.box[0], l.base); const c = viewport.convertToPdfPoint(w.box[2], l.base);
        words.push({ text: w.text, x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), width: Math.abs(c[0] - a[0]), height: px / viewport.scale, line: k, par });
      }
    }
  });
  return { words, pars };
}

/** Checks doubtful characters by their shape: "+" or "±", period or comma at the end of a word. */
const UMLAUT = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' };
function fixSymbols(G, w, base, s) {
  // "ı" (Turkish dotless i) does not occur in the supported languages.
  w.text = w.text.replace(/ı/g, 'i');
  const sy = w.symbols;
  if (!sy.length || sy.map((y) => y.text).join('').replace(/ı/g, 'i') !== w.text) return;
  const chars = sy.map((y) => y.text.replace(/ı/g, 'i'));
  const letters = /[a-zäöüß]/.test(w.text);
  let changed = false;
  chars.forEach((ch, i) => {
    const bb = sy[i].bbox; const box = [bb.x0, bb.y0, bb.x1, bb.y1];
    let r = null;
    if (ch === '+' && isPlusMinus(G, box, base, s)) r = '±';
    else if (i === chars.length - 1 && '.,;:'.includes(ch)) r = stopKind(G, box, base, s, ch);
    else if (letters && (ch === '1' || ch === 'l' || ch === '|') && hasDot(G, box, base, s)) r = 'i';
    else if (UMLAUT[ch] && hasUmlaut(G, box, base, s)) r = UMLAUT[ch];
    if (r) { chars[i] = r; changed = true; }
  });
  // "ii" instead of "ü": a single letter with two dots above it.
  for (let i = 0; i + 1 < chars.length; i++) {
    if (chars[i] !== 'i' || chars[i + 1] !== 'i') continue;
    const a = sy[i].bbox; const b = sy[i + 1].bbox;
    if (hasUmlaut(G, [Math.min(a.x0, b.x0), Math.min(a.y0, b.y0), Math.max(a.x1, b.x1), Math.max(a.y1, b.y1)], base, s)) { chars[i] = 'ü'; chars[i + 1] = ''; changed = true; }
  }
  if (changed) w.text = chars.join('');
}

// --- Edit recognized text ------------------------------------------------------------------

const imageDims = (page, name) => {
  const res = page.node.Resources();
  const xo = res && res.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const s = xo && xo.lookupMaybe(PDFName.of(name), PDFStream);
  if (!s) return null;
  const n = (k) => s.dict.lookup(PDFName.of(k))?.asNumber?.();
  const filter = s.dict.lookup(PDFName.of('Filter'));
  const filters = filter ? (filter.asArray ? filter.asArray().map(String) : [String(filter)]) : [];
  return { width: n('Width'), height: n('Height'), jpeg: filters.includes('/DCTDecode') };
};
const escName = (n) => n.replace(/[^A-Za-z0-9._-]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** Pixels of an image on the page at full resolution (PDF.js decodes all image formats). */
async function imagePixels(d, pageIdx, name, W, H) {
  const t = await PDFDocument.create();
  const [p] = await t.copyPages(d, [pageIdx]);
  t.addPage(p);
  p.node.set(PDFName.of('Contents'), t.context.register(t.context.flateStream(`q ${W} 0 0 ${H} 0 0 cm /${escName(name)} Do Q`)));
  p.node.delete(PDFName.of('Annots'));
  p.setMediaBox(0, 0, W, H); p.setCropBox(0, 0, W, H); p.setRotation(degrees(0));
  const pdf = await pdfjs.getDocument({ data: await t.save(), ...RENDER_OPTS }).promise;
  try {
    const pg = await pdf.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    await pg.render({ canvas: c, canvasContext: ctx, viewport: vp, background: 'white' }).promise;
    return { canvas: c, ctx, img: ctx.getImageData(0, 0, W, H) };
  } finally { pdf.loadingTask.destroy(); }
}

/**
 * Really removes recognized text from the image below: the letters are painted over with the background
 * in the image itself, and the image is replaced. rects: word boxes in page coordinates.
 * Returns { done, color, bg } (colors 0..1) or { done: false } if there is no image below.
 */
export async function eraseInImages(d, pageIdx, rects) {
  const page = d.getPage(pageIdx);
  const images = interpret(page).items.filter((o) => o.kind === 'image');
  // For each word, the images visible at its position: from top to bottom, each gets the part of the
  // word box that no image above already covers. Scanners often split pages into strips, so a text line
  // then runs through two images; its letters must be removed in both.
  const byImage = new Map();
  const top = [...images].reverse();
  for (const r of rects) {
    let rest = [r];
    for (const img of top) {
      if (!rest.length) break;
      const next = [];
      for (const part of rest) {
        const b = img.bbox;
        const hit = [Math.max(part[0], b[0]), Math.max(part[1], b[1]), Math.min(part[2], b[2]), Math.min(part[3], b[3])];
        if (hit[2] - hit[0] <= 0.3 || hit[3] - hit[1] <= 0.3) { next.push(part); continue; }
        if (!byImage.has(img)) byImage.set(img, []);
        byImage.get(img).push(hit);
        next.push(...subtractRect(part, b));
      }
      rest = next;
    }
  }
  if (!byImage.size) return { done: false };
  let color = null; let bg = null;
  for (const [img, rs] of byImage) {
    const dims = imageDims(page, img.name);
    if (!dims || !dims.width || !dims.height) continue;
    const { width: W, height: H } = dims;
    const m = inv(img.ctm);
    const toPx = (x, y) => { const [u, v] = apply(m, x, y); return [u * W, (1 - v) * H]; };
    const pxRects = rs.map((r) => {
      const pts = [toPx(r[0], r[1]), toPx(r[2], r[1]), toPx(r[0], r[3]), toPx(r[2], r[3])];
      const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
    const { canvas, ctx, img: data } = await imagePixels(d, pageIdx, img.name, W, H);
    const r = eraseText(data, pxRects);
    if (!r.erased) { canvas.width = 0; continue; }
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, dims.jpeg ? 'image/jpeg' : 'image/png', 0.92));
    canvas.width = 0;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const fresh = dims.jpeg ? await d.embedJpg(bytes) : await d.embedPng(bytes);
    // Only this page gets the new image: resources are copied if other pages share them.
    const res = page.node.Resources().clone(d.context);
    const xo = res.lookup(PDFName.of('XObject'), PDFDict).clone(d.context);
    xo.set(PDFName.of(img.name), fresh.ref);
    res.set(PDFName.of('XObject'), xo);
    page.node.set(PDFName.of('Resources'), res);
    // Create the new image as an object right away (otherwise only when saving): whoever reads the page afterwards
    // finds it. Only the image, not d.flush(): that would also finalize fonts before anything is written with them.
    await fresh.embed();
    color = color || r.color; bg = bg || r.bg;
  }
  return { done: !!color || !!bg, color, bg };
}

/**
 * Makes room for additional lines in an image: at splitY (page coordinates), image rows are
 * inserted, everything below moves down together with its recognized text, and the image grows accordingly.
 * The inserted rows repeat the calmest image row just below splitY (pure background, vertical lines
 * also continue). Only for upright, undistorted images. Returns the inserted height in pt.
 */
export async function insertImageRows(d, pageIdx, match, splitY, amountPt, lineSize) {
  const page = d.getPage(pageIdx);
  const img = interpret(page).items.find((o) => o.kind === 'image' && match(o));
  if (!img) return 0;
  const c = img.ctm;
  if (Math.abs(c[1]) > 1e-6 || Math.abs(c[2]) > 1e-6 || c[0] <= 0 || c[3] <= 0) return 0;
  const dims = imageDims(page, img.name);
  if (!dims || !dims.width || !dims.height) return 0;
  const { width: W, height: H } = dims;
  const perPt = H / c[3];
  const k = Math.round(amountPt * perPt);
  if (k < 1) return 0;
  const r0 = Math.round((1 - (splitY - c[5]) / c[3]) * H);
  if (r0 < 1 || r0 >= H) return 0;
  const { canvas, img: data } = await imagePixels(d, pageIdx, img.name, W, H);
  // Calmest row within about half a font size below the split point.
  let best = r0; let bestDev = Infinity;
  for (let y = r0; y <= Math.min(H - 1, r0 + Math.max(1, Math.round(lineSize * perPt * 0.5))); y++) {
    let sr = 0; let sg = 0; let sb = 0;
    for (let x = 0; x < W; x++) { const p = (y * W + x) * 4; sr += data.data[p]; sg += data.data[p + 1]; sb += data.data[p + 2]; }
    sr /= W; sg /= W; sb /= W;
    let dev = 0;
    for (let x = 0; x < W; x++) { const p = (y * W + x) * 4; dev += Math.abs(data.data[p] - sr) + Math.abs(data.data[p + 1] - sg) + Math.abs(data.data[p + 2] - sb); }
    if (dev < bestDev - 1e-6) { bestDev = dev; best = y; }
  }
  const out = document.createElement('canvas'); out.width = W; out.height = H + k;
  const o2 = out.getContext('2d', { alpha: false });
  o2.drawImage(canvas, 0, 0, W, best, 0, 0, W, best);
  o2.drawImage(canvas, 0, best, W, 1, 0, best, W, k);
  o2.drawImage(canvas, 0, best, W, H - best, 0, best + k, W, H - best);
  canvas.width = 0;
  const blob = await new Promise((res) => out.toBlob(res, dims.jpeg ? 'image/jpeg' : 'image/png', 0.92));
  out.width = 0;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fresh = dims.jpeg ? await d.embedJpg(bytes) : await d.embedPng(bytes);
  const res = page.node.Resources().clone(d.context);
  const xo = res.lookup(PDFName.of('XObject'), PDFDict).clone(d.context);
  xo.set(PDFName.of(img.name), fresh.ref);
  res.set(PDFName.of('XObject'), xo);
  page.node.set(PDFName.of('Resources'), res);
  await fresh.embed();
  const amount = k / perPt;
  const split = c[5] + (1 - best / H) * c[3];
  growImageInPage(page, (it) => it.name === img.name && it.bbox.every((v, j) => Math.abs(v - img.bbox[j]) < 0.5), split, amount);
  return amount;
}

/** Text and background color from the rendered page (colors 0..1). */
export function sampleColors(canvas, cssRect, ratio) {
  if (!canvas) return null;
  const x = Math.max(0, Math.floor(cssRect.left * ratio)); const y = Math.max(0, Math.floor(cssRect.top * ratio));
  const w = Math.min(canvas.width - x, Math.ceil(cssRect.width * ratio)); const h = Math.min(canvas.height - y, Math.ceil(cssRect.height * ratio));
  if (w < 2 || h < 2) return null;
  const data = canvas.getContext('2d').getImageData(x, y, w, h);
  const c = classify({ data: data.data, width: w, height: h }, [0, 0, w, h]);
  if (!c) return null;
  const f = (v) => (v ? v.map((n) => n / 255) : null);
  return { text: f(c.text), bg: f(c.bg) };
}

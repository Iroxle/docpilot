// Tests the PDF core without an interface. Results are checked with PDF.js as an independent reader.
import fs from 'node:fs';
import assert from 'node:assert';
import { PDFDocument, StandardFonts, rgb, PDFOperator, PDFName, PDFString } from '@cantoo/pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import fonts from '../electron/fonts.js';
import * as ops from '../src/pdf/ops.js';
import * as content from '../src/pdf/content.js';
import * as annots from '../src/pdf/annots.js';
import * as sign from '../src/pdf/sign.js';
import * as inpaint from '../src/pdf/inpaint.js';
import * as ocrlayout from '../src/pdf/ocrlayout.js';
import * as replace from '../src/pdf/replace.js';
import * as formdetect from '../src/pdf/formdetect.js';
import * as textutil from '../src/textutil.js';
import * as tables from '../src/pdf/tables.js';
import * as deskew from '../src/pdf/deskew.js';

const readFont = async (f) => { try { return new Uint8Array(fs.readFileSync(`C:/Windows/Fonts/${f}`)); } catch { return null; } };
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const open = (b, password) => getDocument({ data: b.slice(), password, verbosity: 0, useSystemFonts: false, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise;
const textOf = async (pdf, n) => (await (await pdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ');

async function fixture(n = 5) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(`Page ${i} header line`, { x: 72, y: 760, size: 18, font: f });
    p.drawText(`Second line on page ${i}`, { x: 72, y: 720, size: 12, font: f, color: rgb(0, 0, 1) });
    p.drawRectangle({ x: 72, y: 500, width: 200, height: 100, color: rgb(0.8, 0.9, 1) });
  }
  return d.save();
}
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));

test('Rotate, delete, reorder pages', async () => {
  let b = await fixture();
  b = await ops.rotatePages(b, [0], 90);
  assert.equal((await (await open(b)).getPage(1)).rotate, 90);
  const del = await ops.deletePages(b, [1, 3]);
  assert.deepEqual(del.pageMap, [0, 2, 4]);
  let pdf = await open(del.bytes);
  assert.equal(pdf.numPages, 3);
  assert.match(await textOf(pdf, 2), /Page 3/);
  const re = await ops.reorderPages(del.bytes, [2, 0, 1]);
  pdf = await open(re.bytes);
  assert.match(await textOf(pdf, 1), /Page 5/);
  await assert.rejects(ops.deletePages(b, [0, 1, 2, 3, 4]));
});
test('Insert, duplicate, replace, extract, merge, split', async () => {
  const a = await fixture(2); const c = await fixture(3);
  const ins = await ops.insertPdf(a, c, 1);
  assert.deepEqual(ins.pageMap, [0, -1, -1, -1, 1]);
  assert.equal((await open(ins.bytes)).numPages, 5);
  const dup = await ops.duplicatePages(a, [0]);
  assert.deepEqual(dup.pageMap, [0, 0, 1]);
  assert.match(await textOf(await open(dup.bytes), 2), /Page 1/);
  const blank = await ops.insertBlank(a, 2);
  assert.equal((await open(blank.bytes)).numPages, 3);
  const rep = await ops.replacePages(a, 0, 1, c, [2]);
  assert.match(await textOf(await open(rep.bytes), 1), /Page 3/);
  const ext = await ops.extractPages(c, [1]);
  assert.match(await textOf(await open(ext), 1), /Page 2/);
  assert.equal((await open(await ops.mergePdfs([{ bytes: a }, { bytes: c }]))).numPages, 5);
  const parts = await ops.splitPdf(c, ops.chunkRanges(3, 2));
  assert.equal(parts.length, 2);
  assert.deepEqual(ops.parseRange('1-3, 5', 6), [0, 1, 2, 4]);
  assert.throws(() => ops.parseRange('9', 6));
});
test('Watermark, header, Bates, crop, background', async () => {
  let b = await fixture(2);
  b = await ops.addWatermark(b, { text: 'CONFIDENTIAL ÄÖÜ', size: 40, color: '#0e7c86', opacity: 0.3, rotation: 45 }, readFont);
  b = await ops.addHeaderFooter(b, { center: 'DocPilot', footRight: 'Page {page} of {pages}' }, readFont);
  b = await ops.addBates(b, { prefix: 'DP-', start: 7, digits: 4 }, readFont);
  b = await ops.addBackground(b, { color: '#ffffee' });
  const pdf = await open(b);
  const t = await textOf(pdf, 2);
  assert.match(t, /CONFIDENTIAL ÄÖÜ/); assert.match(t, /Page 2 of 2/); assert.match(t, /DP-0008/);
  const cr = await ops.cropPages(b, [0], { left: 10, right: 10, top: 20, bottom: 20 });
  const v = (await (await open(cr)).getPage(1)).view;
  assert.deepEqual(v.map(Math.round), [10, 20, 585, 822]);
});
test('Multiline text with Windows fonts and foreign characters', async () => {
  for (const family of ['Calibri', 'Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma', 'Georgia', 'Segoe UI', 'Helvetica']) {
    const b = await ops.addTextBlock(await fixture(1), 0, [72, 300, 500, 400], 'Erste Zeile äöü €\nZweite Zeile ✓ 漢\tEnde', { family, size: 11, color: '#000000' }, readFont);
    const t = (await textOf(await open(b), 1)).replace(/\s+/g, ' ');
    assert.match(t, /Erste Zeile äöü €/, `${family}: ${t}`); assert.match(t, /Zweite Zeile/, family);
  }
});
test('Ligatures: written text stays the same when read back', async () => {
  for (const family of ['Calibri', 'Segoe UI', 'Georgia']) {
    const b = await ops.addTextBlock(await fixture(1), 0, [72, 300, 500, 400], 'Position Offizier fit fl ffi Aktion', { family, size: 11, color: '#000000' }, readFont);
    const t = (await textOf(await open(b), 1)).replace(/\s+/g, ' ');
    assert.match(t, /Position Offizier fit fl ffi Aktion/, `${family}: ${t}`);
  }
});
const zip = (files) => {
  // Small ZIP like Normal.dotm (compressed entries), for the Word template reader.
  const local = []; const central = []; let pos = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'); const data = zlib.deflateRawSync(raw); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(pos, 42);
    local.push(lh, n, data); central.push(ch, n); pos += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(pos, 16);
  return Buffer.concat([...local, cd, end]);
};
test('Default font like Word from Normal.dotm', async () => {
  const theme = '<a:theme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display" panose="0"/></a:majorFont><a:minorFont><a:latin typeface="Aptos" panose="0"/></a:minorFont></a:fontScheme></a:theme>';
  const styles = (normal) => `<w:styles><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/>${normal}</w:style></w:styles>`;
  let r = fonts.parseNormal(zip({ 'word/styles.xml': styles(''), 'word/theme/theme1.xml': theme }));
  assert.deepEqual([r.body, r.heading, r.size], ['Aptos', 'Aptos Display', 11]);
  // Default font changed in Word: stored in the "Normal" style.
  r = fonts.parseNormal(zip({ 'word/styles.xml': styles('<w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic"/><w:sz w:val="20"/></w:rPr>'), 'word/theme/theme1.xml': theme }));
  assert.deepEqual([r.body, r.size], ['Century Gothic', 10]);
  r = fonts.parseNormal(Buffer.from('not a zip'));
  assert.deepEqual([r.body, r.size], [null, null]);
});
test('Font catalog: all fonts, collections, synthesized bold and italic, symbol fonts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-fonts-'));
  const cat = new fonts.FontCatalog(path.join(dir, 'cache.json'));
  const { families } = await cat.load();
  const fam = (n) => families.find((f) => f.name === n);
  assert.ok(families.length > 50, `only ${families.length} fonts`);
  assert.equal(fam('Arial').faces.filter((x) => x !== null).length, 4);
  assert.ok(fam('Arial Black'), 'Arial Black missing');
  assert.ok(fs.existsSync(path.join(dir, 'cache.json')));
  ops.setFontCatalog(families);
  const read = async (id) => { const b = await cat.data(id); return b ? new Uint8Array(b) : null; };
  try {
    // Font from a .ttc collection (Cambria) is extracted and embedded.
    if (fam('Cambria')) {
      const b = await ops.addTextBlock(await fixture(1), 0, [72, 300, 500, 400], 'Cambria Text äöü', { family: 'Cambria', size: 12, color: '#000000' }, read);
      assert.match(await textOf(await open(b), 1), /Cambria Text äöü/);
    }
    // Arial Black has no italic face: italic is slanted, bold is synthesized with an outline.
    const fake = await ops.addTextBlock(await fixture(1), 0, [72, 300, 500, 400], 'Schraeg', { family: 'Arial Black', size: 12, color: '#000000', italic: true }, read);
    const items = content.interpret((await PDFDocument.load(fake)).getPage(0)).items.filter((o) => o.kind === 'text');
    assert.ok(items.some((o) => /ArialBlack|Arial-Black/i.test(o.baseFont || '')), 'Arial Black not embedded');
    const pg = await (await open(fake)).getPage(1);
    const it = (await pg.getTextContent()).items.find((x) => x.str.includes('Schraeg'));
    assert.ok(it && Math.abs(it.transform[2]) > 1.5, `not slanted: ${it && it.transform}`);
    // Font without a bold face: bold via outline (text render mode 2), text stays readable.
    ops.setFontCatalog(families.map((f) => (f.name === 'Arial' ? { ...f, faces: [f.faces[0], null, null, null] } : f)));
    const bold = await ops.addTextBlock(await fixture(1), 0, [72, 300, 500, 400], 'bold synthesized', { family: 'Arial', size: 12, color: '#000000', bold: true }, read);
    const ol = await (await (await open(bold)).getPage(1)).getOperatorList();
    assert.ok(ol.fnArray.some((fn, k) => fn === OPS.setTextRenderingMode && ol.argsArray[k][0] === 2), 'no outline bold');
    assert.match(await textOf(await open(bold), 1), /bold synthesized/);
    ops.setFontCatalog(families);
    const styled = await ops.getStyledFont(await PDFDocument.create(), 'Arial Black', { bold: true, italic: true }, 'x', read);
    // Arial Black has only one face: bold and italic are both synthesized (like Word).
    assert.deepEqual([styled.fakeBold, styled.fakeItalic], [true, true]);
    const arial = await ops.getStyledFont(await PDFDocument.create(), 'Arial', { bold: true, italic: true }, 'x', read);
    assert.deepEqual([arial.fakeBold, arial.fakeItalic, /Bold/.test(arial.font.name) && /Italic/.test(arial.font.name)], [false, false, true]);
    const tahoma = await ops.getStyledFont(await PDFDocument.create(), 'Tahoma', { bold: false, italic: true }, 'x', read);
    assert.equal(tahoma.fakeItalic, !fam('Tahoma').faces[2]);
    // Symbol font: a typed "J" becomes the Wingdings glyph (smiley) like in Word, not "?".
    if (fam('Wingdings')) {
      const wd = await ops.getStyledFont(await PDFDocument.create(), 'Wingdings', {}, 'J', read);
      assert.ok(['J', String.fromCodePoint(0xF04A)].includes(ops.sanitizeFor(wd.font, 'J')), 'Wingdings glyph missing');
      const b = await ops.addTextBlock(await fixture(1), 0, [72, 300, 500, 400], 'JJ', { family: 'Wingdings', size: 20, color: '#000000' }, read);
      assert.ok((await PDFDocument.load(b)).getPageCount() === 1);
    }
    // Unknown font: default font instead of a crash.
    const un = await ops.getStyledFont(await PDFDocument.create(), 'Does Not Exist', {}, 'abc', read);
    assert.ok(un.font);
    assert.equal(ops.resolveFamily('arial'), 'Arial');
    assert.ok(ops.fontFamilies().length === families.filter((f) => f.embeddable).length);
  } finally { ops.setFontCatalog([]); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Remove text from scan: background, lines and color', async () => {
  // Image 200 x 60: gray stripe at the top with dark blue "letters" in it; a table line below.
  const W = 200; const H = 60; const data = new Uint8ClampedArray(W * H * 4);
  const set = (x, y, c) => { const p = (y * W + x) * 4; data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, y < 30 ? [220, 220, 220] : [255, 255, 255]);
  const ink = [20, 30, 120];
  const glyphs = [[20, 8, 24, 24], [30, 8, 34, 24], [30, 8, 44, 11], [50, 8, 54, 24], [60, 14, 70, 17]];
  for (const [x0, y0, x1, y1] of glyphs) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, ink);
  for (let x = 0; x < W; x++) { set(x, 27, [0, 0, 0]); }
  const img = { data, width: W, height: H };
  const r = inpaint.eraseText(img, [[18, 6, 72, 26]]);
  assert.ok(r.erased > 100, `removed: ${r.erased}`);
  const at = (x, y) => [...data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
  for (const [x, y] of [[22, 15], [32, 9], [52, 20], [65, 15]]) {
    const c = at(x, y);
    assert.ok(c.every((v) => Math.abs(v - 220) < 25), `letter at ${x},${y} removed, gray background: ${c}`);
  }
  // The line across the rectangle stays, as does everything outside.
  assert.deepEqual(at(40, 27), [0, 0, 0]); assert.deepEqual(at(150, 27), [0, 0, 0]); assert.deepEqual(at(100, 45), [255, 255, 255]);
  assert.ok(r.color && Math.abs(r.color[2] - 120 / 255) < 0.08 && r.color[0] < 0.15, `text color dark blue: ${r.color}`);
  // Ohne Kontrast passiert nichts.
  const flat = { data: new Uint8ClampedArray(40 * 20 * 4).fill(240), width: 40, height: 20 };
  assert.equal(inpaint.eraseText(flat, [[2, 2, 30, 15]]).erased, 0);
});
test('Invisible text from text recognition is detected', async () => {
  const d = await PDFDocument.create(); d.registerFontkit((await import('@cantoo/fontkit')).default);
  const b0 = await (d.addPage([595, 842]), d.save());
  const b = await ops.addInvisibleText(b0, [{ page: 0, words: [{ text: 'Rechnung', x: 60, y: 700, width: 80, height: 12 }] }], readFont);
  const page = (await PDFDocument.load(b)).getPage(0);
  const items = content.interpret(page).items.filter((x) => x.kind === 'text');
  assert.equal(items.length, 1); assert.equal(items[0].invisible, true);
  // Text written afterwards stays visible (the render mode does not carry over).
  const b2 = await ops.addTextBlock(b, 0, [60, 600, 400, 650], 'Sichtbar', { family: 'Helvetica', size: 12, color: '#000000' }, readFont);
  const all = content.interpret((await PDFDocument.load(b2)).getPage(0)).items.filter((x) => x.kind === 'text');
  assert.deepEqual(all.map((x) => x.invisible), [true, false]);
  assert.match(await textOf(await open(b2), 1), /Rechnung.*Sichtbar|Sichtbar.*Rechnung/);
});
test('Text recognition: dark background, bullets, ±, punctuation, paragraphs', async () => {
  // Light text on a dark background becomes dark text on a white background, as does dark text on a light background.
  const W = 96; const H = 24; const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4; const dark = x < 48; const ink = y >= 8 && y < 16 && x % 12 >= 3 && x % 12 < 6;
    const v = dark ? (ink ? 235 : 30) : (ink ? 20 : 250);
    data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
  }
  const N = ocrlayout.normalizeForOcr({ data, width: W, height: H });
  assert.ok(N.g[10 * W + 4] < 60 && N.g[10 * W + 52] < 60, 'text dark (both pages)');
  assert.ok(N.g[2 * W + 10] > 240 && N.g[2 * W + 70] > 240, 'background white (both pages)');
  // Large bold text fills a whole tile: it stays text and does not become background (otherwise
  // the letters appear inverted and are misread, e.g. "Batrag" instead of "Betrag").
  {
    const W2 = 120; const H2 = 72; const d2 = new Uint8ClampedArray(W2 * H2 * 4);
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
      const p = (y * W2 + x) * 4; const v = x >= 20 && x < 52 && y >= 20 && y < 52 ? 10 : 248;
      d2[p] = v; d2[p + 1] = v; d2[p + 2] = v; d2[p + 3] = 255;
    }
    const N2 = ocrlayout.normalizeForOcr({ data: d2, width: W2, height: H2 });
    assert.ok(N2.g[36 * W2 + 36] < 60, `center of the bold area stays dark: ${N2.g[36 * W2 + 36]}`);
    assert.ok(N2.g[60 * W2 + 100] > 240, 'background stays white');
  }

  // Shapes on a white background: baseline at y = 100, font size 40 pixels.
  const G = { g: new Uint8Array(300 * 140).fill(255), width: 300, height: 140 };
  const disc = (cx, cy, r, ring) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) { const d = Math.hypot(x - cx, y - cy); if (d <= r && (!ring || d >= r - 2)) G.g[y * 300 + x] = 0; } };
  const box = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) G.g[y * 300 + x] = 0; };
  disc(20, 88, 6); disc(50, 88, 7, true); disc(80, 94, 6); box(104, 82, 116, 94);
  const kind = (x0, x1) => ocrlayout.findBullet(G, [x0, 60, x1, 104], 100, 40)?.kind || null;
  assert.equal(kind(10, 30), '•'); assert.equal(kind(40, 60), '◦'); assert.equal(kind(100, 120), '▪');
  assert.equal(kind(70, 90), null, 'an "o" on the baseline is not a bullet');
  // ± (plus with a stroke on the baseline) and plus alone.
  box(140, 78, 160, 81); box(148, 70, 151, 90); box(140, 96, 160, 99);
  box(180, 78, 200, 81); box(188, 70, 191, 90);
  assert.equal(ocrlayout.isPlusMinus(G, [140, 70, 160, 99], 100, 40), true);
  assert.equal(ocrlayout.isPlusMinus(G, [180, 70, 200, 90], 100, 40), false);
  // A comma reaches below the baseline, a period does not.
  box(220, 95, 224, 100); box(240, 95, 244, 100); box(241, 100, 243, 108);
  assert.equal(ocrlayout.stopKind(G, [220, 95, 224, 100], 100, 40, ','), '.');
  assert.equal(ocrlayout.stopKind(G, [240, 95, 244, 108], 100, 40, '.'), ',');
  // Missed umlaut: "o" with two dots (inside the text recognition box or above it), "o" without dots.
  const U = { g: new Uint8Array(120 * 80).fill(255), width: 120, height: 80 };
  const ring = (cx) => { for (let y = 44; y <= 62; y++) for (let x = cx - 9; x <= cx + 9; x++) { const dd = Math.hypot(x - cx, y - 53); if (dd <= 7.5 && dd >= 4.5) U.g[y * 120 + x] = 0; } };
  ring(30); ring(80);
  for (const [x0, y0] of [[24, 38], [32, 38]]) for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) U.g[y * 120 + x] = 0;
  assert.equal(ocrlayout.hasUmlaut(U, [22, 38, 39, 61], 60, 40), true, 'dots inside the box');
  assert.equal(ocrlayout.hasUmlaut(U, [22, 45, 39, 61], 60, 40), true, 'dots above the box');
  assert.equal(ocrlayout.hasUmlaut(U, [72, 45, 89, 61], 60, 40), false, 'without dots');
  // Two i side by side: one dot each above its own stroke, so not a ü.
  for (const x0 of [100, 108]) { for (let y = 46; y < 61; y++) for (let x = x0; x < x0 + 3; x++) U.g[y * 120 + x] = 0; for (let y = 40; y < 43; y++) for (let x = x0; x < x0 + 3; x++) U.g[y * 120 + x] = 0; }
  assert.equal(ocrlayout.hasUmlaut(U, [100, 40, 111, 61], 60, 40), false, 'ii stays ii');

  // Paragraphs: heading, two bullet points (the first one wrapped), then a normal paragraph.
  const L = (x0, x1, base, extra = {}) => ({ x0, x1, base, size: 40, bold: false, ...extra });
  const lines = [
    L(0, 200, 50, { bold: true }),
    L(10, 20, 110, { marker: true }), L(40, 900, 110, { list: true, markerX: 10 }), L(40, 600, 160),
    L(10, 20, 210, { marker: true }), L(40, 700, 210, { list: true, markerX: 10 }),
    L(0, 900, 300), L(0, 500, 350),
  ];
  const groups = ocrlayout.groupParagraphs(lines).map((g) => g.sort((a, b) => a - b));
  assert.deepEqual(groups.sort((a, b) => a[0] - b[0]), [[0], [1], [2, 3], [4], [5], [6, 7]]);

  // Recognized text with paragraphs: its own marker per paragraph including the font, spaces between the words.
  const d = await PDFDocument.create(); d.registerFontkit((await import('@cantoo/fontkit')).default);
  const b0 = await (d.addPage([595, 842]), d.save());
  const words = [{ text: '•', x: 50, y: 700, width: 5, height: 11, line: 0, par: 0 }, { text: 'All', x: 62, y: 700, width: 20, height: 11, line: 1, par: 1 }, { text: 'words', x: 86, y: 700, width: 34, height: 11, line: 1, par: 1 }];
  const b = await ops.addInvisibleText(b0, [{ page: 0, words, pars: [{ font: 'Segoe UI', bold: false, tz: 100 }, { font: 'Segoe UI', bold: true, tz: 97.5 }] }], readFont);
  const r = content.interpret((await PDFDocument.load(b)).getPage(0));
  const marks = [...new Set(r.items.filter((x) => x.kind === 'text').map((x) => x.mark))];
  assert.equal(marks.length, 2, 'two paragraphs');
  assert.ok(marks.every((m) => /^ocr/.test(m) && r.ocr.has(m)));
  assert.deepEqual(r.ocr.get(marks[1]), { font: 'Segoe UI', bold: true, tz: 97.5 });
  const pdf = await open(b);
  const strs = (await (await pdf.getPage(1)).getTextContent()).items.map((x) => x.str);
  assert.ok(strs.some((s) => /^All\s/.test(s)) || strs.join('').includes('All words'), `space after "All": ${JSON.stringify(strs)}`);
});
test('Bookmarks and properties', async () => {
  let b = await fixture(3);
  b = await ops.setOutline(b, [{ title: 'Kapitel Ä', page: 1, children: [{ title: 'Unter', page: 2 }] }, { title: 'Ende', page: 2 }]);
  b = await ops.setMetadata(b, { title: 'Title', author: 'DocPilot', keywords: 'a, b' });
  const pdf = await open(b);
  const o = await pdf.getOutline();
  assert.equal(o.length, 2); assert.equal(o[0].title, 'Kapitel Ä'); assert.equal(o[0].items[0].title, 'Unter');
  assert.equal(await pdf.getPageIndex(o[0].dest[0]), 1);
  assert.equal((await pdf.getMetadata()).info.Title, 'Title');
});
test('Attachments, encryption, sanitizing', async () => {
  let b = await fixture(1);
  b = await ops.addAttachment(b, 'a.txt', new TextEncoder().encode('hallo'), 'text/plain');
  const att = await (await open(b)).getAttachments();
  assert.ok(att['a.txt'] || att.get?.('a.txt'));
  const clean = await ops.removeAttachment(b, 'a.txt');
  assert.equal(await (await open(clean)).getAttachments(), null);
  const enc = await ops.encrypt(b, { userPassword: 'geheim', ownerPassword: 'chef' });
  await assert.rejects(open(enc));
  const pdf = await open(enc, 'geheim');
  assert.match(await textOf(pdf, 1), /Page 1/);
  const again = await ops.loadDoc(enc, 'chef');
  assert.equal(again.getPageCount(), 1);
  await assert.rejects(ops.loadDoc(enc, 'falsch'));
  const san = await ops.sanitizeDocument(b, { metadata: true, attachments: true, comments: true, javascript: true, thumbs: true });
  assert.equal(await (await open(san)).getAttachments(), null);
});
test('Really remove text from the content stream', async () => {
  const b = await fixture(1);
  const d = await ops.loadDoc(b);
  const page = d.getPage(0);
  const { items } = content.interpret(page);
  const t = items.filter((i) => i.kind === 'text');
  assert.equal(t.length, 2);
  assert.ok(Math.abs(t[0].bbox[0] - 72) < 1, 'x'); assert.ok(t[0].bbox[2] > 200 && t[0].bbox[2] < 300, 'Width');
  assert.ok(Math.abs(t[1].color[2] - 1) < 0.01, 'Color');
  assert.equal(content.removeTextInPage(page, [[70, 750, 400, 790]]), 1);
  const out = await ops.saveDoc(d);
  const tx = await textOf(await open(out), 1);
  assert.doesNotMatch(tx, /header line/); assert.match(tx, /Second line/);
});
test('Overlapping text blocks stay separate (editor marker)', async () => {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([595, 842]);
  page.drawText('Original below', { x: 72, y: 500, size: 14, font: f });
  page.pushOperators(PDFOperator.of('BDC', [PDFName.of(content.EDIT_TAG), d.context.obj({ Id: PDFString.of('blockA') })]));
  page.drawText('New above', { x: 90, y: 503, size: 14, font: f });
  page.pushOperators(PDFOperator.of('EMC'));
  const b = await d.save();
  const items = (await content.listPageObjects(b, 0)).filter((o) => o.kind === 'text');
  assert.deepEqual(items.map((o) => o.mark).sort(), ['blockA', null].sort(), 'marker is read');
  const rect = [60, 490, 300, 520];
  // Unmarked text in the same rectangle: the marked block stays.
  let d2 = await ops.loadDoc(b);
  assert.equal(content.removeTextInPage(d2.getPage(0), [rect], { mark: null }), 1);
  let tx = await textOf(await open(await ops.saveDoc(d2)), 1);
  assert.match(tx, /New above/); assert.doesNotMatch(tx, /Original below/);
  // Marked block: only it is removed.
  d2 = await ops.loadDoc(b);
  assert.equal(content.removeTextInPage(d2.getPage(0), [rect], { mark: 'blockA' }), 1);
  tx = await textOf(await open(await ops.saveDoc(d2)), 1);
  assert.match(tx, /Original below/); assert.doesNotMatch(tx, /New above/);
  // Without a mark (e.g. redaction), everything in the rectangle is still removed.
  d2 = await ops.loadDoc(b);
  assert.equal(content.removeTextInPage(d2.getPage(0), [rect]), 2);
});
test('Move and delete image', async () => {
  let b = await fixture(1);
  b = await ops.addImage(b, 0, [100, 100, 200, 200], PNG, 'image/png');
  let objs = (await content.listPageObjects(b, 0)).filter((o) => o.kind === 'image');
  assert.equal(objs.length, 1);
  b = await content.moveImage(b, 0, objs[0].bbox, [300, 300, 350, 320]);
  objs = (await content.listPageObjects(b, 0)).filter((o) => o.kind === 'image');
  assert.equal(objs.length, 1);
  assert.deepEqual(objs[0].bbox.map(Math.round), [300, 300, 350, 320]);
  b = await content.deleteImage(b, 0, objs[0].bbox);
  assert.equal((await content.listPageObjects(b, 0)).filter((o) => o.kind === 'image').length, 0);
});
test('Scans: remove lines, noise, tables stay line by line, scan pieces, recognize again', async () => {
  // 1. Lines: a text line (stems with crossbars), a dotted line above it, a slanted solid line below.
  const W = 700; const H = 200;
  const G = { g: new Uint8Array(W * H).fill(255), width: W, height: H };
  const put = (x, y, v = 0) => { if (x >= 0 && x < W && y >= 0 && y < H) G.g[y * W + x] = v; };
  const glyphs = (x0, top, height) => { for (let k = 0; k < 36; k++) { const x = x0 + k * 16; for (let y = top; y < top + height; y++) for (let d = 0; d < 4; d++) put(x + d, y); for (let d = 0; d < 10; d++) { put(x + d, top); put(x + d, top + 1); put(x + d, top + height - 1); put(x + d, top + height - 2); } } };
  glyphs(40, 80, 34);                                             // normal text
  glyphs(40, 150, 12);                                            // small text (must not count as a line)
  for (let x = 30; x < 660; x++) if (x % 7 < 3) { put(x, 62, 190); put(x, 63, 190); }   // dotted and faint
  for (let x = 30; x < 660; x++) { const y = 128 + Math.round((x - 30) * 0.006); for (let d = 0; d < 3; d++) put(x, y + d); }   // slanted, 3 pixels thick
  for (let y = 20; y < 190; y++) for (let d = 0; d < 2; d++) put(676 + d, y);           // senkrechte Tabellenlinie
  const inkIn = (y0, y1, x0 = 0, x1 = W) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (G.g[y * W + x] < 225) n++; return n; };
  const textBefore = inkIn(80, 114, 0, 670) + inkIn(150, 162, 0, 670);
  assert.ok(inkIn(60, 66) > 300 && inkIn(126, 136) > 1500 && inkIn(20, 190, 674, 680) > 300);
  const n = ocrlayout.removeRules(G, { minLen: 60, minLenV: 150, maxThick: 9, gap: 13 });
  assert.ok(n > 0);
  assert.equal(inkIn(60, 66), 0, 'dotted line removed');
  assert.equal(inkIn(126, 136, 0, 670), 0, 'slanted line removed');
  assert.equal(inkIn(20, 190, 674, 680), 0, 'vertical line removed');
  assert.equal(inkIn(80, 114, 0, 670) + inkIn(150, 162, 0, 670), textBefore, 'text stays unchanged, small text too');

  // 2. Noise: the background of a noisy scan becomes white, text stays dark, faint dots stay visible.
  {
    const w = 240; const h = 96; const d = new Uint8ClampedArray(w * h * 4); let seed = 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4; let v = 236 + (rnd() - 0.5) * 24;
      if (y >= 40 && y < 56 && x % 20 >= 4 && x % 20 < 9) v = 30;      // text
      if (y >= 30 && y < 34 && x >= 100 && x < 104) v = 150;          // blasser Umlautpunkt
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
    const N = ocrlayout.normalizeForOcr({ data: d, width: w, height: h });
    let grey = 0; for (let y = 0; y < 26; y++) for (let x = 0; x < w; x++) if (N.g[y * w + x] < 250) grey++;
    assert.ok(grey < 26 * w * 0.02, `background without grain: ${grey}`);
    assert.ok(N.g[48 * w + 6] < 40, 'text dark');
    assert.ok(N.g[32 * w + 102] < 150, `faint dot stays text: ${N.g[32 * w + 102]}`);
  }

  // 3. Paragraphs: table rows, number column and address stay one line each, running text is joined.
  const L = (x0, x1, base, n, first, lower) => ({ x0, x1, base, size: 40, bold: false, n, first, lower });
  const lines = [
    L(0, 300, 100, 3, 100, false), L(0, 340, 150, 2, 280, false), L(0, 220, 200, 2, 90, false),         // Adresse
    L(0, 1800, 400, 14, 60, false), L(0, 1790, 450, 12, 180, true), L(0, 900, 500, 7, 160, true),       // Fliesstext
    L(0, 1780, 700, 13, 90, false), L(0, 1795, 750, 11, 200, false), L(0, 600, 800, 4, 120, false),     // Fliesstext, Zeilen beginnen gross
    L(0, 620, 1000, 4, 80, false), L(0, 300, 1050, 2, 80, false), L(0, 420, 1100, 2, 80, false), L(0, 610, 1150, 2, 80, false), L(0, 560, 1200, 3, 80, false),   // Tabelle, erste Spalte
    L(1500, 1600, 1000, 1, 100, false), L(1500, 1600, 1050, 1, 100, false), L(1440, 1600, 1100, 1, 160, false),   // Zahlenspalte
  ];
  const groups = ocrlayout.groupParagraphs(lines).map((g) => g.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(groups, [[0], [1], [2], [3, 4, 5], [6, 7, 8], [9], [10], [11], [12], [13], [14], [15], [16]]);

  // 4. Role of the images: strips of a scan, full page, pasted image, single image.
  const strips = [0, 1, 2].map((k) => ({ bbox: [0, 600 - k * 100, 595, 700 - k * 100], pasted: false }));
  const pasted = { bbox: [100, 620, 300, 690], pasted: true };
  const pageArea = 595 * 842;
  assert.equal(content.imageRole(strips[1], [...strips, pasted], pageArea), 'piece');
  assert.equal(content.imageRole(pasted, [...strips, pasted], pageArea), 'object');
  assert.equal(content.imageRole({ bbox: [0, 0, 595, 842], pasted: false }, [], pageArea), 'page');
  const logo = { bbox: [50, 700, 150, 760], pasted: false };
  assert.equal(content.imageRole(logo, [logo, { bbox: [300, 100, 500, 300], pasted: false }], pageArea), 'object');
  // An image placed with "Add image" or Ctrl+V carries the marker, an image from a third-party PDF does not.
  let b = await ops.addImage(await fixture(1), 0, [100, 100, 200, 200], PNG, 'image/png');
  assert.equal((await content.listPageObjects(b, 0)).find((o) => o.kind === 'image').pasted, true);
  const plain = await PDFDocument.create(); plain.addPage([595, 842]).drawImage(await plain.embedPng(PNG), { x: 0, y: 0, width: 595, height: 842 });
  b = await plain.save();
  assert.equal((await content.listPageObjects(b, 0)).find((o) => o.kind === 'image').pasted, false);

  // 5. Recognize again: the previous recognition is removed, visible text stays.
  b = await ops.addInvisibleText(await fixture(1), [{ page: 0, words: [{ text: 'Alt', x: 300, y: 300, width: 20, height: 11, line: 0, par: 0 }, { text: 'erkannt', x: 324, y: 300, width: 40, height: 11, line: 0, par: 0 }], pars: [{ font: 'Arial', tz: 100 }] }], readFont);
  const visible = (await content.listPageObjects(b, 0)).filter((o) => o.kind === 'text' && !o.invisible).length;
  const r = await content.removeRecognizedText(b, [0]);
  assert.equal(r.count, 2);
  const left = (await content.listPageObjects(r.bytes, 0)).filter((o) => o.kind === 'text');
  assert.equal(left.filter((o) => o.invisible).length, 0);
  assert.equal(left.length, visible);
  assert.doesNotMatch(await textOf(await open(r.bytes), 1), /erkannt/);
});
test('Pasted screenshot: recognized text moves with the image, image grows, delete removes the text too', async () => {
  let b = await fixture(1);
  b = await ops.addImage(b, 0, [100, 400, 300, 500], PNG, 'image/png');
  b = await ops.addInvisibleText(b, [{ page: 0, words: [
    { text: 'Top', x: 110, y: 470, width: 40, height: 12, line: 0, par: 0 },
    { text: 'Bottom', x: 110, y: 420, width: 45, height: 12, line: 1, par: 1 },
  ], pars: [{ font: 'Arial', tz: 100 }, { font: 'Arial', tz: 100 }] }], readFont);
  const texts = async (bytes) => (await content.listPageObjects(bytes, 0)).filter((o) => o.kind === 'text');
  const find = (list, s) => list.find((o) => o.invisible && o.bbox[0] > 100 && o.bbox[0] < 400 && Math.abs(o.bbox[1] - s) < 30);
  const t0 = await texts(b);
  const own0 = t0.filter((o) => !o.invisible);
  // Move: image and its recognized text by (+50, -100), the page text stays.
  let img = (await content.listPageObjects(b, 0)).find((o) => o.kind === 'image');
  b = await content.moveImage(b, 0, img.bbox, [150, 300, 350, 400]);
  const t1 = await texts(b);
  for (const y of [470, 420]) {
    const a = find(t0, y); const c = find(t1, y - 100);
    assert.ok(a && c && Math.abs(c.bbox[0] - a.bbox[0] - 50) < 0.01 && Math.abs(c.bbox[1] - a.bbox[1] + 100) < 0.01, `word at ${y} moves along`);
  }
  assert.deepEqual(t1.filter((o) => !o.invisible).map((o) => o.bbox.map(Math.round)), own0.map((o) => o.bbox.map(Math.round)), 'page text stays');
  // Extend below the upper word: image 20 pt longer downwards, the lower word moves along, the upper one stays.
  img = (await content.listPageObjects(b, 0)).find((o) => o.kind === 'image');
  let d = await ops.loadDoc(b);
  assert.ok(content.growImageInPage(d.getPage(0), (o) => o.name === img.name, 350, 20));
  b = await ops.saveDoc(d);
  const img2 = (await content.listPageObjects(b, 0)).find((o) => o.kind === 'image');
  assert.deepEqual(img2.bbox.map(Math.round), [150, 280, 350, 400]);
  const t2 = await texts(b);
  assert.ok(Math.abs(find(t2, 370).bbox[1] - find(t1, 370).bbox[1]) < 0.01, 'upper word stays');
  assert.ok(Math.abs(find(t2, 300).bbox[1] - find(t1, 320).bbox[1] + 20) < 0.01, 'lower word moves down 20 pt');
  assert.match(await textOf(await open(b), 1), /Top.*Bottom/s);
  // A text block is removed entirely (including everything inside its marker).
  d = await ops.loadDoc(b);
  const mark = (await texts(b)).find((o) => o.invisible && o.mark).mark;
  assert.ok(content.removeTextInPage(d.getPage(0), [], { mark }) >= 1);
  const r = content.interpret(d.getPage(0));
  assert.ok(!r.spans.some((s) => s.id === mark) && !r.items.some((o) => o.mark === mark), 'block removed with its marker');
  // Delete: image and its recognized text gone, the page text stays.
  b = await content.deleteImage(b, 0, img2.bbox);
  const t3 = await texts(b);
  assert.equal(t3.filter((o) => o.invisible).length, 0);
  assert.equal(t3.length, own0.length);
  assert.equal((await content.listPageObjects(b, 0)).filter((o) => o.kind === 'image').length, 0);
});
test('Write, reload and flatten comments', async () => {
  const b = await fixture(2);
  const base = { author: 'Test', opacity: 1, width: 2, contents: 'Inhalt äöü', modified: new Date().toISOString(), replies: [] };
  const q = [72, 778, 200, 778, 72, 760, 200, 760];
  const list = [
    { ...base, id: 'a1', type: 'highlight', page: 0, rect: [72, 760, 200, 778], quads: [q], color: [1, 1, 0], replies: [{ id: 'r1', author: 'Fritz', contents: 'Antwort', modified: base.modified }], status: 'Accepted' },
    { ...base, id: 'a2', type: 'underline', page: 0, rect: [72, 760, 200, 778], quads: [q], color: [0, 1, 0] },
    { ...base, id: 'a3', type: 'strikeout', page: 0, rect: [72, 760, 200, 778], quads: [q], color: [1, 0, 0] },
    { ...base, id: 'a4', type: 'squiggly', page: 0, rect: [72, 760, 200, 778], quads: [q], color: [1, 0, 1] },
    { ...base, id: 'a5', type: 'note', page: 0, rect: [300, 500, 320, 520], color: [1, 0.8, 0] },
    { ...base, id: 'a6', type: 'freetext', page: 0, rect: [100, 300, 300, 360], fontSize: 14, textColor: [0, 0, 1], fill: [1, 1, 0.8], color: null, contents: 'Freier Text äöü' },
    { ...base, id: 'a7', type: 'rect', page: 0, rect: [100, 100, 200, 200], color: [1, 0, 0], fill: [0, 1, 0] },
    { ...base, id: 'a8', type: 'ellipse', page: 0, rect: [210, 100, 300, 200], color: [0, 0, 1] },
    { ...base, id: 'a9', type: 'arrow', page: 0, rect: [0, 0, 1, 1], points: [[320, 100], [400, 180]], color: [0, 0, 0] },
    { ...base, id: 'a10', type: 'line', page: 1, rect: [0, 0, 1, 1], points: [[20, 20], [100, 20]], color: [0, 0, 0] },
    { ...base, id: 'a11', type: 'polygon', page: 1, rect: [0, 0, 1, 1], points: [[50, 50], [100, 50], [80, 90]], color: [0, 0, 0] },
    { ...base, id: 'a12', type: 'polyline', page: 1, rect: [0, 0, 1, 1], points: [[150, 50], [200, 50], [180, 90]], color: [0, 0, 0] },
    { ...base, id: 'a13', type: 'cloud', page: 1, rect: [0, 0, 1, 1], points: [[250, 50], [350, 50], [350, 150], [250, 150]], color: [1, 0, 0] },
    { ...base, id: 'a14', type: 'ink', page: 1, rect: [0, 0, 1, 1], strokes: [[[10, 300], [20, 310], [30, 300]]], color: [0, 0, 1] },
    { ...base, id: 'a15', type: 'stamp', page: 1, rect: [100, 500, 300, 560], stamp: { text: 'APPROVED', sub: 'from test', color: [0, 0.5, 0] } },
    { ...base, id: 'a16', type: 'callout', page: 1, rect: [300, 600, 450, 650], points: [[250, 550], [300, 620]], fontSize: 11, textColor: [0, 0, 0], borderColor: [1, 0, 0], color: null },
    { ...base, id: 'a17', type: 'caret', page: 1, rect: [50, 700, 60, 710], color: [0, 0, 1] },
    { ...base, id: 'a18', type: 'redact', page: 1, rect: [72, 760, 200, 778], quads: [q], color: [1, 0, 0] },
  ];
  const byPage = new Map();
  for (const a of list) { if (!byPage.has(a.page)) byPage.set(a.page, []); byPage.get(a.page).push(a); }
  const d = await ops.loadDoc(b);
  await annots.writeAnnotations(d, byPage, readFont);
  const out = await ops.saveDoc(d);
  const pdf = await open(out);
  const p1 = await pdf.getPage(1);
  const seen = await p1.getAnnotations();
  assert.ok(seen.find((a) => a.subtype === 'Highlight' && a.titleObj.str === 'Test'), 'PDF.js sees highlight');
  assert.ok(seen.find((a) => a.subtype === 'FreeText'));
  await p1.getOperatorList();
  await (await pdf.getPage(2)).getOperatorList();
  const imp = await annots.stripAndImport(out);
  const again = [...imp.annots.values()].flat();
  assert.equal(again.length, list.length, 'all reloaded');
  for (const orig of list) {
    const got = again.find((a) => a.id === orig.id);
    assert.ok(got, orig.id);
    assert.equal(got.type, orig.type, orig.id);
    assert.equal(got.contents, orig.contents, orig.id);
  }
  const h = again.find((a) => a.id === 'a1');
  assert.equal(h.replies.length, 1); assert.equal(h.replies[0].contents, 'Antwort'); assert.equal(h.status, 'Accepted');
  assert.equal(again.find((a) => a.id === 'a15').stamp.text, 'APPROVED');
  assert.deepEqual(again.find((a) => a.id === 'a9').points, [[320, 100], [400, 180]]);
  assert.equal(again.find((a) => a.id === 'a6').fontSize, 14);
  assert.equal(((await (await open(imp.bytes)).getPage(1)).getAnnotations ? (await (await (await open(imp.bytes)).getPage(1)).getAnnotations()).length : 0), 0, 'removed from base');
  const fl = await ops.loadDoc(out);
  annots.flattenAnnotationsInDoc(fl);
  const flb = await ops.saveDoc(fl);
  const fp = await open(flb);
  assert.equal((await (await fp.getPage(1)).getAnnotations()).length, 0);
  assert.match(await textOf(fp, 1), /Freier Text/);
});
test('Create forms, export and import data, flatten', async () => {
  let b = await fixture(1);
  b = await ops.addFormField(b, 0, [100, 400, 300, 425], { type: 'text', name: 'name', value: 'Max', required: true });
  b = await ops.addFormField(b, 0, [100, 370, 120, 390], { type: 'checkbox', name: 'ok' });
  b = await ops.addFormField(b, 0, [100, 340, 120, 360], { type: 'radio', name: 'wahl', value: 'A' });
  b = await ops.addFormField(b, 0, [130, 340, 150, 360], { type: 'radio', name: 'wahl', value: 'B' });
  b = await ops.addFormField(b, 0, [100, 310, 300, 330], { type: 'dropdown', name: 'dd', options: ['eins', 'zwei'] });
  b = await ops.addFormField(b, 0, [100, 250, 300, 300], { type: 'list', name: 'li', options: ['x', 'y'] });
  b = await ops.addFormField(b, 0, [100, 220, 300, 245], { type: 'button', name: 'btn', value: 'Klick' });
  b = await ops.addFormField(b, 0, [100, 180, 300, 215], { type: 'signature', name: 'unterschrift' });
  const fields = await ops.listFormFields(b);
  assert.equal(fields.length, 7);
  assert.equal(fields[0].page, 0);
  await assert.rejects(ops.addFormField(b, 0, [0, 0, 10, 10], { type: 'text', name: 'name' }));
  b = await ops.importFormData(b, { name: 'Äda', ok: true, wahl: 'B', dd: 'zwei', li: 'y' });
  const data = await ops.exportFormData(b);
  assert.equal(data.name, 'Äda'); assert.equal(data.ok, true); assert.equal(data.wahl, 'B'); assert.deepEqual(data.dd, ['zwei']);
  { const fo = await (await open(b)).getFieldObjects(); assert.ok(fo.name || fo.get?.('name')); }
  const r = await ops.resetForm(b);
  assert.equal((await ops.exportFormData(r)).name, '');
  const flat = await ops.flattenForms(b);
  assert.match(await textOf(await open(flat), 1), /Äda/);
  const rm = await ops.removeFormField(b, 'dd');
  assert.equal((await ops.listFormFields(rm)).length, 6);
});
test('Create and validate digital signature', async () => {
  const b = await fixture(1);
  const p12 = await sign.createDigitalId({ name: 'Max Müller', org: 'Muster AG', password: 'pw123' });
  assert.throws(() => sign.readP12(p12, 'falsch'));
  const signed = await sign.signPdf(b, { p12, password: 'pw123', reason: 'Freigabe', location: 'Zurich', visible: { page: 0, rect: [100, 100, 300, 160] } });
  const res = sign.verifySignatures(signed);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].error, undefined);
  assert.ok(res[0].valid); assert.ok(res[0].covers); assert.equal(res[0].name, 'Max Müller');
  const pdf = await open(signed);
  assert.equal((await pdf.getPage(1)).pageNumber, 1);
  const tampered = signed.slice();
  const idx = res[0].byteRange[1] - 100;
  tampered[idx] = tampered[idx] ^ 1;
  assert.equal(sign.verifySignatures(tampered)[0].valid, false, 'tampering detected');
});
test('Invisible text, page labels, JavaScript, analysis, PDF/A, image to PDF', async () => {
  let b = await fixture(1);
  b = await ops.addInvisibleText(b, [{ page: 0, words: [{ text: 'Geheimwort', x: 100, y: 100, width: 80, height: 12 }, { text: 'Größe', x: 200, y: 100, width: 50, height: 12 }] }], readFont);
  assert.match(await textOf(await open(b), 1), /Geheimwort/); assert.match(await textOf(await open(b), 1), /Größe/);
  b = await ops.setPageLabels(b, [{ from: 0, style: 'r' }]);
  assert.deepEqual(await (await open(b)).getPageLabels(), ['i']);
  b = await ops.setDocumentJavascript(b, 'init', 'app.alert("x")');
  assert.equal((await ops.listDocumentJavascript(b))[0].code, 'app.alert("x")');
  b = await ops.setDocumentJavascript(b, 'init', '');
  assert.equal((await ops.listDocumentJavascript(b)).length, 0);
  const info = await ops.analyze(b);
  assert.ok(info.fonts.length >= 1);
  let icc = null; try { icc = new Uint8Array(fs.readFileSync('C:/Windows/System32/spool/drivers/color/sRGB Color Space Profile.icm')); } catch { /* optional */ }
  const a = await ops.toPdfA(b, icc, 'Archiv');
  assert.ok((await open(a)).numPages === 1);
  const im = await ops.imagesToPdf([{ bytes: PNG, mime: 'image/png' }]);
  assert.equal((await open(im)).numPages, 1);
  const op = await ops.optimize(await fixture(3), {}, null);
  assert.equal((await open(op.bytes)).numPages, 3);
  const rp = await ops.replacePageWithImage(await fixture(1), 0, Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')));
  assert.equal(await textOf(await open(rp), 1), '');
});

test('Find and replace: map results to a paragraph, replace in the paragraph, rewrap', async () => {
  // Search pattern: whitespace matches line breaks, special characters are literal, whole word, match case.
  assert.ok(replace.searchRegex('Muster AG', {}).test('die muster\nag hat'));
  assert.equal('Mustermann'.match(replace.searchRegex('Muster', { wholeWord: true })), null);
  assert.ok(replace.searchRegex('2024', { wholeWord: true }).test('Jahr 2024.'));
  assert.equal('Jahr 20241'.match(replace.searchRegex('2024', { wholeWord: true })), null);
  assert.equal('muster'.match(replace.searchRegex('Muster', { caseSensitive: true })), null);
  assert.ok(replace.searchRegex('a.b(c)', {}).test('xa.b(c)y'));
  assert.equal('axb(c)'.match(replace.searchRegex('a.b(c)', {})), null);

  // A page as the search sees it: text items with line end, from them the page text and the mapping character -> item.
  const items = [
    { str: 'Die Firma Muster' }, { str: ' AG liefert', hasEOL: true },
    { str: 'jedes Jahr an die Muster', hasEOL: true }, { str: 'AG in Bern.', hasEOL: true },
    { str: ' ' }, { str: 'Kunde: Muster AG', hasEOL: true }, { str: 'Muster AG (gedreht)' },
  ];
  let pageText = ''; const map = [];
  items.forEach((it, idx) => { for (let k = 0; k < it.str.length; k++) map.push({ item: idx, off: k }); pageText += it.str; if (it.hasEOL) { pageText += ' '; map.push({ item: idx, off: -1 }); } });
  // The same page as the editor sees it: a paragraph of three lines and a single line. The rotated
  // text item 6 is in no block.
  const blocks = [
    { kind: 'image', rect: [0, 0, 10, 10] },
    { kind: 'text', lines: [
      { text: 'Die Firma Muster AG liefert', x0: 0, x1: 135, parts: [{ item: 0, at: 0 }, { item: 1, at: 16 }] },
      { text: 'jedes Jahr an die Muster', x0: 0, x1: 120, parts: [{ item: 2, at: 0 }] },
      { text: 'AG in Bern.', x0: 0, x1: 55, parts: [{ item: 3, at: 0 }] },
    ] },
    { kind: 'text', lines: [{ text: 'Kunde: Muster AG', x0: 0, x1: 80, parts: [{ item: 5, at: 0 }] }] },
  ];
  const re = replace.searchRegex('Muster AG', {});
  const at = replace.locator(blocks, {});
  const found = [...pageText.matchAll(re)].map((m) => at(pageText, map, m.index, m.index + m[0].length, re));
  assert.equal(found.length, 4);
  // 1: across two text items of the same line, 2: across the line break, 3: single line, 4: no block.
  assert.deepEqual(found[0], { block: 1, a: 10, b: 19 });
  const para = replace.blockLines(blocks[1]);
  assert.equal(para.text.slice(found[0].a, found[0].b), 'Muster AG');
  assert.equal(found[1].block, 1);
  assert.equal(para.text.slice(found[1].a, found[1].b), 'Muster\nAG');
  assert.deepEqual(found[2], { block: 2, a: 7, b: 16 });
  assert.deepEqual(found[3], { reason: 'no-text' });
  // A result across two blocks ("Bern. Kunde") cannot be replaced.
  const across = /Bern\.\s+Kunde/u.exec(pageText);
  assert.deepEqual(at(pageText, map, across.index, across.index + across[0].length), { reason: 'multiple' });

  // Replace in the paragraph: both positions, the second one joins two lines.
  const hits = [found[0], found[1]].map(({ a, b }) => ({ a, b }));
  const r = replace.replaceInBlock(blocks[1], hits, 'Beispiel GmbH', [true, true]);
  assert.deepEqual(r.lines, ['Die Firma Beispiel GmbH liefert', 'jedes Jahr an die Beispiel GmbH in Bern.']);
  assert.deepEqual(r.soft, [true]); assert.equal(r.first, 0);
  // A block with a fixed width (recognized running text) keeps its separators and only wraps when it is set.
  const flowBlock = { ...blocks[1], seps: [' ', ' '], fixedWidth: true };
  const ft = replace.blockLines(flowBlock).text;
  assert.equal(ft, 'Die Firma Muster AG liefert jedes Jahr an die Muster AG in Bern.');
  const fh = [...ft.matchAll(re)].map((m) => ({ a: m.index, b: m.index + m[0].length }));
  assert.equal(replace.replacedText(flowBlock, fh, 'Test AG', null, null), 'Die Firma Test AG liefert jedes Jahr an die Test AG in Bern.');

  // Wrap: width = 5 per character, text width 27 characters. Lines before stay, what does not fit moves on.
  const measure = (t) => t.length * 5;
  const flow = { soft: [true, true], width: 135 };
  const out = replace.replacedText(blocks[1], [{ a: found[1].a, b: found[1].b }], 'Beispiel Holding AG', flow, measure).split('\n');
  assert.equal(out[0], 'Die Firma Muster AG liefert', 'line before the change stays');
  assert.equal(out.join(' '), 'Die Firma Muster AG liefert jedes Jahr an die Beispiel Holding AG in Bern.');
  assert.ok(out.length === 3 && out.every((l) => measure(l) <= 135), `every line fits in the column: ${JSON.stringify(out)}`);
  // Shorter text: nothing is wrapped, the lines stay.
  assert.deepEqual(replace.replacedText(blocks[1], [{ a: found[0].a, b: found[0].b }], 'X AG', flow, measure).split('\n'), ['Die Firma X AG liefert', 'jedes Jahr an die Muster', 'AG in Bern.']);
  // No running text (e.g. address, table): a longer line stays one line.
  assert.deepEqual(replace.replacedText(blocks[1], [{ a: found[0].a, b: found[0].b }], 'Beispiel Holding und Partner AG', { soft: [false, false], width: 135 }, measure).split('\n'),
    ['Die Firma Beispiel Holding und Partner AG liefert', 'jedes Jahr an die Muster', 'AG in Bern.']);
  // Running text ends in the middle of the block: the overflow becomes its own line and does not run into the next line.
  assert.deepEqual(replace.reflow(['aaaa bbbb cccc', 'Neue Zeile'], [false], 50, measure), ['aaaa bbbb', 'cccc', 'Neue Zeile']);
  assert.deepEqual(replace.reflow(['aaaa bbbb cccc', 'dd'], [true], 50, measure), ['aaaa bbbb', 'cccc dd']);
});

test('Detect form fields: lines, underscores, boxes, circles, table, names, existing fields', async () => {
  // Fictional registration form as a real PDF: the detection reads lines and circles from the page content.
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([595, 842]);
  const black = rgb(0, 0, 0);
  const line = (x0, y0, x1, y1, t = 0.7) => p.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: t, color: black });
  p.drawText('Anmeldung zum Kurs', { x: 60, y: 780, size: 18, font: fb });
  line(60, 772, 535, 772, 1.2);                                   // separator below the heading: not a field
  p.drawText('Name:', { x: 60, y: 730, size: 11, font: f }); line(130, 728, 330, 728);
  p.drawText('Vorname:', { x: 60, y: 705, size: 11, font: f }); line(130, 703, 330, 703);
  p.drawText('Telefon: ____________________', { x: 60, y: 680, size: 11, font: f });   // underscores in the text
  p.drawText('Betrifft Kurs', { x: 60, y: 652, size: 11, font: f }); line(60, 650, 122, 650);   // underlined text: not a field
  // Check boxes as small squares, label to the right.
  p.drawRectangle({ x: 60, y: 620, width: 10, height: 10, borderColor: black, borderWidth: 0.8 }); p.drawText('Newsletter', { x: 76, y: 621, size: 11, font: f });
  p.drawRectangle({ x: 200, y: 620, width: 10, height: 10, borderColor: black, borderWidth: 0.8 }); p.drawText('Parkplatz', { x: 216, y: 621, size: 11, font: f });
  // Radio buttons as circles, question to the left of them.
  p.drawText('Verpflegung:', { x: 60, y: 591, size: 11, font: f });
  p.drawCircle({ x: 150, y: 595, size: 5, borderColor: black, borderWidth: 0.8 }); p.drawText('Fleisch', { x: 160, y: 591, size: 11, font: f });
  p.drawCircle({ x: 230, y: 595, size: 5, borderColor: black, borderWidth: 0.8 }); p.drawText('Vegetarisch', { x: 240, y: 591, size: 11, font: f });
  p.drawCircle({ x: 62, y: 560, size: 2, color: black }); p.drawText('Aufzählungspunkt, kein Optionsfeld', { x: 70, y: 556, size: 11, font: f });
  // Empty box with a label above it (multiline).
  p.drawText('Bemerkungen', { x: 60, y: 528, size: 11, font: f });
  p.drawRectangle({ x: 60, y: 460, width: 300, height: 60, borderColor: black, borderWidth: 0.8 });
  // Table: header row with text, two empty rows. Columns: Tag | Zeit.
  for (const y of [420, 400, 380, 360]) line(60, y, 300, y);
  for (const x of [60, 180, 300]) line(x, 360, x, 420);
  p.drawText('Tag', { x: 66, y: 406, size: 11, font: fb }); p.drawText('Zeit', { x: 186, y: 406, size: 11, font: fb });
  // Signature lines with a small label below them.
  line(60, 280, 240, 280); p.drawText('Ort, Datum', { x: 60, y: 268, size: 9, font: f });
  line(300, 280, 500, 280); p.drawText('Unterschrift', { x: 300, y: 268, size: 9, font: f });
  // Frame around a text block: not a field (not empty).
  p.drawRectangle({ x: 60, y: 180, width: 300, height: 40, borderColor: black, borderWidth: 0.8 }); p.drawText('Hinweis: Die Anmeldung ist verbindlich.', { x: 68, y: 196, size: 10, font: f });
  // One field already exists: it must not be suggested again.
  d.getForm().createTextField('Vorname').addToPage(p, { x: 130, y: 704, width: 200, height: 14, font: f });
  let b = await d.save();

  const scan = async (bytes) => {
    const doc = await ops.loadForEdit(bytes);
    const g = formdetect.pageGraphics(doc.getPage(0));
    const tc = await (await (await open(bytes)).getPage(1)).getTextContent();
    const words = textutil.wordBoxes(tc).map((w) => ({ text: w.text, rect: w.rect, y: w.y, height: w.height }));
    const { names, widgets } = await ops.listFieldWidgets(bytes);
    const found = formdetect.detectFields({ words, lines: g.lines, circles: g.circles, page: { width: 595, height: 842 }, existing: widgets.filter((w) => w.page === 0).map((w) => w.rect), taken: new Set(names.map((n) => n.toLowerCase())) });
    return { g, found };
  };
  const { g, found } = await scan(b);
  assert.equal(g.circles.length, 2, `two circles (the filled dot does not count): ${JSON.stringify(g.circles)}`);
  const by = (name) => found.filter((x) => x.name === name);
  const list = found.map((x) => `${x.type}:${x.name}${x.value ? `=${x.value}` : ''}`);
  // Text fields from a line and from underscores, name from the label to the left.
  assert.equal(by('Name').length, 1, list.join(' | ')); assert.equal(by('Name')[0].type, 'text');
  const nm = by('Name')[0].rect;
  assert.ok(Math.abs(nm[0] - 130) < 1 && Math.abs(nm[2] - 330) < 1 && nm[1] > 728 && nm[3] <= 743, `field lies on the line: ${nm}`);
  assert.equal(by('Telefon').length, 1, list.join(' | '));
  const tel = by('Telefon')[0].rect;
  assert.ok(tel[0] > 95 && tel[0] < 112 && tel[2] - tel[0] > 100, `field over the underscores: ${tel}`);
  // The existing field "Vorname" is not suggested again.
  assert.equal(found.filter((x) => /^Vorname/.test(x.name)).length, 0, list.join(' | '));
  // Check boxes with a label to the right.
  assert.deepEqual(found.filter((x) => x.type === 'checkbox').map((x) => x.name), ['Newsletter', 'Parkplatz']);
  assert.ok(Math.abs(by('Newsletter')[0].rect[0] - 60) < 1.5 && Math.abs(by('Newsletter')[0].rect[3] - 630) < 1.5);
  // Radio buttons: one group with the name of the question, values from the labels to the right.
  const radios = found.filter((x) => x.type === 'radio');
  assert.deepEqual(radios.map((x) => `${x.name}=${x.value}`), ['Verpflegung=Fleisch', 'Verpflegung=Vegetarisch'], list.join(' | '));
  // Empty box: multiline text field, name from above.
  assert.equal(by('Bemerkungen').length, 1, list.join(' | ')); assert.equal(by('Bemerkungen')[0].type, 'multiline');
  // Table: four empty cells, names from the column header, unique.
  const cellsFound = found.filter((x) => /^(Tag|Zeit)/.test(x.name));
  assert.deepEqual(cellsFound.map((x) => x.name).sort(), ['Tag', 'Tag 2', 'Zeit', 'Zeit 2'], list.join(' | '));
  assert.ok(cellsFound.every((x) => x.type === 'text' && x.rect[3] <= 400.5 && x.rect[1] >= 359.5));
  // Signature line: signature field; "Ort, Datum" stays a text field.
  assert.equal(by('Unterschrift').length, 1, list.join(' | ')); assert.equal(by('Unterschrift')[0].type, 'signature');
  assert.ok(by('Unterschrift')[0].rect[3] - by('Unterschrift')[0].rect[1] >= 20, 'signature field is taller than a text field');
  assert.equal(by('Ort, Datum').length, 1, list.join(' | ')); assert.equal(by('Ort, Datum')[0].type, 'text');
  // No fields from the separator, underlined text, bullet point or the frame with text.
  assert.equal(found.length, 13, `exactly the expected fields: ${list.join(' | ')}`);
  assert.equal(new Set(found.filter((x) => x.type !== 'radio').map((x) => x.name.toLowerCase())).size, found.filter((x) => x.type !== 'radio').length, 'names are unique');

  // Create in one step; afterwards the detection finds nothing new.
  b = await ops.addFormFields(b, found.map((x) => ({ ...x, page: 0 })));
  const fields = await ops.listFormFields(b);
  assert.equal(fields.length, 13, `Vorname + 11 fields + one radio group: ${fields.map((x) => `${x.type}:${x.name}`).join(' | ')}`);
  const check = await ops.loadForEdit(b);
  assert.deepEqual(check.getForm().getRadioGroup('Verpflegung').getOptions(), ['Fleisch', 'Vegetarisch']);
  assert.ok(check.getForm().getTextField('Bemerkungen').isMultiline());
  assert.equal((await scan(b)).found.length, 0, 'existing fields are not created twice');
  // PDF.js reads the new fields as form fields.
  const an = await (await (await open(b)).getPage(1)).getAnnotations();
  assert.equal(an.filter((a) => a.subtype === 'Widget').length, 14);

  // Names: colon and underscores removed, dots replaced, length limited, unique.
  assert.equal(formdetect.fieldName('Name, Vorname: ___'), 'Name, Vorname');
  assert.equal(formdetect.fieldName('Nr. *'), 'Nr');
  assert.equal(formdetect.fieldName('', 'Text field'), 'Text field');
  assert.ok(formdetect.fieldName('Dies ist eine sehr lange Beschriftung, die viel zu lang für einen Feldnamen ist').length <= 40);
  const takenNames = new Set(['datum']);
  assert.equal(formdetect.uniqueName('Datum', takenNames), 'Datum 2'); assert.equal(formdetect.uniqueName('Datum', takenNames), 'Datum 3');

  // Boxes as characters and a label inside the box.
  const w = (text, x, y, width, height = 11) => ({ text, rect: [x, y - height * 0.22, x + width, y + height], y, height });
  const glyph = formdetect.detectFields({ words: [w('☐', 60, 700, 9), w('Ja', 74, 700, 12), w('☐', 110, 700, 9), w('Nein', 124, 700, 24)], lines: [], page: { width: 595, height: 842 } });
  assert.deepEqual(glyph.map((x) => `${x.type}:${x.name}`), ['checkbox:Ja', 'checkbox:Nein']);
  const boxed = formdetect.detectFields({ words: [w('Firma:', 64, 706, 32)], lines: [{ x0: 60, y0: 700, x1: 360, y1: 700 }, { x0: 60, y0: 722, x1: 360, y1: 722 }, { x0: 60, y0: 700, x1: 60, y1: 722 }, { x0: 360, y0: 700, x1: 360, y1: 722 }], page: { width: 595, height: 842 } });
  assert.equal(boxed.length, 1); assert.equal(boxed[0].name, 'Firma'); assert.ok(boxed[0].rect[0] > 96 && boxed[0].rect[2] < 360);

  // Scanned form: lines from the image. A box and a writing line in a grayscale image.
  const W = 400; const H = 200; const gimg = new Uint8Array(W * H).fill(255);
  const hline = (x0, x1, y, t = 2) => { for (let yy = y; yy < y + t; yy++) for (let x = x0; x < x1; x++) gimg[yy * W + x] = 30; };
  const vline = (x, y0, y1, t = 2) => { for (let xx = x; xx < x + t; xx++) for (let y = y0; y < y1; y++) gimg[y * W + xx] = 30; };
  hline(40, 62, 40); hline(40, 62, 60); vline(40, 40, 62); vline(60, 40, 62);     // box 20 x 20
  hline(120, 360, 150);                                                              // Schreiblinie
  for (let y = 90; y < 130; y++) for (let x = 200; x < 300; x++) gimg[y * W + x] = 40;   // dark area: not a line
  for (let x = 40; x < 48; x++) gimg[170 * W + x] = 30;                             // kurzer Strich eines Buchstabens
  const rl = formdetect.rasterLines({ g: gimg, width: W, height: H }, { minLen: 10, maxThick: 5 });
  const horiz = rl.filter((l) => l.y0 === l.y1); const vert = rl.filter((l) => l.x0 === l.x1);
  assert.equal(horiz.length, 3, `three horizontal lines: ${JSON.stringify(horiz)}`);
  assert.equal(vert.length, 2, `two vertical lines: ${JSON.stringify(vert)}`);
  assert.ok(horiz.some((l) => l.x0 === 120 && l.x1 === 360 && Math.abs(l.y0 - 151) <= 1));
  // Converted to points (2 pixels per point, y upwards) this gives a check box and a text field.
  const toPt = (l) => ({ x0: l.x0 / 2, x1: l.x1 / 2, y0: (H - l.y1) / 2, y1: (H - l.y0) / 2 });
  const fromScan = formdetect.detectFields({ words: [w('Kunde', 30, 26, 26)], lines: rl.map(toPt), page: { width: 200, height: 100 }, tol: 2.4, scan: true });
  assert.deepEqual(fromScan.map((x) => `${x.type}:${x.name}`), ['checkbox:Check box', 'text:Kunde']);
});

test('Detect tables: lines with merged cells, without lines from the alignment, numbers and dates', async () => {
  // Values for Excel: Swiss, German and English notation, currency, percent, date.
  const v = (t) => tables.parseValue(t);
  assert.deepEqual(v("1'250.00"), { value: 1250, type: 'number', numFmt: '#,##0.00' });
  assert.deepEqual(v('1’250.50'), { value: 1250.5, type: 'number', numFmt: '#,##0.00' });
  assert.deepEqual(v('CHF 1\'570.00'), { value: 1570, type: 'number', numFmt: '"CHF" #,##0.00' });
  assert.deepEqual(v('320.00'), { value: 320, type: 'number', numFmt: '0.00' });
  assert.deepEqual(v('12'), { value: 12, type: 'number' });
  assert.equal(v('1 250,50').value, 1250.5); assert.equal(v('1.250,00').value, 1250); assert.equal(v('1,250.00').value, 1250);
  assert.equal(v('3,5').value, 3.5); assert.equal(v('-12.50').value, -12.5); assert.equal(v('(12.50)').value, -12.5); assert.equal(v('12.50-').value, -12.5);
  assert.equal(v('−45.00').value, -45); assert.equal(v('12.-').value, 12); assert.equal(v('12.50 EUR').numFmt, '#,##0.00 "EUR"');
  assert.deepEqual(v('7.7%'), { value: 0.077, type: 'number', numFmt: '0.0%' }); assert.equal(v('8 %').value, 0.08);
  const d = v('12.11.2026');
  assert.equal(d.type, 'date'); assert.equal(d.numFmt, 'dd.mm.yyyy'); assert.equal(d.value.toISOString(), '2026-11-12T00:00:00.000Z');
  assert.equal(v('2026-11-12').value.toISOString(), '2026-11-12T00:00:00.000Z'); assert.equal(v('3.4.26').value.toISOString(), '2026-04-03T00:00:00.000Z');
  // Stays text: leading zero, phone, invalid date, numbers with a hyphen, long digit sequences, mixed text.
  for (const t of ['0041', '007', '044 123 45 67', '31.02.2026', '2026-0815', '1234567890123456', 'Montage', 'Nr. 5', '8000 Zürich', '1.2.3', 'Europa', '']) assert.equal(v(t).type, 'text', t);

  // Table with lines as a real PDF: header "Leistung" merged across two columns, "Region" across two rows.
  const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.Helvetica); const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([595, 842]); const black = rgb(0, 0, 0);
  const line = (x0, y0, x1, y1) => p.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 0.7, color: black });
  const X = [60, 180, 300, 420]; const Y = [700, 680, 660, 640, 620];
  for (const y of Y) line(y === 680 ? 180 : 60, y, 420, y);          // the line below "Leistung" is missing in the first column
  line(60, 620, 60, 700); line(180, 620, 180, 700); line(420, 620, 420, 700);
  line(300, 620, 300, 680);                                          // the column line is missing in the header row "Leistung"
  const right = (t, x, y, font = f) => p.drawText(t, { x: x - font.widthOfTextAtSize(t, 10), y, size: 10, font });
  p.drawText('Region', { x: 66, y: 686, size: 10, font: fb });
  p.drawText('Leistung', { x: 280, y: 686, size: 10, font: fb });
  p.drawText('Menge', { x: 186, y: 666, size: 10, font: fb }); p.drawText('Betrag', { x: 306, y: 666, size: 10, font: fb });
  p.drawText('Nord', { x: 66, y: 646, size: 10, font: f }); right('12', 294, 646); right("1'250.00", 414, 646);
  p.drawText('Süd', { x: 66, y: 626, size: 10, font: f }); right('3', 294, 626); right('320.00', 414, 626);
  p.drawText('Überschrift ausserhalb der Tabelle', { x: 60, y: 740, size: 12, font: fb });
  // Table without lines below it: three columns, numbers right-aligned, then running text.
  const rowsB = [['Artikel', 'Datum', 'Preis'], ['Schraube M8', '12.11.2026', '4.50'], ['Dübel', '03.12.2026', '12.00'], ['Winkel verzinkt', '15.01.2027', '128.75']];
  rowsB.forEach((r, k) => { p.drawText(r[0], { x: 60, y: 540 - k * 16, size: 10, font: k ? f : fb }); p.drawText(r[1], { x: 220, y: 540 - k * 16, size: 10, font: k ? f : fb }); right(r[2], 420, 540 - k * 16, k ? f : fb); });
  p.drawText('Dieser Satz steht unter der Tabelle und läuft über die ganze Breite der Seite hinweg.', { x: 60, y: 470, size: 10, font: f });
  p.drawText('Eine zweite Zeile Fliesstext folgt gleich darunter und gehört auch nicht zur Tabelle.', { x: 60, y: 456, size: 10, font: f });
  const bytes = await doc.save();
  const g = formdetect.pageGraphics((await ops.loadForEdit(bytes)).getPage(0));
  const tc = await (await (await open(bytes)).getPage(1)).getTextContent();
  const words = textutil.wordBoxes(tc).map((w) => ({ text: w.text, rect: w.rect, y: w.y, height: w.height }));
  const found = tables.detectTables({ words, lines: g.lines });
  assert.equal(found.length, 2, `two tables: ${JSON.stringify(found.map((t) => [t.ruled, t.rows, t.cols]))}`);
  const [a, b] = found;
  // Table with lines: 4 rows, 3 columns, merged cells.
  assert.ok(a.ruled && a.rows === 4 && a.cols === 3, `grid: ${a.rows} x ${a.cols}`);
  const at = (t, r, c) => t.cells.find((x) => x.r === r && x.c === c);
  assert.deepEqual([at(a, 0, 0).text, at(a, 0, 0).rowSpan, at(a, 0, 0).colSpan], ['Region', 2, 1]);
  assert.deepEqual([at(a, 0, 1).text, at(a, 0, 1).rowSpan, at(a, 0, 1).colSpan], ['Leistung', 1, 2]);
  assert.equal(at(a, 1, 0), undefined, 'the cell below "Region" belongs to the merged cell');
  assert.deepEqual([at(a, 1, 1).text, at(a, 1, 2).text], ['Menge', 'Betrag']);
  assert.deepEqual([at(a, 2, 0).text, at(a, 2, 1).text, at(a, 2, 2).text], ['Nord', '12', "1'250.00"]);
  assert.deepEqual([at(a, 3, 0).text, at(a, 3, 1).text, at(a, 3, 2).text], ['Süd', '3', '320.00']);
  assert.equal(at(a, 2, 2).align, 'right'); assert.equal(at(a, 2, 1).align, 'right'); assert.equal(at(a, 2, 0).align, 'left');
  assert.equal(at(a, 0, 1).align, 'center', 'header across two columns is centered');
  assert.deepEqual(a.colX.map(Math.round), X); assert.deepEqual(a.rowY.map(Math.round), Y);
  // Table without lines: 4 rows, 3 columns; the running text below does not belong to it.
  assert.ok(!b.ruled && b.rows === 4 && b.cols === 3, `without lines: ${b.rows} x ${b.cols}`);
  assert.deepEqual(b.cells.filter((c) => c.r === 3).map((c) => c.text), ['Winkel verzinkt', '15.01.2027', '128.75']);
  assert.deepEqual(b.cells.filter((c) => c.r === 0).map((c) => c.text), ['Artikel', 'Datum', 'Preis']);
  assert.deepEqual([at(b, 1, 0).align, at(b, 1, 1).align, at(b, 1, 2).align], ['left', 'left', 'right']);
  assert.ok(b.rect[1] > 475, `table ends before the running text: ${b.rect}`);
  // What is not in a table: heading and running text as whole lines.
  const inT = (w) => found.some((t) => (w.rect[0] + w.rect[2]) / 2 > t.rect[0] && (w.rect[0] + w.rect[2]) / 2 < t.rect[2] && (w.rect[1] + w.rect[3]) / 2 > t.rect[1] && (w.rect[1] + w.rect[3]) / 2 < t.rect[3]);
  const loose = tables.textRows(words.filter((w) => !inT(w)));
  assert.deepEqual(loose.map((r) => r.segs.length), [1, 1, 1]);
  assert.equal(loose[0].segs[0].text, 'Überschrift ausserhalb der Tabelle');

  // Two text columns side by side (newspaper layout) are not a table.
  const wd = (text, x, y) => ({ text, rect: [x, y - 2, x + text.length * 5, y + 10], y, height: 10 });
  const cols2 = [];
  for (let k = 0; k < 8; k++) { 'Dies ist ein langer Satz in der linken Spalte'.split(' ').reduce((x, t) => { cols2.push(wd(t, x, 700 - k * 13)); return x + t.length * 5 + 3; }, 60); 'und hier läuft der Text der rechten Spalte weiter'.split(' ').reduce((x, t) => { cols2.push(wd(t, x, 700 - k * 13)); return x + t.length * 5 + 3; }, 320); }
  assert.equal(tables.detectTables({ words: cols2 }).length, 0, 'two text columns are not a table');
  // A single line with a gap is not a table, two below each other are.
  assert.equal(tables.detectTables({ words: [wd('Total', 60, 500), wd('1570.00', 400, 500)] }).length, 0);
  const two = tables.detectTables({ words: [wd('Zwischensumme', 60, 500), wd('1450.00', 400, 500), wd('Total', 60, 486), wd('1570.00', 400, 486)] });
  assert.equal(two.length, 1); assert.deepEqual(two[0].cells.map((c) => c.text), ['Zwischensumme', '1450.00', 'Total', '1570.00']);
});

test('Skewed scans: determine the angle, straighten the image, map points back, rotated recognized text', async () => {
  // Page with "text lines": words as dark bars, some lines shorter (paragraph ends).
  const W = 800; const H = 1000;
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const g = new Uint8Array(W * H).fill(255);
  for (let line = 0; line < 24; line++) {
    const y = 80 + line * 34; let x = 70; const end = line % 5 === 4 ? 400 : 720;
    while (x < end) { const w = 14 + Math.floor(rnd() * 50); for (let yy = y; yy < y + 11; yy++) for (let xx = x; xx < Math.min(end, x + w); xx++) if (rnd() > 0.25) g[yy * W + xx] = 20; x += w + 9; }
  }
  const straight = { g, width: W, height: H };
  const r0 = deskew.skewAngle(straight);
  assert.ok(Math.abs(r0.angle) <= 0.1, `straight page: ${JSON.stringify(r0)}`);
  assert.equal(deskew.usableSkew(r0), 0, 'a straight page is not rotated');
  for (const a of [2.3, -4.1, 0.6, 7.5, -0.4]) {
    const r = deskew.skewAngle(deskew.rotateGray(straight, a));
    assert.ok(Math.abs(r.angle - a) <= 0.15, `angle ${a}: ${JSON.stringify(r)}`);
    assert.ok(r.confidence >= deskew.MIN_CONFIDENCE, `angle ${a} is reliable: ${r.confidence}`);
    assert.equal(deskew.usableSkew(r), r.angle);
  }
  // Straighten: afterwards the angle is zero.
  const tilted = deskew.rotateGray(straight, 3.2);
  const found = deskew.skewAngle(tilted).angle;
  const fixed = deskew.rotateGray(tilted, -found);
  assert.ok(Math.abs(deskew.skewAngle(fixed).angle) <= 0.15, 'straightened page');
  // Mapping back: a dark pixel in the straightened image lies at the calculated position in the skewed image.
  let hit = 0; let all = 0;
  for (let y = 100; y < H - 100; y += 7) for (let x = 100; x < W - 100; x += 11) {
    if (fixed.g[y * W + x] > 40) continue;
    const [sx, sy] = deskew.rotatePoint(x, y, found, (W - 1) / 2, (H - 1) / 2);
    all++; if (tilted.g[Math.round(sy) * W + Math.round(sx)] < 140) hit++;
  }
  assert.ok(all > 300 && hit >= all * 0.95, `points lie on the text again: ${hit}/${all}`);
  assert.deepEqual(deskew.rotatePoint(10, 0, 90, 0, 0).map((v) => Math.round(v * 1000) / 1000), [0, 10]);
  // No lines (noise, empty page): no reliable angle, nothing is rotated.
  const noise = new Uint8Array(W * H).fill(255); for (let k = 0; k < W * H; k++) if (rnd() < 0.06) noise[k] = 10;
  assert.equal(deskew.usableSkew(deskew.skewAngle({ g: noise, width: W, height: H })), 0, 'noise has no angle');
  assert.deepEqual(deskew.skewAngle({ g: new Uint8Array(W * H).fill(255), width: W, height: H }), { angle: 0, confidence: 0 });
  // Rotated more than the search range: uncertain, so do not rotate anything.
  assert.equal(deskew.usableSkew(deskew.skewAngle(deskew.rotateGray(straight, 20))), 0, 'nothing is rotated outside the range');

  // Recognized text of a skewed line is written rotated: PDF.js reads it as one line with this rotation.
  const ang = (-2.5 * Math.PI) / 180;
  const ws = ['Schiefe', 'Zeile', 'im', 'Scan']; let x = 100; let y = 600;
  const words = ws.map((text, k) => { const w = { text, x, y, width: text.length * 6, height: 11, line: 0, par: 0, angle: ang }; x += (text.length * 6 + 4) * Math.cos(ang); y += (text.length * 6 + 4) * Math.sin(ang); return { ...w, k }; });
  const b = await ops.addInvisibleText(await fixture(1), [{ page: 0, words, pars: [{ font: 'Arial', bold: false, tz: 100 }] }], readFont);
  const all4 = (await (await (await open(b)).getPage(1)).getTextContent()).items.filter((i) => i.transform[5] < 610 && i.transform[5] > 580);
  const joined = all4.map((i) => i.str + (i.hasEOL ? ' ' : '')).join('');
  assert.match(joined.replace(/\s+/g, ' '), /Schiefe Zeile im Scan/, `words stay readable separately: ${JSON.stringify(all4.map((i) => [i.str, i.hasEOL, i.transform.map((v) => Math.round(v * 100) / 100)]))}`);
  const items = all4.filter((i) => /Schiefe/.test(i.str));
  assert.equal(items.length, 1);
  assert.ok(Math.abs(Math.atan2(items[0].transform[1], items[0].transform[0]) - ang) < 0.003, `rotation in the text: ${items[0].transform}`);
  // The content reader returns the area at the rotated position for each word (for removing it from the image).
  const objs = content.interpret((await ops.loadForEdit(b)).getPage(0)).items.filter((o) => o.kind === 'text' && o.invisible);
  assert.equal(objs.length, 4);
  assert.ok(objs[3].bbox[1] < objs[0].bbox[1] - 3, `the last word lies lower than the first: ${objs[0].bbox} / ${objs[3].bbox}`);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log(`  OK    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL   ${name}\n         ${e.stack.split('\n').slice(0, 6).join('\n         ')}`); }
}
console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nAll ${cases.length} core tests passed`);
process.exit(failed ? 1 : 0);

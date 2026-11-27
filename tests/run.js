'use strict';
// End-to-end test in the real Electron app. Clicks through the interface and checks the saved files independently.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFDict, decodePDFRawStream } = require('@cantoo/pdf-lib');
const fontkit = require('@cantoo/fontkit');
const JSZip = require('jszip');

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-e2e-'));
const shots = path.join(root, 'dist', 'shots');
fs.mkdirSync(shots, { recursive: true });
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

let pdfjs;
const open = (b, password) => pdfjs.getDocument({ data: new Uint8Array(b), password, verbosity: 0 }).promise;
const textOf = async (pdf, n) => (await (await pdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ');
const allText = async (pdf) => { let t = ''; for (let i = 1; i <= pdf.numPages; i++) t += `${await textOf(pdf, i)}\n`; return t; };
const file = (n) => path.join(work, n);

async function makeFixture(name, pages = 4) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(`DocPilot test document page ${i}`, { x: 72, y: 760, size: 20, font: b });
    ['This is the first paragraph with some text to mark up.', 'The second line contains the word Secret and a number.', 'Phone and further details follow here in line three.'].forEach((t, k) => p.drawText(t, { x: 72, y: 700 - k * 18, size: 12, font: f }));
    p.drawRectangle({ x: 72, y: 420, width: 220, height: 120, color: rgb(0.17, 0.48, 0.78) });
  }
  const form = d.getForm();
  const t = form.createTextField('vorname');
  t.addToPage(d.getPage(0), { x: 72, y: 300, width: 200, height: 24, font: f });
  fs.writeFileSync(file(name), await d.save());
  return file(name);
}

/**
 * Invoice in the style of an online invoice: labels and values in two columns (the dates form a paragraph of their own
 * that lies within the one of the labels), a value that wraps, and an address. Values and address are in an embedded
 * font (Liberation Sans from PDF.js) whose ToUnicode map leaves "-" and ":" empty, as Chrome does for raised hyphens.
 */
async function invoiceFixture(name) {
  const d = await PDFDocument.create(); d.registerFontkit(fontkit);
  const lib = (f) => fs.readFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts', f));
  const reg = await d.embedFont(lib('LiberationSans-Regular.ttf'), { subset: true }); const bold = await d.embedFont(lib('LiberationSans-Bold.ttf'), { subset: true });
  const hb = await d.embedFont(StandardFonts.HelveticaBold); const h = await d.embedFont(StandardFonts.Helvetica);
  const pg = d.addPage([595, 842]);
  const t = (s, x, y, font, size = 9) => pg.drawText(s, { x, y, size, font });
  t('Invoice', 30, 744, hb, 18);
  t('Invoice number', 30, 711.75, hb); t('INV-0042', 108, 711.75, bold);
  t('Date of issue', 30, 698.25, h); t('November 21, 2026', 108, 698.25, reg);
  t('Date due', 30, 684.75, h); t('November 21, 2026', 108, 684.75, reg);
  t('VAT Registration', 30, 671.25, h); t('Sample VAT: CHE-', 108, 671.25, reg);
  t('123.456.789 MWST', 108, 657.75, reg);
  t('Bill to', 250, 629.25, hb);
  ['Example Ltd', 'Main Street 1', 'CH-1234 Sample Town', 'Switzerland'].forEach((s, k) => t(s, 250, 612.75 - k * 13.5, reg));
  const d2 = await PDFDocument.load(await d.save());
  const fontDicts = d2.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict);
  for (const [, ref] of fontDicts.entries()) {
    const tuRef = d2.context.lookup(ref, PDFDict).get(PDFName.of('ToUnicode'));
    if (!tuRef) continue;
    const cmap = Buffer.from(decodePDFRawStream(d2.context.lookup(tuRef)).decode()).toString('latin1').replace(/^(<[0-9a-f]+>\s+)<(002d|003a)>$/gim, '$1<0000>');
    d2.context.assign(tuRef, d2.context.flateStream(Buffer.from(cmap, 'latin1')));
  }
  fs.writeFileSync(file(name), await d2.save());
  return file(name);
}

/**
 * Form block that DocPilot has already set once, as in a saved document: bold labels, regular values in a second
 * column, a bold label with its value right after it, all in one editor block; below the first two lines lies what is
 * left of the old text (shifts without glyphs, as removeTextItems leaves them). All names invented.
 */
async function editedBlockFixture(name) {
  const d = await PDFDocument.create();
  const h = await d.embedFont(StandardFonts.Helvetica); const hb = await d.embedFont(StandardFonts.HelveticaBold);
  const pg = d.addPage([595, 842]);
  pg.node.set(PDFName.of('Resources'), d.context.obj({ Font: { F1: h.ref, F2: hb.ref } }));
  const parts = [['Contract holder', 72, 720, hb], ['Name / First name', 72, 709, hb], ['Muster Anna', 190, 709, h], ['Street', 72, 698, hb],
    ['Example Road 5', 190, 698, h], ['Customer no.:', 72, 687, hb], ['4711', 72 + hb.widthOfTextAtSize('Customer no.: ', 9), 687, h]];
  const op = (s, x, y, f, shift) => `BT /${f === hb ? 'F2' : 'F1'} 9 Tf 1 0 0 1 ${x} ${y} Tm ${shift ? `[${(-f.widthOfTextAtSize(s, 1000)).toFixed(3)}] TJ` : `(${s}) Tj`} ET`;
  const raw = [...parts.slice(0, 3).map((p) => op(...p, true)), '/DPEdit <</Id (e1fixture)>> BDC', ...parts.map((p) => op(...p, false)), 'EMC'].join('\n');
  pg.node.set(PDFName.of('Contents'), d.context.register(d.context.flateStream(Buffer.from(raw, 'latin1'))));
  fs.writeFileSync(file(name), await d.save());
  return file(name);
}

(async () => {
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const app = await electron.launch({
    executablePath: process.env.DP_EXE || require('electron'), // Do not pause rendering when the test window is covered by other windows.
    args: [...(process.env.DP_EXE ? [] : [root]), '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    env: { ...process.env, DP_USER_DATA: path.join(work, 'userdata'), ELECTRON_RUN_AS_NODE: undefined },
  });
  const page = await app.firstWindow();
  await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {});
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message} ${(e.stack || '').split('\n').slice(1, 3).join(' ').trim()}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.waitForFunction(() => !!window.__app);

  const setDialogs = (o) => app.evaluate(({ dialog }, x) => {
    dialog.showOpenDialog = async () => ({ canceled: !x.open, filePaths: x.open || [] });
    dialog.showSaveDialog = async () => ({ canceled: !x.save, filePath: x.save });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, o);
  const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) });
  const wait = (ms) => page.waitForTimeout(ms);
  const idle = () => page.waitForFunction(() => !document.querySelector('.prog'), null, { timeout: 180000 });
  const ok = async () => { await page.click('.scrim [data-ok], .scrim .btn.primary'); await idle(); await wait(150); };
  const field = async (k, v) => {
    const sel = `.scrim [data-field="${k}"]`;
    const tag = await page.$eval(sel, (e) => (e.type === 'checkbox' ? 'chk' : e.tagName));
    if (tag === 'SELECT') await page.selectOption(sel, String(v)); else if (tag === 'chk') await page.setChecked(sel, !!v); else await page.fill(sel, String(v));
  };
  /** Clicks a button of a message box (e.g. "Update", "Remove"). */
  const choose = async (label) => { await page.waitForSelector('.scrim [role="alertdialog"]'); await page.click(`.scrim [role="alertdialog"] .f .btn:text-is("${label}")`); await wait(150); };
  const dialog = async (vals) => { await page.waitForSelector('.scrim'); for (const [k, v] of Object.entries(vals)) await field(k, v); await ok(); };
  const rendered = (i = 0) => page.waitForFunction((n) => { const p = window.__app.viewer.node(n); return p && p.layers && p.textLayer && !p.task && p.stale === false && !!p.layers.text.querySelector('.endOfContent'); }, i, { timeout: 30000 });
  const fitPage = async () => { await page.evaluate(() => { window.__app.viewer.setZoom('page'); window.__app.viewer.goto(0, { noHistory: true }); }); await wait(350); await rendered(); await wait(100); };
  const openFile = async (p) => { await page.evaluate((x) => window.__app.openPath(x), p); await rendered(); await fitPage(); };
  const closeAll = async () => { await page.evaluate(async () => { const a = window.__app; for (const d of [...a.docs]) { d.dirty = false; await a.closeDoc(d, true); } }); await wait(100); };
  const pagePt = async (i, x, y) => page.evaluate(([n, px, py]) => { const v = window.__app.viewer; const r = v.node(n).el.getBoundingClientRect(); const q = v.viewport(n).convertToViewportPoint(px, py); return [r.left + q[0], r.top + q[1]]; }, [i, x, y]);
  const drag = async (i, a, b) => { const [x0, y0] = await pagePt(i, ...a); const [x1, y1] = await pagePt(i, ...b); await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await page.mouse.move(x1, y1, { steps: 4 }); await page.mouse.up(); await wait(120); };
  const clickAt = async (i, a) => { const [x, y] = await pagePt(i, ...a); await page.mouse.click(x, y); await wait(120); };
  const tool = (t) => page.evaluate((x) => window.__app.tools.selectTool(x), t);
  const group = (g) => page.evaluate((x) => window.__app.tools.openGroup(x), g);
  const run = (c, a) => page.evaluate(([x, y]) => { window.__app.run(x, y); }, [c, a]);
  const count = () => page.evaluate(() => window.__app.doc.allAnnots().length);
  const saveAs = async (n) => { const p = file(n); await setDialogs({ save: p }); await page.evaluate(() => window.__app.saveAs()); await idle(); await wait(200); return fs.readFileSync(p); };

  const steps = [];
  const step = (n, fn) => steps.push([n, fn]);

  step('Home: interface and logo', async () => {
    await page.waitForSelector('#view-home .home-hero img');
    const nat = await page.$eval('#view-home .home-hero img', async (i) => { await i.decode(); return i.naturalWidth; });
    assert.ok(nat > 0, 'logo loaded');
    assert.equal(await page.title(), 'DocPilot');
    const c = await page.$eval('.btn.primary', (e) => getComputedStyle(e).backgroundColor);
    assert.equal(c, 'rgb(14, 124, 134)');
    await shot('01-start');
  });
  step('Open via file dialog, page is rendered', async () => {
    const p = await makeFixture('a.pdf');
    await setDialogs({ open: [p] });
    await page.click('#home-open');
    await rendered();
    const lit = await page.evaluate(() => { const c = window.__app.viewer.node(0).canvas; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 400) if (d[i] < 200) dark++; return dark; });
    assert.ok(lit > 50, 'page has content');
    await wait(300); await shot('02-document');
  });
  step('Zoom, navigation, layouts, rotation', async () => {
    await page.evaluate(() => window.__app.viewer.setZoom(1));
    await wait(200);
    assert.equal(await page.inputValue('#page-controls input'), '1');
    await page.evaluate(() => window.__app.viewer.next());
    await wait(200);
    assert.equal(await page.inputValue('#page-controls input'), '2');
    for (const l of ['single', 'double', 'double-continuous', 'continuous']) { await page.evaluate((x) => window.__app.viewer.setLayout(x), l); await wait(150); }
    await run('view-rotate', 90); await wait(200); await run('view-rotate', -90); await wait(200);
    await page.evaluate(() => window.__app.viewer.goto(0)); await wait(200);
    await fitPage();
  });
  step('Find with highlighting', async () => {
    await run('find');
    await page.fill('#findbar input[type=text]', 'Secret');
    await page.waitForFunction(() => /of 4/.test(document.querySelector('#findbar .cnt').textContent));
    await wait(300);
    assert.ok(await page.$eval('.pv-page .hl', (e) => e.children.length) >= 1, 'results visible');
    await page.keyboard.press('Escape');
    await wait(100);
  });
  step('Text selection: highlight via mini toolbar', async () => {
    await rendered();
    await drag(0, [74, 704], [260, 704]);
    await page.waitForSelector('.mini');
    await page.click('.mini .ib[title="Highlight"]');
    await wait(200);
    const a = await page.evaluate(() => window.__app.doc.allAnnots()[0]);
    assert.equal(a.type, 'highlight'); assert.ok(a.quads.length >= 1);
    assert.ok(a.rect[2] - a.rect[0] > 120);
  });
  step('Draw: rectangle, arrow, pencil, note, text box, polygon', async () => {
    await tool('rect'); await drag(0, [320, 540], [480, 440]);
    await tool('arrow'); await drag(0, [320, 400], [480, 360]);
    await tool('ink'); await drag(0, [100, 200], [200, 240]);
    await tool('select');
    await tool('note'); await clickAt(0, [500, 700]); await page.waitForSelector('.note-pop textarea');
    await page.fill('.note-pop textarea', 'My note äöü'); await wait(300); await page.keyboard.press('Escape');
    await tool('freetext'); await drag(0, [320, 330], [520, 280]); await wait(150);
    await page.keyboard.type('Free text'); await page.evaluate(() => document.activeElement.blur()); await wait(150);
    await tool('polygon'); await clickAt(0, [100, 150]); await clickAt(0, [180, 150]); await clickAt(0, [140, 100]); await page.evaluate(() => window.__app.overlay.finishPoly()); await wait(100);
    assert.equal(await count(), 7);
    await shot('03-comments');
  });
  step('Undo and redo', async () => {
    await run('undo'); await wait(200); assert.equal(await count(), 6);
    await run('redo'); await wait(200); assert.equal(await count(), 7);
  });
  step('Move with the mouse and delete', async () => {
    await tool('select');
    const before = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.type === 'rect').rect);
    await drag(0, [322, 500], [352, 470]);
    const after = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.type === 'rect').rect);
    assert.ok(Math.abs(after[0] - before[0] - 30) < 3, `moved ${before} -> ${after}`);
  });
  step('Place stamp and comments panel', async () => {
    await group('stamp'); await page.click('.stamp-btn[data-stamp="APPROVED"]'); await dialog({ dyn: true });
    await clickAt(0, [320, 240]); await wait(150);
    assert.equal(await count(), 8);
    await page.evaluate(() => window.__app.tools.closeGroup());
    await page.click('#right-rail [data-panel="comments"]');
    await wait(200);
    assert.equal(await page.$$eval('.cm', (e) => e.length), 8);
    await page.fill('.cm .act input', 'Reply one'); await page.keyboard.press('Enter'); await wait(150);
    await shot('04-panel');
  });
  step('Save: real annotations, reopen', async () => {
    const buf = await saveAs('a-kommentiert.pdf');
    const pdf = await open(buf);
    const an = await (await pdf.getPage(1)).getAnnotations();
    const st = an.map((a) => a.subtype);
    for (const t of ['Highlight', 'Square', 'Line', 'Ink', 'Text', 'FreeText', 'Polygon', 'Stamp']) assert.ok(st.includes(t), `${t} missing: ${st}`);
    await closeAll();
    await openFile(file('a-kommentiert.pdf'));
    assert.equal(await count(), 8, 'comments editable again');
    const h1 = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.type === 'highlight'));
    assert.equal(h1.replies[0].contents, 'Reply one');
    const fs2 = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.type === 'freetext').contents);
    assert.equal(fs2, 'Free text');
    await shot('05-reopened');
    await closeAll();
  });
  step('Edit PDF: really replace text', async () => {
    await openFile(file('a.pdf'));
    await group('edit');
    await page.waitForSelector('.eb');
    await wait(200);
    await shot('06-edit');
    const box = await page.evaluate(() => { const o = window.__app.editor.cache.get(0).find((b) => b.text.includes('second line') || b.text.includes('first paragraph')); return o.rect; });
    await page.mouse.dblclick(...await pagePt(0, box[0] + 20, (box[1] + box[3]) / 2));
    await page.waitForSelector('.eb-input');
    await page.fill('.eb-input', 'New paragraph from DocPilot with umlauts äöü and euro €.');
    await page.evaluate(() => window.__app.editor.commitInput());
    await page.waitForFunction(() => window.__app.doc.dirty && !window.__app.editor.input);
    await wait(700);
    await page.evaluate(() => window.__app.tools.closeGroup());
    const buf = await saveAs('a-edit.pdf');
    const t = await textOf(await open(buf), 1);
    assert.match(t, /New paragraph from DocPilot with umlauts äöü and euro €/);
    assert.doesNotMatch(t, /first paragraph/);
    assert.match(t, /test document page 1/);
    await closeAll();
  });
  step('Add text and image', async () => {
    await openFile(file('a.pdf'));
    await group('edit'); await page.waitForSelector('.eb');
    await page.click('.lp-item[data-tool="add-text"]');
    await clickAt(0, [300, 300]);
    await page.waitForSelector('.eb-frame .eb-input');
    await page.keyboard.type('Extra text');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line');
    await page.fill('#propbar input[type=number]', '14'); await page.dispatchEvent('#propbar input[type=number]', 'change');
    assert.match(await page.$eval('.eb-input', (e) => e.style.font), /18\.|18px|1[0-9]\.[0-9]+px/, 'size visible immediately');
    await page.click('#propbar .btn.primary');
    await page.waitForFunction(() => window.__app.doc.dirty && !window.__app.editor.input); await wait(500);
    const added = await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.filter((x) => /Extra|Second line$/.test(x.str)).map((x) => ({ s: x.str, x: x.transform[4], y: x.transform[5], h: Math.hypot(x.transform[2], x.transform[3]) })));
    assert.equal(added.length, 2, `two lines: ${JSON.stringify(added)}`);
    assert.ok(Math.abs(added[0].x - 300) < 2 && added[0].y < 300 && added[0].y > 280 && Math.abs(added[0].h - 14) < 0.1, `position and size: ${JSON.stringify(added)}`);
    assert.equal(await page.evaluate(() => window.__app.overlay.tool), 'edit', 'back in edit mode after inserting');
    await page.click('.lp-item[data-tool="add-text"]');
    await clickAt(0, [400, 150]); await page.waitForSelector('.eb-frame .eb-input'); await page.keyboard.press('Escape'); await wait(200);
    assert.equal(await page.$$eval('.eb-frame', (e) => e.length), 0, 'empty field is discarded');
    await page.evaluate(() => window.__app.tools.closeGroup());
    const buf = await saveAs('a-add.pdf');
    assert.match(await textOf(await open(buf), 1), /Extra text/);
    await closeAll();
  });
  step('Fonts like Word: default font, picker, embedding, comments without font choice', async () => {
    const word = require('../electron/fonts.js').wordDefaults();
    await openFile(file('a.pdf'));
    await page.evaluate(() => window.__app.fontsReady);
    const fam = await page.evaluate(() => ({ ...window.__app.editor.newStyle }));
    const installed = await page.evaluate(async (n) => (await window.dp.fonts()).families.some((f) => f.name === n && f.embeddable), word.body);
    if (!installed) word.body = null;
    // New text starts in Word's default font (Normal.dotm), e.g. Aptos 11.
    // (The previous step set the size to 14; like in Word, it is kept for further text.)
    if (word.body) assert.equal(fam.family, word.body, `default font ${JSON.stringify(fam)} instead of ${JSON.stringify(word)}`);
    const reset = await page.evaluate(() => { window.__app.editor.useWordDefault(); return { ...window.__app.editor.newStyle }; });
    if (word.body && word.size) assert.deepEqual([reset.family, reset.size], [word.body, word.size], `Standard ${JSON.stringify(reset)}`);
    await group('edit'); await page.waitForSelector('.eb');
    await page.click('.lp-item[data-tool="add-text"]');
    await clickAt(0, [300, 200]);
    await page.waitForSelector('.eb-frame .eb-input');
    assert.equal(await page.inputValue('#propbar .fp-input'), fam.family, 'font field shows the default font');
    await page.keyboard.type('Default text');
    await page.click('#propbar .btn.primary');
    await page.waitForFunction(() => !window.__app.editor.input); await wait(400);
    // Picker list like in Word: theme fonts, all fonts, typing searches.
    await page.click('.lp-item[data-tool="add-text"]');
    await clickAt(0, [300, 150]);
    await page.waitForSelector('.eb-frame .eb-input');
    await page.click('#propbar .fp-arrow');
    await page.waitForSelector('.fp-pop .fp-item');
    const heads = await page.$$eval('.fp-pop .fp-head', (e) => e.map((x) => x.textContent));
    assert.ok(heads.includes('All Fonts'), `headings: ${heads}`);
    if (word.body) assert.ok(heads.includes('Theme Fonts'), 'theme fonts missing');
    const n = await page.$$eval('.fp-pop .fp-item', (e) => e.length);
    assert.ok(n > 50, `only ${n} fonts`);
    await wait(300);
    const previewed = await page.$$eval('.fp-pop .fp-item .fp-name', (e) => e.filter((x) => /bmp-/.test(x.style.fontFamily)).length);
    assert.ok(previewed > 3 && previewed < n, `preview in own font only for visible entries: ${previewed}/${n}`);
    await page.evaluate(() => document.fonts.ready); await wait(300); await shot('07-font-picker');
    await page.fill('#propbar .fp-input', 'times new');
    await page.waitForFunction(() => document.querySelector('.fp-pop .fp-item.active')?.dataset.font === 'Times New Roman');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__app.editor.input?.o.family === 'Times New Roman');
    assert.match(await page.$eval('.eb-input', (e) => e.style.font), /bmf-/, 'input shows the chosen font');
    await page.focus('.eb-input');
    await page.keyboard.type('Times Text');
    await page.click('#propbar .ib[title="Italic"]'); await wait(200);
    await shot('08-font-input');
    await page.click('#propbar .btn.primary');
    await page.waitForFunction(() => !window.__app.editor.input); await wait(400);
    // An unknown font is rejected, the old one stays.
    await page.click('.lp-item[data-tool="add-text"]');
    await clickAt(0, [300, 100]); await page.waitForSelector('.eb-frame .eb-input');
    await page.fill('#propbar .fp-input', 'Does Not Exist Font'); await page.keyboard.press('Enter'); await wait(200);
    assert.equal(await page.evaluate(() => window.__app.editor.input?.o.family), 'Times New Roman', 'unknown font not applied');
    await page.keyboard.press('Escape'); await page.focus('.eb-input'); await page.keyboard.press('Escape'); await wait(200);
    await page.evaluate(() => window.__app.tools.closeGroup());
    const buf = await saveAs('a-fonts.pdf');
    const t = await textOf(await open(buf), 1);
    assert.match(t, /Default text/); assert.match(t, /Times Text/);
    const d = await PDFDocument.load(buf);
    const fonts = d.getPage(0).node.Resources().lookup(require('@cantoo/pdf-lib').PDFName.of('Font'));
    const bases = fonts.keys().map((k) => String(fonts.lookup(k).lookup(require('@cantoo/pdf-lib').PDFName.of('BaseFont'))));
    assert.ok(bases.some((b) => /TimesNewRoman/.test(b)), `Times embedded: ${bases}`);
    if (word.body) assert.ok(bases.some((b) => b.replace(/[^A-Za-z]/g, '').includes(word.body.replace(/[^A-Za-z]/g, ''))), `${word.body} embedded: ${bases}`);
    // Comments stay in the normal font: no font choice for the text box comment.
    await tool('freetext'); await wait(150);
    assert.equal(await page.$$eval('.fontpick, select[title="Font"]', (e) => e.length), 0, 'Comment without font choice');
    await drag(0, [320, 500], [520, 460]); await page.keyboard.type('Comment'); await page.evaluate(() => document.activeElement.blur()); await wait(150);
    assert.equal(await page.$$eval('.fontpick, select[title="Font"]', (e) => e.length), 0, 'Comment without font choice');
    const ft = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.type === 'freetext'));
    assert.ok(!ft.fontFamily, `comment without own font: ${ft.fontFamily}`);
    await tool('select');
    await closeAll();
  });
  step('Fill in and save form', async () => {
    await openFile(file('a.pdf'));
    await page.waitForSelector('.annotationLayer input');
    await page.fill('.annotationLayer input', 'Fritz Muster');
    await wait(150);
    const buf = await saveAs('a-form.pdf');
    const d = await PDFDocument.load(buf);
    assert.equal(d.getForm().getTextField('vorname').getText(), 'Fritz Muster');
    await closeAll();
  });
  step('Check boxes and radio buttons show their state on the page, also after a click', async () => {
    const d = await PDFDocument.create();
    const pg = d.addPage([595, 842]);
    const form = d.getForm();
    const agree = form.createCheckBox('agree'); agree.addToPage(pg, { x: 72, y: 600, width: 22, height: 22 }); agree.check();
    form.createCheckBox('news').addToPage(pg, { x: 72, y: 560, width: 22, height: 22 });
    const size = form.createRadioGroup('size');
    size.addOptionToPage('S', pg, { x: 72, y: 520, width: 22, height: 22 }); size.addOptionToPage('L', pg, { x: 120, y: 520, width: 22, height: 22 }); size.select('L');
    fs.writeFileSync(file('boxes.pdf'), await d.save());
    await openFile(file('boxes.pdf'));
    await page.waitForSelector('.annotationLayer input[name="news"]'); await wait(300);
    // Share of dark pixels in the middle of a field, measured in a screenshot of the window: what the user really sees.
    const ink = async (name, k = 0) => {
      const box = await page.$$eval(`.annotationLayer input[name="${name}"]`, (l, n) => { const r = l.map((e) => e.closest('section').getBoundingClientRect()).sort((a, b) => a.left - b.left)[n]; return { x: r.left, y: r.top, width: r.width, height: r.height }; }, k);
      const png = await page.screenshot({ clip: { x: box.x + box.width * 0.22, y: box.y + box.height * 0.22, width: box.width * 0.56, height: box.height * 0.56 } });
      return page.evaluate(async (b64) => {
        const bmp = await window.createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new window.OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height).data; let dark = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11 < 110) dark++;
        return dark / (px.length / 4);
      }, png.toString('base64'));
    };
    const shows = async (name, k, on) => { const v = await ink(name, k); assert.ok(on ? v > 0.05 : v < 0.01, `${name}${k ? ` #${k + 1}` : ''} ${on ? 'shows its mark' : 'is empty'} (dark share ${v.toFixed(3)})`); };
    await shows('agree', 0, true); await shows('news', 0, false); await shows('size', 0, false); await shows('size', 1, true);
    await shot('05-check-boxes');
    // A click changes what the page shows.
    await page.click('.annotationLayer input[name="news"]'); await page.click('.annotationLayer input[name="agree"]');
    await page.$$eval('.annotationLayer input[name="size"]', (l) => l.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0].click());
    await wait(200);
    await shows('agree', 0, false); await shows('news', 0, true); await shows('size', 0, true); await shows('size', 1, false);
    // Still right after the page is drawn again (zoom), and saved with the new values.
    await page.evaluate(() => window.__app.viewer.setZoom(1.5)); await rendered(); await page.waitForSelector('.annotationLayer input[name="news"]'); await wait(300);
    await shows('agree', 0, false); await shows('news', 0, true); await shows('size', 0, true);
    const saved = await PDFDocument.load(await saveAs('boxes-saved.pdf'));
    assert.deepEqual([saved.getForm().getCheckBox('agree').isChecked(), saved.getForm().getCheckBox('news').isChecked(), saved.getForm().getRadioGroup('size').getSelected()], [false, true, 'S']);
    await closeAll();
  });
  step('Create form field', async () => {
    await openFile(file('a.pdf'));
    await group('form');
    await page.click('.lp-item[data-tool="form-checkbox"]');
    await drag(0, [300, 300], [320, 280]);
    await dialog({ name: 'zustimmung' });
    await wait(300);
    await page.waitForSelector('.lp-body .res');
    const buf = await saveAs('a-formneu.pdf');
    const d = await PDFDocument.load(buf);
    assert.ok(d.getForm().getCheckBox('zustimmung'));
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
  });
  step('Organize pages: view, rotate, delete, reorder', async () => {
    await openFile(file('a.pdf'));
    await group('organize');
    await page.waitForSelector('.org-grid .thumb canvas');
    await wait(300);
    await shot('07-organize');
    await page.click('.org-grid .thumb[data-page="1"]');
    await page.click('.org-bar .ib[title="Rotate clockwise"]');
    await wait(500);
    assert.equal(await page.evaluate(() => window.__app.doc.pages[1].rotate), 90);
    const from = await page.$('.org-grid .thumb[data-page="3"]'); const to = await page.$('.org-grid .thumb[data-page="0"]');
    await from.dragTo ? await from.dragTo(to).catch(() => {}) : null;
    await page.dragAndDrop('.org-grid .thumb[data-page="3"]', '.org-grid .thumb[data-page="0"]').catch(() => {});
    await wait(700);
    let t = await page.evaluate(async () => { const c = await window.__app.doc.pageText(0); return c.items.map((x) => x.str).join(' '); });
    assert.match(t, /page 4/, 'page moved');
    await page.click('.org-grid .thumb[data-page="1"]');
    await page.click('.org-bar .ib[title="Delete"]');
    await page.waitForSelector('.scrim'); await page.click('.scrim .btn:not(.primary)');
    await wait(600);
    assert.equal(await page.evaluate(() => window.__app.doc.numPages), 3);
    await run('undo'); await wait(600);
    assert.equal(await page.evaluate(() => window.__app.doc.numPages), 4);
    await page.evaluate(() => { window.__app.organizer.hide(); window.__app.tools.closeGroup(); });
    await closeAll();
  });
  step('Watermark, header, Bates via dialog', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.watermark(); });
    await dialog({ text: 'INTERNAL', size: 50 });
    await page.evaluate(() => { window.__app.tools.headerFooter(); });
    await dialog({ center: 'Head {page}' });
    await page.evaluate(() => { window.__app.tools.bates(); });
    await dialog({ prefix: 'X-' });
    await wait(300);
    const buf = await saveAs('a-wm.pdf');
    const t = await textOf(await open(buf), 2);
    assert.match(t, /INTERNAL/); assert.match(t, /Head 2/); assert.match(t, /X-000002/);
    await rendered(); await wait(300); await shot('08-watermark');
    await closeAll();
  });
  step('Header & footer and watermark: update and remove', async () => {
    await openFile(file('a-wm.pdf'));
    await page.evaluate(() => { window.__app.tools.headerFooter(); });
    await choose('Update');
    await page.waitForSelector('.scrim [data-field="center"]');
    assert.equal(await page.inputValue('.scrim [data-field="center"]'), 'Head {page}', 'the dialog opens with the settings of the header');
    await dialog({ center: 'Changed {page}' });
    await page.evaluate(() => { window.__app.tools.watermark(); });
    await choose('Remove'); await idle(); await wait(300);
    const buf = await saveAs('a-wm2.pdf');
    const t = await textOf(await open(buf), 2);
    assert.doesNotMatch(t, /INTERNAL/); assert.doesNotMatch(t, /Head 2/);
    assert.match(t, /Changed 2/); assert.match(t, /X-000002/); assert.match(t, /DocPilot test document page 2/);
    await closeAll();
  });
  step('Redact: content really gone', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.searchRedact(); });
    await dialog({ q: 'Secret' });
    await page.waitForFunction(() => window.__app.doc.allAnnots().length === 4);
    await wait(200); await shot('09-redaction-marked');
    await page.evaluate(() => { window.__app.tools.applyRedactions(); });
    await page.waitForSelector('.scrim'); await page.click('.scrim .btn:not(.primary)');
    await wait(400); await idle(); await wait(400);
    // The report of what was removed.
    await page.waitForSelector('.scrim h3:has-text("Redactions applied")');
    assert.match(await page.textContent('.scrim .b'), /Removed on 4 page\(s\)\. Text: \d+ character/);
    await page.click('.scrim .btn.primary');
    const buf = await saveAs('a-redact.pdf');
    assert.ok(!buf.includes('Secret'), 'word not in raw data');
    const pdf = await open(buf);
    const t = await allText(pdf);
    assert.doesNotMatch(t, /Secret/); assert.match(t, /test document/, 'remaining text stays searchable');
    await rendered(); await wait(200); await shot('10-redacted');
    await closeAll();
  });
  step('Password protection: save, password when opening', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.encryptDialog(); });
    await dialog({ user: 'geheim1', user2: 'geheim1' });
    const buf = await saveAs('a-enc.pdf');
    await assert.rejects(open(buf));
    assert.equal((await open(buf, 'geheim1')).numPages, 4);
    await closeAll();
    await page.evaluate((p) => { window.__app.openPath(p); }, file('a-enc.pdf'));
    await page.waitForSelector('.scrim [data-field="pw"]');
    await field('pw', 'falsch'); await page.click('.scrim [data-ok]');
    await wait(500);
    await page.waitForSelector('.scrim [data-field="pw"]');
    await field('pw', 'geheim1'); await page.click('.scrim [data-ok]');
    await rendered(); await wait(200);
    assert.equal(await page.evaluate(() => window.__app.doc.numPages), 4);
    const re = await saveAs('a-enc2.pdf');
    await assert.rejects(open(re), undefined, 'stays protected');
    await closeAll();
  });
  step('Create digital ID, sign, validate', async () => {
    await openFile(file('a.pdf'));
    await setDialogs({ save: file('id.pfx') });
    await page.evaluate(() => { window.__app.tools.createId(); });
    await dialog({ name: 'Max Muster', password: 'test123', password2: 'test123' });
    await wait(200); await idle();
    assert.ok(fs.existsSync(file('id.pfx')));
    await setDialogs({ save: file('a-sig.pdf'), open: [file('id.pfx')] });
    await page.evaluate(() => { window.__app.tools.digitalSign(null); });
    await dialog({ password: 'test123', reason: 'Test' });
    await page.waitForFunction(() => window.__app.doc?.name === 'a-sig.pdf', null, { timeout: 60000 });
    await rendered(); await page.waitForSelector('.cm .badge');
    assert.match(await page.$eval('.cm .badge', (e) => e.textContent), /Valid/);
    await wait(100); await shot('11-signature');
    // A second signature is appended: the first stays valid and reports the permitted change.
    const first = fs.readFileSync(file('a-sig.pdf'));
    await setDialogs({ save: file('a-sig2.pdf'), open: [file('id.pfx')] });
    await page.evaluate(() => { window.__app.tools.digitalSign(null); });
    await dialog({ password: 'test123', reason: 'Seen' });
    await page.waitForFunction(() => window.__app.doc?.name === 'a-sig2.pdf', null, { timeout: 60000 });
    await rendered(); await page.waitForFunction(() => document.querySelectorAll('.cm[data-sig]').length === 2, null, { timeout: 30000 });
    const second = fs.readFileSync(file('a-sig2.pdf'));
    assert.ok(second.subarray(0, first.length).equals(first), 'the signed file stays as it was, the second signature is appended');
    const badges = await page.$$eval('.cm[data-sig] .badge', (e) => e.map((x) => x.textContent));
    assert.ok(badges.every((b) => /Valid/.test(b)), `both signatures valid: ${badges}`);
    assert.match(await page.$eval('.cm[data-sig="0"] [data-changes]', (e) => e.textContent), /permitted: signatures/);
    // A comment on the signed document is saved by appending as well (Save to the same file).
    // Changing a signed document asks first ("Edit anyway?"): confirm with "Edit".
    await page.evaluate(() => { window.__t = window.__app.overlay.add({ type: 'note', page: 0, rect: [500, 700, 520, 720], contents: 'Checked', color: [1, 0.8, 0] }); });
    await page.waitForSelector('.scrim'); await page.click('.scrim button:has-text("Edit")'); await page.evaluate(() => window.__t);
    await page.evaluate(() => window.__app.save()); await idle();
    await page.waitForFunction(() => !window.__app.doc.dirty, null, { timeout: 30000 }); await wait(300);
    const third = fs.readFileSync(file('a-sig2.pdf'));
    assert.ok(third.length > second.length && third.subarray(0, second.length).equals(second), 'saved incrementally');
    await page.evaluate(() => window.__app.panels.show('signatures')); await wait(300);
    await page.waitForFunction(() => /comments/.test(document.querySelector('.cm[data-sig="1"] [data-changes]')?.textContent || ''), null, { timeout: 30000 });
    assert.ok((await page.$$eval('.cm[data-sig] .badge', (e) => e.map((x) => x.textContent))).every((b) => /Valid/.test(b)));
    await closeAll();
  });
  step('Set up and place signature', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.placeSignature('signature'); });
    await page.waitForSelector('.sign-pad');
    const b = await page.$eval('.sign-pad', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    await page.mouse.move(b[0] + 30, b[1] + 60); await page.mouse.down(); await page.mouse.move(b[0] + 150, b[1] + 100, { steps: 5 }); await page.mouse.move(b[0] + 300, b[1] + 40, { steps: 5 }); await page.mouse.up();
    await page.click('.scrim [data-ok]');
    await page.waitForFunction(() => window.__app.overlay.tool === 'place-stamp');
    await clickAt(0, [300, 200]); await wait(300);
    assert.equal((await page.evaluate(() => window.__app.doc.allAnnots()[0].type)), 'stamp');
    const buf = await saveAs('a-unterschrift.pdf');
    assert.ok(await (await (await open(buf)).getPage(1)).getAnnotations());
    await closeAll();
  });
  step('Exports: Word, Excel, PowerPoint, HTML, RTF, TXT, PNG', async () => {
    await openFile(file('a.pdf'));
    const ex = async (fmt) => { await setDialogs({ save: file(`e.${fmt}`) }); await page.evaluate((x) => window.__app.tools.exportAs(x), fmt); await idle(); await wait(100); return fs.readFileSync(file(`e.${fmt}`)); };
    const dz = await JSZip.loadAsync(await ex('docx'));
    assert.match(await dz.file('word/document.xml').async('string'), /second line contains/);
    const xz = await JSZip.loadAsync(await ex('xlsx'));
    assert.ok(xz.file('xl/worksheets/sheet1.xml')); assert.match(await xz.file('xl/sharedStrings.xml').async('string'), /test document/);
    await setDialogs({ save: file('e.pptx') });
    await page.evaluate(() => { window.__app.tools.exportAs('pptx'); });
    await dialog({ mode: 'edit' });
    await idle(); await wait(200);
    const pz = await JSZip.loadAsync(fs.readFileSync(file('e.pptx')));
    assert.match(await pz.file('ppt/slides/slide1.xml').async('string'), /test document/);
    assert.match((await ex('html')).toString(), /test document/);
    assert.match((await ex('rtf')).toString(), /rtf1/);
    assert.match((await ex('txt')).toString(), /test document/);
    await app.evaluate(({ dialog: d }, x) => { d.showOpenDialog = async () => ({ canceled: false, filePaths: [x] }); }, work);
    await app.evaluate(({ shell }) => { shell.openPath = async () => ''; shell.showItemInFolder = () => {}; });
    await page.evaluate(() => { window.__app.tools.exportAs('png'); });
    await dialog({ dpi: 72 });
    await idle(); await wait(300);
    assert.ok(fs.existsSync(file('a_P001.png')));
    await closeAll();
  });
  step('Create PDF: image, text, Word, combine', async () => {
    fs.writeFileSync(file('t.txt'), 'Content of the text file äöü');
    const b = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 400; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#2d7bc8'; x.fillRect(0, 0, 400, 200); const u = c.toDataURL('image/png').split(',')[1]; return u; });
    fs.writeFileSync(file('b.png'), Buffer.from(b, 'base64'));
    await setDialogs({ open: [file('t.txt')] });
    await page.evaluate(() => window.__app.tools.createFromFile()); await idle(); await rendered();
    assert.match(await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).join('')), /text file/);
    await closeAll();
    await setDialogs({ open: [file('a.pdf'), file('b.png')] });
    await page.evaluate(() => { window.__app.tools.combine(); });
    await page.waitForSelector('.scrim .btn:not(.primary)');
    await page.click('.scrim .b .btn');
    await wait(200);
    await page.click('.scrim [data-ok]');
    await idle(); await rendered();
    assert.equal(await page.evaluate(() => window.__app.doc.numPages), 5);
    await closeAll();
  });
  step('OCR: recognize text on an image page', async () => {
    const b = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1654; c.height = 2339; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000'; x.font = '64px Arial'; x.fillText('Muster Rechnung Nummer 12345', 150, 300); x.fillText('Grüsse aus der Schweiz', 150, 420); return c.toDataURL('image/png').split(',')[1]; });
    fs.writeFileSync(file('scan.png'), Buffer.from(b, 'base64'));
    await setDialogs({ open: [file('scan.png')] });
    await page.evaluate(() => window.__app.tools.createFromFile()); await idle(); await page.waitForFunction(() => window.__app.doc?.name === 'scan.pdf'); await wait(400);
    await page.evaluate(() => { window.__ocr = window.__app.tools.ocr(); });
    await page.waitForSelector('.scrim'); await field('dpi', 200); await page.click('.scrim [data-ok]');
    await page.evaluate(() => window.__ocr);
    await wait(300);
    const buf = await saveAs('scan-ocr.pdf');
    const t = await textOf(await open(buf), 1);
    assert.match(t, /Muster/); assert.match(t, /12345/);
    await closeAll();
  });
  step('Compress, compare, measure, reports', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.compress(); });
    await dialog({ level: 'standard' });
    await page.waitForSelector('.scrim h3:has-text("PDF compressed")');
    assert.match(await page.textContent('.scrim .b'), /Before: .*\nAfter: /s);
    await page.click('.scrim .btn.primary'); await wait(200);
    await page.evaluate(() => { window.__app.doc.dirty = false; });
    await closeAll();
    await openFile(file('a-wm.pdf'));
    await setDialogs({ open: [file('a.pdf')] });
    await page.evaluate(() => { window.__app.tools.compare(); });
    await page.waitForFunction(() => /Comparison complete/.test(document.querySelector('.scrim h3')?.textContent || ''), null, { timeout: 60000 });
    assert.match(await page.$eval('.scrim .b', (e) => e.textContent), /Added words: [1-9]/);
    await shot('12-compare');
    await page.click('.scrim .btn.primary');
    await closeAll();
    await openFile(file('a.pdf'));
    await tool('measure-dist'); await drag(0, [100, 100], [100 + 283.46, 100]); await wait(200);
    const c0 = await page.evaluate(() => window.__app.doc.allAnnots()[0].contents);
    assert.match(c0, /100 mm/);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__app.tools.accessCheck(); }); await page.waitForSelector('.scrim .tbl'); await page.click('.scrim .btn.primary'); await wait(150);
    await page.evaluate(() => { window.__app.tools.preflight(); }); await page.waitForSelector('.scrim .tbl'); await page.click('.scrim .btn.primary'); await wait(150);
    await closeAll();
  });
  step('Sidebars: thumbnails, bookmarks, attachments, layers, search', async () => {
    await openFile(file('a.pdf'));
    await page.click('#right-rail [data-panel="thumbs"]'); await page.waitForSelector('.thumbs .thumb canvas');
    await page.click('#right-rail [data-panel="bookmarks"]'); await wait(200);
    await page.click('#right-panel .rp-head .ib[title="New bookmark"]'); await dialog({ t: 'Chapter One' }); await wait(400);
    await page.waitForSelector('.tree-row .lb');
    await setDialogs({ open: [file('t.txt')] });
    await page.click('#right-rail [data-panel="attachments"]'); await wait(150);
    await page.click('#right-panel .rp-head .ib[title="Attach file"]'); await wait(500);
    await page.waitForSelector('#right-panel .kv');
    await page.click('#right-rail [data-panel="layers"]'); await wait(100);
    await page.click('#right-rail [data-panel="search"]'); await page.fill('#right-panel input[type=search]', 'number'); await page.keyboard.press('Enter'); await page.waitForSelector('#right-panel .res');
    const buf = await saveAs('a-panels.pdf');
    const pdf = await open(buf);
    assert.equal((await pdf.getOutline())[0].title, 'Chapter One');
    assert.ok(await pdf.getAttachments());
    await shot('13-sidebar');
    await closeAll();
  });
  step('Print output (as PDF sample) and properties', async () => {
    await openFile(file('a.pdf'));
    const printers = await page.evaluate(() => window.dp.printers());
    assert.ok(Array.isArray(printers));
    const out = await page.evaluate(async () => {
      const a = window.__app; const { canvas } = await a.viewer.renderToCanvas(0, 100);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const r = await window.dp.print([{ bytes, width: 595, height: 842 }], { toPdf: true, fit: 'fit' });
      return r.pdf.length;
    });
    assert.ok(out > 1000);
    await run('properties');
    await page.waitForSelector('.scrim .tbl');
    await field('title', 'My title'); await page.click('.scrim [data-ok]'); await wait(500);
    assert.equal((await page.evaluate(async () => (await window.__app.doc.pdf.getMetadata()).info.Title)), 'My title');
    await closeAll();
  });
  step('Realistic PDF from Chromium: change and redact text', async () => {
    const html = '<!doctype html><meta charset="utf-8"><body style="font-family:Arial;font-size:14pt"><h1>Offerte Nr. 4711</h1><p>Sehr geehrte Damen und Herren, wir freuen uns über Ihre Anfrage und unterbreiten Ihnen folgendes Angebot für die gewünschten Arbeiten.</p><p>Der Betrag lautet CHF 12&#39;500.00 und ist vertraulich zu behandeln.</p><table border=1><tr><td>Position</td><td>Preis</td></tr><tr><td>Montage</td><td>500.00</td></tr></table>';
    const pdf = await page.evaluate(async (h) => Array.from(await window.dp.htmlToPdf(h)), html);
    fs.writeFileSync(file('c.pdf'), Buffer.from(pdf));
    await openFile(file('c.pdf'));
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const b = await page.evaluate(() => { const list = window.__app.editor.cache.get(0).filter((o) => o.kind === 'text'); return list.map((o) => ({ t: o.text, r: o.rect })); });
    const target = b.find((x) => /Betrag lautet/.test(x.t));
    assert.ok(target, `paragraph not detected: ${JSON.stringify(b.map((x) => x.t))}`);
    await page.mouse.dblclick(...await pagePt(0, target.r[0] + 30, (target.r[1] + target.r[3]) / 2));
    await page.waitForSelector('.eb-input');
    await page.fill('.eb-input', 'Der neue Betrag ist CHF 9000.00 netto.');
    await page.evaluate(() => window.__app.editor.commitInput());
    await page.waitForFunction(() => window.__app.doc.dirty); await wait(900);
    await page.evaluate(() => window.__app.tools.closeGroup());
    let buf = await saveAs('c-edit.pdf');
    let t = await allText(await open(buf));
    assert.match(t, /neue Betrag ist CHF 9000/); assert.doesNotMatch(t, /12.500/); assert.match(t, /Offerte/); assert.match(t, /Montage/);
    await rendered(); await wait(300); await shot('14-chromium-edited');
    await page.evaluate(() => { window.__app.tools.searchRedact(); });
    await dialog({ q: 'Anfrage' });
    await page.waitForFunction(() => window.__app.doc.allAnnots().length >= 1);
    await page.evaluate(() => { window.__app.tools.applyRedactions(); });
    await page.waitForSelector('.scrim'); await page.click('.scrim .btn:not(.primary)');
    await wait(400); await idle(); await wait(500);
    await page.waitForSelector('.scrim h3:has-text("Redactions applied")'); await page.click('.scrim .btn.primary');
    buf = await saveAs('c-redact.pdf');
    t = await allText(await open(buf));
    assert.doesNotMatch(t, /Anfrage/); assert.match(t, /Offerte/);
    await rendered(); await wait(300); await shot('15-chromium-redacted');
    await closeAll();
  });
  step('Edit paragraph: shape, lines and size stay (Calibri)', async () => {
    const html = '<!doctype html><meta charset="utf-8"><body style="font-family:Calibri;font-size:11pt;width:16cm"><p>Sehr geehrte Damen und Herren, wir freuen uns über Ihre Anfrage und unterbreiten Ihnen hiermit gerne folgendes Angebot für die gewünschten Arbeiten an Ihrer Anlage in Zürich.</p>';
    fs.writeFileSync(file('cal.pdf'), Buffer.from(await page.evaluate(async (h) => Array.from(await window.dp.htmlToPdf(h)), html)));
    await openFile(file('cal.pdf'));
    const items = () => page.evaluate(async () => (await window.__app.doc.pageText(0)).items.filter((i) => i.str.trim()).map((i) => ({ s: i.str, y: i.transform[5], x: i.transform[4], h: Math.hypot(i.transform[2], i.transform[3]) })));
    const before = await items();
    assert.equal(before.length, 2, 'two-line paragraph');
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const o = await page.evaluate(() => { const b = window.__app.editor.cache.get(0).find((x) => x.kind === 'text'); return { rect: b.rect, text: b.text }; });
    assert.ok(o.text.includes('\n'), 'line break is kept');
    await page.mouse.dblclick(...await pagePt(0, o.rect[0] + 40, (o.rect[1] + o.rect[3]) / 2));
    await page.waitForSelector('.eb-input');
    const sz = await page.evaluate((r) => { const t = document.querySelector('.eb-input').getBoundingClientRect(); const c = window.__app.viewer.rectToCss(0, r); return { dw: t.width - c.width, dh: t.height - c.height }; }, o.rect);
    assert.ok(Math.abs(sz.dw) < 6 && Math.abs(sz.dh) < 6, `input field aligned: ${JSON.stringify(sz)}`);
    await page.fill('.eb-input', o.text.replace('Anfrage', 'Nachfrage'));
    await page.evaluate(() => window.__app.editor.commitInput());
    await page.waitForFunction(() => window.__app.doc.dirty && !window.__app.editor.input); await wait(900);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.toast.err').length), 0, 'no error');
    const after = await items();
    assert.equal(after.length, 2, 'still two lines');
    for (let k = 0; k < 2; k++) {
      const a = before.sort((p, q) => q.y - p.y)[k]; const b = after.sort((p, q) => q.y - p.y)[k];
      assert.ok(Math.abs(a.y - b.y) < 0.3 && Math.abs(a.x - b.x) < 0.3 && Math.abs(a.h - b.h) < 0.05, `line ${k + 1} unchanged: ${JSON.stringify([a, b])}`);
    }
    assert.match(after.map((x) => x.s).join(' '), /Nachfrage/);
    await page.evaluate(() => window.__app.tools.closeGroup());
    const buf = await saveAs('cal-edit.pdf');
    assert.match(await textOf(await open(buf), 1), /Nachfrage/);
    await closeAll();
  });  step('Move text: preview, no selection, frame while typing', async () => {
    const html = '<!doctype html><meta charset="utf-8"><body style="font-family:Calibri;font-size:11pt;width:16cm"><h2>Offerte Nr. 4711</h2><p>Sehr geehrte Damen und Herren, wir freuen uns über Ihre Anfrage und unterbreiten Ihnen hiermit gerne folgendes Angebot.</p><p>Position eins kostet 500 Franken.</p><p>Freundliche Grüsse</p>';
    fs.writeFileSync(file('mv.pdf'), Buffer.from(await page.evaluate(async (h) => Array.from(await window.dp.htmlToPdf(h)), html)));
    await openFile(file('mv.pdf'));
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const blocks = await page.evaluate(() => window.__app.editor.cache.get(0).filter((b) => b.kind === 'text').map((b) => ({ t: b.text, r: b.rect })));
    const gap = blocks[1].r;
    await drag(0, [gap[0] + 30, gap[1] - 4], [gap[0] + 200, gap[1] - 80]);
    assert.equal(await page.evaluate(() => window.getSelection().toString().length), 0, 'dragging next to a paragraph selects nothing');
    const r = blocks.find((b) => /Position/.test(b.t)).r;
    const [sx, sy] = await pagePt(0, r[0] + 20, (r[1] + r[3]) / 2); const [ex, ey] = await pagePt(0, r[0] + 80, (r[1] + r[3]) / 2 + 40);
    await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(ex, ey, { steps: 10 });
    await page.waitForSelector('.eb.dragging .eb-snap', { timeout: 10000 });
    const snapInk = await page.$eval('.eb.dragging .eb-snap', (c) => { const d2 = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n2 = 0; for (let k = 3; k < d2.length; k += 4) if (d2[k] > 128) n2++; return n2; });
    assert.ok(snapInk > 50, `text follows while dragging: ${snapInk}`);
    await page.mouse.up();
    await page.waitForFunction(() => window.__app.doc.dirty); await wait(1000);
    assert.equal(await page.evaluate(() => window.getSelection().toString().length), 0, 'nothing selected after moving');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.toast.err').length), 0, 'no error');
    let items = await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.filter((x) => x.str.trim()).map((x) => ({ s: x.str, x: x.transform[4], y: x.transform[5] })));
    const pos = items.find((x) => /^Position eins/.test(x.s));
    assert.ok(pos, `text correct (no ligature glyphs): ${JSON.stringify(items.map((x) => x.s))}`);
    assert.ok(Math.abs(pos.x - (r[0] + 60)) < 3, `moved right: ${pos.x}`);
    assert.equal(items.filter((x) => /Position/.test(x.s)).length, 1, 'old position is empty');
    await shot('19-moved');
    // double-click, change text, move by the frame
    await page.waitForSelector('.eb'); await wait(200);
    const b2 = await page.evaluate(() => window.__app.editor.cache.get(0).find((b) => /Grüsse/.test(b.text)).rect);
    await page.mouse.dblclick(...await pagePt(0, b2[0] + 15, (b2[1] + b2[3]) / 2));
    await page.waitForSelector('.eb-frame');
    await page.keyboard.press('End'); await page.keyboard.type(' und bis bald');
    const fb = await page.$eval('.eb-frame', (e) => { const x = e.getBoundingClientRect(); return [x.left + 2, x.top + x.height / 2]; });
    await page.mouse.move(...fb); await page.mouse.down(); await page.mouse.move(fb[0], fb[1] + 60, { steps: 8 }); await page.mouse.up(); await wait(200);
    assert.ok(await page.$('.eb-frame'), 'still in typing mode after dragging the frame');
    assert.equal(await page.evaluate(() => window.getSelection().toString().length), 0, 'dragging the frame selects no text');
    await page.click('#propbar .btn.primary');
    await page.waitForFunction(() => !window.__app.editor.input); await wait(1000);
    items = await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.filter((x) => x.str.trim()).map((x) => ({ s: x.str, y: x.transform[5] })));
    const g = items.find((x) => /Grüsse und bis bald/.test(x.s));
    assert.ok(g, `changed: ${JSON.stringify(items.map((x) => x.s))}`);
    assert.ok(b2[1] - g.y > 25, `moved down: ${b2[1]} -> ${g.y}`);
    await page.evaluate(() => window.__app.tools.closeGroup());
    const buf = await saveAs('mv-edit.pdf');
    const tx = await textOf(await open(buf), 1);
    assert.match(tx, /Position eins kostet/); assert.match(tx, /Grüsse und bis bald/); assert.doesNotMatch(tx, /Ɵ/);
    await closeAll();
  });  step('Rotated page: comment lands in the right place', async () => {
    const r = await PDFDocument.load(fs.readFileSync(file('a.pdf')));
    r.getPage(0).setRotation(require('@cantoo/pdf-lib').degrees(90));
    fs.writeFileSync(file('rot.pdf'), await r.save());
    await openFile(file('rot.pdf'));
    const z0 = await page.evaluate(() => window.__app.viewer.scale);
    await tool('rect'); await drag(0, [300, 300], [400, 400]); await wait(150);
    const a = await page.evaluate(() => window.__app.doc.allAnnots()[0].rect);
    console.log(`         Zoom before/after dragging: ${z0} / ${await page.evaluate(() => window.__app.viewer.scale)}, Panel: ${await page.evaluate(() => window.__app.panels.current)}`);
    assert.deepEqual(a.map((v) => Math.round(v / 5) * 5), [300, 300, 400, 400]);
    await shot('16-rotated');
    await closeAll();
  });
  step('Large document (800 pages) stays responsive', async () => {
    await makeFixture('big.pdf', 800);
    const t0 = Date.now();
    await openFile(file('big.pdf'));
    const opened = Date.now() - t0;
    console.log(`         Open 800 pages: ${opened} ms`);
    assert.ok(opened < 25000, `too slow: ${opened}`);
    await page.evaluate(() => window.__app.viewer.goto(700)); await rendered(700);
    assert.ok(await page.evaluate(() => window.__app.viewer.nodes.filter((n) => n.canvas).length) < 15, 'pages are virtualized');
    await closeAll();
  });
  step('Office files to PDF', async () => {
    for (const n of ['e.docx', 'e.xlsx']) {
      await setDialogs({ open: [file(n)] });
      await page.evaluate(() => window.__app.tools.createFromFile()); await idle(); await rendered(); await wait(200);
      assert.match(await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).join(' ')), /test document/, n);
      await closeAll();
    }
  });
  step('More comment tools and comment exchange', async () => {
    await openFile(file('a.pdf'));
    for (const [t2, y] of [['squiggly', 704], ['strikeout', 686], ['underline', 668]]) { await tool(t2); await drag(0, [74, y], [230, y]); await wait(200); await tool('select'); }
    assert.equal(await count(), 3, 'text markups: ' + JSON.stringify(await page.evaluate(() => ({ types: window.__app.doc.allAnnots().map((a) => a.type), tool: window.__app.overlay.tool, ver: window.__app.viewer.node(0).ver, renders: window.__renders || 0 }))));
    await tool('caret'); await drag(0, [74, 704], [120, 704]); await wait(200); await tool('select');
    await tool('callout'); await drag(0, [320, 330], [520, 280]); await wait(200); await page.keyboard.type('Note'); await page.evaluate(() => document.activeElement.blur()); await wait(150);
    await tool('ellipse'); await drag(0, [320, 540], [480, 440]);
    await tool('line'); await drag(0, [320, 420], [480, 420]);
    await tool('polyline'); await clickAt(0, [100, 200]); await clickAt(0, [160, 240]); await clickAt(0, [220, 200]); await page.evaluate(() => window.__app.overlay.finishPoly()); await wait(100);
    await tool('cloud'); await clickAt(0, [300, 200]); await clickAt(0, [400, 200]); await clickAt(0, [400, 120]); await page.evaluate(() => window.__app.overlay.finishPoly()); await wait(100);
    await tool('ink'); await drag(0, [100, 100], [260, 100]); await wait(100);
    await page.evaluate(() => window.__app.overlay.setTool('select'));
    await clickAt(0, [100, 704]); await wait(100);
    assert.ok(await page.evaluate(() => window.__app.overlay.selected), 'click selects text markup');
    await page.evaluate(() => window.__app.overlay.select(null));
    const n0 = await count();
    await page.evaluate(() => window.__app.overlay.setTool('eraser')); await drag(0, [180, 130], [180, 70]); await wait(100);
    const strokes = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.type === 'ink').strokes.length);
    assert.equal(strokes, 2, 'eraser splits the line');
    await page.evaluate(() => window.__app.overlay.setTool('select'));
    assert.ok(n0 >= 9);
    await shot('17-tools');
    const buf = await saveAs('a-tools.pdf');
    const types = (await (await (await open(buf)).getPage(1)).getAnnotations()).map((a) => a.subtype);
    for (const s of ['Squiggly', 'StrikeOut', 'Underline', 'Caret', 'FreeText', 'Circle', 'Line', 'PolyLine', 'Polygon', 'Ink']) assert.ok(types.includes(s), `${s}: ${types}`);
    await setDialogs({ save: file('k.xfdf') });
    await page.evaluate(() => window.__app.tools.exportXfdf()); await wait(200);
    assert.match(fs.readFileSync(file('k.xfdf'), 'utf8'), /<squiggly /);
    await page.evaluate(() => { window.__app.tools.deleteAllComments(); }); await page.waitForSelector('.scrim'); await page.click('.scrim .btn:not(.primary)'); await wait(200);
    assert.equal(await count(), 0);
    await setDialogs({ open: [file('k.xfdf')] });
    await page.evaluate(() => window.__app.tools.importXfdf()); await wait(300);
    assert.ok(await count() >= 8, 'XFDF loaded');
    await page.evaluate(() => window.__app.tools.commentSummary()); await idle(); await page.waitForFunction(() => /_Comments/.test(window.__app.doc?.name || '')); await wait(300);
    await closeAll();
    await openFile(file('a-tools.pdf'));
    await page.evaluate(() => { window.__app.tools.flattenComments(); }); await page.waitForSelector('.scrim'); await page.click('.scrim .btn:not(.primary)'); await wait(800);
    assert.equal(await count(), 0);
    const fl = await saveAs('a-flat.pdf');
    assert.equal((await (await (await open(fl)).getPage(1)).getAnnotations()).filter((a) => a.subtype !== 'Widget').length, 0);
    await closeAll();
  });
  step('Page and document functions via dialogs', async () => {
    await openFile(file('a.pdf'));
    const T = (fn) => page.evaluate((x) => { window.__t = window.__app.tools[x](); }, fn);
    const done = async () => { await page.evaluate(() => window.__t); await idle(); await wait(250); };
    await T('cropDialog'); await dialog({ top: 5, bottom: 5, left: 5, right: 5 }); await done();
    await T('resizeDialog'); await dialog({ size: '841.89x595.28', range: '2' }); await done();
    assert.ok(await page.evaluate(() => window.__app.doc.pages[1].view[2] > 800), 'Page size');
    await T('pageNumbers'); await dialog({ fmt: 'Page {page}' }); await done();
    await T('background'); await dialog({ color: '#eef5fc', range: '3' }); await done();
    await T('pageLabels'); await dialog({ style: 'R' }); await done();
    assert.equal(await page.evaluate(() => window.__app.doc.label(1)), 'II');
    await T('titleLang'); await dialog({ title: 'My document' }); await done();
    await T('initialView'); await dialog({ layout: 'OneColumn', page: 2 }); await done();
    await T('javascript'); await dialog({ name: 'a', code: 'var x=1;' }); await done();
    await T('sanitize'); await dialog({ attachments: true, comments: false, javascript: true, metadata: false }); await done();
    assert.equal((await page.evaluate(async () => (await window.__app.doc.pdf.getMetadata()).info.Title)), 'My document');
    await page.evaluate(() => window.__app.overlay.setTool('add-link')); await drag(0, [72, 420], [292, 540]);
    await dialog({ url: 'https://example.ch' }); await wait(300);
    await page.evaluate(() => window.__app.overlay.setTool('crop')); await drag(0, [40, 800], [560, 40]);
    await page.waitForSelector('.scrim'); await page.click('.scrim .btn.primary'); await wait(600);
    await page.evaluate(async () => { await window.__app.tools.insertBlankAt(1); }); await wait(300);
    // "Extract pages" asks first (copy only or also delete): confirm the dialog.
    await page.evaluate(() => { window.__t = window.__app.tools.extract([0]); }); await dialog({}); await page.evaluate(() => window.__t).catch(() => {});
    await closeAll();
    await openFile(file('a.pdf'));
    await app.evaluate(({ dialog: d }, x) => { d.showOpenDialog = async () => ({ canceled: false, filePaths: [x] }); }, work);
    await page.evaluate(() => { window.__t = window.__app.tools.split(); }); await dialog({ count: 2 }); await page.evaluate(() => window.__t); await idle(); await wait(200);
    assert.ok(fs.existsSync(file('a_Part1.pdf')) && fs.existsSync(file('a_Part2.pdf')));
    assert.equal((await open(fs.readFileSync(file('a_Part2.pdf')))).numPages, 2);
    await setDialogs({ save: file('a-pdfa.pdf') });
    await page.evaluate(() => { window.__t = window.__app.tools.pdfa(); }); await page.waitForSelector('.scrim'); await page.click('.scrim .btn.primary');
    await page.waitForSelector('.scrim h3:has-text("Save as PDF/A") ~ .b p'); await page.click('.scrim .btn.primary'); await page.evaluate(() => window.__t); await wait(200);
    assert.ok(fs.readFileSync(file('a-pdfa.pdf')).includes('pdfaid') || (await open(fs.readFileSync(file('a-pdfa.pdf')))).numPages === 4);
    await closeAll();
  });
  step('Display modes, rulers, grid, full screen, hand, marquee zoom', async () => {
    await openFile(file('a.pdf'));
    await run('toggle-rulers'); await wait(100); await run('toggle-grid'); await wait(100); await shot('18-rulers');
    await run('toggle-rulers'); await run('toggle-grid');
    await run('reading-mode'); await wait(100); assert.ok(await page.evaluate(() => document.body.classList.contains('reading'))); await page.keyboard.press('Escape'); await wait(100);
    await tool('zoom'); const s0 = await page.evaluate(() => window.__app.viewer.scale); await drag(0, [72, 760], [300, 650]); await wait(400);
    assert.ok(await page.evaluate(() => window.__app.viewer.scale) > s0, 'Marquee zoom');
    await fitPage();
    await tool('hand'); await page.evaluate(() => { window.__app.viewer.setZoom(2); }); await wait(300);
    const st0 = await page.evaluate(() => window.__app.viewer.el.scrollTop);
    const b = await page.$eval('#viewer', (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.mouse.move(...b); await page.mouse.down(); await page.mouse.move(b[0], b[1] - 150, { steps: 4 }); await page.mouse.up(); await wait(100);
    assert.ok(await page.evaluate(() => window.__app.viewer.el.scrollTop) > st0, 'hand scrolls');
    await page.keyboard.press('Escape'); await fitPage();
    await run('speak', 'page'); await wait(100); await run('speak', 'stop');
    await run('goto-page'); await dialog({ p: 3 }); await wait(150); assert.equal(await page.inputValue('#page-controls input'), '3');
    await run('nav-back'); await wait(150); assert.equal(await page.inputValue('#page-controls input'), '1');
    await run('fullscreen'); await wait(500); assert.ok(await page.evaluate(() => document.body.classList.contains('presenting'))); await run('fullscreen'); await wait(500);
    await page.evaluate(async () => { await window.__app.about; }); await run('about'); await page.waitForSelector('.scrim img'); await page.click('.scrim .btn.primary'); await run('shortcuts'); await page.waitForSelector('.scrim .tbl'); await page.click('.scrim .btn.primary');
    await run('preferences'); await page.waitForSelector('.dlg.pref'); await page.click('.pref-cat[data-cat="identity"]'); await page.fill('[data-pref="userName"]', 'Fritz'); await page.click('.dlg.pref [data-ok]'); await wait(200);
    assert.equal(await page.evaluate(() => window.__app.userName()), 'Fritz');
    await page.evaluate(async () => { const a = window.__app; a.settings = { ...a.settings, userName: '' }; await a.saveSettings(); });
    await closeAll();
  });
  step('Preferences: categories, saving, effect', async () => {
    await openFile(file('a.pdf'));
    await run('preferences');
    await page.waitForSelector('.dlg.pref');
    const cats = await page.$$eval('.pref-cat', (e) => e.map((x) => x.textContent));
    for (const c of ['General', 'Identity', 'JavaScript', 'Comment', 'Page Display', 'Trust Manager', 'Convert to PDF', 'Units & Guides', 'Find', 'Read Out Loud']) assert.ok(cats.includes(c), `Kategorie ${c} missing: ${cats}`);
    await page.click('.pref-cat[data-cat="identity"]'); await page.fill('[data-pref="userName"]', 'Erika Muster');
    await page.click('.pref-cat[data-cat="trust"]'); await page.selectOption('[data-pref="links"]', 'block');
    await page.click('.pref-cat[data-cat="search"]'); await page.check('.pref-pane input[type=checkbox] >> nth=0');
    await page.click('.pref-cat[data-cat="convert"]');
    assert.equal(await page.isChecked('.pref-pane input[type=checkbox]'), false, 'macros blocked by default');
    await page.click('.pref-cat[data-cat="js"]');
    assert.equal(await page.isChecked('.pref-pane input[type=checkbox]'), false, 'JavaScript off by default');
    await shot('20-preferences');
    await page.click('.dlg.pref [data-ok]'); await wait(300);
    const s = await page.evaluate(() => window.dp.settingsGet());
    assert.equal(s.userName, 'Erika Muster'); assert.equal(s.links, 'block'); assert.equal(s.searchCase, true);
    assert.equal(await page.evaluate(() => window.__app.find.opts.caseSensitive), true, 'search uses default');
    await app.evaluate(({ shell, dialog: d }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; d.showMessageBox = async () => ({ response: 0 }); });
    assert.equal(await page.evaluate(() => window.dp.openExternal('https://example.ch')), false, 'link blocked');
    assert.equal((await app.evaluate(() => global.__opened)).length, 0);
    await tool('note'); await clickAt(0, [400, 500]); await page.waitForSelector('.note-pop textarea'); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__app.doc.allAnnots()[0].author), 'Erika Muster', 'name from identity');
    await page.evaluate(async () => { const a = window.__app; a.settings = { ...a.settings, userName: '', links: 'ask', searchCase: false }; await a.saveSettings(); a.applySettings(); });
    await closeAll();
  });
  step('Appearance: Light stays light with dark Windows, Dark and Same as Windows take effect immediately', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openFile(file('a.pdf'));
    await tool('note'); await clickAt(0, [400, 500]); await page.waitForSelector('.note-pop textarea');
    const c = await page.$eval('.note-pop textarea', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]);
    assert.equal(c[0], 'rgb(255, 255, 255)', `background ${c[0]}`);
    assert.notEqual(c[1], 'rgb(255, 255, 255)', 'text not white');
    await page.keyboard.press('Escape');
    await page.click('#right-rail [data-panel="comments"]'); await page.waitForSelector('.cm .act input');
    const r = await page.$eval('.cm .act input', (e) => getComputedStyle(e).backgroundColor);
    assert.equal(r, 'rgb(255, 255, 255)', `reply field ${r}`);
    const pc = await page.$eval('#page-controls input', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).borderTopColor, getComputedStyle(e).borderTopWidth]);
    assert.equal(pc[0], 'rgb(255, 255, 255)', `page field ${pc}`);
    assert.notEqual(pc[1], 'rgb(255, 255, 255)', 'page field has a visible border');
    await page.evaluate(() => window.__app.viewer.setZoom(1.22)); await wait(300);
    assert.equal(await page.$eval('#page-controls select', (s) => s.options[s.selectedIndex]?.textContent), '122 %', 'zoom field shows custom zoom');
    await page.evaluate(() => window.__app.viewer.setZoom('page')); await wait(300);
    assert.equal(await page.$eval('#page-controls select', (s) => s.options[s.selectedIndex]?.textContent), 'Fit page');
    await shot('21-dark-mode');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'default "Light" also applies with dark Windows');
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'light');
    await page.keyboard.press('Escape'); await tool('select');
    await page.emulateMedia({ colorScheme: 'light' });

    // --- "Appearance" choice under Preferences > General ---
    // Measures the text color against the background behind it: brightness of the background (0 black, 1 white) and contrast.
    const probe = (sels) => page.evaluate((list) => {
      // Colors come as rgb()/rgba(), mixed colors (color-mix) as color(srgb r g b / a) with values from 0 to 1.
      const parse = (c) => {
        const s = /color\(srgb ([^)]+)\)/.exec(c);
        if (s) { const p = s[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
        const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return [0, 0, 0, 1]; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      };
      const lum = ([r, g, b]) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0.95) return c; } return [255, 255, 255, 1]; };
      return list.map((sel) => { const el = document.querySelector(sel); if (!el) return { sel, missing: true }; const a = lum(parse(getComputedStyle(el).color)); const b = lum(bgOf(el)); return { sel, bg: Math.round(b * 1000) / 1000, contrast: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10 }; });
    }, sels);
    const allDark = async (what, sels, min = 4.5) => { for (const r of await probe(sels)) { assert.ok(!r.missing, `${what}: ${r.sel} vorhanden`); assert.ok(r.bg < 0.12, `${what}: ${r.sel} is dark (brightness ${r.bg})`); assert.ok(r.contrast >= min, `${what}: ${r.sel} is readable (contrast ${r.contrast})`); } };
    const setAppearance = async (v) => {
      await run('preferences'); await page.waitForSelector('.dlg.pref [data-pref="appearance"]');
      await page.selectOption('.dlg.pref [data-pref="appearance"]', v);
      await page.click('.dlg.pref [data-ok]'); await wait(250);
    };
    assert.equal(await page.evaluate(() => window.__app.settings.appearance), 'light', 'default stays Light');
    await run('preferences'); await page.waitForSelector('.dlg.pref [data-pref="appearance"]');
    assert.deepEqual(await page.$$eval('.dlg.pref [data-pref="appearance"] option', (o) => o.map((x) => x.textContent)), ['Light', 'Dark', process.platform === 'darwin' ? 'Same as macOS' : 'Same as Windows']);
    await page.click('.dlg.pref .btn:not(.primary)'); await wait(100);

    // Dark: takes effect immediately, without a restart.
    await setAppearance('dark');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.deepEqual(await app.evaluate(({ nativeTheme }) => [nativeTheme.themeSource, nativeTheme.shouldUseDarkColors]), ['dark', true], 'menu bar and window frame follow');
    assert.equal((await page.evaluate(() => window.dp.settingsGet())).appearance, 'dark', 'gespeichert');
    // Dokumentansicht: Tabs, Werkzeugleiste, Werkzeugfenster, Seitenleiste, Seitensteuerung.
    await group('edit'); await page.waitForSelector('.eb'); await wait(200);
    await allDark('document view', ['#tabs .tab.active', '#tabs .tab:not(.active) .name', '#cmd-search .ph', '#cmd-search kbd', '#doc-toolbar .gb', '#left-panel .lp-head', '#left-panel .lp-item', '#left-panel .lp-sub', '#page-controls input', '#page-controls select', '#page-controls .of', '.cm .au', '.cm .act input']);
    await allDark('icons', ['#right-rail .ib:not(.active)', '#quick-tools .ib:not(.active)', '#left-panel .lp-item .ic'], 3);
    // The page stays white like paper, only the background around the page is dark.
    const paper = await page.evaluate(() => { const n = window.__app.viewer.node(0); const d = n.canvas.getContext('2d').getImageData(6, 6, 1, 1).data; const lumOf = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c)[1].split(/[\s,/]+/).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; }; return { page: getComputedStyle(n.el).backgroundColor, pixel: [d[0], d[1], d[2]], around: lumOf(getComputedStyle(document.querySelector('#viewer-wrap')).backgroundColor) }; });
    assert.equal(paper.page, 'rgb(255, 255, 255)', 'page stays white'); assert.deepEqual(paper.pixel, [255, 255, 255], 'paper in the page image is white');
    assert.ok(paper.around < 0.12, `background around the page is dark: ${paper.around}`);
    // What lies on the page stays light: form field and the frame while editing.
    await page.evaluate(() => window.__app.tools.closeGroup()); await rendered(); await wait(300);
    const onPage = await page.$eval('.annotationLayer input', (e) => { const c = getComputedStyle(e); const n = (x) => /rgba?\(([^)]+)\)/.exec(x)[1].split(/[\s,/]+/).map(Number); return { bg: n(c.backgroundColor), fg: n(c.color) }; });
    assert.ok(onPage.fg[0] < 90 && (onPage.bg[3] === 0 || onPage.bg[0] > 200), `form field on the page stays light with dark text: ${JSON.stringify(onPage)}`);
    // Font picker, find bar, message, context menu.
    await group('edit'); await page.waitForSelector('.eb'); await wait(200);
    await run('find'); await page.waitForSelector('#findbar:not([hidden])');
    await page.evaluate(() => window.__app.find.showReplace(true));
    await allDark('find bar', ['#findbar input[type=text]', '#findbar label', '#findbar .row.rep .btn']);
    await page.evaluate(() => window.__app.find.close());
    const [bx, by] = await pagePt(0, 150, 704);
    await page.mouse.dblclick(bx, by); await page.waitForSelector('.eb-frame .eb-input');
    const edit = await page.$eval('.eb-input', (e) => getComputedStyle(e).backgroundColor);
    assert.equal(edit, 'rgb(255, 255, 255)', 'input field on the page stays white');
    await page.click('#propbar .fp-arrow'); await page.waitForSelector('.fp-pop .fp-item');
    await allDark('font picker', ['#propbar .fp-input', '.fp-pop .fp-head', '.fp-pop .fp-item', '#propbar label']);
    await shot('21-dark-edit');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await wait(150);
    await page.evaluate(() => { window.__app.editor.cancelInput?.(); window.__app.tools.closeGroup(); });
    // Dialogs and messages.
    await run('preferences'); await page.waitForSelector('.dlg.pref');
    await allDark('Preferences', ['.dlg.pref h3', '.pref-cat', '.pref-cat.active', '.pref-lbl span', '.pref-lbl select', '.pref-help', '.dlg .f .btn:not(.primary)']);
    await page.click('.pref-cat[data-cat="identity"]');
    await allDark('input fields', ['.pref-lbl input']);
    await page.click('.pref-cat[data-cat="js"]');
    await allDark('Option', ['.pref-chk span']);
    if (await page.$('.pref-lock')) await allDark('locked option', ['.pref-lock']);
    await shot('21-dark-preferences');
    await page.click('.dlg.pref .btn:not(.primary)'); await wait(100);
    await page.evaluate(() => { window.__app.tools.encryptDialog(); }); await page.waitForSelector('.scrim .fr input');
    await allDark('Dialog', ['.dlg h3', '.fr > span', '.fr input', '.fr select']);
    await page.click('.scrim .btn:not(.primary)'); await wait(100);
    await page.evaluate(() => { window.__app.run('redo'); }); await page.waitForSelector('.toast');
    await allDark('message', ['.toast:not(.ok):not(.err)']);
    // Home page and "All tools".
    await page.evaluate(() => window.__app.showHome()); await wait(500);
    await allDark('home page', ['.home-hero h1', '.home-hero p', '.tool-card b', '.tool-card small', 'h2.sec']);
    await allDark('home page, icon', ['.tool-card .tc-ic'], 3);
    if (await page.$('.recent-card')) await allDark('Recent files', ['.recent-card .rc-name', '.recent-card .rc-meta']);
    await allDark('drop area', ['.drop-zone h1', '.drop-zone p']);
    const [btn] = await probe(['#home-open']); assert.ok(btn.contrast >= 4.5, `text on the accent button is readable: ${btn.contrast}`);
    const logo = await page.$eval('.home-hero img', (e) => getComputedStyle(e).backgroundColor);
    assert.equal(logo, 'rgb(255, 255, 255)', 'logo sits on a light plate');
    await shot('21-dark-home');
    await page.evaluate(() => window.__app.showTools()); await wait(400);
    await allDark('All tools', ['#view-tools .tool-card b', '#view-tools .tool-card small']);
    await page.evaluate(() => window.__app.setView('doc')); await wait(300);

    // Same as Windows: follows the Windows mode, even if it changes while the program is running.
    await setAppearance('system');
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
    await page.emulateMedia({ colorScheme: 'dark' }); await wait(150);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'Same as Windows, Windows dark');
    await page.emulateMedia({ colorScheme: 'light' }); await wait(150);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'Same as Windows, Windows light');
    // Back to light: everything as before, also with dark Windows.
    await page.emulateMedia({ colorScheme: 'dark' });
    await setAppearance('light');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'light');
    const back = await page.$eval('#page-controls input', (e) => getComputedStyle(e).backgroundColor);
    assert.equal(back, 'rgb(255, 255, 255)', 'Light: fields white again');
    assert.equal(await page.$eval('#topbar', (e) => getComputedStyle(e).backgroundColor), 'rgb(233, 235, 238)', 'title bar light again');
    await page.emulateMedia({ colorScheme: null });
    await closeAll();
    // With the document, the note window that belonged to it closes too.
    assert.equal(await page.$('.note-pop'), null, 'no note window stays open after closing');
  });
  step('Title bar: tabs, menu behind ☰ with all entries, search field, shortcuts, window buttons, many tabs', async () => {
    const MAC = process.platform === 'darwin';
    await openFile(file('a.pdf'));
    // The tabs are in the title bar: the window has no frame of its own, and empty parts of the bar move the window.
    assert.deepEqual(await page.$$eval('#topbar #tabs .tab', (l) => l.map((t) => t.dataset.view || 'doc')), ['home', 'tools', 'doc']);
    assert.ok(await page.$('#tabs .tab.active[data-doc]'), 'the document tab is active');
    assert.equal(await page.$eval('#topbar', (e) => getComputedStyle(e).getPropertyValue('-webkit-app-region') || getComputedStyle(e).webkitAppRegion), 'drag');
    if (!MAC) {
      // Windows: room for minimize, maximize and close at the right of the bar.
      const room = await page.evaluate(() => ({ overlay: !!navigator.windowControlsOverlay?.visible, pad: parseFloat(getComputedStyle(document.querySelector('#topbar')).paddingRight), right: document.querySelector('#top-actions').getBoundingClientRect().right }));
      assert.ok(room.overlay && room.pad > 80 && room.right < 1440 - 80, `room for the window buttons: ${JSON.stringify(room)}`);
      // ☰ opens the menu of the menu bar, with all its entries, below the button; F10 and Alt on its own open it too.
      assert.deepEqual(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label)), ['File', 'Edit', 'View', 'E-Sign', 'Window', 'Help']);
      assert.ok(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.some((i) => i.label === 'Save as...' && /Shift\+S/.test(i.accelerator))), 'entries keep their shortcuts');
      await app.evaluate(({ Menu }) => { const m = Menu.getApplicationMenu(); globalThis.__popups = []; m.popup = (o) => globalThis.__popups.push({ x: o.x, y: o.y }); });
      const popups = async (n) => { for (let k = 0; k < 40; k++) { const p = await app.evaluate(() => globalThis.__popups); if (p.length >= n) return p; await wait(50); } return app.evaluate(() => globalThis.__popups); };
      await page.click('#menu-btn');
      const [p1] = await popups(1);
      const btn = await page.$eval('#menu-btn', (b) => { const r = b.getBoundingClientRect(); return { left: r.left, bottom: r.bottom }; });
      assert.ok(p1 && Math.abs(p1.x - btn.left) <= 2 && p1.y >= btn.bottom && p1.y < btn.bottom + 10, `menu below the button: ${JSON.stringify([p1, btn])}`);
      await page.focus('#viewer'); await page.keyboard.press('F10'); assert.equal((await popups(2)).length, 2, 'F10 opens the menu');
      await page.keyboard.press('Alt'); assert.equal((await popups(3)).length, 3, 'Alt on its own opens the menu');
      await page.keyboard.press('Alt+ArrowLeft'); await wait(150); assert.equal((await popups(4)).length, 3, 'Alt with another key does not');
      await app.evaluate(({ Menu }) => { delete Menu.getApplicationMenu().popup; });
    } else assert.equal(await page.$('#menu-btn'), null, 'a Mac keeps its menu bar at the top of the screen');
    // The search field in the middle opens the command search right below it; typing on it starts the search.
    await page.click('#cmd-search'); await page.waitForSelector('.palette [data-palette-input]');
    const [fx, px] = await page.evaluate(() => { const c = (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; }; return [c(document.querySelector('#cmd-search')), c(document.querySelector('.palette'))]; });
    assert.ok(Math.abs(fx - px) < 30, `command search below the field: ${fx} / ${px}`);
    await page.keyboard.press('Escape'); await page.waitForSelector('.palette', { state: 'detached' });
    await page.focus('#cmd-search'); await page.keyboard.press('w');
    await page.waitForSelector('.palette [data-palette-input]');
    assert.equal(await page.$eval('.palette [data-palette-input]', (e) => e.value), 'w');
    await page.keyboard.press('Escape'); await page.waitForSelector('.palette', { state: 'detached' });
    // The menu's shortcuts still work without a menu bar: command search and Preferences. The keys are sent as input
    // of the window (key presses from Playwright never reach the menu's shortcuts, with or without a frame); the
    // shortcuts only act in the active window, and a test window started in the background soon loses that.
    const sendKey = (keyCode, modifiers) => app.evaluate(async ({ BrowserWindow }, [k, m]) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('app://'));
      w.focus(); await new Promise((r) => setTimeout(r, 150));
      for (const type of ['keyDown', 'keyUp']) w.webContents.sendInputEvent({ type, keyCode: k, modifiers: m });
    }, [keyCode, modifiers]);
    const mod = MAC ? 'meta' : 'control';
    await page.focus('#viewer');
    await sendKey('P', [mod, 'shift']); await page.waitForSelector('.palette');
    await page.keyboard.press('Escape'); await page.waitForSelector('.palette', { state: 'detached' });
    await sendKey('K', [mod]); await page.waitForSelector('.dlg.pref');
    await page.click('.dlg.pref .btn:not(.primary)'); await wait(100);
    // With few tabs the search field is in the middle of the window; more tabs push it aside, the tabs stay readable.
    await page.evaluate(() => window.__app.showHome()); await wait(300);
    const mid = await page.$eval('#cmd-search', (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2 - window.innerWidth / 2; });
    assert.ok(Math.abs(mid) < 3, `search field in the middle: ${mid}`);
    for (let k = 1; k <= 7; k++) { fs.copyFileSync(file('a.pdf'), file(`Quarterly report part ${k}.pdf`)); await page.evaluate((x) => window.__app.openPath(x), file(`Quarterly report part ${k}.pdf`)); }
    await rendered(); await wait(300);
    const bar = await page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const tabs = [...document.querySelectorAll('#tabs .tab')]; const s = r(document.querySelector('#cmd-search'));
      const box = r(document.querySelector('#tabs'));
      return { search: [s.left, s.right, s.width], tabsRight: box.right, actions: r(document.querySelector('#top-actions')).left, narrowest: Math.min(...tabs.map((t) => r(t).width)), active: (() => { const a = r(document.querySelector('#tabs .tab.active')); return a.left >= box.left - 1 && a.right <= box.right + 1; })() };
    });
    assert.ok(bar.search[2] >= 180 && bar.search[0] >= bar.tabsRight && bar.search[1] <= bar.actions, `search field between tabs and actions: ${JSON.stringify(bar)}`);
    assert.ok(bar.narrowest >= 60, `tabs stay readable: ${JSON.stringify(bar)}`);
    assert.ok(bar.active, 'the active tab is in view');
    await shot('22-title-bar');
    await closeAll();
  });
  step('Home page: drop area, recent files as pictures of the first page, colored tool tiles', async () => {
    fs.copyFileSync(file('a.pdf'), file('gone.pdf'));
    await closeAll();
    for (const f of ['gone.pdf', 'a.pdf']) await openFile(file(f));
    await closeAll(); fs.rmSync(file('gone.pdf'));
    await page.evaluate(() => window.__app.showHome()); await page.waitForSelector('#home-drop');
    assert.equal(await page.textContent('#home-drop h1'), 'Drop a PDF here or open one');
    // The recent files show a picture of their first page; the card shows the name, the full path only as a tooltip.
    await page.waitForFunction((p) => [...document.querySelectorAll('.recent-card')].some((c) => c.dataset.path === p && c.querySelector('img')?.naturalWidth > 0), file('a.pdf'), { timeout: 30000 });
    const card = await page.$$eval('.recent-card', (l, p) => {
      const c = l.find((x) => x.dataset.path === p); const img = c.querySelector('img');
      // The blue rectangle of the test page (x 72-292, y 420-540 on an A4 page) is in the picture.
      const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; cv.getContext('2d').drawImage(img, 0, 0);
      const [r, g, b] = cv.getContext('2d').getImageData(Math.round(img.naturalWidth * 182 / 595), Math.round(img.naturalHeight * (842 - 480) / 842), 1, 1).data;
      return { title: c.title, text: c.textContent, w: img.naturalWidth, h: img.naturalHeight, first: l[0] === c, blue: b > r + 60 && b > g };
    }, file('a.pdf'));
    assert.equal(card.title, file('a.pdf'), 'the full path is the tooltip');
    assert.ok(card.text.startsWith('a.pdf') && !card.text.includes(path.dirname(file('a.pdf'))), `only the name is shown: ${card.text}`);
    assert.ok(card.first, 'the file opened last comes first');
    assert.ok(card.w >= 300 && card.h > card.w * 1.3, `a picture of the A4 page: ${card.w} x ${card.h}`);
    assert.ok(card.blue, 'the picture shows the page');
    // A file that was moved or deleted is marked; right-click offers Open, Show in Explorer and Remove from list.
    const gone = await page.$$eval('.recent-card', (l, p) => { const c = l.find((x) => x.dataset.path === p); return c && { missing: c.classList.contains('missing'), meta: c.querySelector('.rc-meta').textContent }; }, file('gone.pdf'));
    assert.deepEqual(gone, { missing: true, meta: 'File not found' });
    await page.$$eval('.recent-card', (l, p) => { const c = l.find((x) => x.dataset.path === p); const r = c.getBoundingClientRect(); c.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 })); }, file('gone.pdf'));
    await page.waitForSelector('.ctx');
    assert.deepEqual(await page.$$eval('.ctx button', (l) => l.map((b) => `${b.textContent}${b.disabled ? ' (off)' : ''}`)), ['Open (off)', `${process.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'} (off)`, 'Remove from list']);
    await page.click('.ctx button:has-text("Remove from list")'); await wait(300);
    assert.equal(await page.$$eval('.recent-card', (l, p) => l.some((c) => c.dataset.path === p), file('gone.pdf')), false, 'removed from the list');
    // Files dragged over the window light up the drop area.
    const dragEvent = (type) => page.evaluate((t) => {
      const dt = new window.DataTransfer(); dt.items.add(new window.File(['x'], 'x.pdf', { type: 'application/pdf' }));
      document.body.dispatchEvent(new window.DragEvent(t, { dataTransfer: dt, bubbles: true }));
      return document.body.classList.contains('dragging-files');
    }, type);
    assert.equal(await dragEvent('dragenter'), true); await wait(400);
    assert.equal(await page.$eval('#home-drop', (e) => getComputedStyle(e).borderTopColor), 'rgb(14, 124, 134)', 'drop area lights up while files are dragged');
    assert.equal(await dragEvent('dragleave'), false, 'and goes back when they leave');
    // Colored tool tiles: each tool group has a color of its own.
    const colors = await page.$$eval('#view-home .tool-card .tc-ic', (l) => l.map((e) => getComputedStyle(e).color));
    assert.ok(colors.length >= 8 && new Set(colors).size === colors.length, `one color per tile: ${colors}`);
    assert.equal(await page.$eval('#view-home .tool-card[data-card="edit"] .tc-ic', (e) => getComputedStyle(e).color), 'rgb(214, 51, 108)');
    await shot('23-home');
  });
  step('Tools pane: colored symbols, search while typing, smooth collapse and expand', async () => {
    await closeAll(); await openFile(file('a.pdf'));
    await page.evaluate(() => window.__app.tools.closeGroup());
    // The structure stays: all groups in a list. Every group has a color of its own, its tools show that color too.
    const groups = await page.$$eval('#left-panel .lp-body .lp-item', (l) => l.map((b) => [b.dataset.group, getComputedStyle(b.querySelector('.ic')).color]));
    assert.equal(groups.length, await page.evaluate(() => window.__app.tools.groups.filter((g) => !g.hidden).length));
    assert.deepEqual(groups.slice(0, 2), [['edit', 'rgb(214, 51, 108)'], ['comment', 'rgb(232, 161, 12)']]);
    assert.equal(new Set(groups.map((g) => g[1])).size, groups.length, 'one color per group');
    await group('comment'); await wait(100);
    assert.equal(await page.$eval('#left-panel .lp-item[data-tool="highlight"] .ic', (e) => getComputedStyle(e).color), 'rgb(232, 161, 12)');
    await page.evaluate(() => window.__app.tools.closeGroup());
    // The search field filters while typing: matching groups first, then the matching tools of every group.
    const search = '#left-panel [data-tool-search]';
    const rows = () => page.$$eval('#left-panel .lp-body .lp-item', (l) => l.map((b) => `${b.dataset.group}:${b.dataset.tool || b.dataset.action || ''}`));
    await page.fill(search, 'water');
    assert.deepEqual(await page.$$eval('#left-panel .lp-body .lp-item', (l) => l.map((b) => b.textContent)), ['Watermark...Edit PDF']);
    await page.fill(search, 'sign');
    const signs = await rows();
    assert.ok(signs[0] === 'fillsign:' && signs.includes('certs:digital-sign') && signs.includes('fillsign:Place signature'), `groups first, then tools: ${signs}`);
    await page.fill(search, 'xyzzy');
    assert.match(await page.textContent('#left-panel .lp-body'), /No tool matches/);
    // Enter runs the first tool found; Escape empties the field and all groups are back.
    await page.fill(search, 'reverse pages'); await page.press(search, 'Enter');
    await page.waitForSelector('.scrim'); await page.click('.scrim .btn:not(.primary)'); await wait(150);
    assert.equal(await page.$eval(search, (e) => e.value), '', 'the field is empty again after choosing');
    await page.fill(search, 'stamp'); await page.press(search, 'Escape');
    assert.equal(await page.$eval(search, (e) => e.value), '');
    assert.equal((await rows()).length, groups.length);
    // A tool for the page opens its group with the tool chosen.
    await page.fill(search, 'cloud'); await page.click('#left-panel .lp-item[data-tool="cloud"]'); await wait(150);
    assert.equal(await page.evaluate(() => `${window.__app.tools.group?.id},${window.__app.overlay.tool}`), 'comment,cloud');
    await page.evaluate(() => { window.__app.overlay.setTool('select'); window.__app.tools.closeGroup(); });
    // Collapsing and expanding slide in both directions: halfway the pane is narrower but still there.
    const width = () => page.$eval('#left-panel', (e) => e.getBoundingClientRect().width);
    await run('toggle-left'); await wait(110); const out = await width(); await wait(450);
    assert.ok(out > 5 && out < 257, `halfway while closing: ${out}`);
    assert.deepEqual(await page.$eval('#left-panel', (e) => [e.getBoundingClientRect().width, getComputedStyle(e).visibility]), [0, 'hidden']);
    assert.equal(await page.$eval('#quick-tools', (e) => Math.round(e.getBoundingClientRect().left - e.parentElement.getBoundingClientRect().left)), 12, 'quick tools move along');
    await run('toggle-left'); await wait(110); const back = await width(); await wait(450);
    assert.ok(back > 5 && back < 257, `halfway while opening: ${back}`);
    assert.equal(await width(), 262);
    await shot('24-tools-pane');
    await closeAll();
  });
  step('JavaScript in forms: off blocks, on calculates', async () => {
    const { PDFName, PDFString } = require('@cantoo/pdf-lib');
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    const pg = d.addPage([595, 842]); pg.drawText('Summe', { x: 72, y: 760, size: 14, font: f });
    const form = d.getForm();
    const mk = (n, y) => { const t2 = form.createTextField(n); t2.addToPage(pg, { x: 72, y, width: 120, height: 22, font: f }); return t2; };
    mk('a', 700); mk('b', 660); const sum = mk('summe', 620);
    sum.acroField.dict.set(PDFName.of('AA'), d.context.obj({ C: d.context.obj({ S: 'JavaScript', JS: PDFString.of('event.value = Number(this.getField("a").value) + Number(this.getField("b").value);') }) }));
    form.acroForm.dict.set(PDFName.of('CO'), d.context.obj([sum.acroField.ref]));
    fs.writeFileSync(file('js.pdf'), await d.save());
    await openFile(file('js.pdf'));
    assert.match(await page.$eval('#doc-banner', (e) => (e.hidden ? '' : e.textContent)), /JavaScript/, 'notice when JavaScript is off');
    const fill = async (x, y) => {
      await page.waitForSelector('.annotationLayer input');
      const inputs = await page.$$('.annotationLayer input');
      await inputs[0].click(); await page.keyboard.press('Control+A'); await page.keyboard.type(x); await page.keyboard.press('Tab');
      await page.keyboard.press('Control+A'); await page.keyboard.type(y); await page.keyboard.press('Tab'); await wait(800);
      return page.$$eval('.annotationLayer input', (e) => e.map((v2) => v2.value));
    };
    let v = await fill('2', '3');
    assert.equal(v[2], '', `no calculation without JavaScript: ${v}`);
    const policy = await page.evaluate(() => window.__app.policy);
    if (!policy.allowJavaScript) {
      // Blocked (default in the installed program): option grayed out, nothing turns JavaScript on. The texts name no IT
      // department and no registry key.
      assert.match(await page.$eval('#doc-banner', (e) => e.textContent), /For security reasons it is not run\.$/, 'notice about the block');
      await run('preferences'); await page.waitForSelector('.dlg.pref');
      await page.click('.pref-cat[data-cat="js"]');
      assert.equal(await page.$eval('[data-pref="jsEnabled"]', (e) => e.disabled), true, 'option locked');
      assert.match(await page.$eval('.pref-pane', (e) => e.textContent), /Blocked\. This feature stays off for security reasons\./);
      assert.doesNotMatch(await page.$eval('.dlg.pref', (e) => e.textContent), /\bIT\b|HKLM|Policies/, 'no IT department, no registry key');
      await page.click('.pref-cat[data-cat="convert"]');
      assert.equal(await page.$eval('[data-pref="officeMacros"]', (e) => e.disabled), true, 'macros locked');
      await page.click('.dlg.pref .f .btn:not(.primary)'); await page.waitForSelector('.scrim', { state: 'detached' });
      // Even a manually changed setting does not turn anything on.
      await page.evaluate(async () => { const a = window.__app; a.settings = { ...a.settings, jsEnabled: true }; await a.scripting.detach(); await a.scripting.attach(a.doc); a.viewer.invalidate(); });
      await wait(800); await rendered();
      assert.equal(await page.evaluate(() => window.__app.scripting.active(window.__app.doc)), false, 'scripts stay off');
      v = await fill('4', '6');
      assert.equal(v[2], '', `no calculation despite changed setting: ${v}`);
      await page.evaluate(() => { window.__app.settings.jsEnabled = false; });
      await closeAll();
      return;
    }
    await run('preferences'); await page.waitForSelector('.dlg.pref');
    await page.click('.pref-cat[data-cat="js"]'); await page.check('.pref-pane input[type=checkbox]');
    await page.click('.dlg.pref [data-ok]');
    await page.waitForFunction(() => window.__app.scripting.active(window.__app.doc), null, { timeout: 15000 });
    await wait(800); await rendered();
    v = await fill('4', '6');
    assert.equal(v[2], '10', `calculated with JavaScript: ${v}`);
    assert.ok(await page.$eval('#doc-banner', (e) => e.hidden), 'notice disappears');
    await page.evaluate(async () => { const a = window.__app; a.settings = { ...a.settings, jsEnabled: false }; await a.saveSettings(); await a.scripting.detach(); });
    await closeAll();
  });
  step('Forms without JavaScript: formats, calculations, value ranges, field properties, data exchange', async () => {
    const { PDFName, PDFString } = require('@cantoo/pdf-lib');
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    const pg = d.addPage([595, 842]); pg.drawText('Order', { x: 72, y: 760, size: 14, font: f });
    const form = d.getForm(); const ctx = d.context;
    const js = (s) => ctx.obj({ S: 'JavaScript', JS: PDFString.of(s) });
    const mk = (n, y, aa) => { const t2 = form.createTextField(n); t2.addToPage(pg, { x: 72, y, width: 160, height: 22, font: f }); if (aa) t2.acroField.dict.set(PDFName.of('AA'), ctx.obj(aa)); return t2; };
    const money = 'AFNumber_Format(2, 4, 0, 0, " CHF", false);';
    mk('Qty', 700); mk('Price', 660, { F: js(money), K: js(money.replace('Format', 'Keystroke')) });
    const total = mk('Total', 620, { F: js(money), C: js('AFSimple_Calculate("PRD", new Array("Qty", "Price"));') });
    mk('Discount', 580, { V: js('AFRange_Validate(true, 0, true, 100);') });
    form.acroForm.dict.set(PDFName.of('CO'), ctx.obj([total.acroField.ref]));
    fs.writeFileSync(file('order.pdf'), await d.save());
    await openFile(file('order.pdf'));
    await page.waitForSelector('.annotationLayer input');
    const values = () => page.$$eval('.annotationLayer input', (e) => e.map((v2) => v2.value));
    const inputs = await page.$$('.annotationLayer input');
    await inputs[0].click(); await page.keyboard.type('3'); await page.keyboard.press('Tab');
    await page.keyboard.type("1'250.5"); await page.keyboard.press('Tab');
    // The calculated field shows its plain value while it has the focus, formatted once it loses it.
    assert.equal((await values())[2], '3751.5');
    await page.keyboard.press('Tab'); await wait(500);
    let v = await values();
    assert.deepEqual(v.slice(0, 3), ['3', "1'250.50 CHF", "3'751.50 CHF"], `formatted and calculated without JavaScript: ${v}`);
    // A value out of range is refused with a message.
    await inputs[3].click(); await page.keyboard.type('150'); await page.keyboard.press('Tab');
    await page.waitForSelector('.scrim'); assert.match(await page.textContent('.scrim .b'), /less than or equal to 100/);
    await page.click('.scrim .btn.primary'); await wait(200);
    v = await values();
    assert.equal(v[3], '', 'the value out of range is not kept');
    // Saved: the values, and the appearance shows the formatted amount.
    let buf = await saveAs('order-filled.pdf');
    let out = await PDFDocument.load(buf);
    assert.equal(out.getForm().getTextField('Total').getText(), '3751.5');
    const ap = out.getForm().getTextField('Total').acroField.getWidgets()[0].getNormalAppearance();
    assert.match(Buffer.from(decodePDFRawStream(out.context.lookup(ap)).decode()).toString('latin1'), /3'751\.50 CHF/);
    // Field properties: a percentage format for the discount, written as a standard script.
    await page.evaluate(() => { window.__app.tools.openGroup('form'); });
    await page.evaluate((n) => { window.__app.tools.fieldPropertiesFor(n); }, 'Discount');
    await page.waitForSelector('.scrim [data-field="format"]');
    await page.selectOption('.scrim [data-field="format"]', 'percent');
    await page.fill('.scrim [data-field="decimals"]', '1');
    await ok();
    buf = await saveAs('order-props.pdf');
    out = await PDFDocument.load(buf);
    const aa = out.getForm().getTextField('Discount').acroField.dict.lookup(PDFName.of('AA'));
    const script = (k) => { const a = aa.lookup(PDFName.of(k)); return a ? a.lookup(PDFName.of('JS')).decodeText() : ''; };
    assert.match(script('F'), /AFPercent_Format\(1, 0\)/); assert.match(script('V'), /AFRange_Validate/);
    // Form data as XFDF and back from CSV.
    await setDialogs({ save: file('order.xfdf') });
    await page.evaluate(() => { window.__app.tools.exportForm(); });
    await dialog({ format: 'xfdf' }); await wait(300);
    assert.match(fs.readFileSync(file('order.xfdf'), 'utf8'), /<field name="Total">\s*<value>3751\.5<\/value>/);
    fs.writeFileSync(file('order.csv'), 'Qty,Price\r\n5,10\r\n');
    await setDialogs({ open: [file('order.csv')] });
    await page.evaluate(() => { window.__app.tools.importForm(); }); await idle(); await wait(400);
    buf = await saveAs('order-csv.pdf');
    out = await PDFDocument.load(buf);
    assert.equal(out.getForm().getTextField('Qty').getText(), '5'); assert.equal(out.getForm().getTextField('Price').getText(), '10');
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
  });
  step('Security: only open folders, conversion without internet', async () => {
    // The open function does not start files or programs.
    const msg = await page.evaluate((p) => window.dp.openPath(p), file('a.pdf'));
    assert.match(String(msg), /Only folders/, `file is not opened: ${msg}`);
    // A program is not started either (on a Mac, an app is a folder: Calculator.app).
    const prog = process.platform === 'win32' ? 'C:\\Windows\\System32\\calc.exe' : process.platform === 'darwin' ? '/System/Applications/Calculator.app' : '/usr/bin/env';
    assert.match(String(await page.evaluate((x) => window.dp.openPath(x), prog)), /Only folders/, 'program is not started');
    // HTML conversion loads nothing from the network and runs no JavaScript.
    const http = require('http');
    let hits = 0;
    const srv = http.createServer((_q, r) => { hits++; r.end('x'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const html = `<!doctype html><meta charset="utf-8"><h1>Offline</h1><img src="http://127.0.0.1:${port}/image.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/x.css"><iframe src="http://127.0.0.1:${port}/f"></iframe><script>fetch('http://127.0.0.1:${port}/js'); document.title='JS';</script><meta http-equiv="refresh" content="0;url=http://127.0.0.1:${port}/weiter">`;
    const pdf = await page.evaluate((x) => window.dp.htmlToPdf(x), html);
    await wait(500); srv.close();
    assert.ok(pdf && pdf.length > 500, 'PDF created');
    assert.equal(hits, 0, `no network requests: ${hits}`);
    // Without spaces: on a Mac, the default font sets "fl" as a ligature, which comes back as "Of fl ine".
    assert.match((await textOf(await open(Buffer.from(Object.values(pdf))), 1)).replace(/\s+/g, ''), /Offline/);
  });
  step('Move image over image: only the dragged image moves', async () => {
    const png = async (color) => Buffer.from(await page.evaluate((c) => { const cv = document.createElement('canvas'); cv.width = 100; cv.height = 100; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 100, 100); return cv.toDataURL('image/png').split(',')[1]; }, color), 'base64');
    const d = await PDFDocument.create(); const pg = d.addPage([595, 842]);
    pg.drawImage(await d.embedPng(await png('#2060ff')), { x: 200, y: 500, width: 150, height: 150 });
    pg.drawImage(await d.embedPng(await png('#ff2020')), { x: 60, y: 500, width: 120, height: 120 });
    fs.writeFileSync(file('img.pdf'), await d.save());
    await openFile(file('img.pdf'));
    await group('edit'); await page.waitForSelector('.eb.img'); await wait(300);
    const mv = async (from, to) => {
      const [x0, y0] = await pagePt(0, ...from); const [x1, y1] = await pagePt(0, ...to);
      await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 10 });
      return async () => { await page.mouse.up(); await page.waitForFunction(() => window.__app.doc.dirty); await wait(1000); await page.waitForSelector('.eb.img'); await wait(300); };
    };
    let up = await mv([120, 560], [220, 560]); await up();
    // The red image now lies half over the blue one. Grab it again and drag.
    up = await mv([200, 560], [200, 420]);
    await page.waitForSelector('.eb.dragging.has-preview', { timeout: 15000 });
    const stats = await page.evaluate(() => {
      const count = (cv) => { const d2 = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let red = 0; let blue = 0; for (let k = 0; k < d2.length; k += 4) { if (d2[k + 3] < 128) continue; if (d2[k] > 200 && d2[k + 2] < 80) red++; if (d2[k + 2] > 200 && d2[k] < 80) blue++; } return { red, blue }; };
      return { snap: count(document.querySelector('.eb.dragging .eb-snap')), under: count(document.querySelector('canvas.eb-mask')) };
    });
    await shot('22-image-over-image');
    assert.ok(stats.snap.red > 100, `red image moves along: ${JSON.stringify(stats)}`);
    assert.equal(stats.snap.blue, 0, `blue image does NOT move: ${JSON.stringify(stats)}`);
    assert.ok(stats.under.blue > 100, `blue image stays visible underneath: ${JSON.stringify(stats)}`);
    await up();
    const objs = await page.evaluate(async () => (await window.__app.editor.objects(0)).filter((o) => o.kind === 'image').map((o) => o.rect.map(Math.round)));
    assert.equal(objs.length, 2, 'both images present');
    assert.ok(objs.some((r) => r[0] === 200 && r[1] === 500), `blue image unchanged: ${JSON.stringify(objs)}`);
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
  });
  step('Move text over text: only the dragged text moves', async () => {
    const d = await PDFDocument.create(); const pg = d.addPage([595, 842]); const f = await d.embedFont(StandardFonts.Helvetica);
    pg.drawText('Upper paragraph Alpha', { x: 72, y: 700, size: 14, font: f });
    pg.drawText('Lower paragraph Beta', { x: 72, y: 500, size: 14, font: f });
    fs.writeFileSync(file('tt.pdf'), await d.save());
    await openFile(file('tt.pdf'));
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const mv = async (from, to) => {
      const [x0, y0] = await pagePt(0, ...from); const [x1, y1] = await pagePt(0, ...to);
      await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 10 });
      return async () => {
        await page.evaluate(() => { window.__app.doc.dirty = false; });
        await page.mouse.up(); await page.waitForFunction(() => window.__app.doc.dirty, null, { timeout: 15000 }); await wait(800); await page.waitForSelector('.eb'); await wait(300);
      };
    };
    const pos = async () => page.evaluate(async () => Object.fromEntries((await window.__app.doc.pageText(0)).items.filter((x) => /Alpha|Beta|Gamma|Delta/.test(x.str)).map((x) => [x.str.trim().split(' ').pop(), [Math.round(x.transform[4]), Math.round(x.transform[5])]])));
    const blocks = async () => (await page.evaluate(async () => (await window.__app.editor.objects(0)).filter((o) => o.kind === 'text').map((o) => o.text))).sort();
    const near = (a, b, msg) => assert.ok(a && Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2, `${msg}: ${JSON.stringify(a)} instead of ${JSON.stringify(b)}`);
    // 1. Drag Alpha so that it partly lies on Beta.
    let up = await mv([100, 704], [140, 509]); await up();
    let p = await pos();
    near(p.Alpha, [112, 505], 'Alpha moved'); near(p.Beta, [72, 500], 'Beta stays');
    assert.deepEqual(await blocks(), ['Lower paragraph Beta', 'Upper paragraph Alpha'], 'two separate text blocks');
    // 2. Grab Alpha where only Alpha is and drag it away: Beta stays in place, also in the preview.
    up = await mv([225, 509], [225, 309]);
    await page.waitForSelector('.eb.dragging.has-preview', { timeout: 15000 });
    const dark = await page.evaluate(() => { const c = document.querySelector('canvas.eb-mask'); const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < px.length; k += 4) if (px[k] < 100) n++; return n; });
    assert.ok(dark > 20, `Beta stays visible in place in the preview (${dark})`);
    await up();
    p = await pos();
    near(p.Alpha, [112, 305], 'Alpha moved again'); near(p.Beta, [72, 500], 'Beta stays on the second move');
    // 3. New text directly on Beta, then drag it away. The font of new text is set explicitly: the default
    // (Word's, e.g. the cloud font Aptos) differs from computer to computer, and the new text must stay its own
    // block in any font.
    const fonts = [['Arial', 'Gamma', 200], ['Calibri', 'Delta', -130]];
    const done = [];
    const family0 = await page.evaluate(() => window.__app.editor.newStyle.family);
    for (const [family, word, dy] of fonts) {
      await page.evaluate((f) => { window.__app.editor.newStyle.family = f; }, family);
      await page.click('.lp-item[data-tool="add-text"]');
      await clickAt(0, [150, 512]); await page.waitForSelector('.eb-frame .eb-input');
      await page.keyboard.type(`New ${word}`); await page.click('#propbar .btn.primary');
      await page.waitForFunction(() => !window.__app.editor.input); await wait(800); await page.waitForSelector('.eb'); await wait(300);
      done.push(`New ${word}`);
      assert.deepEqual(await blocks(), ['Lower paragraph Beta', ...done, 'Upper paragraph Alpha'].sort(), `${family}: new text is its own block`);
      const g = (await pos())[word];
      up = await mv([g[0] + 40, g[1] + 4], [g[0] + 40, g[1] + 4 + dy]); await up();
      p = await pos();
      near(p.Beta, [72, 500], `${family}: Beta stays when the new text is moved`); near(p[word], [g[0], g[1] + dy], `${family}: new text moved`);
    }
    await page.evaluate((f) => { window.__app.editor.newStyle.family = f; }, family0);
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
  });
  step('Invoice table: overlapping paragraphs are one block, moved exactly, edited cell by cell; unmapped hyphens', async () => {
    await openFile(await invoiceFixture('invoice.pdf'));
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const TABLE = 'Invoice number INV-0042\nDate of issue November 21, 2026\nDate due November 21, 2026\nVAT Registration Sample VAT: CHE-\n123.456.789 MWST';
    const objs = () => page.evaluate(async () => (await window.__app.editor.objects(0)).filter((o) => o.kind === 'text').map((o) => ({ text: o.text, rect: o.rect, lines: o.lines.map((l) => ({ y: l.y, cells: l.cells.map((c) => ({ text: l.text.slice(c.start, c.end), x: c.x0, bold: c.style.bold, size: c.style.size })) })) })));
    let list = await objs();
    // 1. The dates lie within the paragraph of the labels: one block, no frame within another.
    assert.deepEqual(list.filter((o) => /November/.test(o.text)).map((o) => o.text), [TABLE], 'the table is one block');
    assert.ok(list.some((o) => o.text === 'Example Ltd\nMain Street 1\nCH-1234 Sample Town\nSwitzerland'), `hyphen without a text mapping recognized: ${JSON.stringify(list.map((o) => o.text))}`);
    // 2. Move the table: everything moves along exactly (font, size, columns), nothing stays behind or gets lost.
    const items = () => page.evaluate(async () => (await window.__app.doc.pageText(0)).items.filter((x) => x.str.trim()).map((x) => ({ s: x.str, x: Math.round(x.transform[4] * 100) / 100, y: Math.round(x.transform[5] * 100) / 100, size: Math.round(Math.hypot(x.transform[2], x.transform[3]) * 100) / 100 })));
    const before = await items();
    const [x0, y0] = await pagePt(0, 50, 688); const [x1, y1] = await pagePt(0, 300, 688);
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 10 });
    await page.evaluate(() => { window.__app.doc.dirty = false; });
    await page.mouse.up(); await page.waitForFunction(() => window.__app.doc.dirty, null, { timeout: 15000 }); await wait(800); await page.waitForSelector('.eb'); await wait(300);
    const after = await items();
    for (const w of ['Invoice number', 'Date of issue', 'Date due', 'VAT Registration', '123.456.789 MWST']) {
      const a = before.find((i) => i.s.includes(w)); const b = after.find((i) => i.s.includes(w));
      assert.ok(b && Math.abs(b.x - a.x - 250) < 0.05 && Math.abs(b.y - a.y) < 0.05 && b.size === a.size, `${w} moved exactly: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
    assert.equal(after.filter((i) => i.s.includes('November 21, 2026') && i.x > 300).length, 2, `both dates moved along: ${JSON.stringify(after)}`);
    list = await objs();
    const table = list.find((o) => o.text === TABLE);
    assert.ok(table, `still one block after moving: ${JSON.stringify(list.map((o) => o.text))}`);
    assert.deepEqual(table.lines.map((l) => l.cells.map((c) => c.bold)), [[true, true], [false, false], [false, false], [false, false], [false]], 'only the first row is bold');
    // 3. Change a date: every cell keeps its place, size and weight.
    const [tx, ty] = await pagePt(0, 300, 701);
    await page.mouse.dblclick(tx, ty); await page.waitForSelector('.eb-frame .eb-input');
    assert.equal(await page.$eval('.eb-input', (e) => e.value), TABLE);
    await page.evaluate(() => { const ta = document.querySelector('.eb-input'); ta.value = ta.value.replace('November 21, 2026', 'November 22, 2026'); ta.dispatchEvent(new Event('input')); });
    await page.click('#propbar .btn.primary');
    await page.waitForFunction(() => !window.__app.editor.input); await wait(800); await page.waitForSelector('.eb'); await wait(300);
    list = await objs();
    const edited = list.find((o) => /November 22/.test(o.text));
    assert.equal(edited?.text, TABLE.replace('November 21, 2026', 'November 22, 2026'), `edited table: ${JSON.stringify(list.map((o) => o.text))}`);
    const near = (a, b) => Math.abs(a - b) < 0.05;
    edited.lines.forEach((l, k) => {
      assert.ok(near(l.y, table.lines[k].y), `row ${k + 1} stays on its baseline: ${l.y} / ${table.lines[k].y}`);
      l.cells.forEach((c, j) => assert.ok(near(c.x, table.lines[k].cells[j].x) && near(c.size, 9) && c.bold === table.lines[k].cells[j].bold, `cell "${c.text}" keeps place, size and weight: ${JSON.stringify(c)}`));
    });
    // 4. Change the address: the hyphen stays a hyphen.
    const [ax, ay] = await pagePt(0, 270, 602);
    await page.mouse.dblclick(ax, ay); await page.waitForSelector('.eb-frame .eb-input');
    assert.ok((await page.$eval('.eb-input', (e) => e.value)).includes('CH-1234 Sample Town'), 'hyphen in the input field');
    await page.evaluate(() => { const ta = document.querySelector('.eb-input'); ta.value = ta.value.replace('Main Street 1', 'Main Street 12'); ta.dispatchEvent(new Event('input')); });
    await page.click('#propbar .btn.primary');
    await page.waitForFunction(() => !window.__app.editor.input); await wait(800); await page.waitForSelector('.eb'); await wait(300);
    const text = (await items()).map((i) => i.s).join('|');
    assert.ok(text.includes('Main Street 12') && /CH-1234 Sample Town/.test(text) && !text.includes('CH?'), `address set again with the hyphen: ${text}`);
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
  });
  step('Edit a block set before: nothing disappears, the field shows bold and regular parts as they are set', async () => {
    await openFile(await editedBlockFixture('edited-block.pdf'));
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const BLOCK = 'Contract holder\nName / First name Muster Anna\nStreet Example Road 5\nCustomer no.: 4711';
    const blocks = () => page.evaluate(async () => (await window.__app.editor.objects(0)).filter((o) => o.kind === 'text').map((o) => ({ text: o.text, complex: !!o.complex, bold: o.lines.map((l) => l.parts.map((p) => p.style.bold)) })));
    let list = await blocks();
    // What is left of the old text is no text: it does not split the block (editing a piece used to remove the rest).
    assert.deepEqual(list.map((o) => o.text), [BLOCK], 'one block');
    assert.ok(list[0].complex, 'columns and mixed weights');
    const items = () => page.evaluate(async () => (await window.__app.doc.pageText(0)).items.filter((x) => x.str.trim()).map((x) => ({ s: x.str.trim(), x: x.transform[4], y: x.transform[5] })));
    const before = await items();
    // The input field shows each part in its own weight at its place.
    const runs = () => page.$$eval('.eb-frame .eb-rich .eb-run', (els) => els.map((e) => ({ t: e.textContent.replace(/​/g, ''), w: getComputedStyle(e).fontWeight, x: e.getBoundingClientRect().left })));
    const weights = [['Contract holder', '700'], ['Name / First name ', '700'], ['Muster Anna', '400'], ['Street ', '700'], ['Example Road 5', '400'], ['Customer no.: ', '700'], ['4711', '400']];
    const [vx, vy] = await pagePt(0, 200, 701);
    await page.mouse.dblclick(vx, vy); await page.waitForSelector('.eb-frame .eb-rich'); await wait(400);
    let shown = await runs();
    assert.deepEqual(shown.map((r) => [r.t, r.w]), weights, 'bold labels, regular values');
    const scale = await page.evaluate(() => window.__app.viewer.scale);
    const at = (t) => shown.find((r) => r.t === t).x;
    assert.ok(Math.abs(at('Muster Anna') - at('Name / First name ') - 118 * scale) < 2 && Math.abs(at('Example Road 5') - at('Muster Anna')) < 1, `values in their column: ${JSON.stringify(shown)}`);
    assert.ok(Math.abs(at('4711') - at('Customer no.: ') - (before.find((i) => i.s === '4711').x - 72) * scale) < 2, 'value right after its label');
    await page.keyboard.press('End'); await page.keyboard.type('a');
    let n = await page.evaluate(() => window.__app.doc.undoStack.length);
    await page.click('#propbar .btn.primary');
    await page.waitForFunction((k) => !window.__app.editor.input && window.__app.doc.undoStack.length > k, n, { timeout: 30000 }); await wait(800); await page.waitForSelector('.eb'); await wait(300);
    let after = await items();
    // Every other part stays exactly where it was (copied), the changed value keeps its column and weight.
    for (const w of ['Contract holder', 'Name / First name', 'Muster Anna', 'Street', 'Customer no.:', '4711']) {
      const a = before.find((i) => i.s === w); const b = after.find((i) => i.s === w);
      assert.ok(b && Math.abs(b.x - a.x) < 0.01 && Math.abs(b.y - a.y) < 0.01, `"${w}" stays in place: ${JSON.stringify(after)}`);
    }
    const v = after.find((i) => i.s === 'Example Road 5a');
    assert.ok(v && Math.abs(v.x - 190) < 0.05 && Math.abs(v.y - 698) < 0.05, `value changed in its column: ${JSON.stringify(after)}`);
    list = await blocks();
    assert.deepEqual(list.map((o) => o.text), [BLOCK.replace('Road 5', 'Road 5a')], 'still one block');
    assert.deepEqual(list[0].bold, [[true], [true, false], [true, false], [true, false]], 'weights kept');
    // Again: the field looks like the result. Enter in a value column starts a new line there; the lines below move down.
    const [ax, ay] = await pagePt(0, 230, 712);
    await page.mouse.dblclick(ax, ay); await page.waitForSelector('.eb-frame .eb-rich'); await wait(400);
    shown = await runs();
    assert.deepEqual(shown.map((r) => [r.t, r.w]), weights.map(([t, w]) => [t === 'Example Road 5' ? 'Example Road 5a' : t, w]), 'same parts after setting');
    await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('Second line');
    n = await page.evaluate(() => window.__app.doc.undoStack.length);
    await page.click('#propbar .btn.primary');
    await page.waitForFunction((k) => !window.__app.editor.input && window.__app.doc.undoStack.length > k, n, { timeout: 30000 }); await wait(800); await page.waitForSelector('.eb'); await wait(300);
    after = await items();
    const pos = (s) => after.find((i) => i.s === s);
    assert.ok(Math.abs(pos('Second line')?.x - 190) < 0.05 && Math.abs(pos('Second line')?.y - 698) < 0.05, `new line in the value column: ${JSON.stringify(after)}`);
    assert.ok(Math.abs(pos('Street')?.y - 687) < 0.05 && Math.abs(pos('Customer no.:')?.y - 676) < 0.05 && Math.abs(pos('Muster Anna')?.y - 709) < 0.05, `lines below moved down: ${JSON.stringify(after)}`);
    list = await blocks();
    assert.deepEqual(list[0].bold, [[true], [true, false], [false], [true, false], [true, false]], 'new line in the weight of its column');
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
  });
  step('Scanned invoice: recognize, search and edit text in the image', async () => {
    // Draw an invoice as a PDF and "scan" it as an image (200 dpi, JPEG), like a photo or scan of an invoice.
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold);
    const pg = d.addPage([595, 842]);
    pg.drawText('Muster AG', { x: 60, y: 770, size: 20, font: fb, color: rgb(0.1, 0.3, 0.6) });
    pg.drawText('Rechnung Nr. 2026-0815', { x: 60, y: 720, size: 16, font: fb });
    pg.drawText('Datum: 12.11.2026', { x: 60, y: 698, size: 11, font: f });
    pg.drawRectangle({ x: 60, y: 600, width: 475, height: 22, color: rgb(0.86, 0.86, 0.86) });
    pg.drawText('Position', { x: 66, y: 607, size: 11, font: fb }); pg.drawText('Betrag', { x: 470, y: 607, size: 11, font: fb });
    pg.drawText('Montage Anlage', { x: 66, y: 580, size: 11, font: f }); pg.drawText('CHF 1250.00', { x: 460, y: 580, size: 11, font: f });
    pg.drawText('Service', { x: 66, y: 552, size: 11, font: f }); pg.drawText('CHF 320.00', { x: 466, y: 552, size: 11, font: f });
    for (const y of [574, 546]) pg.drawLine({ start: { x: 60, y }, end: { x: 535, y }, thickness: 0.8, color: rgb(0, 0, 0) });
    pg.drawText('Total CHF 1570.00', { x: 420, y: 515, size: 12, font: fb });
    pg.drawText('Zahlbar innert 30 Tagen', { x: 60, y: 470, size: 11, font: f });
    fs.writeFileSync(file('rechnung-original.pdf'), await d.save());
    await openFile(file('rechnung-original.pdf'));
    const jpg = await page.evaluate(async () => { const { canvas } = await window.__app.viewer.renderToCanvas(0, 200, { noAnnots: true }); const b = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85)); return Array.from(new Uint8Array(await b.arrayBuffer())); });
    fs.writeFileSync(file('rechnung.jpg'), Uint8Array.from(jpg));
    await closeAll();

    // 1. Import the image as a PDF: the text is recognized immediately (preference).
    await setDialogs({ open: [file('rechnung.jpg')] });
    await page.evaluate(() => window.__app.tools.createFromFile());
    await page.waitForFunction(() => window.__app.doc?.name === 'rechnung.pdf');
    await page.evaluate(() => window.__app.doc.scanCheck); await idle(); await wait(300);
    const words = async () => (await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).join(' '))).replace(/\s+/g, ' ');
    let t = await words();
    for (const w of ['Rechnung', '2026-0815', 'Montage', '1250.00', 'Zahlbar', 'Tagen']) assert.ok(t.includes(w), `"${w}" recognized: ${t}`);
    // Searchable like normal text.
    await run('find'); await page.fill('#findbar input[type=text]', '2026-0815');
    await page.waitForFunction(() => /1 of 1|of 1\b/.test(document.querySelector('#findbar .cnt').textContent)); await page.keyboard.press('Escape');

    // 2. Change the amount in the scan: the old digits disappear from the image, the new text is at the same position.
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const blockAt = (re) => page.evaluate(async (src) => { const r = new RegExp(src); const o = (await window.__app.editor.objects(0)).find((x) => x.kind === 'text' && r.test(x.text)); return o ? { text: o.text, rect: o.rect, ocr: !!o.ocr, size: o.size } : null; }, re.source);
    const amount = await blockAt(/1250\.00/);
    assert.ok(amount && amount.ocr, `amount as recognized text: ${JSON.stringify(amount)}`);
    assert.ok(Math.abs(amount.size - 11) < 1.5, `font size similar to the original: ${amount.size}`);
    // Text on a gray table header also gets the right size.
    const head = await blockAt(/^Position$/);
    assert.ok(head && Math.abs(head.size - 11) < 1.5, `table header: ${JSON.stringify(head)}`);
    const [ax, ay] = await pagePt(0, (amount.rect[0] + amount.rect[2]) / 2, (amount.rect[1] + amount.rect[3]) / 2);
    await page.mouse.dblclick(ax, ay); await page.waitForSelector('.eb-frame .eb-input');
    assert.ok(await page.$('#propbar .ocr-tag'), 'notice "Recognized text"');
    await page.keyboard.press('Control+a'); await page.keyboard.type('CHF 1480.00');
    const undoBefore = await page.evaluate(() => window.__app.doc.undoStack.length);
    await page.click('#propbar .btn.primary');
    await page.waitForFunction((n) => !window.__app.editor.input && window.__app.doc.undoStack.length > n, undoBefore, { timeout: 30000 }); await wait(800); await page.waitForSelector('.eb');
    t = await words();
    assert.ok(t.includes('1480.00') && !t.includes('1250.00'), `amount replaced: ${t}`);
    const edited = await blockAt(/1480\.00/);
    assert.ok(edited && !edited.ocr, `new amount is real, visible text: ${JSON.stringify(edited)}`);
    // Check pixels: the table line below the amount stays, the digits of the old amount are removed from the image.
    const ink = (r, lineY) => page.evaluate(([rect, ly]) => {
      const v = window.__app.viewer; const n = v.node(0); const css = v.rectToCss(0, rect); const k = n.canvas.width / n.el.clientWidth;
      const c = n.canvas.getContext('2d'); let dark = 0; let shade = 0;
      const data = c.getImageData(Math.round(css.left * k), Math.round(css.top * k), Math.max(1, Math.round(css.width * k)), Math.max(1, Math.round(css.height * k))).data;
      for (let q = 0; q < data.length; q += 4) { if (data[q] < 110) dark++; if (data[q] < 225) shade++; }
      let line = null;
      // The table line is thin: at some zoom levels it falls on two rows of pixels, each only gray. A removed line
      // would leave white paper, so anything clearly darker than paper counts.
      if (ly !== null) { const p = v.viewport(0).convertToViewportPoint((rect[0] + rect[2]) / 2, ly); const row = c.getImageData(Math.round(p[0] * k) - 20, Math.round(p[1] * k) - 3, 40, 7).data; line = 0; for (let q = 0; q < row.length; q += 4) if (row[q] < 190) line++; }
      return { dark, shade, line };
    }, [r, lineY ?? null]);
    const underLine = await ink(amount.rect, 574);
    assert.ok(underLine.line > 20, `table line below the amount kept: ${JSON.stringify(underLine)}`);

    // 3. Move a paragraph: a clean background remains at the old position, no shadow of the old text.
    const pay = await blockAt(/Zahlbar/);
    assert.ok(pay && pay.ocr, 'payment note as recognized text');
    const before = await ink(pay.rect);
    assert.ok(before.dark > 30, `text visible before: ${JSON.stringify(before)}`);
    const [px0, py0] = await pagePt(0, pay.rect[0] + 20, (pay.rect[1] + pay.rect[3]) / 2); const [px1, py1] = await pagePt(0, pay.rect[0] + 20, (pay.rect[1] + pay.rect[3]) / 2 - 120);
    await page.evaluate(() => { window.__app.doc.dirty = false; });
    await page.mouse.move(px0, py0); await page.mouse.down(); await page.mouse.move(px1, py1, { steps: 10 }); await wait(400); await page.mouse.up();
    await page.waitForFunction(() => window.__app.doc.dirty, null, { timeout: 30000 }); await wait(1200); await page.waitForSelector('.eb'); await rendered(); await wait(300);
    const after = await ink(pay.rect);
    // Also no light shadow (anti-aliased edges, JPEG artifacts): hardly any pixels darker than almost white.
    assert.ok(after.dark === 0 && after.shade <= before.shade * 0.03, `old position clean, no shadow: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    const moved = await blockAt(/Zahlbar/);
    assert.ok(moved && moved.rect[1] < pay.rect[1] - 100, `paragraph moved: ${JSON.stringify(moved)}`);
    await shot('30-invoice-edited');
    await page.evaluate(() => window.__app.tools.closeGroup());
    const buf = await saveAs('rechnung-bearbeitet.pdf');
    const saved = (await textOf(await open(buf), 1)).replace(/\s+/g, ' ');
    assert.ok(saved.includes('1480.00') && saved.includes('Zahlbar') && !saved.includes('1250.00'), `saved: ${saved}`);
    await closeAll();

    // 4. Open a scanned PDF without a text layer: notice with "Recognize text".
    const sd = await PDFDocument.create(); const im = await sd.embedJpg(fs.readFileSync(file('rechnung.jpg'))); sd.addPage([595, 842]).drawImage(im, { x: 0, y: 0, width: 595, height: 842 });
    fs.writeFileSync(file('rechnung-scan.pdf'), await sd.save());
    await openFile(file('rechnung-scan.pdf'));
    await page.evaluate(() => window.__app.doc.scanCheck);
    await page.waitForSelector('#doc-banner:not([hidden]) .btn.primary');
    assert.match(await page.textContent('#doc-banner'), /scanned/);
    await page.click('#doc-banner .btn.primary'); await idle(); await wait(300);
    t = await words();
    assert.ok(t.includes('Rechnung') && t.includes('Zahlbar'), `recognized after click: ${t}`);
    assert.ok(await page.$('#doc-banner[hidden]'), 'notice disappears');
    await closeAll();
  });
  step('Scan in strips (hotel invoice with logos and table): recognize, edit cells individually', async () => {
    // Like a real scan: logos, address, running text, table with dotted lines; slightly skewed, blurry,
    // noisy, as JPEG; like with many scanners, the page is split into horizontal strips.
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold); const tb = await d.embedFont(StandardFonts.TimesRomanBold);
    const pg = d.addPage([595, 842]); const ink = rgb(0.1, 0.16, 0.2);
    pg.drawRectangle({ x: 48, y: 745, width: 40, height: 46, color: ink }); pg.drawSvgPath('M 0 0 L 40 0 L 20 12 Z', { x: 48, y: 745, color: ink });
    pg.drawRectangle({ x: 53, y: 757, width: 30, height: 26, color: rgb(1, 1, 1) });
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) pg.drawRectangle({ x: 55 + c * 5.6, y: 759 + r * 8, width: 3.2, height: 5.5, color: ink });
    pg.drawText('LMK', { x: 100, y: 757, size: 40, font: tb, color: ink });
    pg.drawText('kbx', { x: 395, y: 760, size: 30, font: fb }); pg.drawRectangle({ x: 444, y: 754, width: 1.6, height: 32, color: rgb(0, 0, 0) });
    pg.drawText('Muster Akademie für Weiterbildung', { x: 395, y: 744, size: 9.5, font: f });
    ['Hotel Muster AG', 'Seeweg 12', '1234 Musterhausen'].forEach((t, k) => pg.drawText(t, { x: 60, y: 690 - k * 14, size: 11, font: f }));
    pg.drawText('Rechnung Nr. 48213', { x: 60, y: 625, size: 15, font: fb });
    ['Wir danken Ihnen für Ihren Aufenthalt in unserem Haus und erlauben uns, Ihnen die', 'folgenden Leistungen in Rechnung zu stellen. Bitte überweisen Sie den Betrag innert', 'dreissig Tagen auf das unten angegebene Konto.'].forEach((t, k) => pg.drawText(t, { x: 60, y: 596 - k * 14, size: 11, font: f }));
    const rule = (y) => pg.drawLine({ start: { x: 60, y }, end: { x: 550, y }, thickness: 1, color: rgb(0.25, 0.25, 0.25) });
    const dotted = (y) => [[60, 280], [285, 355], [360, 425], [430, 495], [500, 550]].forEach(([a, b]) => pg.drawLine({ start: { x: a, y }, end: { x: b, y }, thickness: 0.7, dashArray: [0.7, 1.3], color: rgb(0.2, 0.2, 0.2) }));
    const right = (t, x, y, font = f) => pg.drawText(t, { x: x - font.widthOfTextAtSize(t, 11), y, size: 11, font });
    rule(530); pg.drawText('Diese Rechnung enthält die folgenden MWST-Beträge:', { x: 62, y: 510, size: 11, font: f }); rule(486);
    pg.drawText('MWST-Beschreibung', { x: 62, y: 472, size: 11, font: fb }); right('Netto', 352, 472, fb); right('Taxe', 422, 472, fb); right('Brutto', 492, 472, fb); right('Code', 548, 472, fb);
    dotted(466);
    const rows = [['3.8% Zimmer / Verpflegung', '2.31', '0.09', '2.40', '1'], ['0.0% Kurtaxe', '3.00', '0.00', '3.00', '6'], ['8.1% Verpflegung', '156.52', '12.68', '169.20', '16'], ['3.8% Zimmer/Verpflegung', '579.48', '22.02', '601.50', '17'], ['8.1% Weitere Leistungen', '27.75', '2.25', '30.00', '18']];
    rows.forEach((r, k) => { const y = 455 - k * 14; pg.drawText(r[0], { x: 60, y, size: 11, font: f }); right(r[1], 352, y); right(r[2], 422, y); right(r[3], 492, y); right(r[4], 548, y); });
    dotted(393);
    pg.drawText('Total', { x: 62, y: 380, size: 11, font: fb }); right('769.07', 352, 380, fb); right('37.03', 422, 380, fb); right('806.10', 492, 380, fb); rule(372);
    pg.drawText('Bemerkung: Alle Preise verstehen sich in Schweizer Franken.', { x: 60, y: 345, size: 11, font: f });
    fs.writeFileSync(file('hotel-original.pdf'), await d.save());
    await openFile(file('hotel-original.pdf'));
    const scan = await page.evaluate(async () => {
      const { canvas } = await window.__app.viewer.renderToCanvas(0, 200, { noAnnots: true });
      const W = canvas.width; const H = canvas.height;
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.filter = 'grayscale(1) blur(0.55px)';
      x.translate(W / 2, H / 2); x.rotate(0.25 * Math.PI / 180); x.translate(-W / 2, -H / 2); x.drawImage(canvas, 0, 0); x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none';
      const im = x.getImageData(0, 0, W, H); let seed = 7;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let k = 0; k < im.data.length; k += 4) { const n = (rnd() - 0.5) * 26 - 6; for (let j = 0; j < 3; j++) im.data[k + j] = Math.max(0, Math.min(255, im.data[k + j] + n)); }
      x.putImageData(im, 0, 0);
      const parts = []; let y = 0;
      while (y < H) {
        // All strips are narrow (under 3 % of the page): together they still count as the scanned page.
        const h = Math.min(H - y, y < 290 ? 22 : 38 + ((y * 7) % 23));
        const s = document.createElement('canvas'); s.width = W; s.height = h; s.getContext('2d').drawImage(c, 0, y, W, h, 0, 0, W, h);
        const b = await new Promise((r) => s.toBlob(r, 'image/jpeg', 0.7)); parts.push({ y, h, bytes: Array.from(new Uint8Array(await b.arrayBuffer())) }); y += h;
      }
      return { H, parts };
    });
    await closeAll();
    const sd = await PDFDocument.create(); const sp = sd.addPage([595, 842]);
    for (const p of scan.parts) { const im = await sd.embedJpg(Uint8Array.from(p.bytes)); const k = 842 / scan.H; sp.drawImage(im, { x: 0, y: 842 - (p.y + p.h) * k, width: 595, height: p.h * k }); }
    assert.ok(scan.parts.length > 30, 'page consists of many image strips');
    fs.writeFileSync(file('hotel-scan.pdf'), await sd.save());
    await openFile(file('hotel-scan.pdf'));
    await page.evaluate(() => window.__app.doc.scanCheck);
    await page.waitForSelector('#doc-banner:not([hidden]) .btn.primary');
    await page.click('#doc-banner .btn.primary'); await idle(); await wait(300);
    const words = async () => (await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).join(' '))).replace(/\s+/g, ' ');
    for (let k = 0; k < 240 && !(await words()).includes('Rechnung'); k++) await wait(500);
    await idle();
    let t = await words();
    // Running text, address and the whole table without errors, including the line directly below the dotted line.
    for (const w of ['Hotel Muster AG', 'Seeweg 12', '1234 Musterhausen', 'Rechnung Nr. 48213', 'erlauben uns, Ihnen die folgenden Leistungen', 'Konto.', 'MWST-Beträge:', 'MWST-Beschreibung', 'Netto', 'Taxe', 'Brutto', 'Code', '3.8% Zimmer / Verpflegung', '2.31', '0.09', '2.40', '0.0% Kurtaxe', '8.1% Verpflegung', '156.52', '12.68', '169.20', '3.8% Zimmer/Verpflegung', '579.48', '22.02', '601.50', '8.1% Weitere Leistungen', '27.75', '2.25', '30.00', 'Total', '769.07', '37.03', '806.10', 'Schweizer Franken.']) assert.ok(t.includes(w), `"${w}" recognized: ${t}`);
    // No noise text from lines (rows of dots and dashes, single strokes).
    assert.ok(!t.split(' ').some((w) => /^[.\-_–—=|·:]+$/.test(w)), `no remnants of lines: ${t}`);

    await group('edit'); await page.waitForSelector('.eb'); await wait(400);
    const objs = () => page.evaluate(async () => (await window.__app.editor.objects(0)).map((o) => ({ kind: o.kind, text: o.text || '', rect: o.rect, ocr: !!o.ocr, size: o.size, align: o.align || '', locked: !!o.locked })));
    let list = await objs();
    // The image strips are locked: no frames, nothing can be moved by accident.
    assert.ok(list.filter((o) => o.kind === 'image').length > 30 && list.filter((o) => o.kind === 'image').every((o) => o.locked), 'strips are locked');
    assert.equal(await page.$$eval('.edit .eb.img', (e) => e.length), 0, 'no frames around image strips');
    const texts = list.filter((o) => o.kind === 'text').map((o) => o.text);
    // Every table row, every number and every address line is its own block; only the running text is a paragraph.
    for (const w of ['3.8% Zimmer / Verpflegung', '0.0% Kurtaxe', '8.1% Verpflegung', '3.8% Zimmer/Verpflegung', '8.1% Weitere Leistungen', '2.31', '156.52', '579.48', '27.75', '0.09', '22.02', '601.50', 'Hotel Muster AG', 'Seeweg 12', '1234 Musterhausen', 'Total', 'Netto', 'Code']) assert.ok(texts.includes(w), `own block "${w}": ${JSON.stringify(texts)}`);
    assert.equal(texts.filter((x) => x === '3.00').length, 2, 'both "3.00" (net and gross) are separate blocks');
    const prose = list.find((o) => /^Wir danken/.test(o.text));
    assert.ok(prose && !prose.text.includes('\n') && /Konto\.$/.test(prose.text), `running text as one paragraph: ${JSON.stringify(prose && prose.text)}`);
    // Text of the same size gets the same size (11 pt in the original).
    const body = list.filter((o) => o.kind === 'text' && /Kurtaxe|^2\.31$|^Wir danken|^Seeweg|^806\.10$|^Bemerkung/.test(o.text));
    assert.ok(body.length === 6 && body.every((o) => Math.abs(o.size - body[0].size) < 0.05 && Math.abs(o.size - 11) < 0.8), `same size: ${JSON.stringify(body.map((o) => o.size))}`);

    // Double-click on a table row: the input field contains exactly this row (previously the rows ran together).
    // With the comments sidebar open: the page is then wider than the window and scrolled horizontally.
    await page.evaluate(() => window.__app.panels.show('comments')); await wait(300);
    await page.evaluate(() => { window.__app.viewer.setZoom(1.5); }); await wait(400); await rendered();
    await page.evaluate(() => window.__app.viewer.goto(0, { pdfY: 640 })); await wait(500); await rendered(); await page.waitForSelector('.eb'); await wait(400);
    const open = async (re) => {
      const o = (await objs()).find((x) => x.kind === 'text' && re.test(x.text)); assert.ok(o, `block ${re}`);
      const [x, y] = await pagePt(0, o.rect[0] + 4, (o.rect[1] + o.rect[3]) / 2);
      await page.mouse.dblclick(x, y); await page.waitForSelector('.eb-frame .eb-input');
      return o;
    };
    const commit = async () => {
      const n = await page.evaluate(() => window.__app.doc.undoStack.length);
      const [ox, oy] = await pagePt(0, 300, 300); await page.mouse.click(ox, oy);
      await page.waitForFunction((k) => !window.__app.editor.input && window.__app.doc.undoStack.length > k, n, { timeout: 30000 }); await wait(900); await page.waitForSelector('.eb'); await rendered(); await wait(300);
    };
    const undo0 = await page.evaluate(() => window.__app.doc.undoStack.length);
    await open(/Weitere Leistungen/);
    assert.equal(await page.$eval('.eb-frame .eb-input', (e) => e.value), '8.1% Weitere Leistungen');
    await page.keyboard.press('Escape'); await wait(500);
    assert.equal(await page.evaluate(() => window.__app.doc.undoStack.length), undo0, 'viewing changes nothing');

    // Add to the text of a row: the rows above and below stay as they are.
    const rowBefore = (await objs()).filter((o) => /Verpflegung|Leistungen/.test(o.text)).map((o) => [o.text, Math.round(o.rect[1])]);
    await open(/^0\.0% Kurtaxe$/); await page.keyboard.press('End'); await page.keyboard.type(' pro Nacht'); await commit();
    list = await objs();
    assert.ok(list.some((o) => o.text === '0.0% Kurtaxe pro Nacht' && !o.ocr), 'line extended');
    assert.deepEqual(list.filter((o) => /Verpflegung|Leistungen/.test(o.text)).map((o) => [o.text, Math.round(o.rect[1])]), rowBefore, 'other lines unchanged');

    // Change a number in a right-aligned column: the right edge stays in place, the number grows to the left.
    const cell = (await objs()).find((o) => o.text === '3.00' && o.rect[0] < 400);
    assert.equal(cell.align, 'right', 'number column detected as right-aligned');
    assert.equal((await objs()).find((o) => o.text === '0.0% Kurtaxe pro Nacht').align, '', 'text column left-aligned');
    const [nx, ny] = await pagePt(0, (cell.rect[0] + cell.rect[2]) / 2, (cell.rect[1] + cell.rect[3]) / 2);
    await page.mouse.dblclick(nx, ny); await page.waitForSelector('.eb-frame .eb-input');
    await page.keyboard.press('Control+a'); await page.keyboard.type('1215.00'); await commit();
    list = await objs();
    const cell2 = list.find((o) => o.text === '1215.00');
    assert.ok(cell2 && Math.abs(cell2.rect[2] - cell.rect[2]) < 1.2 && cell2.rect[0] < cell.rect[0] - 8, `right edge stays: ${JSON.stringify([cell.rect, cell2 && cell2.rect])}`);
    assert.equal(list.filter((o) => o.text === '3.00').length, 1, 'only the changed number replaced');
    // The old number is removed from the image, even where its row runs through two image strips: to the left of the
    // new number and between the rows nothing dark remains except the new text.
    const dark = (r) => page.evaluate(([rc]) => {
      const v = window.__app.viewer; const n = v.node(0); const css = v.rectToCss(0, rc); const k = n.canvas.width / n.el.clientWidth;
      const dd = n.canvas.getContext('2d').getImageData(Math.round(css.left * k), Math.round(css.top * k), Math.max(1, Math.round(css.width * k)), Math.max(1, Math.round(css.height * k))).data;
      let c = 0; for (let q = 0; q < dd.length; q += 4) if (dd[q] < 110) c++; return c;
    }, [r]);
    assert.ok(await dark(cell2.rect) > 40, 'new number visible');
    assert.equal(await dark([cell2.rect[0] - 14, cell2.rect[1], cell2.rect[0] - 2, cell2.rect[3]]), 0, 'clean to the left of the new number');
    await shot('34-scan-strips-edited');

    // Move a paragraph in the strip scan: only the paragraph moves, no image strip; the old position is clean.
    await page.evaluate(() => window.__app.viewer.goto(0, { pdfY: 790 })); await wait(500); await rendered(); await page.waitForSelector('.eb'); await wait(400);
    const adr = (await objs()).find((o) => o.text === '1234 Musterhausen');
    const imgs0 = JSON.stringify((await objs()).filter((o) => o.kind === 'image').map((o) => o.rect.map(Math.round)));
    const [mx, my] = await pagePt(0, adr.rect[0] + 10, (adr.rect[1] + adr.rect[3]) / 2); const [tx, ty] = await pagePt(0, adr.rect[0] + 150, (adr.rect[1] + adr.rect[3]) / 2);
    const un = await page.evaluate(() => window.__app.doc.undoStack.length);
    await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(tx, ty, { steps: 8 }); await wait(400); await page.mouse.up();
    await page.waitForFunction((k) => window.__app.doc.undoStack.length > k, un, { timeout: 30000 }); await wait(1200); await page.waitForSelector('.eb'); await rendered(); await wait(300);
    list = await objs();
    const adr2 = list.find((o) => o.text === '1234 Musterhausen');
    assert.ok(adr2 && adr2.rect[0] > adr.rect[0] + 120 && Math.abs(adr2.rect[1] - adr.rect[1]) < 2, `paragraph moved: ${JSON.stringify([adr.rect, adr2 && adr2.rect])}`);
    assert.equal(JSON.stringify(list.filter((o) => o.kind === 'image').map((o) => o.rect.map(Math.round))), imgs0, 'no image strip moved');
    assert.equal(await dark([adr.rect[0], adr.rect[1], adr.rect[0] + 60, adr.rect[3]]), 0, 'old position clean');
    assert.ok(list.some((o) => o.text === 'Seeweg 12' && o.ocr), 'line above untouched');
    await page.evaluate(() => window.__app.tools.closeGroup());

    // Recognize again (for scans recognized with an older version): replaces the recognition in one
    // step, text changed by hand stays.
    const u2 = await page.evaluate(() => window.__app.doc.undoStack.length);
    await page.evaluate(() => window.__app.tools.recognizeText([0], { redo: true, silent: true })); await wait(300); await idle();
    for (let k = 0; k < 240 && !(await words()).includes('Schweizer'); k++) await wait(500);
    await idle(); await wait(300);
    assert.equal(await page.evaluate(() => window.__app.doc.undoStack.length), u2 + 1, 'one step for undo');
    t = await words();
    assert.ok(t.includes('1215.00') && t.includes('0.0% Kurtaxe pro Nacht') && t.includes('8.1% Weitere Leistungen') && t.includes('579.48'), `after recognizing again: ${t}`);
    assert.equal((t.match(/Weitere Leistungen/g) || []).length, 1, 'nothing recognized twice');
    await closeAll();
  });
  step('Paste screenshot with Ctrl+V: recognize and edit a list in dark mode', async () => {
    // Screenshot like from a chat in dark mode: heading, list with sub-points, special characters.
    const html = `<div style="background:#1f1e1d;color:#e8e6e3;font-family:'Segoe UI';font-size:15px;line-height:1.55;padding:16px 22px;width:560px"><div style="font-weight:600;margin-bottom:6px">Geprüft</div><ul style="margin:6px 0;padding-left:26px"><li>Testrechnung: Firmenname, Rechnungsnummer, Tabelle mit grauem Kopf und Linien, Beträge.<ul style="list-style:circle;padding-left:24px"><li>Alle Wörter wurden fehlerfrei erkannt.</li><li>Der Betrag liess sich von 1250.00 auf 1480.00 ändern. Die Tabellenlinie darunter blieb erhalten, und die alte Zahl ist auch in der gespeicherten Datei weg.</li></ul></li><li>Schriftgrösse: Sie wird auf etwa ±4 % genau getroffen.</li><li>Tests: Alle 18 Kern-Tests und 44 App-Tests bestehen.</li></ul></div>`;
    const box = await page.evaluate((x) => { const e = document.createElement('div'); e.id = 'shotbox'; e.style.cssText = 'position:fixed;left:0;top:0;z-index:99999'; e.innerHTML = x; document.body.append(e); const r = e.firstChild.getBoundingClientRect(); return { x: r.left, y: r.top, width: Math.ceil(r.width), height: Math.ceil(r.height) }; }, html);
    const png = await page.screenshot({ clip: box });
    await page.evaluate(() => document.getElementById('shotbox').remove());
    await page.evaluate((arr) => window.dp.clipboardWriteImage(Uint8Array.from(arr)), Array.from(png));

    // Without an open document, a new PDF is created from the clipboard.
    await closeAll(); await page.evaluate(() => window.__app.showHome());
    // Do not click: otherwise recently opened files on the home page lie under the mouse.
    await page.evaluate(() => { document.activeElement?.blur(); }); await page.keyboard.press('Control+V');
    await page.waitForFunction(() => window.__app.doc?.name === 'Clipboard.pdf', null, { timeout: 30000 });
    await page.evaluate(() => window.__app.doc.scanCheck); await idle();
    await closeAll();

    // Paste onto a letter page: the image is placed on the page and its text is recognized (also over hidden text).
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    const pg = d.addPage([595, 842]); pg.drawText('Briefkopf Muster AG', { x: 70, y: 760, size: 14, font: f }); pg.drawText('Verdeckter Text', { x: 200, y: 420, size: 12, font: f });
    fs.writeFileSync(file('brief.pdf'), await d.save());
    await openFile(file('brief.pdf'));
    const [cx, cy] = await pagePt(0, 300, 600); await page.mouse.click(cx, cy);
    await page.keyboard.press('Control+V');
    await page.waitForFunction(() => window.__app.doc.undoStack.length > 0, null, { timeout: 30000 }); await idle(); await wait(500);
    // Wait until text recognition has finished (waitForFunction does not wait for async checks).
    for (let k = 0; ; k++) {
      if (await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.some((x) => /Geprüft/.test(x.str)))) break;
      if (k > 240) throw new Error('text recognition not finished after pasting');
      await wait(500);
    }
    await idle(); await wait(300);
    const t = (await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).join(' '))).replace(/\s+/g, ' ');
    for (const w of ['Geprüft', 'Beträge.', 'Schriftgrösse:', '±4 %', 'Kern-Tests', '1480.00', 'gespeicherten', 'Briefkopf']) assert.ok(t.includes(w), `"${w}" recognized: ${t}`);
    assert.equal((t.match(/•/g) || []).length, 3, `three bullet points: ${t}`);
    assert.equal((t.match(/◦/g) || []).length, 2, `two sub-points: ${t}`);

    // Edit: each point is its own paragraph, in the recognized font, bullets separate.
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const blocks = await page.evaluate(async () => (await window.__app.editor.objects(0)).filter((o) => o.kind === 'text' && o.ocr).map((o) => ({ text: o.text, rect: o.rect, family: o.family, bold: o.bold, size: o.size })));
    const find = (re) => blocks.find((b) => re.test(b.text));
    assert.deepEqual(blocks.filter((b) => /^[•◦]$/.test(b.text)).length, 5, `bullets as separate blocks: ${JSON.stringify(blocks.map((b) => b.text))}`);
    const head = find(/^Geprüft$/); assert.ok(head && head.bold, `heading bold: ${JSON.stringify(head)}`);
    const para = find(/^Der Betrag/);
    assert.ok(para && para.family === 'Segoe UI' && /Datei weg\.$/.test(para.text) && !para.text.includes('\n'), `wrapped paragraph as running text in Segoe UI: ${JSON.stringify(para || blocks.map((b) => [b.family, b.text]))}`);
    assert.ok(Math.abs(para.size - 11.25) < 0.8, `size as in the image (15 px = 11.25 pt): ${para.size}`);
    const [ax, ay] = await pagePt(0, para.rect[0] + 30, (para.rect[1] + para.rect[3]) / 2);
    await page.mouse.dblclick(ax, ay); await page.waitForSelector('.eb-frame .eb-input');
    await page.keyboard.press('Control+End'); await page.keyboard.type(' Neu dazu.');
    const undo = await page.evaluate(() => window.__app.doc.undoStack.length);
    await page.click('#propbar .btn.primary');
    await page.waitForFunction((n) => !window.__app.editor.input && window.__app.doc.undoStack.length > n, undo, { timeout: 30000 }); await wait(800); await page.waitForSelector('.eb');
    const after = (await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).join(' '))).replace(/\s+/g, ' ');
    assert.ok(/Datei weg\. Neu dazu\./.test(after) && after.includes('Beträge.') && (after.match(/•/g) || []).length === 3, `changed, rest unchanged: ${after}`);
    const edited = await page.evaluate(async () => (await window.__app.editor.objects(0)).find((o) => o.kind === 'text' && /Neu dazu/.test(o.text)));
    assert.ok(edited && edited.family === 'Segoe UI' && Math.abs(edited.rect[0] - para.rect[0]) < 1, `set again in Segoe UI at the same position: ${JSON.stringify(edited && { f: edited.family, r: edited.rect })}`);
    await shot('31-screenshot-pasted');

    // Enter in a point in the middle of the screenshot: the new line gets room, everything below moves down
    // (instead of being covered), and the image gets taller.
    const objsNow = () => page.evaluate(async () => (await window.__app.editor.objects(0)).map((o) => ({ kind: o.kind, text: o.text || '', rect: o.rect, ocr: !!o.ocr, size: o.size })));
    const typeIn = async (re, keys) => {
      const b = (await objsNow()).find((o) => o.kind === 'text' && re.test(o.text));
      assert.ok(b, `paragraph ${re} present`);
      const [x, y] = await pagePt(0, b.rect[0] + 15, b.rect[3] - b.size * 0.5);
      await page.mouse.dblclick(x, y); await page.waitForSelector('.eb-frame .eb-input');
      for (const k of keys) { if (k.startsWith('#')) await page.keyboard.press(k.slice(1)); else await page.keyboard.type(k); }
      const n = await page.evaluate(() => window.__app.doc.undoStack.length);
      // Finish with a click next to the text, like a user.
      const [ox, oy] = await pagePt(0, 520, 800); await page.mouse.click(ox, oy);
      await page.waitForFunction((k) => !window.__app.editor.input && window.__app.doc.undoStack.length > k, n, { timeout: 30000 }); await wait(800); await page.waitForSelector('.eb');
    };
    let before = await objsNow();
    const imgBefore = before.find((o) => o.kind === 'image');
    const nextBefore = before.find((o) => /^Schriftgrösse/.test(o.text));
    await typeIn(/^Alle Wörter/, ['#End', '#Enter', 'Mitte neu']);
    let now = await objsNow();
    const nextNow = now.find((o) => /^Schriftgrösse/.test(o.text));
    const imgNow = now.find((o) => o.kind === 'image');
    const pitch = nextBefore.size * 1.2;
    assert.ok(nextNow && nextNow.ocr && nextBefore.rect[3] - nextNow.rect[3] > pitch * 0.8 && nextBefore.rect[3] - nextNow.rect[3] < pitch * 2.2, `next point moves down one line: before ${nextBefore.rect[3]}, after ${nextNow && nextNow.rect[3]}`);
    assert.ok(Math.abs(imgNow.rect[3] - imgBefore.rect[3]) < 0.5 && imgBefore.rect[1] - imgNow.rect[1] > pitch * 0.8, `image grows downwards: ${JSON.stringify([imgBefore.rect, imgNow.rect])}`);
    const mid = now.find((o) => /Mitte neu$/.test(o.text));
    assert.ok(mid && mid.rect[1] > nextNow.rect[3] - 1, `new line above the next point, not on it: ${JSON.stringify([mid && mid.rect, nextNow.rect])}`);
    const t2 = (await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).join(' '))).replace(/\s+/g, ' ');
    assert.ok(t2.includes('Mitte neu') && t2.includes('Schriftgrösse:') && (t2.match(/•/g) || []).length === 3, `text complete: ${t2}`);

    // Keep writing below the last point: the text is visible (light text on the image's background,
    // not invisible on white paper) and lies in the extended image.
    await typeIn(/^Tests:/, ['#End', '#Enter', 'Ganz unten neu', '#Enter']);
    now = await objsNow();
    const low = now.find((o) => /Ganz unten neu$/.test(o.text)); const imgLow = now.find((o) => o.kind === 'image');
    assert.ok(low && !/\n$/.test(low.text) && low.rect[1] > imgLow.rect[1] - 0.5, `new line in the extended image: ${JSON.stringify([low && low.rect, imgLow.rect])}`);
    const ink = await page.evaluate(([r]) => {
      const v = window.__app.viewer; const n = v.node(0); const css = v.rectToCss(0, r); const k = n.canvas.width / n.el.clientWidth;
      const d = n.canvas.getContext('2d').getImageData(Math.round(css.left * k), Math.round(css.top * k), Math.max(1, Math.round(css.width * k)), Math.max(1, Math.round(css.height * k))).data;
      let light = 0; let dark = 0; for (let q = 0; q < d.length; q += 4) { const l = d[q] * 0.3 + d[q + 1] * 0.59 + d[q + 2] * 0.11; if (l > 150) light++; if (l < 60) dark++; }
      return { light, dark, all: d.length / 4 };
    }, [[low.rect[0], low.rect[1], Math.min(low.rect[2], low.rect[0] + 60), low.rect[1] + (low.rect[3] - low.rect[1]) / Math.max(1, low.text.split('\n').length)]]);
    assert.ok(ink.light > 20 && ink.dark > ink.all * 0.5, `light text visible on dark background: ${JSON.stringify(ink)}`);
    await shot('32-screenshot-continued');

    // Move the image by clicking on its text: the whole image moves together with its text. After release
    // it does not jump back (the frame is only replaced after the page is redrawn) and stays selected.
    before = await objsNow();
    const img0 = before.find((o) => o.kind === 'image'); const head0 = before.find((o) => o.text === 'Geprüft');
    const grip = before.find((o) => /^Schriftgrösse/.test(o.text));
    const [gx, gy] = await pagePt(0, grip.rect[0] + 20, (grip.rect[1] + grip.rect[3]) / 2);
    await page.evaluate(() => {
      // Observer: is the editing layer replaced while the old page is still drawn? Then the image would
      // briefly be visible at the old position.
      const n = window.__app.viewer.node(0); const layer = [...n.el.children].find((c) => c.classList.contains('edit'));
      window.__jump = { canvas: n.canvas, bad: 0, armed: false };
      const ob = new window.MutationObserver(() => { const j = window.__jump; if (j.armed && !layer.querySelector('.dragging') && n.canvas === j.canvas) j.bad++; });
      ob.observe(layer, { childList: true }); window.__jump.ob = ob;
    });
    await page.mouse.move(gx, gy); await page.mouse.down();
    for (let k = 1; k <= 8; k++) { await page.mouse.move(gx + 6 * k, gy + 12 * k); await wait(25); }
    await wait(300);
    await page.evaluate(() => { window.__jump.armed = true; });
    await page.mouse.up();
    await page.waitForFunction(() => window.__app.editor.selected?.o?.kind === 'image', null, { timeout: 30000 }); await wait(300);
    const jump = await page.evaluate(() => { window.__jump.ob.disconnect(); return window.__jump.bad; });
    assert.equal(jump, 0, 'Image does not jump back to the old position after release');
    now = await objsNow();
    const img1 = now.find((o) => o.kind === 'image'); const head1 = now.find((o) => o.text === 'Geprüft');
    const ddx = img1.rect[0] - img0.rect[0]; const ddy = img1.rect[1] - img0.rect[1];
    assert.ok(ddx > 20 && ddy < -40, `whole image moved: ${JSON.stringify([img0.rect, img1.rect])}`);
    assert.ok(head1 && head1.ocr && Math.abs(head1.rect[0] - head0.rect[0] - ddx) < 1 && Math.abs(head1.rect[1] - head0.rect[1] - ddy) < 1, `recognized text moves along: ${JSON.stringify([head0.rect, head1 && head1.rect])}`);
    assert.ok(now.filter((o) => o.kind === 'text' && o.ocr).length === before.filter((o) => o.kind === 'text' && o.ocr).length, 'no paragraph torn out of the image');
    // The text of the letter itself (including the part hidden by the image) stays where it is.
    for (const o of before.filter((x) => x.kind === 'text' && !/^(Briefkopf Muster AG|Verdeckter Text)$/.test(x.text))) {
      // The same text occurs several times (bullets): search at the expected position.
      const m = now.find((x) => x.text === o.text && Math.abs(x.rect[0] - o.rect[0] - ddx) < 1 && Math.abs(x.rect[1] - o.rect[1] - ddy) < 1);
      assert.ok(m, `"${o.text.slice(0, 20)}" moves along: ${JSON.stringify(o.rect)} + ${ddx.toFixed(1)}/${ddy.toFixed(1)}, found: ${JSON.stringify(now.filter((x) => x.text === o.text).map((x) => x.rect))}`);
    }
    for (const fixed of ['Briefkopf Muster AG', 'Verdeckter Text']) {
      const a = before.find((x) => x.text === fixed); const b = now.find((x) => x.text === fixed);
      assert.ok(a && b && Math.abs(a.rect[1] - b.rect[1]) < 0.5, `"${fixed}" stays in place`);
    }
    await shot('33-screenshot-moved');
    await page.evaluate(() => window.__app.tools.closeGroup());

    // Only text on the clipboard: Ctrl+V does not paste an image.
    const n0 = await page.evaluate(() => window.__app.doc.undoStack.length);
    await page.evaluate(() => navigator.clipboard.writeText('text only').catch(() => {}));
    await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('text only'); });
    await page.mouse.click(cx, cy); await page.keyboard.press('Control+V'); await wait(800);
    assert.equal(await page.evaluate(() => window.__app.doc.undoStack.length), n0, 'no image pasted');
    await closeAll();
  });
  step('Find and replace: one, all, undo, paragraph reflows, recognized text in a scan', async () => {
    const { degrees } = require('@cantoo/pdf-lib');
    const OLD = 'Nordwind Handels AG'; const NEW = 'Südlicht Logistik und Handel GmbH';
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold);
    const p1 = d.addPage([595, 842]);
    p1.drawText(`Angebot 2024 für die ${OLD}`, { x: 72, y: 770, size: 18, font: fb, color: rgb(0.1, 0.3, 0.6) });
    // Running text: the name spans a line break.
    const para = ['Die Zusammenarbeit mit der Nordwind Handels', 'AG besteht seit dem Jahr 2024 und umfasst die', 'regelmässige Lieferung von Ersatzteilen sowie', 'die Wartung der Anlagen am Standort.'];
    para.forEach((t, k) => p1.drawText(t, { x: 72, y: 720 - k * 15, size: 11, font: f }));
    const colRight = 72 + Math.max(...para.map((t) => f.widthOfTextAtSize(t, 11)));
    p1.drawText(`Kunde: ${OLD}`, { x: 72, y: 620, size: 11, font: f });
    p1.drawText('Auftrag 20241', { x: 72, y: 600, size: 11, font: f });
    // Rotated text at the edge: cannot be replaced and must be reported.
    p1.drawText(OLD, { x: 560, y: 300, size: 10, font: f, rotate: degrees(90) });
    const p2 = d.addPage([595, 842]);
    p2.drawText('Bedingungen', { x: 72, y: 770, size: 18, font: fb });
    p2.drawText(`Die ${OLD} haftet nicht für Verzögerungen.`, { x: 72, y: 720, size: 11, font: f });
    p2.drawText('Kontakt: info at nordwind handels ag', { x: 72, y: 690, size: 11, font: f });
    fs.writeFileSync(file('ersetzen.pdf'), await d.save());
    // Before this, "Edit PDF" was open in another document: its text blocks must not play any role here.
    await openFile(await makeFixture('ersetzen-vorher.pdf', 1)); await group('edit'); await page.waitForSelector('.eb'); await wait(200);
    await closeAll();
    await openFile(file('ersetzen.pdf'));

    const SEARCH = '#findbar .row:not(.rep) input[type=text]'; const REPL = '#findbar .row.rep input[type=text]';
    const cnt = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#findbar .cnt').textContent), re.source, { timeout: 30000 });
    const docText = () => page.evaluate(async () => { const a = window.__app.doc; let t = ''; for (let i = 0; i < a.numPages; i++) t += `${(await a.pageText(i)).items.map((x) => x.str + (x.hasEOL ? ' ' : '')).join('')}\n`; return t.replace(/[ \t]+/g, ' '); });
    const times = (t, s) => t.toLowerCase().split(s.toLowerCase()).length - 1;
    const undoN = () => page.evaluate(() => window.__app.doc.undoStack.length);
    const blockOf = (i, re) => page.evaluate(async ([n, src]) => { const r = new RegExp(src); const o = (await window.__app.editor.objects(n)).find((x) => x.kind === 'text' && r.test(x.text)); return o ? { text: o.text, size: o.size, bold: !!o.bold, color: o.color, ocr: !!o.ocr, lines: o.lines.map((l) => ({ text: l.text, x0: l.x0, x1: l.x1 })) } : null; }, [i, re.source]);

    // 1. Open the bar with the "Replace with" row, search.
    await run('replace');
    await page.waitForSelector('#findbar .row.rep:not([hidden])');
    await page.fill(SEARCH, OLD);
    await cnt(/^1 of 6$/);
    await page.fill(REPL, NEW);

    // 2. Replace one: the highlighted result (heading) is replaced; font, size and color stay.
    let u = await undoN();
    await page.click('#findbar [data-act=replace]');
    await cnt(/of 5$/);
    assert.equal(await undoN(), u + 1, 'replacing is one step');
    const head = await blockOf(0, /^Angebot 2024/);
    assert.ok(head && head.text === `Angebot 2024 für die ${NEW}`, `heading replaced: ${JSON.stringify(head)}`);
    assert.ok(Math.abs(head.size - 18) < 0.2 && head.bold, `size and bold stay: ${head.size}, ${head.bold}`);
    assert.ok(head.color[2] > 0.5 && head.color[0] < 0.2, `color stays: ${head.color}`);
    await shot('ersetzen-einzeln');

    // 3. Undo: the result is back, the counter is right again.
    await run('undo');
    await cnt(/of 6$/);

    // 4. Replace all: the count first, then the message with the position that did not work (rotated text).
    u = await undoN();
    await page.click('#findbar [data-act=replace-all]');
    await page.waitForSelector('.scrim .dlg');
    let msg = await page.$eval('.scrim .dlg', (e) => e.textContent);
    assert.ok(/6 results/.test(msg) && msg.includes(NEW), `confirmation states the count: ${msg}`);
    await page.click('.scrim .btn.primary');
    await page.waitForFunction(() => /were replaced/.test(document.querySelector('.scrim .dlg')?.textContent || ''), null, { timeout: 60000 });
    msg = await page.$eval('.scrim .dlg', (e) => e.textContent);
    assert.ok(/5 of 6 results were replaced/.test(msg), `message states the count: ${msg}`);
    assert.ok(/Not replaced \(1\)/.test(msg) && /Page 1/.test(msg) && /rotated/.test(msg), `message states the position and the reason: ${msg}`);
    await page.click('.scrim .btn.primary'); await wait(300);
    assert.equal(await undoN(), u + 1, '"Replace all" is a single step for undo');
    let t = await docText();
    assert.equal(times(t, NEW), 5, `five positions replaced: ${t}`);
    assert.equal(times(t, OLD), 1, `only the rotated text stays: ${t}`);

    // 5. The paragraph has reflowed: same wording, no line extends beyond the column.
    await rendered();
    const par = await blockOf(0, /^Die Zusammenarbeit/);
    assert.ok(par, 'paragraph found');
    assert.equal(par.lines.map((l) => l.text).join(' '), `Die Zusammenarbeit mit der ${NEW} besteht seit dem Jahr 2024 und umfasst die regelmässige Lieferung von Ersatzteilen sowie die Wartung der Anlagen am Standort.`);
    assert.ok(par.lines.length >= 5, `paragraph has one more line: ${par.lines.length}`);
    for (const l of par.lines) assert.ok(l.x1 <= colRight + 8 && Math.abs(l.x0 - 72) < 1, `line stays in the column (${Math.round(colRight)}): ${JSON.stringify(l)}`);
    assert.ok(Math.abs(par.size - 11) < 0.2, `font size of the paragraph stays: ${par.size}`);
    // A single line stays one line.
    const kunde = await blockOf(0, /^Kunde:/);
    assert.ok(kunde && kunde.lines.length === 1 && kunde.text === `Kunde: ${NEW}`, `line "Kunde": ${JSON.stringify(kunde)}`);
    await shot('ersetzen-alle');

    // 6. The saved file contains the same (real change in the page content).
    const saved = await allText(await open(await saveAs('ersetzen-neu.pdf')));
    assert.equal(times(saved.replace(/\s+/g, ' '), NEW), 5, `file: ${saved}`);
    assert.equal(times(saved.replace(/\s+/g, ' '), OLD), 1, `file, old name: ${saved}`);
    // The old page content is also no longer in the file as an unused object.
    const { PDFRawStream, decodePDFRawStream } = require('@cantoo/pdf-lib');
    const hex = Buffer.from('Kunde: Nordwind', 'latin1').toString('hex').toUpperCase();
    const streamsWith = async (name) => {
      const raw = await PDFDocument.load(fs.readFileSync(file(name)));
      let n = 0;
      for (const [, o] of raw.context.enumerateIndirectObjects()) {
        if (!(o instanceof PDFRawStream)) continue;
        let txt = ''; try { txt = Buffer.from(decodePDFRawStream(o).decode()).toString('latin1'); } catch { continue; }
        if (txt.toUpperCase().includes(hex) || txt.includes('Kunde: Nordwind')) n++;
      }
      return n;
    };
    assert.equal(await streamsWith('ersetzen.pdf'), 1, 'cross-check: in the original the text is in the page content');
    assert.equal(await streamsWith('ersetzen-neu.pdf'), 0, 'replaced text is removed from the file, not just hidden');

    // 7. One "Undo" step takes everything back.
    await run('undo'); await wait(600);
    t = await docText();
    assert.equal(times(t, OLD), 6, `everything back: ${t}`); assert.equal(times(t, NEW), 0);

    // 8. Whole word: "2024" does not match "20241".
    await page.fill(SEARCH, '2024'); await cnt(/of 3$/);
    await page.setChecked('#findbar input[data-opt="wholeWord"]', true); await cnt(/of 2$/);
    await page.fill(REPL, '2025');
    await page.click('#findbar [data-act=replace-all]');
    await page.waitForSelector('.scrim .dlg'); await page.click('.scrim .btn.primary');
    await page.waitForFunction(() => /were replaced/.test(document.querySelector('.scrim .dlg')?.textContent || ''), null, { timeout: 60000 });
    msg = await page.$eval('.scrim .dlg', (e) => e.textContent);
    assert.ok(/All 2 results were replaced/.test(msg) && !/Not replaced/.test(msg), `message: ${msg}`);
    await page.click('.scrim .btn.primary'); await wait(300);
    t = await docText();
    assert.ok(t.includes('Auftrag 20241') && t.includes('Angebot 2025') && t.includes('Jahr 2025') && !/\b2024\b/.test(t), `whole word: ${t}`);
    await page.setChecked('#findbar input[data-opt="wholeWord"]', false);
    // Match case: only the exact spelling.
    await page.fill(SEARCH, 'nordwind'); await cnt(/of 6$/);
    await page.setChecked('#findbar input[data-opt="caseSensitive"]', true); await cnt(/^1 of 1$/);
    await page.setChecked('#findbar input[data-opt="caseSensitive"]', false); await cnt(/of 6$/);

    // 9. The replacement text contains the search term: each position is replaced only once, also when clicking through.
    await page.fill(SEARCH, 'Nordwind'); await cnt(/of 6$/);
    await page.fill(REPL, 'Nordwind Nord');
    // The rotated text is skipped with a notice.
    const left = () => page.$eval('#findbar .cnt', (e) => Number((/of (\d+)/.exec(e.textContent) || [0, 0])[1]));
    for (let k = 0; k < 8 && (await left()) > 3; k++) {
      await page.click('#findbar [data-act=replace]'); await wait(250);
      await page.waitForFunction(() => !window.__app.find.own, null, { timeout: 30000 }); await wait(250);
    }
    assert.equal(await left(), 3, 'three results remain');
    t = await docText();
    assert.equal(times(t, 'Nordwind Nord'), 3, `three positions replaced: ${t}`);
    assert.equal(times(t, 'Nord Nord'), 0, `no position replaced twice: ${t}`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__app.find.close());
    await closeAll();

    // 10. Recognized text in a scan: old letters disappear from the image, the new text is there.
    const s = await PDFDocument.create(); const sf = await s.embedFont(StandardFonts.Helvetica); const sb = await s.embedFont(StandardFonts.HelveticaBold);
    const sp = s.addPage([595, 842]);
    sp.drawText('Lieferschein Nr. 4711', { x: 60, y: 740, size: 16, font: sb });
    sp.drawText('Montage der Anlage in Halle 3', { x: 60, y: 690, size: 12, font: sf });
    sp.drawText('Abnahme nach der Montage durch den Kunden', { x: 60, y: 660, size: 12, font: sf });
    fs.writeFileSync(file('lieferschein-original.pdf'), await s.save());
    await openFile(file('lieferschein-original.pdf'));
    const jpg = await page.evaluate(async () => { const { canvas } = await window.__app.viewer.renderToCanvas(0, 200, { noAnnots: true }); const b = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9)); return Array.from(new Uint8Array(await b.arrayBuffer())); });
    fs.writeFileSync(file('lieferschein.jpg'), Uint8Array.from(jpg));
    await closeAll();
    await setDialogs({ open: [file('lieferschein.jpg')] });
    await page.evaluate(() => window.__app.tools.createFromFile());
    await page.waitForFunction(() => window.__app.doc?.name === 'lieferschein.pdf');
    await page.evaluate(() => window.__app.doc.scanCheck); await idle(); await wait(300); await rendered();
    t = await docText();
    assert.equal(times(t, 'Montage'), 2, `scan recognized: ${t}`);
    const dark = (re) => page.evaluate(async (src) => {
      const r = new RegExp(src); const v = window.__app.viewer; const n = v.node(0);
      const o = (await window.__app.editor.objects(0)).find((x) => x.kind === 'text' && r.test(x.text));
      const css = v.rectToCss(0, o.rect); const k = n.canvas.width / n.el.clientWidth;
      const data = n.canvas.getContext('2d').getImageData(Math.round(css.left * k), Math.round(css.top * k), Math.max(1, Math.round(css.width * k)), Math.max(1, Math.round(css.height * k))).data;
      let c = 0; for (let q = 0; q < data.length; q += 4) if (data[q] < 110) c++;
      return { dark: c, width: o.rect[2] - o.rect[0] };
    }, re.source);
    const before = await dark(/^Montage der Anlage/);
    await run('replace'); await page.fill(SEARCH, 'Montage'); await cnt(/of 2$/);
    await page.fill(REPL, 'Inbetriebnahme');
    u = await undoN();
    await page.click('#findbar [data-act=replace-all]');
    await page.waitForSelector('.scrim .dlg'); await page.click('.scrim .btn.primary');
    await page.waitForFunction(() => /were replaced/.test(document.querySelector('.scrim .dlg')?.textContent || ''), null, { timeout: 60000 });
    msg = await page.$eval('.scrim .dlg', (e) => e.textContent);
    assert.ok(/All 2 results were replaced/.test(msg), `scan, message: ${msg}`);
    await page.click('.scrim .btn.primary'); await wait(300);
    assert.equal(await undoN(), u + 1, 'scan: one step');
    await rendered(); await wait(300);
    t = await docText();
    assert.ok(times(t, 'Inbetriebnahme') === 2 && times(t, 'Montage') === 0, `scan replaced: ${t}`);
    const line = await blockOf(0, /^Inbetriebnahme der Anlage/);
    if (!line) console.log('         Blocks: ' + JSON.stringify(await page.evaluate(async () => (await window.__app.editor.objects(0)).map((x) => [x.kind, x.text, x.ocr, x.size && Math.round(x.size * 10) / 10, x.rect.map(Math.round)]))));
    assert.ok(line && !line.ocr && Math.abs(line.size - 12) < 1.6, `new text is visible text of similar size: ${JSON.stringify(line)}`);
    // The line has become longer and carries text only once: if the old letters were still in the image, there would be
    // clearly more black there than the longer word explains.
    const after = await dark(/^Inbetriebnahme der Anlage/);
    assert.ok(after.width > before.width, `line is longer: ${before.width} -> ${after.width}`);
    assert.ok(after.dark < before.dark * (after.width / before.width) * 1.35, `old letters removed from the image: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    await shot('ersetzen-scan');
    await page.evaluate(() => window.__app.find.close());
    await closeAll();
  });
  step('Detect form fields automatically: preview, deselect, create, undo, scanned form', async () => {
    // Erfundenes Anmeldeformular.
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold);
    const p = d.addPage([595, 842]); const black = rgb(0, 0, 0);
    const line = (x0, y0, x1, y1, t = 0.9) => p.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: t, color: black });
    p.drawText('Anmeldung zum Kurs', { x: 60, y: 780, size: 18, font: fb }); line(60, 772, 535, 772, 1.2);
    p.drawText('Name:', { x: 60, y: 730, size: 12, font: f }); line(140, 728, 340, 728);
    p.drawText('Vorname:', { x: 60, y: 702, size: 12, font: f }); line(140, 700, 340, 700);
    p.drawText('Telefon: ____________________', { x: 60, y: 672, size: 12, font: f });
    p.drawRectangle({ x: 60, y: 636, width: 11, height: 11, borderColor: black, borderWidth: 1 }); p.drawText('Newsletter', { x: 78, y: 637, size: 12, font: f });
    p.drawRectangle({ x: 220, y: 636, width: 11, height: 11, borderColor: black, borderWidth: 1 }); p.drawText('Parkplatz', { x: 238, y: 637, size: 12, font: f });
    p.drawText('Verpflegung:', { x: 60, y: 603, size: 12, font: f });
    p.drawCircle({ x: 160, y: 607, size: 5.5, borderColor: black, borderWidth: 1 }); p.drawText('Fleisch', { x: 171, y: 603, size: 12, font: f });
    p.drawCircle({ x: 250, y: 607, size: 5.5, borderColor: black, borderWidth: 1 }); p.drawText('Vegetarisch', { x: 261, y: 603, size: 12, font: f });
    p.drawText('Bemerkungen', { x: 60, y: 560, size: 12, font: f });
    p.drawRectangle({ x: 60, y: 490, width: 320, height: 62, borderColor: black, borderWidth: 1 });
    line(60, 380, 250, 380); p.drawText('Ort, Datum', { x: 60, y: 367, size: 9, font: f });
    line(310, 380, 520, 380); p.drawText('Unterschrift', { x: 310, y: 367, size: 9, font: f });
    fs.writeFileSync(file('formular-leer.pdf'), await d.save());
    // The same page with a field that already exists.
    d.getForm().createTextField('Vorname').addToPage(p, { x: 140, y: 701, width: 200, height: 15, font: f });
    fs.writeFileSync(file('formular.pdf'), await d.save());
    await openFile(file('formular.pdf'));
    await group('form'); await wait(200);

    const boxes = () => page.$$eval('.fd-box', (els) => els.map((e) => ({ name: e.dataset.name, type: e.dataset.type, off: e.classList.contains('off') })));
    const undoN = () => page.evaluate(() => window.__app.doc.undoStack.length);
    const fieldsOf = async (bytes) => { const x = await PDFDocument.load(bytes); return x.getForm().getFields().map((q) => `${q.constructor.name.replace('PDF', '')}:${q.getName()}`).sort(); };
    const detect = async () => {
      await page.click('#left-panel >> text=Detect fields automatically');
      await page.waitForSelector('.scrim [data-field="range"]');
      await ok();
    };

    // 1. Detect: preview on the page, nothing created yet.
    const u0 = await undoN(); const bytes0 = await page.evaluate(() => window.__app.doc.bytes.length);
    await detect();
    await page.waitForSelector('.fd-box'); await page.waitForSelector('#detectbar');
    let b = await boxes();
    const names = b.map((x) => `${x.type}:${x.name}`).sort();
    assert.deepEqual(names, ['checkbox:Newsletter', 'checkbox:Parkplatz', 'multiline:Bemerkungen', 'radio:Verpflegung', 'radio:Verpflegung', 'signature:Unterschrift', 'text:Name', 'text:Ort, Datum', 'text:Telefon'], `detected fields: ${names.join(' | ')}`);
    assert.ok(!names.some((n) => /Vorname/.test(n)), 'the existing field "Vorname" is not suggested again');
    assert.ok(/9 fields detected, 9 selected/.test(await page.$eval('#detectbar', (e) => e.textContent)));
    assert.equal(await undoN(), u0, 'nothing is changed before confirming');
    assert.equal(await page.evaluate(() => window.__app.doc.bytes.length), bytes0);
    // The preview lies on the line: the box "Name" starts at the line and ends at it.
    const nameBox = await page.$eval('.fd-box[data-name="Name"]', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.bottom]; });
    const [lx0, ly] = await pagePt(0, 140, 728); const [lx1] = await pagePt(0, 340, 728);
    assert.ok(Math.abs(nameBox[0] - lx0) < 3 && Math.abs(nameBox[1] - lx1) < 3 && Math.abs(nameBox[2] - ly) < 4, `preview lies on the line: ${nameBox} / ${lx0}, ${lx1}, ${ly}`);
    await shot('felder-vorschau');

    // 2. Deselect one field, then create.
    await page.click('.fd-box[data-name="Parkplatz"]');
    await page.waitForSelector('.fd-box.off[data-name="Parkplatz"]');
    assert.ok(/9 fields detected, 8 selected/.test(await page.$eval('#detectbar', (e) => e.textContent)));
    assert.equal(await page.$eval('#detectbar [data-act=apply]', (e) => e.textContent), 'Create 8 fields');
    await page.click('#detectbar [data-act=apply]');
    await page.waitForFunction(() => !document.querySelector('.fd-box') && !document.querySelector('#detectbar'), null, { timeout: 30000 });
    await idle(); await wait(300);
    assert.equal(await undoN(), u0 + 1, 'all fields together are one step for undo');
    const saved = await saveAs('formular-felder.pdf');
    assert.deepEqual(await fieldsOf(saved), ['CheckBox:Newsletter', 'RadioGroup:Verpflegung', 'Signature:Unterschrift', 'TextField:Bemerkungen', 'TextField:Name', 'TextField:Ort, Datum', 'TextField:Telefon', 'TextField:Vorname']);
    const chk = await PDFDocument.load(saved);
    assert.deepEqual(chk.getForm().getRadioGroup('Verpflegung').getOptions(), ['Fleisch', 'Vegetarisch']);
    assert.ok(chk.getForm().getTextField('Bemerkungen').isMultiline());
    // The fields can be filled in (PDF.js shows them as input fields).
    await rendered(); await wait(400);
    assert.ok(await page.$$eval('.annotationLayer input, .annotationLayer textarea', (e) => e.length) >= 6, 'input fields on the page');
    await shot('felder-angelegt');

    // 3. Detect again: only the deselected field is new, nothing is created twice. Cancel with Esc.
    await detect();
    await page.waitForSelector('.fd-box');
    b = await boxes();
    assert.deepEqual(b.map((x) => `${x.type}:${x.name}`), ['checkbox:Parkplatz'], `second run: ${JSON.stringify(b)}`);
    const u1 = await undoN();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.fd-box') && !document.querySelector('#detectbar'));
    assert.equal(await undoN(), u1, 'cancel changes nothing');

    // 4. Undo takes back all fields in one step.
    await run('undo'); await wait(600);
    assert.deepEqual(await fieldsOf(Buffer.from(await page.evaluate(() => Array.from(window.__app.doc.bytes)))), ['TextField:Vorname']);
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();

    // 5. Scanned form (image): lines and boxes come from the image, the names from the recognized text.
    await openFile(file('formular-leer.pdf'));
    const jpg = await page.evaluate(async () => { const { canvas } = await window.__app.viewer.renderToCanvas(0, 200, { noAnnots: true }); const x = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9)); return Array.from(new Uint8Array(await x.arrayBuffer())); });
    fs.writeFileSync(file('formular-scan.jpg'), Uint8Array.from(jpg));
    await closeAll();
    await setDialogs({ open: [file('formular-scan.jpg')] });
    await page.evaluate(() => window.__app.tools.createFromFile());
    await page.waitForFunction(() => window.__app.doc?.name === 'formular-scan.pdf');
    await page.evaluate(() => window.__app.doc.scanCheck); await idle(); await wait(300); await rendered();
    await group('form'); await wait(200);
    await detect();
    await page.waitForSelector('.fd-box');
    b = await boxes();
    const got = b.map((x) => `${x.type}:${x.name}`);
    const ocrWords = await page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str).filter((x) => x.trim()).join(' / '));
    got.push(`(recognized text: ${ocrWords})`);
    for (const want of ['text:Name', 'text:Vorname', 'checkbox:Newsletter', 'checkbox:Parkplatz', 'multiline:Bemerkungen', 'signature:Unterschrift']) assert.ok(got.includes(want), `scan, "${want}" recognized: ${got.join(' | ')}`);
    assert.ok(b.length <= 10, `scan: no flood of wrong fields: ${got.join(' | ')}`);
    await shot('felder-scan');
    await page.click('#detectbar [data-act=apply]');
    await page.waitForFunction(() => !document.querySelector('.fd-box') && !document.querySelector('#detectbar'), null, { timeout: 30000 });
    await idle(); await wait(300);
    const scanFields = await fieldsOf(Buffer.from(await page.evaluate(() => Array.from(window.__app.doc.bytes))));
    assert.ok(scanFields.includes('TextField:Name') && scanFields.includes('CheckBox:Newsletter') && scanFields.includes('Signature:Unterschrift'), `scan, created: ${scanFields.join(' | ')}`);
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
  });
  step('Tables in export: Word, Excel and PowerPoint with real tables, also from a scan', async () => {
    // Fictional report: table with lines and merged cells, table without lines, text before and after.
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold);
    const p = d.addPage([595, 842]); const black = rgb(0, 0, 0);
    const line = (x0, y0, x1, y1) => p.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 0.9, color: black });
    const right = (t, x, y, font = f, size = 11) => p.drawText(t, { x: x - font.widthOfTextAtSize(t, size), y, size, font });
    p.drawText('Auswertung nach Region', { x: 60, y: 760, size: 16, font: fb });
    for (const y of [700, 676, 652, 628, 604]) line(y === 676 ? 200 : 60, y, 460, y);
    line(60, 604, 60, 700); line(200, 604, 200, 700); line(460, 604, 460, 700); line(330, 604, 330, 676);
    p.drawText('Region', { x: 68, y: 684, size: 11, font: fb }); p.drawText('Leistung', { x: 306, y: 684, size: 11, font: fb });
    p.drawText('Menge', { x: 208, y: 660, size: 11, font: fb }); p.drawText('Betrag', { x: 338, y: 660, size: 11, font: fb });
    p.drawText('Nord', { x: 68, y: 636, size: 11, font: f }); right('12', 322, 636); right("1'250.00", 452, 636);
    p.drawText('Süd', { x: 68, y: 612, size: 11, font: f }); right('34', 322, 612); right('320.00', 452, 612);
    const rows = [['Artikel', 'Datum', 'Preis'], ['Schraube M8', '12.11.2026', '4.50'], ['Dübel', '03.12.2026', '12.00'], ['Winkel verzinkt', '15.01.2027', '128.75'], ['Total', '', '145.25']];
    rows.forEach((r, k) => { const ft = k === 0 || k === 4 ? fb : f; p.drawText(r[0], { x: 60, y: 540 - k * 17, size: 11, font: ft }); if (r[1]) p.drawText(r[1], { x: 230, y: 540 - k * 17, size: 11, font: ft }); right(r[2], 460, 540 - k * 17, ft); });
    p.drawText('Dieser Satz steht unter den Tabellen und läuft über die ganze Breite der Seite hinweg.', { x: 60, y: 430, size: 11, font: f });
    fs.writeFileSync(file('tabellen.pdf'), await d.save());
    await openFile(file('tabellen.pdf'));
    const ex = async (fmt, name = `tab.${fmt}`) => { await setDialogs({ save: file(name) }); await page.evaluate((x) => window.__app.tools.exportAs(x), fmt); await idle(); await wait(150); return fs.readFileSync(file(name)); };
    const times = (t, s) => t.split(s).length - 1;

    // Word: two real tables, merged cells, numbers right-aligned, text outside stays a paragraph.
    const xml = await (await JSZip.loadAsync(await ex('docx'))).file('word/document.xml').async('string');
    assert.equal(times(xml, '<w:tbl>'), 2, 'two tables in Word');
    assert.ok(/<w:gridSpan w:val="2"\/>/.test(xml), 'horizontally merged cell ("Leistung")');
    assert.ok(/<w:vMerge w:val="restart"\/>/.test(xml) && /<w:vMerge w:val="continue"\/>/.test(xml), 'vertically merged cell ("Region")');
    const cellOf = (text) => { const k = xml.indexOf(`>${text}<`); assert.ok(k > 0, `"${text}" is in the document`); return xml.slice(xml.lastIndexOf('<w:tc>', k), k); };
    assert.ok(/<w:jc w:val="right"\/>/.test(cellOf('1&apos;250.00')) || /<w:jc w:val="right"\/>/.test(cellOf("1'250.00")), 'amount right-aligned');
    assert.ok(/<w:jc w:val="right"\/>/.test(cellOf('128.75')), 'price right-aligned (table without lines)');
    assert.ok(!/<w:jc w:val="right"\/>/.test(cellOf('Nord')), 'text left-aligned');
    assert.ok(/<w:jc w:val="center"\/>/.test(cellOf('Leistung')), 'header across two columns centered');
    for (const t of ['Auswertung nach Region', 'Schraube M8', 'Winkel verzinkt', 'Dieser Satz steht unter den Tabellen']) assert.equal(times(xml, t), 1, `"${t}" is in the document exactly once`);
    const firstTbl = xml.indexOf('<w:tbl>'); const lastTblEnd = xml.lastIndexOf('</w:tbl>');
    assert.ok(xml.indexOf('Auswertung nach Region') < firstTbl && xml.indexOf('Dieser Satz steht') > lastTblEnd, 'text outside the tables stays in place');
    assert.ok(xml.indexOf('15.01.2027') > firstTbl && xml.indexOf('15.01.2027') < lastTblEnd);

    // Excel: each cell on its own, numbers and dates are real values, merged cells, text outside stays.
    const ExcelJS = require('exceljs');
    const readSheet = async (bytes) => {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
      const ws = wb.worksheets[0]; const cells = [];
      ws.eachRow((row, r) => row.eachCell((c, k) => cells.push({ r, c: k, v: c.value, fmt: c.numFmt, merged: c.isMerged, master: c.master.address, addr: c.address, align: c.alignment?.horizontal })));
      return { ws, cells, find: (v) => cells.find((x) => (x.v instanceof Date && v instanceof Date ? x.v.getTime() === v.getTime() : x.v === v) && x.addr === x.master) };
    };
    let sh = await readSheet(await ex('xlsx'));
    const nord = sh.find('Nord'); assert.ok(nord, `"Nord" in its own cell: ${JSON.stringify(sh.cells.map((x) => x.v))}`);
    const amount = sh.find(1250); assert.ok(amount && amount.r === nord.r && amount.c === nord.c + 2, `1'250.00 is the number 1250 in the same row, two columns further: ${JSON.stringify(amount)}`);
    assert.equal(amount.fmt, '#,##0.00'); assert.equal(amount.align, 'right');
    assert.equal(sh.ws.getCell(nord.r, nord.c + 1).value, 12); assert.equal(sh.ws.getCell(nord.r + 1, nord.c + 2).value, 320);
    const region = sh.find('Region'); const leistung = sh.find('Leistung');
    assert.ok(region.merged && sh.ws.getCell(region.r + 1, region.c).master.address === region.addr, '"Region" merged across two rows');
    assert.ok(leistung.merged && sh.ws.getCell(leistung.r, leistung.c + 1).master.address === leistung.addr, '"Leistung" merged across two columns');
    const date = sh.find(new Date(Date.UTC(2026, 10, 12)));
    assert.ok(date && date.fmt === 'dd.mm.yyyy', `date is a real date: ${JSON.stringify(sh.cells.filter((x) => x.v instanceof Date))}`);
    const screw = sh.find('Schraube M8'); assert.ok(screw && date.r === screw.r && date.c === screw.c + 1);
    assert.equal(sh.ws.getCell(screw.r, screw.c + 2).value, 4.5); assert.equal(sh.ws.getCell(screw.r + 2, screw.c + 2).value, 128.75);
    const total = sh.find('Total'); assert.ok(total && sh.ws.getCell(total.r, total.c + 2).value === 145.25 && !sh.ws.getCell(total.r, total.c + 1).value, 'Total is below "Preis", the cell in between is empty');
    assert.ok(sh.find('Auswertung nach Region') && sh.cells.some((x) => typeof x.v === 'string' && x.v.startsWith('Dieser Satz steht unter den Tabellen')), 'text outside the tables is kept');
    assert.ok(sh.find('Auswertung nach Region').r < region.r && region.r < screw.r, 'order as on the page');

    // PowerPoint (editable): real tables with merged cells.
    await setDialogs({ save: file('tab.pptx') });
    await page.evaluate(() => { window.__app.tools.exportAs('pptx'); });
    await dialog({ mode: 'edit' }); await idle(); await wait(200);
    const slide = await (await JSZip.loadAsync(fs.readFileSync(file('tab.pptx')))).file('ppt/slides/slide1.xml').async('string');
    assert.equal(times(slide, '<a:tbl>'), 2, 'two tables on the slide');
    assert.ok(/gridSpan="2"/.test(slide) && /rowSpan="2"/.test(slide), 'merged cells in PowerPoint');
    assert.ok(slide.includes('Schraube M8') && slide.includes('Auswertung nach Region'));

    // Cross-check with installed Office (if available): Word, Excel and PowerPoint open the files and
    // convert them back to a PDF. A damaged file would fail here.
    const office = await page.evaluate(() => window.dp.officeAvailable());
    for (const [prog, name] of [['Word.Application', 'tab.docx'], ['Excel.Application', 'tab.xlsx'], ['PowerPoint.Application', 'tab.pptx']]) {
      if (!office.includes(prog)) { console.log(`         Note: ${prog} not installed, ${name} not checked with Office`); continue; }
      // PowerPoint runs only once per user: if it is already open, the conversion would share this window
      // and close it at the end. Then better not check.
      if (prog.startsWith('PowerPoint') && /POWERPNT\.EXE/i.test(require('child_process').execSync('tasklist /FI "IMAGENAME eq POWERPNT.EXE" /NH').toString())) { console.log('         Note: PowerPoint is open, tab.pptx not checked with PowerPoint'); continue; }
      const back = await page.evaluate(async (x) => Array.from(await window.dp.officeToPdf(x)), file(name));
      const txt = (await allText(await open(back))).replace(/\s+/g, ' ');
      assert.ok(/Schraube M8/.test(txt) && /Nord/.test(txt) && /128[.,]75/.test(txt), `${prog} opens ${name}: ${txt.slice(0, 300)}`);
      console.log(`         ${prog.split('.')[0]} opens ${name} and shows the tables`);
    }

    // Other formats stay as before: the text of the tables is in the text export.
    assert.match((await ex('txt')).toString(), /Schraube M8/);
    await shot('tabellen-export');
    await closeAll();

    // Scanned table: lines from the image, text from text recognition.
    await openFile(file('tabellen.pdf'));
    const jpg = await page.evaluate(async () => { const { canvas } = await window.__app.viewer.renderToCanvas(0, 200, { noAnnots: true }); const x = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9)); return Array.from(new Uint8Array(await x.arrayBuffer())); });
    fs.writeFileSync(file('tabellen-scan.jpg'), Uint8Array.from(jpg));
    await closeAll();
    await setDialogs({ open: [file('tabellen-scan.jpg')] });
    await page.evaluate(() => window.__app.tools.createFromFile());
    await page.waitForFunction(() => window.__app.doc?.name === 'tabellen-scan.pdf');
    await page.evaluate(() => window.__app.doc.scanCheck); await idle(); await wait(300); await rendered();
    sh = await readSheet(await ex('xlsx', 'tab-scan.xlsx'));
    const dump = JSON.stringify(sh.cells.map((x) => [x.addr, x.v]));
    const sNord = sh.find('Nord'); assert.ok(sNord, `scan: "Nord" in its own cell: ${dump}`);
    assert.equal(sh.ws.getCell(sNord.r, sNord.c + 2).value, 1250, `scan: amount as a number in the third column: ${dump}`);
    assert.equal(sh.ws.getCell(sNord.r + 1, sNord.c + 2).value, 320, `scan: second row: ${dump}`);
    const sScrew = sh.cells.find((x) => typeof x.v === 'string' && /^Schraube/.test(x.v));
    assert.ok(sScrew && sh.ws.getCell(sScrew.r, sScrew.c + 1).value instanceof Date && sh.ws.getCell(sScrew.r, sScrew.c + 2).value === 4.5, `scan: table without lines with date and number: ${dump}`);
    const sx = await (await JSZip.loadAsync(await ex('docx', 'tab-scan.docx'))).file('word/document.xml').async('string');
    assert.ok(times(sx, '<w:tbl>') >= 2, 'scan: tables in Word');
    await closeAll();
  });
  step('Skewed scan: read straightened, text lies over the image, straighten page with preview, preference', async () => {
    // Fictional letter, "scanned" as an image rotated 2.5 degrees clockwise.
    const ANGLE = 2.5;
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold);
    const p = d.addPage([595, 842]);
    p.drawText('Lieferbedingungen der Werkstatt Sonnenhof', { x: 70, y: 740, size: 16, font: fb });
    const lines = [
      'Die Lieferung erfolgt innerhalb von zehn Arbeitstagen nach Eingang der Bestellung.',
      'Sendungen innerhalb der Stadt werden mit dem eigenen Lastenrad kostenlos gebracht.',
      'Bei Lieferungen ins Ausland berechnen wir die Kosten nach Gewicht und Zielgebiet.',
      'Beanstandungen melden Sie bitte schriftlich innert vierzehn Tagen nach Erhalt.',
      'Gutscheine sind drei Jahre ab dem Ausstellungsdatum in der Werkstatt einlösbar.',
      'Reparaturen erledigen wir nach Voranmeldung jeweils am Dienstag und Donnerstag.',
    ];
    lines.forEach((t, k) => p.drawText(t, { x: 70, y: 690 - k * 26, size: 12, font: f }));
    fs.writeFileSync(file('brief.pdf'), await d.save());
    await openFile(file('brief.pdf'));
    const tiltJpg = async (deg, name) => {
      const arr = await page.evaluate(async (a) => {
        const { canvas } = await window.__app.viewer.renderToCanvas(0, 200, { noAnnots: true });
        const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
        const c = out.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height);
        c.translate(out.width / 2, out.height / 2); c.rotate((a * Math.PI) / 180); c.drawImage(canvas, -out.width / 2, -out.height / 2);
        const x = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9)); return Array.from(new Uint8Array(await x.arrayBuffer()));
      }, deg);
      fs.writeFileSync(file(name), Uint8Array.from(arr));
    };
    await tiltJpg(ANGLE, 'brief-schief.jpg'); await tiltJpg(0, 'brief-gerade.jpg');
    await closeAll();
    const importJpg = async (name) => {
      await setDialogs({ open: [file(name)] });
      await page.evaluate(() => window.__app.tools.createFromFile());
      await page.waitForFunction((n) => window.__app.doc?.name === n, name.replace('.jpg', '.pdf'));
      await page.evaluate(() => window.__app.doc.scanCheck); await idle(); await wait(300); await rendered(); await fitPage();
    };
    const docText = () => page.evaluate(async () => (await window.__app.doc.pageText(0)).items.map((x) => x.str + (x.hasEOL ? ' ' : '')).join('').replace(/\s+/g, ' '));
    const undoN = () => page.evaluate(() => window.__app.doc.undoStack.length);
    // Position of a word in the original (center, slightly above the baseline) and the same position in the rotated image.
    const wordAt = (k, word) => { const t = lines[k]; const i = t.indexOf(word); const x = 70 + f.widthOfTextAtSize(t.slice(0, i), 12) + f.widthOfTextAtSize(word, 12) / 2; return [x, 690 - k * 26 + 4]; };
    const turned = ([x, y], deg) => { const a = (deg * Math.PI) / 180; const dx = x - 297.5; const dy = y - 421; return [297.5 + dx * Math.cos(a) + dy * Math.sin(a), 421 - dx * Math.sin(a) + dy * Math.cos(a)]; };
    // Searches for a word and returns where the highlight lies and how much text (dark pixels) is below it.
    const hit = async (word) => {
      await run('find'); await page.fill('#findbar .row:not(.rep) input[type=text]', word);
      await page.waitForFunction(() => /^1 of 1$/.test(document.querySelector('#findbar .cnt').textContent), null, { timeout: 15000 });
      await wait(400);
      const r = await page.evaluate(() => {
        const els = [...document.querySelectorAll('.pv-page .hl i.cur')]; if (!els.length) return null;
        const b = els.map((e) => e.getBoundingClientRect()); const l = Math.min(...b.map((x) => x.left)); const t = Math.min(...b.map((x) => x.top)); const rr = Math.max(...b.map((x) => x.right)); const bt = Math.max(...b.map((x) => x.bottom));
        const n = window.__app.viewer.node(0); const k = n.canvas.width / n.el.clientWidth; const o = n.el.getBoundingClientRect();
        const data = n.canvas.getContext('2d').getImageData(Math.round((l - o.left) * k), Math.round((t - o.top) * k), Math.max(1, Math.round((rr - l) * k)), Math.max(1, Math.round((bt - t) * k))).data;
        let dark = 0; for (let q = 0; q < data.length; q += 4) if (data[q] < 120) dark++;
        return { x: (l + rr) / 2, y: (t + bt) / 2, dark: dark / (data.length / 4) };
      });
      await page.evaluate(() => window.__app.find.close());
      return r;
    };
    const near = async (word, k, deg, what) => {
      const h = await hit(word); assert.ok(h, `${what}: "${word}" found and highlighted`);
      const [ex, ey] = await pagePt(0, ...turned(wordAt(k, word), deg));
      assert.ok(Math.abs(h.y - ey) <= 5 && Math.abs(h.x - ex) <= 12, `${what}: highlight of "${word}" lies on the word in the image (expected ${Math.round(ex)}/${Math.round(ey)}, is ${Math.round(h.x)}/${Math.round(h.y)})`);
      assert.ok(h.dark > 0.05, `${what}: below the highlight of "${word}" there is text (${h.dark.toFixed(3)})`);
    };
    const tilts = () => page.evaluate(async () => (await window.__app.doc.pageText(0)).items.filter((x) => x.str.trim().length > 3).map((x) => Math.atan2(x.transform[1], x.transform[0]) * 180 / Math.PI));

    // 1. Preference off (default): the skewed page is read straightened, the image stays as it is.
    assert.equal(await page.evaluate(() => window.__app.settings.ocrDeskew), false, 'default: do not straighten the image automatically');
    await page.evaluate(() => { const t = window.__app.tools; window.__straightened = 0; const o = t.straighten; t.straighten = async function (...a) { window.__straightened++; return o.apply(this, a); }; });
    await importJpg('brief-schief.jpg');
    let t = await docText();
    for (const w of ['Lieferbedingungen', 'Arbeitstagen', 'Bestellung', 'Lastenrad', 'kostenlos', 'Zielgebiet', 'Beanstandungen', 'vierzehn', 'Gutscheine', 'einlösbar', 'Reparaturen', 'Donnerstag']) assert.ok(t.includes(w), `read skewed, "${w}" recognized: ${t}`);
    assert.equal(await page.evaluate(() => window.__straightened), 0, 'the image was not changed');
    const L1 = await undoN();
    // The recognized text follows the skew (negative counterclockwise in the PDF) ...
    const tl = await tilts();
    assert.ok(tl.length >= 20 && tl.every((a) => Math.abs(a + ANGLE) < 0.5), `text is rotated with the line: ${tl.slice(0, 8).map((a) => a.toFixed(2))}`);
    // ... and lies exactly over the word in the image at the start and at the end of the line (at the line end it would otherwise be 20 points off).
    await near('erfolgt', 0, ANGLE, 'schief'); await near('Bestellung', 0, ANGLE, 'schief'); await near('Donnerstag', 5, ANGLE, 'schief'); await near('Reparaturen', 5, ANGLE, 'schief');
    await shot('schief-gelesen');
    // Editing in the image: the line is one block with its whole text, and when deleted its letters disappear from the image.
    await group('edit'); await page.waitForSelector('.eb'); await wait(300);
    const blk = await page.evaluate(async () => { const o = (await window.__app.editor.objects(0)).find((x) => x.kind === 'text' && /Gutscheine/.test(x.text)); return o ? { text: o.text, ocr: !!o.ocr, words: o.words.length } : null; });
    assert.ok(blk && blk.ocr && /Gutscheine sind drei Jahre/.test(blk.text) && /einlösbar/.test(blk.text), `skewed line as one block: ${JSON.stringify(blk)}`);
    const inkOnLine = (k) => page.evaluate(([pts]) => { const v = window.__app.viewer; const n = v.node(0); const s = n.canvas.width / n.el.clientWidth; const c = n.canvas.getContext('2d'); let dark = 0; for (const [x, y] of pts) { const q = v.viewport(0).convertToViewportPoint(x, y); const dd = c.getImageData(Math.round(q[0] * s) - 2, Math.round(q[1] * s) - 2, 5, 5).data; for (let i = 0; i < dd.length; i += 4) if (dd[i] < 120) dark++; } return dark; },
      [Array.from({ length: 90 }, (_, j) => turned([72 + j * 5, 690 - k * 26 + 4], ANGLE))]);
    const before = await inkOnLine(4); const other = await inkOnLine(3);
    assert.ok(before > 150, `text on the line before deleting: ${before}`);
    const u = await undoN();
    await page.evaluate(async () => { const e = window.__app.editor; const o = (await e.objects(0)).find((x) => x.kind === 'text' && /Gutscheine/.test(x.text)); await e.replaceText(o, 0, '', null, {}); });
    await page.waitForFunction((n) => window.__app.doc.undoStack.length > n, u, { timeout: 30000 }); await rendered(); await wait(500);
    const after = await inkOnLine(4);
    assert.ok(after <= before * 0.08, `the text of the skewed line is removed from the image: ${before} -> ${after}`);
    assert.ok(await inkOnLine(3) >= other * 0.9, 'the line above is untouched');
    t = await docText(); assert.ok(!t.includes('Gutscheine') && t.includes('Beanstandungen'));
    await run('undo'); await wait(500);
    await page.evaluate(() => window.__app.tools.closeGroup()); await rendered(); await fitPage();

    // 2. "Straighten page": detected angle, preview, angle by hand; afterwards the image is straight.
    await group('ocr'); await wait(200);
    const u2 = await undoN();
    await page.click('#left-panel >> text=Straighten page');
    await page.waitForSelector('.scrim [data-field="angle"]', { timeout: 30000 });
    const auto = Number(await page.inputValue('.scrim [data-field="angle"]'));
    assert.ok(Math.abs(auto - ANGLE) <= 0.3, `detected angle: ${auto}`);
    assert.ok(await page.$eval('.scrim canvas.deskew-view', (c) => c.width > 100 && c.height > 100), 'preview present');
    assert.equal(await page.inputValue('.scrim [data-field="range"]'), '1');
    // By hand: the value can be changed, the preview redraws, "Automatic" restores the detected angle.
    const pix = () => page.$eval('.scrim canvas.deskew-view', (c) => { const dd = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < dd.length; i += 97) s = (s * 31 + dd[i]) % 1000003; return s; });
    const shown = await pix();
    await page.fill('.scrim [data-field="angle"]', '-6'); await wait(100);
    assert.notEqual(await pix(), shown, 'preview follows the angle');
    await shot('begradigen-dialog');
    await page.click('.scrim [data-act=auto]'); await wait(100);
    assert.equal(Number(await page.inputValue('.scrim [data-field="angle"]')), auto);
    assert.equal(await pix(), shown);
    await page.fill('.scrim [data-field="angle"]', String(ANGLE));
    await ok();
    // Straightening and reading again run one after the other, each with its own progress indicator: wait until the text is back.
    for (let k = 0; k < 120; k++) { await idle(); await wait(500); if (!(await page.$('.prog')) && (await tilts()).length >= 6 && (await undoN()) === u2 + 1) break; }
    await rendered(); await fitPage();
    assert.equal(await undoN(), u2 + 1, 'straightening including reading again is one step');
    const flat = await tilts();
    assert.ok(flat.length >= 6 && flat.every((a) => Math.abs(a) < 0.25), `after straightening the text is horizontal: ${flat.slice(0, 8).map((a) => a.toFixed(2))}`);
    await near('erfolgt', 0, 0, 'begradigt'); await near('Bestellung', 0, 0, 'begradigt'); await near('Donnerstag', 5, 0, 'begradigt');
    t = await docText(); for (const w of ['Lieferbedingungen', 'Lastenrad', 'Zielgebiet', 'Gutscheine', 'Donnerstag']) assert.ok(t.includes(w), `straightened, "${w}" recognized: ${t}`);
    await shot('begradigt');
    // Undo: image and text are skewed again.
    await run('undo'); await wait(600); await rendered(); await fitPage();
    await near('Bestellung', 0, ANGLE, 'after undo');
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();

    // 3. Normal PDF without a scan: stays unchanged, with a notice.
    await openFile(file('brief.pdf'));
    const len0 = await page.evaluate(() => window.__app.doc.bytes.length);
    await page.evaluate(() => { window.__app.tools.deskew(); });
    await page.waitForFunction(() => /not a scan/.test(document.querySelector('.scrim .dlg')?.textContent || ''));
    await page.click('.scrim .btn.primary'); await wait(150);
    assert.equal(await page.evaluate(() => window.__app.doc.bytes.length), len0); assert.equal(await undoN(), 0);
    await closeAll();

    // 4. Preference on: when recognizing, the image itself is rotated straight, all in one step.
    await page.evaluate(() => { window.__app.settings.ocrDeskew = true; window.__straightened = 0; });
    await importJpg('brief-schief.jpg');
    assert.equal(await page.evaluate(() => window.__straightened), 1, 'the skewed image was straightened');
    assert.equal(await undoN(), L1, 'straightening and recognizing are one step together');
    const flat2 = await tilts();
    assert.ok(flat2.length >= 6 && flat2.every((a) => Math.abs(a) < 0.25), `preference: text horizontal: ${flat2.slice(0, 8).map((a) => a.toFixed(2))}`);
    await near('Bestellung', 0, 0, 'preference'); await near('Reparaturen', 5, 0, 'preference');
    await closeAll();
    // A page that is already straight stays unchanged.
    await page.evaluate(() => { window.__straightened = 0; });
    await importJpg('brief-gerade.jpg');
    assert.equal(await page.evaluate(() => window.__straightened), 0, 'a straight page is not touched');
    await near('Bestellung', 0, 0, 'straight page');
    await page.evaluate(() => { window.__app.settings.ocrDeskew = false; });
    await closeAll();
  });

  step('Reverse pages and set page boxes', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.reversePagesDialog(); });
    await dialog({ range: '1-4' });
    assert.match(await page.evaluate(() => window.__app.doc.pageText(0).then((t) => t.items.map((x) => x.str).join(' '))), /page 4/);
    await page.evaluate(() => { window.__app.tools.pageBoxesDialog(); });
    await dialog({ box: 'TrimBox', mode: 'margins', top: 10, bottom: 10, left: 5, right: 5, range: '1' });
    const buf = await saveAs('a-boxes.pdf');
    const d = await PDFDocument.load(buf);
    const t = d.getPage(0).getTrimBox();
    assert.ok(Math.abs(t.x - 5 * 2.8346) < 0.1 && Math.abs(t.width - (595 - 10 * 2.8346)) < 0.1, `trim box ${JSON.stringify(t)}`);
    assert.ok(!d.getPage(1).node.get(PDFName.of('TrimBox')), 'other pages keep their boxes');
    const pdf = await open(buf);
    assert.match(await textOf(pdf, 1), /page 4/); assert.match(await textOf(pdf, 4), /page 1/);
    await closeAll();
  });
  step('Export as Markdown and export all images', async () => {
    await openFile(file('a.pdf'));
    await setDialogs({ save: file('e.md') });
    await page.evaluate(() => window.__app.tools.exportAs('md')); await idle(); await wait(100);
    const md = fs.readFileSync(file('e.md'), 'utf8');
    assert.match(md, /^# DocPilot test document page 1$/m, 'the large title is a heading');
    assert.match(md, /^This is the first paragraph with some text to mark up\./m);
    await closeAll();
    const d = await PDFDocument.create();
    const png = await d.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
    for (let i = 0; i < 2; i++) d.addPage([300, 300]).drawImage(png, { x: 20, y: 20, width: 100, height: 100 });
    fs.writeFileSync(file('img.pdf'), await d.save());
    await openFile(file('img.pdf'));
    const dir = path.join(work, 'images-out'); fs.mkdirSync(dir, { recursive: true });
    await app.evaluate(({ dialog: dl }, x) => { dl.showOpenDialog = async () => ({ canceled: false, filePaths: [x] }); }, dir);
    await app.evaluate(({ shell }) => { shell.openPath = async () => ''; });
    await page.evaluate(() => { window.__app.tools.exportImages(); });
    await dialog({ minSide: 1 });
    await idle(); await wait(300);
    assert.deepEqual(fs.readdirSync(dir), ['img_P001_1.png'], 'the image used on both pages is saved once');
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'img_P001_1.png')).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
    await closeAll();
  });
  step('Print: several pages per sheet, booklet, custom scale, form fields only', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.run('print'); });
    await page.waitForSelector('.scrim [data-field="layout"]');
    await field('layout', 'multiple');
    assert.ok(await page.isVisible('.scrim [data-field="perSheet"]'), 'pages per sheet shown for several pages per sheet');
    assert.ok(!(await page.isVisible('.scrim [data-field="scale"]')), 'scale hidden');
    await page.click('.scrim .btn:not(.primary)'); await wait(150);
    const base = { which: 'all', range: '', subset: 'all', reverse: false, paper: 'a4', orient: 'auto', color: 'color', duplex: 'simplex', content: 'doc', dpi: 72, copies: 1, fit: 'fit', scale: 100, perSheet: 2, order: 'horizontal', border: false, bookletSubset: 'both', binding: 'left' };
    const sheets = (o) => page.evaluate(async (x) => { const r = await window.__app.print(x, { toPdf: true }); return Array.from(r.pdf); }, { ...base, ...o });
    const pages = async (o) => (await open(Buffer.from(await sheets(o)))).numPages;
    assert.equal(await pages({ layout: 'multiple', perSheet: 4, border: true }), 1, '4 pages on one sheet');
    assert.equal(await pages({ layout: 'booklet' }), 2, 'booklet of 4 pages: one sheet, both sides');
    assert.equal(await pages({ layout: 'size', fit: 'custom', scale: 50, which: 'range', range: '1-3' }), 3);
    assert.equal(await pages({ layout: 'size', content: 'fields', which: 'current' }), 1);
    await closeAll();
  });
  step('Print production: grayscale, hairlines, printer marks', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.grayscaleDialog(); });
    await dialog({});
    await page.evaluate(() => { window.__app.tools.hairlinesDialog(); });
    await dialog({ narrower: 0.3, width: 0.6 });
    await page.evaluate(() => { window.__app.tools.printerMarksDialog(); });
    await dialog({ colorBars: false, range: '1-2' });
    const buf = await saveAs('a-prepress.pdf');
    const pdf = await open(buf);
    const ol = await (await pdf.getPage(3)).getOperatorList(); // page 3 has no printer marks (registration colour is not gray)
    const fills = ol.fnArray.map((fn, i) => (fn === pdfjs.OPS.setFillRGBColor ? ol.argsArray[i][0] : null)).filter(Boolean);
    assert.ok(fills.length && fills.every((c) => (typeof c === 'string' ? c.slice(1, 3) === c.slice(3, 5) && c.slice(3, 5) === c.slice(5, 7) : c[0] === c[1] && c[1] === c[2])), `all fills gray: ${fills}`);
    assert.match(await textOf(pdf, 2), /2 of 4/, 'page information line');
    assert.doesNotMatch(await textOf(pdf, 3), / of 4/, 'only the chosen pages');
    const d = await PDFDocument.load(buf);
    assert.ok(d.getPage(0).getMediaBox().width > 595 && d.getPage(0).getTrimBox().width === 595, 'page enlarged, trim box kept');
    await page.evaluate(() => { window.__app.tools.printerMarksDialog(); });
    await choose('Update');
    assert.equal(await page.isChecked('.scrim [data-field="colorBars"]'), false, 'the marks dialog opens with the settings used');
    await page.click('.scrim .btn:not(.primary)'); await wait(150);
    await closeAll();
  });
  step('Measure: snap to the corners of a rectangle, export measurements as CSV', async () => {
    await openFile(file('a.pdf'));
    await tool('measure-dist');
    await page.waitForFunction(() => !!window.__app.tools.snapGeom(0), null, { timeout: 10000 });
    // The blue rectangle of the fixture runs from (72, 420) to (292, 540): the drag starts and ends a little off its corners.
    await drag(0, [74.5, 422.5], [289.5, 537.5]);
    await wait(300);
    const dist = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.subject === 'Distance')?.contents);
    assert.equal(dist, `Distance: ${(Math.hypot(220, 120) / 2.834645669).toLocaleString('en-GB', { maximumFractionDigits: 2 })} mm`, 'snapped to both corners');
    await page.evaluate(() => window.__app.overlay.setTool('select'));
    await setDialogs({ save: file('m.csv') });
    await page.evaluate(() => window.__app.tools.exportMeasurements()); await wait(300);
    const csv = fs.readFileSync(file('m.csv'), 'utf8');
    assert.match(csv, /^﻿Page,Index,Type,Value,Unit,Label,Author\r\n1,1,distance,88\.4\d*,"mm"/);
    await closeAll();
  });
  step('Fill and sign: line; Create PDF: several files as separate PDFs', async () => {
    await openFile(file('a.pdf'));
    await group('fillsign');
    await page.click('#left-panel .lp-item[data-tool="fs-line"]');
    await drag(0, [100, 300], [250, 300]);
    const line = await page.evaluate(() => window.__app.doc.allAnnots().find((a) => a.type === 'line'));
    assert.ok(line && Math.abs(line.points[0][1] - line.points[1][1]) < 2 && line.points[1][0] - line.points[0][0] > 140, 'a line from the drag');
    const buf = await saveAs('a-line.pdf');
    const ann = await (await (await open(buf)).getPage(1)).getAnnotations();
    assert.ok(ann.some((a) => a.subtype === 'Line'));
    await page.evaluate(() => window.__app.tools.closeGroup());
    await closeAll();
    fs.writeFileSync(file('one.txt'), 'First text file'); fs.writeFileSync(file('two.txt'), 'Second text file');
    const out = path.join(work, 'separate'); fs.mkdirSync(out, { recursive: true });
    await app.evaluate(({ dialog: dl }, [files, dir]) => { let k = 0; dl.showOpenDialog = async () => (k++ === 0 ? { canceled: false, filePaths: files } : { canceled: false, filePaths: [dir] }); }, [[file('one.txt'), file('two.txt')], out]);
    await app.evaluate(({ shell }) => { shell.openPath = async () => ''; });
    await page.evaluate(() => window.__app.tools.createSeparate()); await idle(); await wait(300);
    assert.deepEqual(fs.readdirSync(out).sort(), ['one.pdf', 'two.pdf']);
    assert.match(await textOf(await open(fs.readFileSync(path.join(out, 'two.pdf'))), 1), /Second text file/);
  });
  step('App: reopen closed tab, show in Explorer, search commands, thumbnail size, bookmark search, fonts, autosave and recovery', async () => {
    await openFile(file('a.pdf'));
    // Show in Explorer.
    await app.evaluate(({ shell }) => { global.revealed = null; shell.showItemInFolder = (p) => { global.revealed = p; }; });
    await run('reveal'); await wait(200);
    assert.equal(await app.evaluate(() => global.revealed), file('a.pdf'));
    // Reopen closed tab.
    await closeAll();
    await run('reopen-closed'); await rendered();
    assert.equal(await page.evaluate(() => window.__app.doc?.name), 'a.pdf');
    // Search commands: typing and Enter runs the tool.
    await run('command-palette');
    await page.waitForSelector('.palette [data-palette-input]');
    await page.fill('.palette [data-palette-input]', 'grayscale');
    assert.equal(await page.textContent('.palette .pal-item.sel .l'), 'Convert to grayscale');
    await page.press('.palette [data-palette-input]', 'Enter');
    await page.waitForSelector('.scrim h3:text-is("Convert to grayscale")');
    await page.click('.scrim .btn:not(.primary)'); await wait(150);
    // Thumbnail size.
    await run('panel', 'thumbs'); await page.waitForSelector('#right-panel [data-thumb-size]');
    await page.$eval('#right-panel [data-thumb-size]', (e) => { e.value = '80'; e.dispatchEvent(new Event('change')); });
    await wait(300);
    assert.equal(await page.evaluate(() => window.__app.settings.thumbSize), 80);
    assert.equal(await page.$eval('#right-panel .thumb', (e) => Math.round(e.firstElementChild.getBoundingClientRect().width)), 80);
    // Bookmark search: matches stay visible with the bookmarks above them.
    await page.evaluate(() => window.__app.panels.saveOutline([{ title: 'Chapter one', page: 0, children: [{ title: 'Details', page: 1, children: [] }] }, { title: 'Appendix', page: 2, children: [] }]));
    await run('panel', 'bookmarks'); await page.waitForSelector('#right-panel [data-bm-search]');
    await page.fill('#right-panel [data-bm-search]', 'details');
    const visible = await page.$$eval('#right-panel .tree li', (l) => l.filter((x) => !x.hidden && x.offsetParent).map((x) => x.querySelector('.lb').textContent));
    assert.deepEqual(visible, ['Chapter one', 'Details']);
    // Fonts in Document properties.
    await run('properties'); await page.waitForSelector('.scrim .fonts-list');
    assert.ok(+(await page.getAttribute('.scrim .fonts-list', 'data-fonts')) >= 2);
    assert.match(await page.textContent('.scrim .fonts-list'), /Helvetica-Bold.*Type 1.*Not embedded/s);
    await page.click('.scrim .btn:not(.primary)'); await wait(150);
    // Autosave: a copy of the unsaved document; after a "crash" it is offered for recovery.
    await page.evaluate(() => window.__app.overlay.add({ type: 'note', page: 0, rect: [100, 600, 120, 620], icon: 'Comment', contents: 'Not saved yet', color: [1, 0.8, 0] }));
    assert.equal(await page.evaluate(() => window.__app.autosave.tick(true)), 1);
    const dir = path.join(work, 'userdata', 'autosave');
    const copies = fs.readdirSync(dir);
    assert.equal(copies.filter((x) => x.endsWith('.pdf')).length, 1);
    const saved = Object.fromEntries(copies.map((x) => [x, fs.readFileSync(path.join(dir, x))]));
    await closeAll();
    assert.deepEqual(fs.readdirSync(dir), [], 'closing removes the copy');
    for (const [n, b] of Object.entries(saved)) fs.writeFileSync(path.join(dir, `old-${n.replace(/^[^-]+-/, '')}`), b);
    await page.evaluate(() => { window.__app.autosave.offerRecovery(); });
    await choose('Recover'); await rendered(); await wait(300);
    const rec = await page.evaluate(() => ({ name: window.__app.doc.name, dirty: window.__app.doc.dirty, notes: window.__app.doc.allAnnots().map((a) => a.contents) }));
    assert.deepEqual(rec, { name: 'a.pdf', dirty: true, notes: ['Not saved yet'] });
    // The recovered document is unsaved again, so a new copy of it may already be there: only the old copies must be gone.
    assert.deepEqual(fs.readdirSync(dir).filter((x) => x.startsWith('old-')), [], 'the recovered copies are removed');
    await run('panel', 'thumbs'); await page.evaluate(() => { window.__app.panels.hide(); window.__app.settings.thumbSize = 150; });
    await closeAll();
  });
  step('Accessibility: tag automatically, Tags panel, alternate text, check report with fixes', async () => {
    await openFile(file('img.pdf'));
    await page.evaluate(() => { window.__app.tools.accessCheck(); });
    await page.waitForSelector('.scrim .access-report');
    assert.equal(await page.getAttribute('.scrim [data-rule="tagged-pdf"]', 'data-status'), 'failed');
    assert.equal(await page.getAttribute('.scrim [data-rule="reading-order"]', 'data-status'), 'manual');
    await page.click('.scrim [data-rule="tagged-pdf"] .btn'); // "Tag": closes the report and opens the tagging dialog
    await page.waitForSelector('.scrim h3:text-is("Automatically tag document")');
    await ok(); await wait(400);
    await page.waitForSelector('#right-panel [data-tag-type="Figure"]');
    assert.ok(await page.$('#right-panel [data-tag-type="Document"]'));
    // Alternate text for the image (used on both pages: two figures).
    await page.evaluate(() => { window.__app.tools.altTextDialog(); });
    await page.waitForSelector('.scrim textarea[data-alt-ref]');
    const n = await page.$$eval('.scrim textarea[data-alt-ref]', (l) => l.length);
    assert.equal(n, 2);
    for (const t of await page.$$('.scrim textarea[data-alt-ref]')) await t.fill('Small coloured square');
    await page.click('.scrim [role="alertdialog"] .btn.primary'); await idle(); await wait(300);
    await page.evaluate(() => { window.__app.tools.titleLang(); });
    await dialog({ title: 'Image test', lang: 'en-GB' });
    await page.evaluate(() => { window.__app.tools.accessCheck(); });
    await page.waitForSelector('.scrim .access-report');
    for (const id of ['tagged-pdf', 'tagged-content', 'figures-alt', 'title', 'language']) assert.equal(await page.getAttribute(`.scrim [data-rule="${id}"]`, 'data-status'), 'passed', id);
    await page.click('.scrim .btn.primary'); await wait(150);
    // Change a tag in the Tags panel.
    await wait(600); await page.waitForSelector('#right-panel [data-tag-type="Figure"]');
    await page.click('#right-panel [data-tag-type="Figure"]');
    await page.waitForFunction(() => window.__app.panels.selTagNode?.type === 'Figure');
    await page.evaluate(() => { window.__te = window.__app.panels.tagEdit(); });
    await page.waitForSelector('.scrim [data-field="type"]');
    assert.equal(await page.inputValue('.scrim [data-field="alt"]'), 'Small coloured square');
    await dialog({ type: 'Figure', alt: 'A square' });
    const buf = await saveAs('img-tagged.pdf');
    const pdf = await open(buf);
    const tree = await (await pdf.getPage(1)).getStructTree();
    const alts = []; const walk = (x) => { if (x.alt) alts.push(x.alt); (x.children || []).forEach(walk); }; walk(tree);
    assert.ok(alts.includes('A square') || alts.includes('Small coloured square'), `alternate text in the file: ${alts}`);
    assert.equal((await pdf.getMetadata()).info.Title, 'Image test');
    await page.evaluate(() => window.__app.panels.hide());
    await closeAll();
  });
  step('Scan & OCR: several files, review recognized text, enhance scans, straighten a photo', async () => {
    // Two files at once: an image and a PDF made from it; both become searchable PDFs in a folder.
    const b2 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1240; c.height = 1754; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000'; x.font = '56px Arial'; x.fillText('Second scanned letter', 120, 260); x.fillText('Invoice number 4711', 120, 360); return c.toDataURL('image/png').split(',')[1]; });
    fs.writeFileSync(file('scan2.png'), Buffer.from(b2, 'base64'));
    const out = path.join(work, 'ocr-out'); fs.mkdirSync(out, { recursive: true });
    await app.evaluate(({ dialog: dl }, [files, dir]) => { let k = 0; dl.showOpenDialog = async () => (k++ === 0 ? { canceled: false, filePaths: files } : { canceled: false, filePaths: [dir] }); }, [[file('scan.png'), file('scan2.png')], out]);
    await app.evaluate(({ shell }) => { shell.openPath = async () => ''; });
    await page.evaluate(() => { window.__run = window.__app.tools.ocrFiles(); });
    await page.waitForSelector('.scrim [data-field="lang"]'); await page.click('.scrim [data-ok]');
    await page.evaluate(() => window.__run); await idle(); await wait(300);
    assert.deepEqual(fs.readdirSync(out).sort(), ['scan2_OCR.pdf', 'scan_OCR.pdf']);
    assert.match(await textOf(await open(fs.readFileSync(path.join(out, 'scan2_OCR.pdf'))), 1), /4711/);
    assert.equal(await page.evaluate(() => window.__app.docs.length), 0, 'the files are closed again');
    // Review: every recognized word with its picture; a correction replaces the word in the text layer.
    await setDialogs({ open: [file('scan2.png')] });
    await page.evaluate(() => window.__app.tools.createFromFile()); await idle();
    await page.waitForFunction(() => window.__app.doc?.name === 'scan2.pdf'); await rendered();
    await page.waitForFunction(() => window.__app.doc.ocrWords?.size > 0, null, { timeout: 120000 });
    await page.evaluate(() => { window.__app.tools.ocrReview(); });
    await dialog({ limit: 101 });
    await page.waitForSelector('.scrim .ocr-review input');
    const words = await page.$$eval('.scrim .ocr-review input', (l) => l.map((i) => i.value));
    assert.ok(words.includes('Second'), `words: ${words}`);
    const k = words.indexOf('Second');
    await (await page.$$('.scrim .ocr-review input'))[k].fill('Third');
    await page.click('.scrim [role="alertdialog"] .btn.primary'); await idle(); await wait(300);
    assert.match(await page.evaluate(() => window.__app.doc.pageText(0).then((t) => t.items.map((x) => x.str).join(' '))), /Third scanned letter/);
    // Enhance: black and white, in the same image; the recognized text stays.
    await page.evaluate(() => { window.__app.tools.enhanceScanDialog(); });
    await dialog({ mode: 'bw' }); await wait(300);
    const buf = await saveAs('scan2-bw.pdf');
    const d = await PDFDocument.load(buf);
    const xo = d.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
    const im = d.context.lookup(xo.get(xo.keys()[0]));
    assert.equal(im.dict.get(PDFName.of('BitsPerComponent')).toString(), '1');
    assert.match(await textOf(await open(buf), 1), /Invoice number 4711/);
    await closeAll();
    // A phone photo: a white sheet at an angle on a grey table.
    const photo = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 1000; c.height = 1300; const x = c.getContext('2d');
      x.fillStyle = '#6a6a6a'; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#f4f4f4'; x.beginPath(); x.moveTo(170, 120); x.lineTo(860, 170); x.lineTo(900, 1180); x.lineTo(120, 1130); x.closePath(); x.fill();
      return c.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(file('photo.png'), Buffer.from(photo, 'base64'));
    // The photo has no text: no automatic recognition (Tesseract would only report the table edges as unreadable lines).
    await page.evaluate(() => { window.__app.settings.ocrOnCreate = false; window.__app.settings.ocrOnOpen = 'never'; });
    await setDialogs({ open: [file('photo.png')] });
    await page.evaluate(() => window.__app.tools.createFromFile()); await idle();
    await page.waitForFunction(() => window.__app.doc?.name === 'photo.pdf'); await rendered(); await wait(500);
    const before = await page.evaluate(() => window.__app.doc.pages[0].view);
    await page.evaluate(() => { window.__p = window.__app.tools.perspectiveDialog(); });
    await page.waitForSelector('.scrim .pq-stage');
    assert.match(await page.textContent('.scrim [role="alertdialog"] p'), /were found/, 'the corners are found');
    await page.click('.scrim [role="alertdialog"] .btn.primary');
    assert.equal(await page.evaluate(() => window.__p), true); await idle(); await wait(300);
    const after = await page.evaluate(() => window.__app.doc.pages[0].view);
    assert.ok(after[2] / after[3] < before[2] / before[3] - 0.01 || Math.abs(after[2] - before[2]) > 5, `page size changed: ${before} -> ${after}`);
    await page.evaluate(() => { window.__app.settings.ocrOnCreate = true; window.__app.settings.ocrOnOpen = 'ask'; });
    await closeAll();
  });
  step('Action wizard: choose and edit an action, run steps on several files', async () => {
    await run('action-wizard');
    await page.waitForSelector('.scrim [data-aw-action]');
    await page.selectOption('.scrim [data-aw-action]', { label: 'Add page numbers' });
    assert.equal(await page.$$eval('.scrim .aw-step', (l) => l.length), 1);
    await page.selectOption('.scrim [data-aw-add]', 'add_watermark');
    assert.equal((await page.$$eval('.scrim .aw-step', (l) => l.map((x) => x.dataset.step))).join(','), 'add_footer,add_watermark', 'the step is added');
    await choose('Cancel');
    const out = path.join(work, 'action-out'); fs.mkdirSync(out, { recursive: true });
    const res = await page.evaluate(([files, dir]) => window.__app.tools.runAction([{ step: 'add_footer', arg: 'Page {page} of {pages}' }, { step: 'add_watermark', arg: 'BATCH' }, { step: 'grayscale' }, { step: 'auto_tag' }], files, dir), [[file('a.pdf'), file('img.pdf')], out]);
    assert.equal(res.map((r) => r.error || '-').join(','), '-,-', JSON.stringify(res));
    assert.deepEqual(fs.readdirSync(out).sort(), ['a.pdf', 'img.pdf']);
    const t = await textOf(await open(fs.readFileSync(path.join(out, 'a.pdf'))), 2);
    assert.match(t, /BATCH/); assert.match(t, /Page 2 of 4/);
    assert.ok(fs.statSync(file('a.pdf')).size > 0 && !(await textOf(await open(fs.readFileSync(file('a.pdf'))), 1)).includes('BATCH'), 'the original stays unchanged');
    const tagged = await (await (await open(fs.readFileSync(path.join(out, 'img.pdf')))).getPage(1)).getStructTree();
    assert.ok(tagged, 'tagged');
    await closeAll();
  });
  step('XFA form: banner, convert into pages and form fields', async () => {
    const template = '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb"><pageSet><pageArea name="P"><contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/><medium short="8.5in" long="11in"/></pageArea></pageSet>'
      + '<subform name="s" layout="position" w="7.5in" h="2in"><draw name="t" x="0" y="0" w="4in" h="0.4in"><value><text>Order form</text></value><font size="14pt" weight="bold"/></draw>'
      + '<field name="Customer" x="0" y="0.6in" w="4in" h="0.3in"><ui><textEdit/></ui><caption reserve="1in"><value><text>Customer</text></value></caption></field></subform></subform></template>';
    const datasets = '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><s><Customer>Example Ltd</Customer></s></form1></xfa:data></xfa:datasets>';
    const d = await PDFDocument.create();
    d.addPage([612, 792]).drawText('Please wait...', { x: 50, y: 700, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
    const enc = (t) => d.context.register(d.context.flateStream(Buffer.from(t)));
    const { PDFString } = require('@cantoo/pdf-lib');
    d.catalog.set(PDFName.of('AcroForm'), d.context.obj({ Fields: [], XFA: [PDFString.of('template'), enc(template), PDFString.of('datasets'), enc(datasets)] }));
    d.catalog.set(PDFName.of('NeedsRendering'), d.context.obj(true));
    fs.writeFileSync(file('xfa.pdf'), await d.save());
    await openFile(file('xfa.pdf'));
    await page.waitForSelector('#doc-banner .btn:text-is("Convert form")');
    await page.click('#doc-banner .btn:text-is("Convert form")');
    await choose('Convert'); await idle(); await wait(400);
    assert.ok(await page.evaluate(() => document.getElementById('doc-banner').hidden || !/XFA/.test(document.getElementById('doc-banner').textContent)), 'the banner is gone');
    const buf = await saveAs('xfa-converted.pdf');
    const pdf = await open(buf);
    assert.match(await textOf(pdf, 1), /Order form/);
    const ann = await (await pdf.getPage(1)).getAnnotations();
    assert.equal(ann.find((a) => a.fieldName === 'form1.s.Customer')?.fieldValue, 'Example Ltd');
    await closeAll();
  });  step('Multiple tabs and protection against data loss', async () => {
    await openFile(file('a.pdf')); await openFile(file('a-wm.pdf'));
    assert.equal(await page.$$eval('#tabs .tab[data-doc]', (e) => e.length), 2);
    await tool('rect'); await drag(0, [100, 100], [200, 200]);
    assert.ok(await page.$('#tabs .tab .dirty'));
    await run('close-tab');
    await page.waitForFunction(() => /Save changes/.test(document.querySelector('.scrim h3')?.textContent || ''));
    await page.click('.scrim .btn:nth-child(3)');
    await wait(150);
    assert.equal(await page.$$eval('#tabs .tab[data-doc]', (e) => e.length), 2, 'cancel keeps the tab open');
    await closeAll();
  });

  let failed = 0;
  // A step that hangs (e.g. waiting for a dialog that never comes) fails after this time, and the run goes on.
  const STEP_TIMEOUT = Number(process.env.DP_STEP_TIMEOUT) || 8 * 60000;
  const limited = (p) => {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Step timed out after ${STEP_TIMEOUT / 60000} minutes`)), STEP_TIMEOUT); });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
  };
  // Steps that cannot pass on a machine (e.g. the GitHub runners lack the Office cloud font Aptos) can be skipped
  // with DP_SKIP_STEPS, a regular expression for step names. They are listed as SKIP and are not failures.
  const skip = process.env.DP_SKIP_STEPS ? new RegExp(process.env.DP_SKIP_STEPS) : null;
  for (const [name, fn] of steps) {
    if (only && !only.test(name)) { if (!/Home|Open via/.test(name)) continue; }
    if (skip && skip.test(name)) { console.log(`  SKIP   ${name}`); continue; }
    const before = errors.length;
    try {
      await limited(fn());
      const newErr = errors.slice(before).filter((e) => !/Failed to load resource.*favicon/i.test(e));
      if (newErr.length) throw new Error(`Errors in the console:\n${newErr.join('\n')}`);
      console.log(`  OK     ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL   ${name}\n         ${String(e.stack || e).split('\n').slice(0, 7).join('\n         ')}`);
      console.log('         Console: ' + errors.slice(before).join(' | ').slice(0, 900));
      console.log('         Message: ' + await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')).catch(() => ''));
      console.log('         Tool: ' + await page.evaluate(() => `${window.__app.overlay.tool}, edit ${window.__app.editor.on}, group ${window.__app.tools.group?.id || '-'}, comments ${JSON.stringify([...(window.__app.doc?.annots || new Map()).values()].flat().map((a) => [a.type, a.rect && a.rect.map(Math.round)]))}`).catch(() => ''));
      await shot(`error-${failed}`).catch(() => {});
      await page.evaluate(() => { document.querySelectorAll('.scrim,.note-pop,.mini,.ctx').forEach((n) => n.remove()); }).catch(() => {});
      await closeAll().catch(() => {});
      await page.evaluate(() => { const a = window.__app; a.organizer.hide(); a.tools.closeGroup(); }).catch(() => {});
    }
  }
  console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nAll ${steps.length} steps passed`);
  await page.evaluate(() => { for (const d of window.__app.docs) d.dirty = false; window.dp.closeOk(); }).catch(() => {});
  await app.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

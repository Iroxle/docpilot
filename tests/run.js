'use strict';
// End-to-end test in the real Electron app. Clicks through the interface and checks the saved files independently.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { PDFDocument, StandardFonts, rgb } = require('@cantoo/pdf-lib');
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

(async () => {
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const app = await electron.launch({
    executablePath: process.env.DP_EXE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), // Do not pause rendering when the test window is covered by other windows.
    args: [...(process.env.DP_EXE ? [] : [root]), '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    env: { ...process.env, DP_USER_DATA: path.join(work, 'userdata'), ELECTRON_RUN_AS_NODE: undefined },
  });
  const page = await app.firstWindow();
  await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {});
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
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
  step('Redact: content really gone', async () => {
    await openFile(file('a.pdf'));
    await page.evaluate(() => { window.__app.tools.searchRedact(); });
    await dialog({ q: 'Secret' });
    await page.waitForFunction(() => window.__app.doc.allAnnots().length === 4);
    await wait(200); await shot('09-redaction-marked');
    await page.evaluate(() => { window.__app.tools.applyRedactions(); });
    await page.waitForSelector('.scrim'); await page.click('.scrim .btn:not(.primary)');
    await wait(400); await idle(); await wait(400);
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
    await dialog({ level: 'mid' });
    await page.waitForSelector('.scrim .btn.primary'); await page.click('.scrim .btn.primary'); await wait(200);
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
    await page.evaluate(async () => { await window.__app.tools.extract([0]); }).catch(() => {});
    await closeAll();
    await openFile(file('a.pdf'));
    await app.evaluate(({ dialog: d }, x) => { d.showOpenDialog = async () => ({ canceled: false, filePaths: [x] }); }, work);
    await page.evaluate(() => { window.__t = window.__app.tools.split(); }); await dialog({ count: 2 }); await page.evaluate(() => window.__t); await idle(); await wait(200);
    assert.ok(fs.existsSync(file('a_Teil1.pdf')) && fs.existsSync(file('a_Teil2.pdf')));
    assert.equal((await open(fs.readFileSync(file('a_Teil2.pdf')))).numPages, 2);
    await setDialogs({ save: file('a-pdfa.pdf') });
    await page.evaluate(() => { window.__t = window.__app.tools.pdfa(); }); await page.waitForSelector('.scrim'); await page.click('.scrim .btn.primary'); await page.evaluate(() => window.__t); await wait(200);
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
  step('Dark Windows mode: fields stay light and readable', async () => {
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
    await page.emulateMedia({ colorScheme: 'light' });
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
      // IT block (default in the installed program): option grayed out, nothing turns JavaScript on.
      assert.match(await page.$eval('#doc-banner', (e) => e.textContent), /blocked by IT\)\.$/, 'notice about IT block');
      await run('preferences'); await page.waitForSelector('.dlg.pref');
      await page.click('.pref-cat[data-cat="js"]');
      assert.equal(await page.$eval('[data-pref="jsEnabled"]', (e) => e.disabled), true, 'option locked');
      assert.match(await page.$eval('.pref-pane', (e) => e.textContent), /Blocked by IT/);
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
  step('Security: only open folders, conversion without internet', async () => {
    // The open function does not start files or programs.
    const msg = await page.evaluate((p) => window.dp.openPath(p), file('a.pdf'));
    assert.match(String(msg), /Only folders/, `file is not opened: ${msg}`);
    assert.match(String(await page.evaluate(() => window.dp.openPath('C:\\Windows\\System32\\calc.exe'))), /Only folders/, 'program is not started');
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
    assert.match(await textOf(await open(Buffer.from(Object.values(pdf))), 1), /Offline/);
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
    const pos = async () => page.evaluate(async () => Object.fromEntries((await window.__app.doc.pageText(0)).items.filter((x) => /Alpha|Beta|Gamma/.test(x.str)).map((x) => [x.str.trim().split(' ').pop(), [Math.round(x.transform[4]), Math.round(x.transform[5])]])));
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
    // 3. New text directly on Beta, then drag it away.
    await page.click('.lp-item[data-tool="add-text"]');
    await clickAt(0, [150, 512]); await page.waitForSelector('.eb-frame .eb-input');
    await page.keyboard.type('New Gamma'); await page.click('#propbar .btn.primary');
    await page.waitForFunction(() => !window.__app.editor.input); await wait(800); await page.waitForSelector('.eb'); await wait(300);
    assert.deepEqual(await blocks(), ['Lower paragraph Beta', 'New Gamma', 'Upper paragraph Alpha'], 'new text is its own block');
    const g = (await pos()).Gamma;
    up = await mv([g[0] + 40, g[1] + 4], [g[0] + 40, g[1] + 204]); await up();
    p = await pos();
    near(p.Beta, [72, 500], 'Beta stays when the new text is moved'); near(p.Gamma, [g[0], g[1] + 200], 'new text moved');
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
      if (ly !== null) { const p = v.viewport(0).convertToViewportPoint((rect[0] + rect[2]) / 2, ly); const row = c.getImageData(Math.round(p[0] * k) - 20, Math.round(p[1] * k) - 3, 40, 7).data; line = 0; for (let q = 0; q < row.length; q += 4) if (row[q] < 110) line++; }
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
  step('Multiple tabs and protection against data loss', async () => {
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
  for (const [name, fn] of steps) {
    if (only && !only.test(name)) { if (!/Home|Open via/.test(name)) continue; }
    const before = errors.length;
    try {
      await fn();
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

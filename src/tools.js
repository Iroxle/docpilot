// All tools: definition of the groups and their implementation.
import { h, $, icon, ibtn, toast, errToast, busy, formDialog, messageBox, hexToRgb, rgbToHex, cssColor, fileBase, canvasBytes, normalizeImage, toBase64, fmtSize, contextMenu } from './util.js';
import * as ops from './pdf/ops.js';
import { loadForEdit, saveDoc } from './pdf/ops.js';
import { writeAnnotations, flattenAnnotationsInDoc, newId } from './pdf/annots.js';
import { createDigitalId, signPdf } from './pdf/sign.js';
import { readFont, Doc } from './document.js';
import { wordBoxes, rectsOverlap, quadFromRect, rectFromQuad, diffWords, prefixRatio } from './textutil.js';
import * as conv from './convert.js';
import { boundsOf } from './overlay.js';
import * as scan from './scan.js';
import { removeRecognizedText } from './pdf/content.js';

const STAMPS = [['APPROVED', [0.1, 0.55, 0.2]], ['NOT APPROVED', [0.8, 0.1, 0.1]], ['DRAFT', [0.176, 0.482, 0.784]], ['FINAL', [0.1, 0.55, 0.2]], ['CONFIDENTIAL', [0.8, 0.1, 0.1]], ['FOR INFORMATION', [0.176, 0.482, 0.784]], ['COMPLETED', [0.1, 0.55, 0.2]], ['RECEIVED', [0.45, 0.45, 0.47]], ['COPY', [0.45, 0.45, 0.47]], ['REJECTED', [0.8, 0.1, 0.1]]];
const IMG_FILTER = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }];
const SIZES = [['595.28x841.89', 'A4 portrait'], ['841.89x595.28', 'A4 landscape'], ['841.89x1190.55', 'A3 portrait'], ['612x792', 'Letter'], ['419.53x595.28', 'A5']];
const parseSize = (s) => { const [width, height] = s.split('x').map(Number); return { width, height }; };
const MM = 2.834645669;

export class Tools {
  constructor(app) {
    this.app = app; this.group = null; this.left = $('#left-panel');
    this.measure = { ratio: 1, unit: 'mm' };
    this.registerTools();
    this.groups = this.defineGroups();
  }
  get doc() { return this.app.doc; }
  get viewer() { return this.app.viewer; }
  get overlay() { return this.app.overlay; }
  guard(fn) { return async (...a) => { try { return await fn(...a); } catch (e) { errToast(e); return undefined; } }; }
  mutate(fn, o) { return this.doc.mutate(fn, o); }
  range(label = 'Pages') { return { k: 'range', label, value: `1-${this.doc.numPages}`, placeholder: 'z.B. 1-3, 5' }; }
  pagesOf(v) { return ops.parseRange(v.range, this.doc.numPages); }
  validateRange = (v) => { try { const p = this.pagesOf(v); return p.length ? null : 'Please specify pages.'; } catch (e) { return e.message; } };

  defineGroups() {
    const T = (tool, label, ic) => ({ tool, label, icon: ic });
    const R = (label, ic, run, needsDoc = true) => ({ label, icon: ic, run: this.guard(run), needsDoc });
    return [
      { id: 'edit', label: 'Edit PDF', icon: 'edit', desc: 'Change text and images directly', onOpen: () => this.app.editor.enable(), onClose: () => this.app.editor.disable(), items: [
        { sub: 'Add' }, T('add-text', 'Add text', 'text'), T('add-image', 'Add image', 'img'), T('add-link', 'Add link', 'link'),
        { sub: 'Page design' }, T('crop', 'Crop pages', 'crop'), R('Crop margins...', 'crop', () => this.cropDialog()), R('Change page size...', 'fit', () => this.resizeDialog()), R('Header & footer...', 'header', () => this.headerFooter()), R('Insert page numbers...', 'header', () => this.pageNumbers()), R('Watermark...', 'watermark', () => this.watermark()), R('Background...', 'bg', () => this.background()), R('Bates numbering...', 'bates', () => this.bates()), R('Page labels...', 'bookmark', () => this.pageLabels()), R('Remove links...', 'link', () => this.removeLinks()),
      ] },
      { id: 'comment', label: 'Comment', icon: 'comment', desc: 'Notes, markups, drawings', onOpen: () => { if (this.app.settings.openCommentsPanel !== false) this.app.panels.show('comments'); }, items: [
        { sub: 'Mark up text' }, T('highlight', 'Highlight', 'highlight'), T('underline', 'Underline', 'text'), T('strikeout', 'Strikethrough', 'replace'), T('squiggly', 'Squiggly', 'polyline'), T('replace', 'Replace text', 'replace'), T('caret', 'Insert text', 'caret'),
        { sub: 'Notes and text' }, T('note', 'Sticky note', 'note'), T('freetext', 'Text box', 'textbox'), T('callout', 'Callout', 'textbox'),
        { sub: 'Draw' }, T('ink', 'Pencil', 'draw'), T('eraser', 'Eraser', 'eraser'), T('rect', 'Rectangle', 'rect'), T('ellipse', 'Ellipse', 'ellipse'), T('line', 'Line', 'line'), T('arrow', 'Arrow', 'arr'), T('polygon', 'Polygon', 'poly'), T('polyline', 'Polyline', 'polyline'), T('cloud', 'Cloud', 'cloud'),
        { sub: 'More' }, R('Stamp...', 'stamp', () => this.openGroup('stamp')), R('Attach file...', 'clip', () => this.app.panels.addAttachment()),
      ] },
      { id: 'stamp', label: 'Stamp', icon: 'stamp', hidden: true, extra: () => this.stampGrid(), items: [R('Custom stamp from image...', 'img', () => this.customStamp())] },
      { id: 'convert', label: 'Export PDF', icon: 'convert', desc: 'To Word, Excel, PowerPoint, images', items: [
        R('Microsoft Word (.docx)', 'convert', () => this.exportAs('docx')), R('Microsoft Excel (.xlsx)', 'convert', () => this.exportAs('xlsx')), R('Microsoft PowerPoint (.pptx)', 'convert', () => this.exportAs('pptx')), R('PNG image', 'img', () => this.exportAs('png')), R('JPEG image', 'img', () => this.exportAs('jpeg')), R('HTML web page', 'convert', () => this.exportAs('html')), R('Rich Text (.rtf)', 'convert', () => this.exportAs('rtf')), R('Plain text (.txt)', 'text', () => this.exportAs('txt')), R('PDF/A...', 'preflight', () => this.pdfa()),
      ] },
      { id: 'create', label: 'Create PDF', icon: 'blank', desc: 'From files, scanner, clipboard', items: [
        R('From file...', 'open', () => this.createFromFile(), false), R('From scanner...', 'scan', () => this.createFromScanner(), false), R('From clipboard', 'dup', () => this.createFromClipboard(), false), R('Blank page', 'blank', () => this.createBlank(), false),
      ] },
      { id: 'combine', label: 'Combine files', icon: 'combine', desc: 'Several files into one PDF', direct: this.guard(() => this.combine()), noDoc: true },
      { id: 'organize', label: 'Organize pages', icon: 'pages', desc: 'Move, rotate, delete, split', onOpen: () => this.app.organizer.show(), onClose: () => this.app.organizer.hide(), items: [
        R('Split document...', 'split', () => this.split()), R('Insert pages from file...', 'insert', () => this.insertFromFile(this.viewer.current + 1)), R('Insert blank page', 'blank', () => this.insertBlankAt(this.viewer.current + 1)),
      ] },
      { id: 'fillsign', label: 'Fill and sign', icon: 'sign', desc: 'Fill in and sign forms', extra: () => this.signSummary(), items: [
        T('fs-text', 'Enter text', 'text'), T('fs-check', 'Check mark', 'check'), T('fs-cross', 'Cross', 'cross'), T('fs-dot', 'Points', 'dot'), T('fs-date', 'Date', 'date'), R('Place signature', 'sign', () => this.placeSignature('signature')), R('Place initials', 'sign', () => this.placeSignature('initials')), R('Set up signature...', 'gear', () => this.signSetup('signature')), R('Set up initials...', 'gear', () => this.signSetup('initials')),
      ] },
      { id: 'certs', label: 'Use certificates', icon: 'cert', desc: 'Sign digitally and validate', items: [
        T('digital-sign', 'Sign digitally', 'cert'), R('Sign digitally (invisible)...', 'cert', () => this.digitalSign(null)), R('Create digital ID...', 'plus', () => this.createId(), false), R('Validate all signatures', 'preflight', () => this.app.panels.show('signatures')),
      ] },
      { id: 'form', label: 'Prepare form', icon: 'form', desc: 'Create fields, manage data', extra: () => this.formFieldsList(), items: [
        { sub: 'Fields' }, T('form-text', 'Text box', 'textbox'), T('form-multiline', 'Multiline text field', 'textbox'), T('form-checkbox', 'Check box', 'chk'), T('form-radio', 'Radio button', 'radio'), T('form-dropdown', 'Dropdown', 'dd'), T('form-list', 'List box', 'list'), T('form-button', 'Button', 'btn'), T('form-signature', 'Signature field', 'cert'),
        { sub: 'Form data' }, R('Highlight form fields', 'highlight', () => this.toggleFormHighlight()), R('Export data (JSON)...', 'share', () => this.exportForm()), R('Import data (JSON)...', 'open', () => this.importForm()), R('Reset form...', 'undo', () => this.resetForm()), R('Flatten form...', 'compress', () => this.flattenForm()),
      ] },
      { id: 'protect', label: 'Protect', icon: 'lock', desc: 'Passwords and permissions', items: [
        R('Password protection...', 'lock', () => this.encryptDialog()), R('Remove security...', 'lock', () => this.removeSecurity()), R('Sanitize document...', 'redact', () => this.sanitize()),
      ] },
      { id: 'redact', label: 'Redact', icon: 'redact', desc: 'Permanently remove content', extra: () => h('div', { class: 'lp-note' }, 'Marks stay editable until you choose "Apply redactions". After that, the content is permanently removed from the document.'), items: [
        T('redact-text', 'Mark up text', 'text'), T('redact-area', 'Mark area', 'rect'), R('Mark pages...', 'pages', () => this.redactPages()), R('Find and mark...', 'search', () => this.searchRedact()), R('Apply redactions', 'check', () => this.applyRedactions()),
      ] },
      { id: 'ocr', label: 'Scan & OCR', icon: 'scan', desc: 'Recognize text in scans', items: [R('Recognize text...', 'scan', () => this.ocr()), R('Create from scanner...', 'scan', () => this.createFromScanner(), false)] },
      { id: 'compress', label: 'Compress PDF', icon: 'compress', desc: 'Reduce file size', direct: this.guard(() => this.compress()) },
      { id: 'measure', label: 'Measure', icon: 'measure', desc: 'Distance, perimeter, area', items: [T('measure-dist', 'Distance', 'line'), T('measure-perimeter', 'Perimeter', 'polyline'), T('measure-area', 'Area', 'poly'), R('Set scale...', 'ruler', () => this.scaleDialog())] },
      { id: 'compare', label: 'Compare files', icon: 'compare', desc: 'Differences between two PDFs', direct: this.guard(() => this.compare()) },
      { id: 'access', label: 'Accessibility', icon: 'access', desc: 'Check and read out loud', items: [R('Quick check', 'preflight', () => this.accessCheck()), R('Set title and language...', 'text', () => this.titleLang()), R('Read page aloud', 'speak', () => this.app.speak('page')), R('Stop reading', 'x', () => this.app.speak('stop'))] },
      { id: 'preflight', label: 'Print production', icon: 'preflight', desc: 'Preflight and fonts', items: [R('Preflight report', 'preflight', () => this.preflight()), R('Crop for prepress...', 'crop', () => this.cropDialog())] },
      { id: 'advanced', label: 'Document check and JavaScript', icon: 'js', desc: 'Open options, scripts', items: [R('Open options...', 'gear', () => this.initialView()), R('Document JavaScript...', 'js', () => this.javascript()), R('Document properties...', 'info', () => this.app.run('properties'))] },
    ];
  }

  // --- Linke Leiste -----------------------------------------------------------------------
  renderAll() {
    this.left.replaceChildren(h('div', { class: 'lp-head' }, h('span', { class: 't' }, 'All tools'), ibtn('chevL', 'Hide', () => this.app.run('toggle-left'))),
      h('div', { class: 'lp-body' }, this.groups.filter((g) => !g.hidden).map((g) => h('button', { class: 'lp-item', type: 'button', data: { group: g.id }, onclick: () => this.openGroup(g.id) }, icon(g.icon), g.label))));
  }
  closeGroup() {
    const g = this.group;
    if (g) { this.group = null; if (g.onClose) g.onClose(); }
    if (this.overlay.tool !== 'select') this.overlay.setTool('select');
    this.renderAll();
    this.app.syncToolbar();
  }
  openGroup(id) {
    const g = this.groups.find((x) => x.id === id);
    if (!g) return;
    if (g.direct) { if (!g.noDoc && !this.doc) { toast('Please open a document first.'); return; } g.direct(); return; }
    if (!this.doc) { this.app.pendingGroup = id; this.app.run('open'); return; }
    const prev = this.group;
    if (prev && prev.onClose && prev !== g) prev.onClose();
    this.group = g;
    this.app.showDocView();
    this.renderGroup();
    if (prev !== g) g.onOpen?.();
    this.app.syncToolbar();
  }
  renderGroup() {
    const g = this.group;
    const body = h('div', { class: 'lp-body' }, (g.items || []).map((it) => {
      if (it.sub) return h('div', { class: 'lp-sub' }, it.sub);
      const active = it.tool && this.overlay.tool === it.tool;
      return h('button', { class: `lp-item ${active ? 'active' : ''}`, type: 'button', data: it.tool ? { tool: it.tool } : { action: it.label }, onclick: () => (it.tool ? this.selectTool(it.tool) : it.run()) }, icon(it.icon), it.label);
    }));
    const head = h('div', { class: 'lp-head' }, ibtn('chevL', 'Back to all tools', () => this.closeGroup()), h('span', { class: 't' }, g.label));
    this.left.replaceChildren(head, body);
    if (g.extra) Promise.resolve(g.extra()).then((n) => { if (this.group === g && n) body.append(n); }).catch(errToast);
    this.left.classList.remove('collapsed');
  }
  onToolChanged() { if (this.group) { this.left.querySelectorAll('.lp-item[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === this.overlay.tool)); } }
  selectTool(t, opts) {
    if (!this.doc) return;
    if (this.app.editor.on && t !== 'edit') this.app.editor.commitInput();
    this.app.organizer.hide();
    this.overlay.setTool(this.overlay.tool === t ? (this.app.editor.on ? 'edit' : 'select') : t, opts);
  }

  // --- Tools on the page -------------------------------------------------------------------
  registerTools() {
    const ov = () => this.overlay;
    const reg = (n, fn, o) => setTimeout(() => this.overlay.registerRect(n, this.guard(fn), o), 0);
    const click = (n, fn, o) => setTimeout(() => this.overlay.registerClick(n, this.guard(fn), o), 0);
    reg('add-text', async (i, rect, p0) => {
      if (!this.app.editor.on) await this.app.editor.enable();
      this.overlay.setTool(this.app.editor.on ? 'edit' : 'select');
      this.app.editor.startNewText(i, p0, rect);
    }, { keep: true });
    reg('add-image', (i, rect, p0) => this.addImageAt(i, rect, p0));
    reg('add-link', (i, rect) => this.addLinkAt(i, rect), { needsDrag: true });
    reg('crop', (i, rect) => this.cropTo(i, rect), { needsDrag: true });
    reg('snapshot', (i, rect) => this.snapshot(i, rect), { needsDrag: true });
    reg('redact-area', async (i, rect) => { await ov().add({ type: 'redact', page: i, rect, quads: [quadFromRect(rect)], color: [0.85, 0, 0], opacity: 1, contents: '' }); }, { needsDrag: true, keep: true });
    reg('digital-sign', (i, rect) => this.digitalSign({ page: i, rect }), { needsDrag: true });
    for (const t of ['text', 'multiline', 'checkbox', 'radio', 'dropdown', 'list', 'button', 'signature']) reg(`form-${t}`, (i, rect, p0) => this.addField(t, i, rect, p0));
    reg('measure-dist', (i, rect, p0, e, p1) => this.measureDistance(i, p0, p1), { needsDrag: true, keep: true });
    reg('place-stamp', (i, rect, p0) => this.placeStamp(i, rect, p0));
    click('fs-text', (i, p) => this.fsText(i, p));
    click('fs-check', (i, p) => this.fsMark(i, p, 'check'));
    click('fs-cross', (i, p) => this.fsMark(i, p, 'cross'));
    click('fs-dot', (i, p) => ov().add({ type: 'ellipse', page: i, rect: [p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], color: [0, 0, 0], fill: [0, 0, 0], width: 1, opacity: 1, contents: '' }));
    click('fs-date', (i, p) => this.fsDate(i, p));
  }

  async addTextAt(i, rect, p0) {
    const r = await formDialog('Add text', [
      { k: 'text', label: 'Text', type: 'textarea', required: true },
      { k: 'family', label: 'Font', type: 'select', options: ops.fontFamilies(), value: this.app.editor.newStyle.family },
      { k: 'size', label: 'Size (pt)', type: 'number', value: this.app.editor.newStyle.size, min: 4, max: 200, step: 0.5 },
      { k: 'color', label: 'Color', type: 'color', value: '#181210' }, { k: 'bold', label: 'Bold', type: 'checkbox' }, { k: 'italic', label: 'Italic', type: 'checkbox' },
      { k: 'align', label: 'Orientation', type: 'select', options: [['left', 'Left'], ['center', 'Centered'], ['right', 'Right']], value: 'left' },
    ], { ok: 'Insert' });
    if (!r) return;
    const box = rect || [p0[0], p0[1] - 400, Math.min(p0[0] + 400, this.doc.pages[i].view[2] - 20), p0[1]];
    await this.mutate((b) => ops.addTextBlock(b, i, box, r.text, r, readFont), { pages: [i] });
    this.app.editor.invalidate();
  }
  async chooseImage(title) {
    const [p] = await window.dp.openDialog({ title: title || 'Choose image', filters: IMG_FILTER });
    if (!p) return null;
    const norm = await normalizeImage(await window.dp.readFile(p), p);
    const bmp = await createImageBitmap(new Blob([norm.bytes]));
    return { ...norm, width: bmp.width, height: bmp.height, name: p };
  }
  async addImageAt(i, rect, p0) {
    const img = await this.chooseImage('Add image');
    if (!img) return;
    const box = this.fitBox(rect, p0, img.width * 0.75, img.height * 0.75, i);
    await this.mutate((b) => ops.addImage(b, i, box, img.bytes, img.mime), { pages: [i] });
    this.app.editor.invalidate();
  }
  fitBox(rect, p0, w0, h0, i) {
    const view = this.doc.pages[i].view;
    if (rect) { const s = Math.min((rect[2] - rect[0]) / w0, (rect[3] - rect[1]) / h0); return [rect[0], rect[3] - h0 * s, rect[0] + w0 * s, rect[3]]; }
    const s = Math.min(1, (view[2] - view[0]) * 0.6 / w0, (view[3] - view[1]) * 0.6 / h0);
    return [p0[0], p0[1] - h0 * s, p0[0] + w0 * s, p0[1]];
  }
  async addLinkAt(i, rect) {
    const r = await formDialog('Add link', [
      { k: 'kind', label: 'Target', type: 'select', options: [['url', 'Web address'], ['page', 'Page in document']], value: 'url' },
      { k: 'url', label: 'Web address', value: 'https://' }, { k: 'page', label: 'Page', type: 'number', value: 1, min: 1, max: this.doc.numPages },
    ], { validate: (v) => (v.kind === 'url' && !/^(https?:\/\/.+|mailto:.+)/i.test(v.url) ? 'Please enter a valid web address.' : null) });
    if (!r) return;
    await this.mutate((b) => ops.addLink(b, i, rect, r.kind === 'url' ? { url: r.url } : { page: r.page - 1 }), { pages: [i] });
  }
  async removeLinks() {
    const r = await formDialog('Remove links', [this.range()], { validate: this.validateRange, ok: 'Remove' });
    if (!r) return;
    const pages = this.pagesOf(r);
    await this.mutate(async (b) => { let out = b; for (const p of pages) out = await ops.removeLinks(out, p, null); return out; }, { pages });
  }
  async cropTo(i, rect) {
    const c = await messageBox('Crop', 'Which pages should the crop be applied to?', ['This page only', 'All pages', 'Cancel']);
    if (c === 2) return;
    await this.mutate((b) => ops.cropPages(b, c === 0 ? [i] : this.doc.pages.map((_, k) => k), { rect }));
  }
  async cropDialog() {
    const r = await formDialog('Crop margins', [
      { k: 'top', label: 'Top (mm)', type: 'number', value: 10, min: 0, step: 0.5 }, { k: 'bottom', label: 'Bottom (mm)', type: 'number', value: 10, min: 0, step: 0.5 },
      { k: 'left', label: 'Left (mm)', type: 'number', value: 10, min: 0, step: 0.5 }, { k: 'right', label: 'Right (mm)', type: 'number', value: 10, min: 0, step: 0.5 }, this.range(),
    ], { validate: this.validateRange, ok: 'Crop' });
    if (!r) return;
    await this.mutate((b) => ops.cropPages(b, this.pagesOf(r), { top: r.top * MM, bottom: r.bottom * MM, left: r.left * MM, right: r.right * MM }));
  }
  async resizeDialog() {
    const r = await formDialog('Change page size', [{ k: 'size', label: 'Format', type: 'select', options: SIZES, value: SIZES[0][0] }, this.range()], { validate: this.validateRange });
    if (!r) return;
    await this.mutate((b) => ops.resizePages(b, this.pagesOf(r), parseSize(r.size)));
  }
  async snapshot(i, rect) {
    const { canvas, viewport } = await this.viewer.renderToCanvas(i, 200);
    const a = viewport.convertToViewportPoint(rect[0], rect[1]); const b = viewport.convertToViewportPoint(rect[2], rect[3]);
    const x = Math.min(a[0], b[0]); const y = Math.min(a[1], b[1]); const w = Math.abs(a[0] - b[0]); const ht = Math.abs(a[1] - b[1]);
    const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, ht);
    c.getContext('2d').drawImage(canvas, x, y, w, ht, 0, 0, c.width, c.height);
    await window.dp.clipboardWriteImage(await canvasBytes(c, 'image/png'));
    toast('Snapshot copied to clipboard', 'ok');
  }

  async headerFooter() {
    const r = await formDialog('Header & footer', [
      { type: 'info', label: 'Placeholders: {page}, {pages}, {date}, {file}' },
      { k: 'left', label: 'Header left' }, { k: 'center', label: 'Header center' }, { k: 'right', label: 'Header right' },
      { k: 'footLeft', label: 'Footer left' }, { k: 'footCenter', label: 'Footer center' }, { k: 'footRight', label: 'Footer right', value: 'Page {page} of {pages}' },
      { k: 'size', label: 'Font size', type: 'number', value: 10, min: 4, max: 72 }, { k: 'color', label: 'Color', type: 'color', value: '#181210' }, { k: 'margin', label: 'Margin (mm)', type: 'number', value: 10, min: 0 }, { k: 'startNumber', label: 'First number', type: 'number', value: 1, min: 0 }, this.range(),
    ], { validate: this.validateRange, ok: 'Add' });
    if (!r) return;
    await this.mutate((b) => ops.addHeaderFooter(b, { ...r, margin: r.margin * MM, pages: this.pagesOf(r), fileName: this.doc.name }, readFont));
  }
  async pageNumbers() {
    const r = await formDialog('Insert page numbers', [
      { k: 'pos', label: 'Position', type: 'select', options: [['footCenter', 'Bottom center'], ['footRight', 'Bottom right'], ['footLeft', 'Bottom left'], ['center', 'Top center'], ['right', 'Top right'], ['left', 'Top left']], value: 'footCenter' },
      { k: 'fmt', label: 'Format', type: 'select', options: [['{page}', '1'], ['Page {page}', 'Page 1'], ['Page {page} of {pages}', 'Page 1 of 5'], ['{page}/{pages}', '1/5']], value: '{page}' }, this.range(),
    ], { validate: this.validateRange, ok: 'Insert' });
    if (!r) return;
    await this.mutate((b) => ops.addHeaderFooter(b, { [r.pos]: r.fmt, pages: this.pagesOf(r) }, readFont));
  }
  async watermark() {
    const r = await formDialog('Watermark', [
      { k: 'kind', label: 'Type', type: 'select', options: [['text', 'Text'], ['image', 'Image from file']], value: 'text' },
      { k: 'text', label: 'Text', value: 'CONFIDENTIAL' }, { k: 'size', label: 'Font size', type: 'number', value: 64, min: 6, max: 300 }, { k: 'color', label: 'Color', type: 'color', value: '#0e7c86' },
      { k: 'scale', label: 'Image size (%)', type: 'number', value: 50, min: 1, max: 500 }, { k: 'opacity', label: 'Opacity (%)', type: 'number', value: 30, min: 1, max: 100 }, { k: 'rotation', label: 'Rotation (degrees)', type: 'number', value: 45, min: -180, max: 180 },
      { k: 'position', label: 'Position', type: 'select', options: [['center', 'Center'], ['top', 'Top'], ['bottom', 'Bottom'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']], value: 'center' }, this.range(),
    ], { validate: (v) => this.validateRange(v) || (v.kind === 'text' && !v.text.trim() ? 'Please enter text.' : null), ok: 'Add' });
    if (!r) return;
    const o = { size: r.size, color: r.color, opacity: r.opacity / 100, rotation: r.rotation, position: r.position, pages: this.pagesOf(r) };
    if (r.kind === 'image') { const im = await this.chooseImage('Watermark image'); if (!im) return; Object.assign(o, { image: im.bytes, mime: im.mime, scale: r.scale / 100 }); } else o.text = r.text;
    await this.mutate((b) => ops.addWatermark(b, o, readFont));
  }
  async background() {
    const r = await formDialog('Background', [{ k: 'color', label: 'Color', type: 'color', value: '#eef8f8' }, { k: 'opacity', label: 'Opacity (%)', type: 'number', value: 100, min: 1, max: 100 }, this.range()], { validate: this.validateRange, ok: 'Add' });
    if (r) await this.mutate((b) => ops.addBackground(b, { color: r.color, opacity: r.opacity / 100, pages: this.pagesOf(r) }));
  }
  async bates() {
    const r = await formDialog('Bates numbering', [{ k: 'prefix', label: 'Prefix', value: 'DP-' }, { k: 'suffix', label: 'Suffix' }, { k: 'start', label: 'Start number', type: 'number', value: 1, min: 0 }, { k: 'digits', label: 'Digits', type: 'number', value: 6, min: 1, max: 15 }, { k: 'position', label: 'Position', type: 'select', options: [['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-right', 'Top right'], ['top-left', 'Top left'], ['bottom', 'Bottom center']], value: 'bottom-right' }, this.range()], { validate: this.validateRange, ok: 'Add' });
    if (r) await this.mutate((b) => ops.addBates(b, { ...r, pages: this.pagesOf(r) }, readFont));
  }
  async pageLabels() {
    const r = await formDialog('Page labels', [{ k: 'from', label: 'From page', type: 'number', value: 1, min: 1, max: this.doc.numPages }, { k: 'style', label: 'Style', type: 'select', options: [['D', '1, 2, 3'], ['r', 'i, ii, iii'], ['R', 'I, II, III'], ['a', 'a, b, c'], ['A', 'A, B, C']], value: 'D' }, { k: 'prefix', label: 'Prefix' }, { k: 'start', label: 'Start with', type: 'number', value: 1, min: 1 }]);
    if (!r) return;
    const ranges = r.from > 1 ? [{ from: 0, style: 'D' }, { from: r.from - 1, style: r.style, prefix: r.prefix, start: r.start }] : [{ from: 0, style: r.style, prefix: r.prefix, start: r.start }];
    await this.mutate((b) => ops.setPageLabels(b, ranges));
  }

  // --- Pages ---------------------------------------------------------------------------------
  async deletePagesAsk(list) {
    const c = await messageBox('Delete pages', `${list.length} page(s) will be deleted. Continue?`, ['Delete', 'Cancel'], { primary: 1 });
    if (c !== 0) return;
    await this.guard(() => this.mutate((b) => ops.deletePages(b, list)))();
    this.app.organizer.sel.clear();
  }
  insertBlankAt(at) { return this.guard(() => this.mutate((b) => ops.insertBlank(b, at)))(); }
  async pickPdf(title) {
    const [p] = await window.dp.openDialog({ title, filters: conv.CREATE_FILTERS });
    if (!p) return null;
    return { bytes: await conv.fileToPdf(p), name: p.split(/[\\/]/).pop() };
  }
  insertFromFile(at) {
    return this.guard(async () => {
      const f = await this.pickPdf('Insert file');
      if (f) await this.mutate((b) => ops.insertPdf(b, f.bytes, at));
    })();
  }
  replaceFromFile(list) {
    return this.guard(async () => {
      const f = await this.pickPdf('Replace with');
      if (f) await this.mutate((b) => ops.replacePages(b, list[0], list.length, f.bytes));
    })();
  }
  extract(list) {
    return this.guard(async () => {
      const r = await formDialog('Extract pages', [{ type: 'info', label: `${list.length} page(s) will be copied to a new document.` }, { k: 'remove', label: 'Then delete them from this document', type: 'checkbox' }], { ok: 'Extract' });
      if (!r) return;
      await this.doc.commitForms();
      const base = fileBase(this.doc.name);
      const out = await ops.extractPages(await this.doc.buildOutput({ noEncrypt: true }), list);
      if (r.remove) await this.mutate((b) => ops.deletePages(b, list));
      await this.app.openBytes(out, `${base}_Extract.pdf`, { unsaved: true });
    })();
  }
  async split() {
    const n = this.doc.numPages;
    const r = await formDialog('Split document', [
      { k: 'mode', label: 'Split by', type: 'select', options: [['count', 'Number of pages per file'], ['ranges', 'Page ranges'], ['bookmarks', 'Top-level bookmarks']], value: 'count' },
      { k: 'count', label: 'Pages per file', type: 'number', value: 1, min: 1, max: n }, { k: 'ranges', label: 'Ranges (separated by ;)', placeholder: '1-3; 4-6' },
    ], { ok: 'Next' });
    if (!r) return;
    let ranges;
    if (r.mode === 'count') ranges = ops.chunkRanges(n, Math.max(1, r.count));
    else if (r.mode === 'ranges') ranges = r.ranges.split(';').filter((s) => s.trim()).map((s) => ops.parseRange(s, n));
    else {
      const o = (await this.app.panels.loadOutline()).filter((x) => x.page !== undefined);
      if (!o.length) throw new Error('This document has no bookmarks.');
      ranges = o.map((x, i) => { const end = i + 1 < o.length ? o[i + 1].page : n; return Array.from({ length: Math.max(1, end - x.page) }, (_, k) => x.page + k); });
    }
    if (!ranges.length) throw new Error('No ranges specified.');
    const dir = await window.dp.folderDialog('Choose destination folder');
    if (!dir) return;
    const base = fileBase(this.doc.name);
    const bytes = await this.doc.buildOutput({ noEncrypt: true });
    await busy('Splitting document', async (p) => {
      for (let i = 0; i < ranges.length; i++) {
        await window.dp.writeFile(`${dir}\\${base}_Part${String(i + 1).padStart(String(ranges.length).length, '0')}.pdf`, await ops.extractPages(bytes, ranges[i]));
        p((i + 1) / ranges.length, `File ${i + 1} of ${ranges.length}`);
      }
    });
    toast(`${ranges.length} files saved`, 'ok');
    window.dp.openPath(dir);
  }

  async combine() {
    const files = [];
    const list = h('div', {});
    const draw = () => list.replaceChildren(...(files.length ? files.map((f, i) => h('div', { class: 'kv' }, h('span', { class: 'g', title: f }, f.split(/[\\/]/).pop()),
      ibtn('chevU', 'Move up', () => { if (i > 0) { [files[i - 1], files[i]] = [files[i], files[i - 1]]; draw(); } }), ibtn('chevD', 'Move down', () => { if (i < files.length - 1) { [files[i + 1], files[i]] = [files[i], files[i + 1]]; draw(); } }), ibtn('x', 'Remove', () => { files.splice(i, 1); draw(); }))) : [h('div', { class: 'empty' }, 'No files chosen yet.')]));
    if (this.doc?.path) files.push(this.doc.path);
    draw();
    const add = h('button', { class: 'btn', type: 'button', style: { marginTop: '8px' }, onclick: async () => { files.push(...await window.dp.openDialog({ title: 'Add files', multi: true, filters: conv.CREATE_FILTERS })); draw(); } }, 'Add files');
    const r = await formDialog('Combine files', [{ type: 'node', node: h('div', {}, list, add) }], { ok: 'Combine', validate: () => (files.length < 2 ? 'Please choose at least two files.' : null) });
    if (!r) return;
    const out = await busy('Combining files', async (p) => {
      const items = [];
      for (let i = 0; i < files.length; i++) { items.push({ bytes: await conv.fileToPdf(files[i]) }); p((i + 1) / files.length / 2, files[i].split(/[\\/]/).pop()); }
      return ops.mergePdfs(items);
    });
    await this.app.openBytes(out, 'Combined.pdf', { unsaved: true });
  }

  // --- Kommentare -------------------------------------------------------------------------
  stampGrid() {
    return h('div', { class: 'stamp-grid' }, STAMPS.map(([text, color]) => h('button', { class: 'stamp-btn', type: 'button', style: { color: cssColor(color), borderColor: cssColor(color) }, data: { stamp: text }, onclick: async () => {
      const r = await formDialog('Stamp', [{ k: 'dyn', label: 'Add name and date', type: 'checkbox', value: true }], { ok: 'Place' });
      if (!r) return;
      this.pendingStamp = { text, color, sub: r.dyn ? `${this.app.userName()}, ${new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}` : '' };
      this.selectTool('place-stamp');
    } }, text)));
  }
  async customStamp() {
    const im = await this.chooseImage('Choose stamp image');
    if (!im) return;
    this.pendingStamp = { image: toBase64(im.bytes), mime: im.mime, width: im.width, height: im.height };
    this.selectTool('place-stamp');
  }
  async placeStamp(i, rect, p0) {
    const st = this.pendingStamp;
    if (!st) return;
    let r = rect;
    if (st.image) { const s = Math.min(1, 200 / (st.width * 0.75)); const w = st.width * 0.75 * s; const ht = st.height * 0.75 * s; r = rect || [p0[0], p0[1] - ht, p0[0] + w, p0[1]]; } else r = rect || [p0[0], p0[1] - 54, p0[0] + 190, p0[1]];
    await this.overlay.add({ type: 'stamp', page: i, rect: r, stamp: st, opacity: 1, contents: '', color: null });
  }
  async flattenComments() {
    const c = await messageBox('Flatten comments', 'All comments are drawn permanently into the pages and can no longer be edited afterwards.', ['Flatten', 'Cancel'], { primary: 1 });
    if (c !== 0) return;
    await this.guard(() => this.mutate(async (b) => {
      const d = await loadForEdit(b);
      await writeAnnotations(d, this.doc.annots, readFont);
      flattenAnnotationsInDoc(d);
      this.doc.annots = new Map();
      return saveDoc(d);
    }))();
  }
  async deleteAllComments() {
    const c = await messageBox('Delete comments', 'Delete all comments in this document?', ['Delete', 'Cancel'], { primary: 1 });
    if (c !== 0) return;
    this.doc.pushUndo(); this.doc.annots = new Map(); this.doc.markDirty();
    this.doc.emit('reload', { annotOnly: true });
  }
  async commentSummary() {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const rows = this.doc.allAnnots().map((a) => `<tr><td>${a.page + 1}</td><td>${esc(a.subject)}</td><td>${esc(a.author)}</td><td>${a.modified ? new Date(a.modified).toLocaleString('en-GB') : ''}</td><td>${esc(a.contents)}${a.replies.map((r) => `<br><i>${esc(r.author)}:</i> ${esc(r.contents)}`).join('')}</td></tr>`).join('');
    const out = await window.dp.htmlToPdf(`<!doctype html><meta charset="utf-8"><style>body{font-family:Arial;font-size:10pt}h1{font-size:15pt;color:#0e7c86}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:4px;text-align:left;vertical-align:top}</style><h1>Comment summary: ${esc(this.doc.name)}</h1><table><tr><th>Page</th><th>Type</th><th>Author</th><th>Date</th><th>Content</th></tr>${rows}</table>`);
    await this.app.openBytes(out, `${fileBase(this.doc.name)}_Comments.pdf`, { unsaved: true });
  }
  async exportXfdf() {
    const X = { highlight: 'highlight', underline: 'underline', strikeout: 'strikeout', squiggly: 'squiggly', note: 'text', freetext: 'freetext', rect: 'square', ellipse: 'circle', line: 'line', arrow: 'line', polygon: 'polygon', polyline: 'polyline', ink: 'ink', callout: 'freetext', cloud: 'polygon', caret: 'caret' };
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const body = this.doc.allAnnots().filter((a) => X[a.type]).map((a) => {
      const r = boundsOf(a);
      let attrs = `page="${a.page}" rect="${r.join(',')}" name="${esc(a.id)}" title="${esc(a.author)}" subject="${esc(a.subject)}" opacity="${a.opacity ?? 1}"`;
      if (a.color) attrs += ` color="${rgbToHex(a.color).toUpperCase()}"`;
      if (a.quads) attrs += ` coords="${a.quads.flat().join(',')}"`;
      if (a.type === 'line' || a.type === 'arrow') attrs += ` start="${a.points[0].join(',')}" end="${a.points[1].join(',')}"`;
      if (a.width) attrs += ` width="${a.width}"`;
      let inner = `<contents>${esc(a.contents)}</contents>`;
      if (a.points && (a.type.startsWith('poly') || a.type === 'cloud')) inner += `<vertices>${a.points.flat().join(',')}</vertices>`;
      if (a.type === 'ink') inner += `<inklist>${a.strokes.map((s) => `<gesture>${s.map((p) => p.join(',')).join(';')}</gesture>`).join('')}</inklist>`;
      return `<${X[a.type]} ${attrs}>${inner}</${X[a.type]}>`;
    }).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots>\n${body}\n</annots></xfdf>`;
    const p = await window.dp.saveDialog({ title: 'Export comments', defaultPath: `${fileBase(this.doc.name)}.xfdf`, filters: [{ name: 'XFDF', extensions: ['xfdf'] }] });
    if (p) { await window.dp.writeFile(p, new TextEncoder().encode(xml)); toast('Comments exported', 'ok'); }
  }
  async importXfdf() {
    const [p] = await window.dp.openDialog({ title: 'Import comments', filters: [{ name: 'XFDF', extensions: ['xfdf', 'xml'] }] });
    if (!p) return;
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(await window.dp.readFile(p)), 'application/xml');
    const annots = xml.getElementsByTagName('annots')[0];
    if (!annots) throw new Error('The file contains no comments.');
    const MAP = { highlight: 'highlight', underline: 'underline', strikeout: 'strikeout', squiggly: 'squiggly', text: 'note', freetext: 'freetext', square: 'rect', circle: 'ellipse', line: 'line', polygon: 'polygon', polyline: 'polyline', ink: 'ink', caret: 'caret' };
    const nums = (s) => (s || '').split(/[,;\s]+/).filter(Boolean).map(Number);
    const pairs = (a) => { const o = []; for (let i = 0; i + 1 < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; };
    let count = 0;
    this.doc.pushUndo();
    for (const el of annots.children) {
      const type = MAP[el.localName];
      const page = +el.getAttribute('page');
      if (!type || !(page >= 0 && page < this.doc.numPages)) continue;
      const rect = nums(el.getAttribute('rect'));
      const contents = el.getElementsByTagName('contents')[0]?.textContent || '';
      const c = el.getAttribute('color');
      const a = { id: newId(), type, page, rect, contents, author: el.getAttribute('title') || '', subject: el.getAttribute('subject') || '', opacity: parseFloat(el.getAttribute('opacity') || '1'), color: c ? hexToRgb(c) : [1, 0.82, 0], width: parseFloat(el.getAttribute('width') || '1'), modified: new Date().toISOString(), replies: [], status: null };
      const q = nums(el.getAttribute('coords'));
      if (q.length) { a.quads = []; for (let i = 0; i + 8 <= q.length; i += 8) a.quads.push(q.slice(i, i + 8)); } else if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(type)) a.quads = [quadFromRect(rect)];
      if (type === 'line') a.points = [nums(el.getAttribute('start')), nums(el.getAttribute('end'))];
      if (type === 'polygon' || type === 'polyline') a.points = pairs(nums(el.getElementsByTagName('vertices')[0]?.textContent));
      if (type === 'ink') a.strokes = [...el.getElementsByTagName('gesture')].map((g) => pairs(nums(g.textContent)));
      if (type === 'freetext') { a.fontSize = 12; a.textColor = [0, 0, 0]; a.color = null; }
      if (type === 'note') a.rect = [rect[0], rect[1], rect[0] + 20, rect[1] + 20];
      this.doc.list(page).push(a); count++;
    }
    this.doc.markDirty(); this.doc.emit('reload', { annotOnly: true }); this.app.panels.commentsChanged();
    toast(`${count} comments imported`, 'ok');
  }

  // --- Fill and sign ---------------------------------------------------------------------------
  async fsText(i, p) {
    const a = await this.overlay.add({ type: 'freetext', page: i, rect: [p[0], p[1] - 7, p[0] + 200, p[1] + 13], contents: '', color: null, textColor: [0, 0, 0], fontSize: 12, fill: null, opacity: 1, subject: 'Text' });
    if (a) setTimeout(() => this.overlay.editFreeText(a), 30);
  }
  fsMark(i, p, kind) {
    const s = 7;
    const strokes = kind === 'check' ? [[[p[0] - s, p[1]], [p[0] - 2, p[1] - s + 1], [p[0] + s, p[1] + s]]] : [[[p[0] - s, p[1] - s], [p[0] + s, p[1] + s]], [[p[0] - s, p[1] + s], [p[0] + s, p[1] - s]]];
    return this.overlay.add({ type: 'ink', page: i, rect: [0, 0, 1, 1], strokes, color: [0, 0, 0], width: 1.6, opacity: 1, contents: '' });
  }
  fsDate(i, p) {
    return this.overlay.add({ type: 'freetext', page: i, rect: [p[0], p[1] - 7, p[0] + 90, p[1] + 13], contents: new Date().toLocaleDateString('en-GB'), color: null, textColor: [0, 0, 0], fontSize: 12, fill: null, opacity: 1, subject: 'Date' });
  }
  signSummary() {
    const s = this.app.settings;
    return h('div', { class: 'lp-note' }, s.signature ? h('div', {}, h('b', {}, 'Your signature'), h('img', { src: `data:image/png;base64,${s.signature.image}`, style: { maxWidth: '100%', maxHeight: '60px', display: 'block', background: '#fff', border: '1px solid var(--line)', marginTop: '4px' } })) : 'No signature set up yet.');
  }
  async signSetup(kind) {
    const title = kind === 'signature' ? 'Set up signature' : 'Set up initials';
    const pad = h('canvas', { class: 'sign-pad', width: 880, height: 300, 'aria-label': 'Signature pad' });
    const ctx = pad.getContext('2d');
    ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#10234a';
    let drawn = false; let down = false;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
    pad.addEventListener('pointerdown', (e) => { down = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
    pad.addEventListener('pointermove', (e) => { if (down) { ctx.lineTo(...pos(e)); ctx.stroke(); drawn = true; } });
    pad.addEventListener('pointerup', () => { down = false; });
    const typed = h('input', { type: 'text', placeholder: 'Or type your name', style: { width: '100%', height: '30px', marginBottom: '8px', padding: '0 6px', border: '1px solid var(--line)', borderRadius: '4px' }, value: kind === 'signature' ? this.app.userName() : '' });
    const fromFile = { val: null };
    const node = h('div', {}, typed, pad, h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
      h('button', { class: 'btn', type: 'button', onclick: () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; } }, 'Delete'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { fromFile.val = await this.chooseImage('Signature image'); if (fromFile.val) toast('Image applied'); } }, 'Choose image')));
    const r = await formDialog(title, [{ type: 'node', node }], { ok: 'Save', wide: true, validate: () => (!drawn && !fromFile.val && !typed.value.trim() ? 'Please draw, type or choose an image.' : null) });
    if (!r) return;
    let out;
    if (fromFile.val) out = { image: toBase64(fromFile.val.bytes), mime: fromFile.val.mime, width: fromFile.val.width, height: fromFile.val.height };
    else {
      let c = pad;
      if (!drawn) { c = document.createElement('canvas'); c.width = 880; c.height = 300; const x = c.getContext('2d'); x.font = 'italic 110px "Segoe Script","Brush Script MT",cursive'; x.fillStyle = '#10234a'; x.textBaseline = 'middle'; x.fillText(typed.value.trim(), 30, 150, 820); }
      const t = this.trim(c);
      out = { image: toBase64(await canvasBytes(t, 'image/png')), mime: 'image/png', width: t.width, height: t.height };
    }
    this.app.settings[kind] = out;
    await this.app.saveSettings();
    if (this.group?.id === 'fillsign') this.renderGroup();
    toast('Saved', 'ok');
  }
  trim(c) {
    const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let x0 = width; let y0 = height; let x1 = 0; let y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 <= x0) return c;
    const t = document.createElement('canvas'); t.width = x1 - x0 + 8; t.height = y1 - y0 + 8;
    t.getContext('2d').drawImage(c, x0 - 4, y0 - 4, t.width, t.height, 0, 0, t.width, t.height);
    return t;
  }
  async placeSignature(kind) {
    if (!this.app.settings[kind]) await this.signSetup(kind);
    const s = this.app.settings[kind];
    if (!s) return;
    const scale = (kind === 'signature' ? 150 : 60) / s.width;
    this.pendingStamp = { ...s, width: s.width * scale / 0.75, height: s.height * scale / 0.75 };
    this.selectTool('place-stamp');
  }

  // --- Zertifikate ------------------------------------------------------------------------
  async createId() {
    const r = await formDialog('Create digital ID', [
      { type: 'info', label: 'The ID is self-signed. Recipients see it as "identity unverified" until they mark your certificate as trusted.' },
      { k: 'name', label: 'Name', required: true, value: this.app.userName() }, { k: 'org', label: 'Organization', value: this.app.settings.org || '' }, { k: 'email', label: 'Email', value: this.app.settings.email || '' },
      { k: 'password', label: 'Password', type: 'password', required: true }, { k: 'password2', label: 'Repeat password', type: 'password', required: true }, { k: 'years', label: 'Validity (years)', type: 'number', value: 5, min: 1, max: 30 },
    ], { ok: 'Create', validate: (v) => (v.password !== v.password2 ? 'The passwords do not match.' : v.password.length < 6 ? 'The password needs at least 6 characters.' : null) });
    if (!r) return;
    const p = await window.dp.saveDialog({ title: 'Save digital ID', defaultPath: `${r.name.replace(/[^\w-]+/g, '_')}.pfx`, filters: [{ name: 'Digital ID', extensions: ['pfx', 'p12'] }] });
    if (!p) return;
    const data = await busy('Creating digital ID', () => createDigitalId(r));
    await window.dp.writeFile(p, data);
    this.app.settings.lastPfx = p; await this.app.saveSettings();
    toast('Digital ID saved', 'ok');
  }
  async digitalSign(visible) {
    const doc = this.doc;
    if (doc.security) throw new Error('Protected documents cannot be signed. Please remove the security first.');
    if (doc.signed) { const c = await messageBox('Already signed', 'The document already contains a signature. Another signature will invalidate the existing one, because additional signatures are not saved incrementally. Continue anyway?', ['Continue', 'Cancel'], { primary: 1 }); if (c !== 0) return; }
    let path = this.app.settings.lastPfx;
    const stat = path ? await window.dp.fileStat(path) : null;
    if (!stat) { [path] = await window.dp.openDialog({ title: 'Choose digital ID', filters: [{ name: 'Digital ID', extensions: ['pfx', 'p12'] }] }); if (!path) return; }
    const r = await formDialog('Sign digitally', [{ type: 'info', label: `Digital ID: ${path.split(/[\\/]/).pop()}` }, { k: 'password', label: 'ID password', type: 'password', required: true }, { k: 'reason', label: 'Reason', value: 'I approve this document' }, { k: 'location', label: 'Location' }], { ok: 'Sign' });
    if (!r) return;
    const target = await window.dp.saveDialog({ title: 'Save signed document', defaultPath: doc.suggestedPath('_signed') });
    if (!target) return;
    const p12 = await window.dp.readFile(path);
    const out = await busy('Signing document', async () => signPdf(await doc.buildOutput({ noEncrypt: true }), { p12, password: r.password, reason: r.reason, location: r.location, visible: visible || undefined }));
    await window.dp.writeFile(target, out);
    this.app.settings.lastPfx = path; await this.app.saveSettings();
    doc.dirty = false;
    await this.app.closeDoc(doc, true);
    await this.app.openPath(target);
    this.app.panels.show('signatures');
    toast('Document signed', 'ok');
  }

  // --- Formulare --------------------------------------------------------------------------
  async addField(type, i, rect, p0) {
    const defaultSize = { checkbox: [14, 14], radio: [14, 14], text: [200, 22], multiline: [240, 80], dropdown: [180, 22], list: [180, 70], button: [110, 26], signature: [220, 50] }[type];
    const box = rect || [p0[0], p0[1] - defaultSize[1], p0[0] + defaultSize[0], p0[1]];
    const existing = await ops.listFormFields(this.doc.bytes);
    const base = { text: 'Text box', multiline: 'Text box', checkbox: 'Check box', radio: 'Radio group', dropdown: 'Dropdown', list: 'List', button: 'Button', signature: 'Signature' }[type];
    let n = 1; while (existing.some((f) => f.name === `${base}${n}`)) n++;
    const fields = [{ k: 'name', label: 'Field name', value: type === 'radio' && existing.some((f) => f.type === 'RadioGroup') ? existing.filter((f) => f.type === 'RadioGroup').pop().name : `${base}${n}`, required: true }];
    if (type === 'radio') fields.push({ k: 'value', label: 'Value of this option', value: `Option${n}`, required: true });
    if (type === 'button') fields.push({ k: 'value', label: 'Label', value: 'Submit' });
    if (type === 'text' || type === 'multiline') fields.push({ k: 'value', label: 'Default value' });
    if (type === 'dropdown' || type === 'list') fields.push({ k: 'options', label: 'Items (one per line)', type: 'textarea', value: 'Item 1\nItem 2', required: true });
    if (type !== 'signature' && type !== 'button') fields.push({ k: 'required', label: 'Required', type: 'checkbox' });
    const r = await formDialog('Add field', fields, { ok: 'Add' });
    if (!r) return;
    await this.mutate((b) => ops.addFormField(b, i, box, { ...r, type, options: r.options ? r.options.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : undefined }), { pages: [i] });
    if (this.group?.id === 'form') this.renderGroup();
  }
  async formFieldsList() {
    const list = await ops.listFormFields(this.doc.bytes).catch(() => []);
    if (!list.length) return h('div', { class: 'lp-note' }, 'This document has no form fields yet.');
    return h('div', {}, h('div', { class: 'lp-sub' }, `Fields (${list.length})`), list.map((f) => h('div', { class: 'kv', style: { padding: '3px 8px' } },
      h('button', { class: 'res', type: 'button', title: f.type, style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, onclick: () => { if (f.page >= 0) this.viewer.goto(f.page, f.rect ? { pdfY: f.rect[3] + 30 } : {}); } }, f.name),
      ibtn('more', 'Options', (e) => contextMenu(e.clientX, e.clientY, [
        { label: f.required ? 'Make optional' : 'Make required', run: this.guard(async () => { await this.mutate((b) => ops.setFieldFlags(b, f.name, { required: !f.required })); this.renderGroup(); }) },
        { label: f.readOnly ? 'Make editable' : 'Read-only', run: this.guard(async () => { await this.mutate((b) => ops.setFieldFlags(b, f.name, { readOnly: !f.readOnly })); this.renderGroup(); }) },
        { label: 'Delete field', run: this.guard(async () => { await this.mutate((b) => ops.removeFormField(b, f.name)); this.renderGroup(); }) },
      ])))));
  }
  toggleFormHighlight() { this.app.formHighlight = !this.app.formHighlight; document.body.classList.toggle('form-hl', this.app.formHighlight); this.viewer.invalidate(); }
  async exportForm() {
    await this.doc.commitForms();
    const data = await ops.exportFormData(this.doc.bytes);
    const p = await window.dp.saveDialog({ title: 'Export form data', defaultPath: `${fileBase(this.doc.name)}_Data.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (p) { await window.dp.writeFile(p, new TextEncoder().encode(JSON.stringify(data, null, 2))); toast('Data exported', 'ok'); }
  }
  async importForm() {
    const [p] = await window.dp.openDialog({ title: 'Import form data', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!p) return;
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await window.dp.readFile(p))); } catch { throw new Error('The file does not contain valid JSON.'); }
    await this.mutate((b) => ops.importFormData(b, data));
  }
  async resetForm() { const c = await messageBox('Reset form', 'Clear all entered values?', ['Reset', 'Cancel'], { primary: 1 }); if (c === 0) await this.mutate((b) => ops.resetForm(b)); }
  async flattenForm() { const c = await messageBox('Flatten form', 'The fields are drawn permanently into the pages and can no longer be filled in afterwards.', ['Flatten', 'Cancel'], { primary: 1 }); if (c === 0) { await this.mutate((b) => ops.flattenForms(b)); if (this.group?.id === 'form') this.renderGroup(); } }

  // --- Schutz -----------------------------------------------------------------------------
  async encryptDialog() {
    const r = await formDialog('Password protection', [
      { k: 'user', label: 'Password to open', type: 'password' }, { k: 'user2', label: 'Redo', type: 'password' },
      { type: 'info', label: 'Optional: a permissions password restricts printing, changing and copying.' },
      { k: 'owner', label: 'Permissions password', type: 'password' },
      { k: 'printing', label: 'Print', type: 'select', options: [['highResolution', 'High resolution'], ['lowResolution', 'Low resolution'], ['none', 'Not allowed']], value: 'highResolution' },
      { k: 'modifying', label: 'Allow changes', type: 'checkbox', value: true }, { k: 'annotating', label: 'Allow commenting', type: 'checkbox', value: true }, { k: 'fillingForms', label: 'Allow filling in forms', type: 'checkbox', value: true }, { k: 'copying', label: 'Allow copying', type: 'checkbox', value: true },
    ], { ok: 'Apply', validate: (v) => (v.user !== v.user2 ? 'The passwords do not match.' : !v.user && !v.owner ? 'Please enter at least one password.' : null) });
    if (!r) return;
    this.doc.security = {
      userPassword: r.user, ownerPassword: r.owner || r.user,
      permissions: { printing: r.printing === 'none' ? false : r.printing, modifying: r.modifying, annotating: r.annotating, fillingForms: r.fillingForms, copying: r.copying, contentAccessibility: true, documentAssembly: r.modifying },
    };
    this.doc.markDirty();
    toast('Protection will be applied the next time you save.', 'ok');
  }
  async removeSecurity() {
    if (!this.doc.security) { toast('This document is not protected.'); return; }
    if (!(await this.doc.allowEdit())) return;
    this.doc.security = null; this.doc.markDirty();
    toast('Protection will be removed the next time you save.', 'ok');
  }
  async sanitize() {
    const r = await formDialog('Sanitize document', [
      { type: 'info', label: 'Removes hidden information from the document. Comments are also deleted if selected.' },
      { k: 'metadata', label: 'Metadata', type: 'checkbox', value: true }, { k: 'attachments', label: 'Attachments', type: 'checkbox', value: true }, { k: 'comments', label: 'Comments', type: 'checkbox', value: true }, { k: 'javascript', label: 'JavaScript and actions', type: 'checkbox', value: true }, { k: 'links', label: 'Left', type: 'checkbox' }, { k: 'forms', label: 'Flatten form fields', type: 'checkbox' }, { k: 'thumbs', label: 'Thumbnails', type: 'checkbox', value: true },
    ], { ok: 'Sanitize' });
    if (!r) return;
    await this.mutate((b) => ops.sanitizeDocument(b, r));
    if (r.comments) { this.doc.annots = new Map(); this.doc.emit('reload', { annotOnly: true }); this.app.panels.commentsChanged(); }
    toast('Document sanitized', 'ok');
  }

  // --- Redact --------------------------------------------------------------------------------
  async redactPages() {
    const r = await formDialog('Redact pages', [this.range()], { validate: this.validateRange, ok: 'Mark' });
    if (!r) return;
    for (const p of this.pagesOf(r)) { const v = this.doc.pages[p].view; await this.overlay.add({ type: 'redact', page: p, rect: [...v], quads: [quadFromRect(v)], color: [0.85, 0, 0], opacity: 1, contents: '' }); }
  }
  async searchRedact() {
    const PRESETS = { iban: 'CH\\d{2}(?:\\s?[0-9A-Z]{4}){4}\\s?[0-9A-Z]', mail: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', ahv: '756\\.\\d{4}\\.\\d{4}\\.\\d{2}', phone: '(?:\\+41|0041|0)\\s?\\d{2}\\s?\\d{3}\\s?\\d{2}\\s?\\d{2}' };
    const r = await formDialog('Find and mark for redaction', [
      { k: 'kind', label: 'Search for', type: 'select', options: [['text', 'Text'], ['iban', 'IBAN (CH)'], ['mail', 'Email addresses'], ['ahv', 'AHV numbers (Swiss social security)'], ['phone', 'Phone numbers (CH)']], value: 'text' },
      { k: 'q', label: 'Text' }, { k: 'cs', label: 'Match case', type: 'checkbox' },
    ], { ok: 'Mark', validate: (v) => (v.kind === 'text' && !v.q.trim() ? 'Please enter search text.' : null) });
    if (!r) return;
    const src = r.kind === 'text' ? r.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') : PRESETS[r.kind];
    const re = new RegExp(src, `gu${r.cs ? '' : 'i'}`);
    let total = 0;
    for (let i = 0; i < this.doc.numPages; i++) {
      const { text, map } = await this.app.find.pageIndex(i);
      const content = await this.doc.pageText(i);
      const quads = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        const perItem = new Map();
        for (let c = m.index; c < m.index + m[0].length; c++) { const e = map[c]; if (!e || e.off < 0) continue; const v = perItem.get(e.item) || [e.off, e.off]; v[1] = e.off; perItem.set(e.item, v); }
        for (const [idx, [a, b]] of perItem) {
          const it = content.items[idx]; const [tx, , , td, e, f] = it.transform; const fh = Math.abs(td) || it.height; const pad = fh * 0.1;
          const sign = tx >= 0 ? 1 : -1;
          quads.push(quadFromRect([e + sign * prefixRatio(it.str, a) * it.width - pad, f - fh * 0.25, e + sign * prefixRatio(it.str, b + 1) * it.width + pad, f + fh * 0.95]));
        }
        total++;
      }
      if (quads.length) { const rs = quads.map(rectFromQuad); await this.overlay.add({ type: 'redact', page: i, rect: [Math.min(...rs.map((x) => x[0])), Math.min(...rs.map((x) => x[1])), Math.max(...rs.map((x) => x[2])), Math.max(...rs.map((x) => x[3]))], quads, color: [0.85, 0, 0], opacity: 1, contents: '' }); }
    }
    toast(total ? `${total} results marked. Please review, then apply.` : 'No results found.', total ? 'ok' : '');
  }
  async applyRedactions() {
    const doc = this.doc;
    const marks = doc.allAnnots().filter((a) => a.type === 'redact');
    if (!marks.length) { toast('No redactions are marked.'); return; }
    const c = await messageBox('Apply redactions', 'The marked content will be permanently removed from the document. Affected pages are rebuilt as images; the remaining text stays searchable.', ['Apply', 'Cancel'], { primary: 1 });
    if (c !== 0) return;
    if (!(await doc.allowEdit())) return;
    await doc.commitForms();
    await busy('Applying redactions', async (progress) => {
      await doc.mutate(async (bytes) => {
        let out = bytes;
        const pages = [...new Set(marks.map((a) => a.page))].sort((a, b) => a - b);
        const invisible = [];
        for (let k = 0; k < pages.length; k++) {
          const p = pages[k];
          const areas = marks.filter((a) => a.page === p).flatMap((a) => a.quads.map(rectFromQuad));
          const { canvas, viewport } = await this.viewer.renderToCanvas(p, 200, { noAnnots: true });
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000';
          for (const r of areas) {
            const a = viewport.convertToViewportPoint(r[0], r[1]); const b = viewport.convertToViewportPoint(r[2], r[3]);
            ctx.fillRect(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1, Math.abs(a[0] - b[0]) + 2, Math.abs(a[1] - b[1]) + 2);
          }
          const jpeg = await canvasBytes(canvas, 'image/jpeg', 0.9);
          canvas.width = 0;
          const info = doc.pages[p];
          const vp1 = doc.page(p).getViewport({ scale: 1 });
          const rot0 = info.rotate === 0;
          const [ox, oy] = [info.view[0], info.view[1]];
          const words = wordBoxes(await doc.pageText(p)).filter((w) => !areas.some((r) => rectsOverlap(w.rect, r, 1)));
          const mapped = [];
          for (const w of words) {
            const a = vp1.convertToViewportPoint(w.x, w.y);
            const e = vp1.convertToViewportPoint(w.x + Math.cos(w.angle) * w.width, w.y + Math.sin(w.angle) * w.width);
            if (Math.abs(a[1] - e[1]) > 1) continue;
            mapped.push({ text: w.text, x: rot0 ? w.x : a[0], y: rot0 ? w.y : vp1.height - a[1], width: w.width, height: w.height });
          }
          invisible.push({ page: p, words: mapped });
          out = await ops.replacePageWithImage(out, p, jpeg);
          const list = doc.list(p).filter((a) => a.type !== 'redact' && !areas.some((r) => rectsOverlap(boundsOf(a), r)));
          if (!rot0 || ox || oy) for (const a of list) this.remapAnnot(a, vp1, rot0);
          doc.annots.set(p, list);
          progress((k + 1) / pages.length, `Page ${k + 1} of ${pages.length}`);
        }
        return ops.addInvisibleText(out, invisible.filter((x) => x.words.length), readFont);
      }, { skipCheck: true });
    });
    toast('Redactions applied. Please save.', 'ok');
  }
  remapAnnot(a, vp, rot0) {
    if (rot0) return;
    const P = (x, y) => { const v = vp.convertToViewportPoint(x, y); return [v[0], vp.height - v[1]]; };
    const r0 = P(a.rect[0], a.rect[1]); const r1 = P(a.rect[2], a.rect[3]);
    a.rect = [Math.min(r0[0], r1[0]), Math.min(r0[1], r1[1]), Math.max(r0[0], r1[0]), Math.max(r0[1], r1[1])];
    if (a.points) a.points = a.points.map((p) => P(p[0], p[1]));
    if (a.strokes) a.strokes = a.strokes.map((s) => s.map((p) => P(p[0], p[1])));
    if (a.quads) a.quads = a.quads.map((q) => [...P(q[0], q[1]), ...P(q[2], q[3]), ...P(q[4], q[5]), ...P(q[6], q[7])]);
  }

  // --- OCR --------------------------------------------------------------------------------
  async ocr() {
    const r = await formDialog('Recognize text (OCR)', [
      { k: 'lang', label: 'Language', type: 'select', options: scan.OCR_LANGS, value: this.app.settings.ocrLang || 'deu+eng' },
      { k: 'dpi', label: 'Resolution', type: 'select', options: [['auto', 'Automatic, based on image quality (recommended)'], [200, '200 dpi'], [300, '300 dpi'], [400, '400 dpi']], value: 'auto' },
      { k: 'redo', label: 'Recognize already recognized text again (replaces the previous recognition)', type: 'checkbox', value: false },
      { type: 'info', label: 'Existing text is not recognized twice. On pages with text, only images are read. "Recognize again" helps with scans that were recognized with an older version: tables and paragraphs are rebuilt. Text you changed by hand is kept.' }, this.range(),
    ], { validate: this.validateRange, ok: 'Recognize' });
    if (!r) return;
    await this.recognizeText(this.pagesOf(r), { lang: r.lang, dpi: r.dpi === 'auto' ? 'auto' : +r.dpi, redo: !!r.redo });
  }
  /**
   * Recognize text and store it as an invisible text layer: afterwards searchable, copyable and changeable
   * in edit mode. Returns the number of pages with new text.
   */
  async recognizeText(pages, o = {}) {
    const doc = this.doc;
    const lang = o.lang || this.app.settings.ocrLang || 'deu+eng';
    // Recognize again: remove the previous recognition first (one "Undo" step together with the new one).
    let cleared = false;
    if (o.redo) {
      const r = await removeRecognizedText(doc.bytes, pages);
      if (r.count) { cleared = await doc.mutate(() => r.bytes, { skipCheck: !!o.skipCheck }); if (cleared) this.app.editor.invalidate(); }
    }
    const found = await busy('Recognizing text', (progress) => scan.recognize(this.app, pages, { lang, dpi: o.dpi || 'auto', progress }));
    if (this.doc !== doc) return 0;
    doc.ocrOffered = true;
    if (!found.length) {
      if (cleared) await doc.undo();
      if (!o.quiet) toast('No new text was recognized.'); this.app.renderBanner(); return 0;
    }
    const ok = await doc.mutate((b) => ops.addInvisibleText(b, found, readFont), { skipCheck: !!o.skipCheck });
    if (!ok) return 0;
    if (cleared) doc.undoStack.splice(-1, 1);
    this.app.editor.invalidate();
    this.app.renderBanner();
    if (!o.silent) toast(`Text recognized on ${found.length} page(s). It is now searchable and can be changed under "Edit PDF".`, 'ok');
    return found.length;
  }

  // --- Exporte ----------------------------------------------------------------------------
  async exportAs(fmt) {
    const doc = this.doc;
    if (!doc) { toast('Please open a document first.'); return; }
    await doc.commitForms();
    const base = fileBase(doc.name);
    if (fmt === 'png' || fmt === 'jpeg') {
      const r = await formDialog('Export as image', [{ k: 'dpi', label: 'Resolution', type: 'select', options: [[150, '150 dpi'], [300, '300 dpi'], [600, '600 dpi'], [72, '72 dpi']], value: 150 }], { ok: 'Next' });
      if (!r) return;
      const dir = await window.dp.folderDialog('Choose destination folder');
      if (!dir) return;
      const ext = fmt === 'png' ? 'png' : 'jpg';
      await busy('Creating images', (p) => conv.pageImages(this.app, { dpi: +r.dpi, mime: `image/${fmt}` }, (i, bytes) => window.dp.writeFile(`${dir}\\${base}_P${String(i + 1).padStart(3, '0')}.${ext}`, bytes), p));
      toast('Images saved', 'ok'); window.dp.openPath(dir);
      return;
    }
    const meta = { docx: ['Microsoft Word', conv.toDocx], xlsx: ['Microsoft Excel', conv.toXlsx], pptx: ['Microsoft PowerPoint', conv.toPptx], html: ['HTML', conv.toHtml], rtf: ['Rich Text', conv.toRtf], txt: ['Text', conv.toText] }[fmt];
    let mode;
    if (fmt === 'pptx') { const r = await formDialog('Export as PowerPoint', [{ k: 'mode', label: 'Content', type: 'select', options: [['exact', 'Page as image (exact)'], ['edit', 'Text and images (editable)']], value: 'exact' }], { ok: 'Next' }); if (!r) return; mode = r.mode; }
    const p = await window.dp.saveDialog({ title: `Export as ${meta[0]}`, defaultPath: doc.path ? doc.path.replace(/\.pdf$/i, `.${fmt}`) : `${base}.${fmt}`, filters: [{ name: meta[0], extensions: [fmt] }] });
    if (!p) return;
    const data = await busy('Exporting document', (pr) => meta[1](this.app, pr, mode));
    await window.dp.writeFile(p, data);
    toast('Export complete', 'ok');
    window.dp.reveal(p);
  }
  async pdfa() {
    const doc = this.doc;
    const info = await ops.analyze(doc.bytes);
    const missing = info.fonts.filter((f) => !f.embedded);
    const c = await messageBox('Save as PDF/A', h('div', {}, 'The document receives the PDF/A-2b identification with an sRGB output profile. This does not include a certified ISO 19005 validation.', missing.length ? h('p', { style: { color: 'var(--danger)' } }, `Fonts that are not embedded (${missing.map((f) => f.name).join(', ')}) violate the standard.`) : null, info.transparency ? h('p', {}, 'Note: The document contains transparency. PDF/A-2 allows this.') : null), ['Next', 'Cancel'], { primary: 0 });
    if (c !== 0) return;
    const p = await window.dp.saveDialog({ title: 'Save PDF/A', defaultPath: doc.suggestedPath('_PDFA') });
    if (!p) return;
    const icc = await window.dp.srgbIcc();
    const out = await ops.toPdfA(await doc.buildOutput({ noEncrypt: true }), icc, fileBase(doc.name));
    await window.dp.writeFile(p, out);
    toast('PDF/A saved', 'ok');
  }

  // --- PDF erstellen ----------------------------------------------------------------------
  async createFromFile() {
    const paths = await window.dp.openDialog({ title: 'Create PDF from file', multi: true, filters: conv.CREATE_FILTERS });
    for (const p of paths) {
      const bytes = await busy('Creating PDF', () => conv.fileToPdf(p));
      await this.app.openBytes(bytes, `${fileBase(p.split(/[\\/]/).pop())}.pdf`, { unsaved: true, fromImage: /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(p) });
    }
  }
  async createFromScanner() {
    const data = await window.dp.scan();
    if (!data) { toast('Nothing was scanned.'); return; }
    await this.app.openBytes(await ops.imagesToPdf([{ bytes: data, mime: 'image/png' }], { pageSize: { width: 595.28, height: 841.89 } }), 'Scan.pdf', { unsaved: true, fromImage: true });
  }
  async createFromClipboard() {
    const data = await window.dp.clipboardImage();
    if (!data) { toast('There is no image on the clipboard.'); return; }
    await this.app.openBytes(await ops.imagesToPdf([{ bytes: data, mime: 'image/png' }]), 'Clipboard.pdf', { unsaved: true, fromImage: true });
  }
  /**
   * Paste an image from the clipboard (e.g. a screenshot) with Ctrl+V: it is placed in the middle of the visible
   * part of the current page, at its original size or scaled down until it fits on the page. The text in it is
   * recognized right away (preference). Without an open document, a new PDF is created from it.
   * Returns false if there is no image on the clipboard.
   */
  async pasteImage() {
    const data = await window.dp.clipboardImage();
    if (!data) return false;
    const doc = this.doc;
    if (!doc || this.app.view !== 'doc') {
      await this.app.openBytes(await ops.imagesToPdf([{ bytes: data, mime: 'image/png' }]), 'Clipboard.pdf', { unsaved: true, fromImage: true });
      return true;
    }
    if (!(await doc.allowEdit())) return true;
    const v = this.app.viewer;
    const i = v.current;
    const bmp = await createImageBitmap(new Blob([data], { type: 'image/png' }));
    const dpi = ops.imageDpi(data, 'image/png') || 96;
    let w = (bmp.width * 72) / dpi; let hgt = (bmp.height * 72) / dpi;
    bmp.close?.();
    const [x0, y0, x1, y1] = doc.pages[i].view;
    const rot = (((doc.pages[i].rotate || 0) % 360) + 360) % 360;
    const shown = rot % 180 ? [y1 - y0, x1 - x0] : [x1 - x0, y1 - y0];
    const s = Math.min(1, (shown[0] - 72) / w, (shown[1] - 72) / hgt);
    w *= s; hgt *= s;
    // Center of the visible part of the page; the image stays entirely on the page.
    const vr = v.el.getBoundingClientRect(); const pr = v.node(i).el.getBoundingClientRect();
    const sx = (Math.max(vr.left, pr.left) + Math.min(vr.right, pr.right)) / 2;
    const sy = (Math.max(vr.top, pr.top) + Math.min(vr.bottom, pr.bottom)) / 2;
    let [cx, cy] = v.toPdf(i, sx, sy);
    const ext = rot % 180 ? [hgt, w] : [w, hgt];
    const fit = (c, a, b, e) => (b - a <= e ? (a + b) / 2 : Math.min(b - e / 2, Math.max(a + e / 2, c)));
    cx = fit(cx, x0, x1, ext[0]); cy = fit(cy, y0, y1, ext[1]);
    const ok = await this.mutate((b) => ops.placeImage(b, i, { cx, cy, width: w, height: hgt, rotate: rot }, data, 'image/png'), { pages: [i] });
    if (ok === false) return true;
    this.app.editor.invalidate();
    if (this.app.editor.on) await this.app.editor.renderPage(i);
    if (this.app.settings.ocrOnCreate !== false) {
      const n = await this.recognizeText([i], { quiet: true, skipCheck: true, silent: true });
      toast(n ? 'Image pasted and its text recognized. You can change it under "Edit PDF".' : 'Image pasted.', 'ok');
    } else toast('Image pasted. You can move and resize it under "Edit PDF".', 'ok');
    if (this.app.editor.on) await this.app.editor.renderPage(i);
    return true;
  }
  async createBlank() {
    const r = await formDialog('Blank document', [{ k: 'size', label: 'Format', type: 'select', options: SIZES, value: SIZES[0][0] }, { k: 'n', label: 'Pages', type: 'number', value: 1, min: 1, max: 500 }], { ok: 'Create' });
    if (r) await this.app.openBytes(await ops.blankPdf(parseSize(r.size), r.n), 'New document.pdf', { unsaved: true });
  }

  // --- Komprimieren -----------------------------------------------------------------------
  async compress() {
    const doc = this.doc;
    if (!doc) { toast('Please open a document first.'); return; }
    const r = await formDialog('Compress PDF', [{ k: 'level', label: 'Quality', type: 'select', options: [['high', 'High quality (small savings)'], ['mid', 'Medium (recommended)'], ['low', 'Low quality (smallest file)']], value: 'mid' }], { ok: 'Compress' });
    if (!r) return;
    const L = { high: [2800, 0.85], mid: [1800, 0.72], low: [1100, 0.55] }[r.level];
    const before = doc.bytes.length;
    let images = 0;
    const ok = await busy('Compressing PDF', () => this.mutate(async (b) => {
      const res = await ops.optimize(b, {}, async (info) => {
        try {
          const bmp = await createImageBitmap(new Blob([info.bytes], { type: 'image/jpeg' }));
          const s = Math.min(1, L[0] / Math.max(bmp.width, bmp.height));
          const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
          c.getContext('2d', { alpha: false }).drawImage(bmp, 0, 0, c.width, c.height);
          return { bytes: await canvasBytes(c, 'image/jpeg', L[1]), width: c.width, height: c.height };
        } catch { return null; }
      });
      images = res.images;
      return res.bytes;
    }));
    if (ok) await messageBox('PDF compressed', `Before: ${fmtSize(before)}\nAfter: ${fmtSize(doc.bytes.length)}\nRecompressed images: ${images}\n\nPlease save to keep the result.`);
  }

  // --- Messen -----------------------------------------------------------------------------
  async scaleDialog() {
    const r = await formDialog('Set scale', [{ type: 'info', label: 'Example: 1 mm on the page equals 100 mm in reality.' }, { k: 'ratio', label: 'Factor', type: 'number', value: this.measure.ratio, min: 0.0001, step: 'any' }, { k: 'unit', label: 'Unit', type: 'select', options: ['mm', 'cm', 'm', 'in', 'pt'], value: this.measure.unit }]);
    if (r) { this.measure = r; toast('Scale set', 'ok'); }
  }
  convertLen(pt) { const mm = (pt / MM) * this.measure.ratio; return { mm: mm, cm: mm / 10, m: mm / 1000, in: mm / 25.4, pt: mm * MM }[this.measure.unit] ?? mm; }
  fmtLen(pt) { return `${this.convertLen(pt).toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${this.measure.unit}`; }
  async measureDistance(i, p0, p1) {
    const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    await this.overlay.add({ type: 'arrow', page: i, rect: [0, 0, 1, 1], points: [p0, p1], color: [0.176, 0.482, 0.784], width: 1, opacity: 1, contents: `Distance: ${this.fmtLen(d)}`, subject: 'Distance' });
    await this.label(i, p1, this.fmtLen(d));
  }
  label(i, p, text) { return this.overlay.add({ type: 'freetext', page: i, rect: [p[0] + 4, p[1] - 8, p[0] + 110, p[1] + 10], contents: text, color: null, textColor: [0.106, 0.31, 0.522], fontSize: 10, fill: [1, 1, 1], opacity: 1, subject: 'Measurement' }); }
  async finishMeasure(t, page, pts) {
    let contents; let type;
    if (t === 'measure-perimeter') {
      let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      contents = this.fmtLen(d); type = 'polyline';
    } else {
      if (pts.length < 3) return;
      let a = 0; for (let i = 0; i < pts.length; i++) { const [x0, y0] = pts[i]; const [x1, y1] = pts[(i + 1) % pts.length]; a += x0 * y1 - x1 * y0; }
      const side = this.convertLen(1);
      contents = `${(Math.abs(a) / 2 * side * side).toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${this.measure.unit}²`; type = 'polygon';
    }
    await this.overlay.add({ type, page, rect: [0, 0, 1, 1], points: pts, color: [0.176, 0.482, 0.784], width: 1, opacity: 1, fill: null, contents, subject: t === 'measure-area' ? 'Area' : 'Perimeter' });
    await this.label(page, pts[pts.length - 1], contents);
  }

  // --- Vergleichen ------------------------------------------------------------------------
  async compare() {
    const doc = this.doc;
    if (!doc) { toast('Please open the new version first.'); return; }
    const [p] = await window.dp.openDialog({ title: 'Choose the older version to compare' });
    if (!p) return;
    const otherBytes = await window.dp.readFile(p);
    const other = new Doc({ name: p.split(/[\\/]/).pop(), path: p, bytes: otherBytes });
    await other.load();
    const res = await busy('Comparing documents', async (progress) => {
      const pages = Math.max(doc.numPages, other.numPages);
      const out = new Map(); let added = 0; let removed = 0;
      for (let i = 0; i < pages; i++) {
        const A = i < other.numPages ? wordBoxes(await other.pageText(i)) : [];
        const B = i < doc.numPages ? wordBoxes(await doc.pageText(i)) : [];
        const d = diffWords(A.map((w) => w.text), B.map((w) => w.text));
        if (i < doc.numPages && (d.added.length || d.removed.length)) {
          const list = [];
          const groups = [];
          for (const k of d.added) { const g = groups[groups.length - 1]; if (g && g[g.length - 1] === k - 1) g.push(k); else groups.push([k]); }
          for (const g of groups) {
            const quads = g.map((k) => quadFromRect(B[k].rect));
            list.push({ id: newId(), type: 'highlight', page: i, rect: rectFromQuad(quads[0]), quads, color: [0.55, 0.9, 0.55], opacity: 1, contents: `Added: ${g.map((k) => B[k].text).join(' ')}`, author: 'Compare', subject: 'Added', modified: new Date().toISOString(), replies: [], status: null });
          }
          if (d.removed.length) {
            const words = d.removed.map((k) => A[k].text).join(' ');
            const anchor = A[d.removed[0]];
            list.push({ id: newId(), type: 'note', page: i, rect: [anchor.x, anchor.y, anchor.x + 20, anchor.y + 20], color: [0.95, 0.4, 0.35], opacity: 1, contents: `Removed: ${words}`, author: 'Compare', subject: 'Removed', icon: 'Comment', modified: new Date().toISOString(), replies: [], status: null });
          }
          out.set(i, list);
        }
        added += d.added.length; removed += d.removed.length;
        progress((i + 1) / pages, `Page ${i + 1} of ${pages}`);
      }
      return { out, added, removed, pagesA: other.numPages, pagesB: doc.numPages };
    });
    other.destroy();
    const bytes = await doc.buildOutput({ noEncrypt: true });
    const nd = await this.app.openBytes(bytes, `Compare_${doc.name}`, { unsaved: true });
    for (const [pg, list] of res.out) nd.list(pg).push(...list);
    nd.emit('reload', { annotOnly: true });
    this.app.panels.show('comments');
    await messageBox('Comparison complete', `Added words: ${res.added}\nRemoved words: ${res.removed}\nPages old/new: ${res.pagesA}/${res.pagesB}\n\nNew text is highlighted in green. Red notes show removed text.`);
  }

  // --- Berichte ---------------------------------------------------------------------------
  report(title, rows) {
    const label = { ok: 'Passed', bad: 'Failed', warn: 'Note' };
    return messageBox(title, h('table', { class: 'tbl' }, rows.map(([s, a, b]) => h('tr', {}, h('td', {}, h('span', { class: `badge ${s}` }, label[s])), h('td', {}, a), h('td', {}, b || '')))), ['Close'], { wide: true });
  }
  async accessCheck() {
    const i = await ops.analyze(this.doc.bytes);
    let hasText = false;
    for (let p = 0; p < Math.min(this.doc.numPages, 30); p++) if ((await this.doc.pageText(p)).items.some((x) => x.str?.trim())) { hasText = true; break; }
    await this.report('Accessibility: quick check', [
      [i.tagged ? 'ok' : 'bad', 'Tags', i.tagged ? 'Document is tagged' : 'Document contains no tags'],
      [hasText ? 'ok' : 'bad', 'Text', hasText ? 'Searchable text present' : 'No text found, please run OCR'],
      [i.title ? 'ok' : 'bad', 'Title', i.title || 'No document title'],
      [i.lang ? 'ok' : 'bad', 'Language', i.lang ? 'Language set' : 'No document language'],
      [i.outlines || this.doc.numPages < 10 ? 'ok' : 'warn', 'Bookmarks', i.outlines ? 'Present' : 'No bookmarks'],
      [this.doc.security ? 'warn' : 'ok', 'Security', this.doc.security ? 'Protection may restrict screen readers' : 'No restriction'],
    ]);
  }
  async titleLang() {
    const m = (await this.doc.pdf.getMetadata()).info;
    const r = await formDialog('Title and language', [{ k: 'title', label: 'Title', value: m.Title || fileBase(this.doc.name), required: true }, { k: 'lang', label: 'Language', type: 'select', options: [['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['de-CH', 'German (Switzerland)'], ['de-DE', 'German'], ['fr-CH', 'French'], ['it-CH', 'Italian']], value: 'en-GB' }]);
    if (r) await this.mutate(async (b) => ops.setLanguage(await ops.setMetadata(b, { title: r.title }), r.lang));
  }
  async preflight() {
    const i = await ops.analyze(this.doc.bytes);
    const missing = i.fonts.filter((f) => !f.embedded);
    const small = i.pageBoxes.filter((b) => Math.abs(b.media.width - b.crop.width) > 0.5 || Math.abs(b.media.height - b.crop.height) > 0.5).length;
    await this.report('Preflight report', [
      [missing.length ? 'bad' : 'ok', 'Fonts', missing.length ? `Not embedded: ${missing.map((f) => f.name).join(', ')}` : `${i.fonts.length} fonts embedded`],
      ['warn', 'PDF version', i.version.trim()],
      [i.colorSpaces.includes('DeviceRGB') ? 'warn' : 'ok', 'Image color spaces', i.colorSpaces.join(', ') || 'No images'],
      [i.transparency ? 'warn' : 'ok', 'Transparency', i.transparency ? 'Present' : 'None'],
      ['ok', 'Images', `${i.images} image objects`],
      [small ? 'warn' : 'ok', 'Page boxes', small ? `${small} pages with a different crop` : 'Uniform'],
      ['ok', 'Forms', i.hasForms ? 'Present' : 'None'],
    ]);
  }
  async initialView() {
    const r = await formDialog('Open options', [
      { k: 'layout', label: 'Page layout', type: 'select', options: [['', 'Default'], ['SinglePage', 'Single page'], ['OneColumn', 'Continuous'], ['TwoColumnLeft', 'Two pages continuous'], ['TwoPageLeft', 'Two pages']], value: '' },
      { k: 'mode', label: 'Navigation', type: 'select', options: [['', 'Page only'], ['UseOutlines', 'Bookmarks'], ['UseThumbs', 'Thumbnails'], ['FullScreen', 'Full screen']], value: '' },
      { k: 'page', label: 'Open on page', type: 'number', value: 1, min: 1, max: this.doc.numPages }, { k: 'showTitle', label: 'Show document title', type: 'checkbox' },
    ]);
    if (r) await this.mutate((b) => ops.setInitialView(b, { ...r, page: r.page - 1 }));
  }
  async javascript() {
    const list = await ops.listDocumentJavascript(this.doc.bytes);
    const r = await formDialog('Document JavaScript', [
      { type: 'info', label: `${list.length ? `Existing scripts: ${list.map((s) => s.name).join(', ')}. They stay in the document.` : 'No scripts.'} ${this.app.policy?.allowJavaScript ? 'Scripts only run when JavaScript is turned on in Preferences, and then in isolation without access to files or the internet.' : 'Scripts are not run in DocPilot (blocked by IT).'}` },
      { k: 'name', label: 'Script name', value: list[0]?.name || 'Script1', required: true }, { k: 'code', label: 'Code (empty = delete)', type: 'textarea', value: list[0]?.code || '' },
    ], { wide: true, ok: 'Save' });
    if (r) await this.mutate((b) => ops.setDocumentJavascript(b, r.name, r.code));
  }
}

// All tools: definition of the groups and their implementation.
import { h, $, icon, ibtn, toast, errToast, busy, formDialog, messageBox, hexToRgb, rgbToHex, cssColor, fileBase, canvasBytes, normalizeImage, toBase64, fmtSize, contextMenu, inFolder, imageCodec, emptyState } from './util.js';
import * as ops from './pdf/ops.js';
import { loadForEdit, saveDoc } from './pdf/ops.js';
import { writeAnnotations, flattenAnnotationsInDoc, newId } from './pdf/annots.js';
import { createDigitalId, signPdf } from './pdf/sign.js';
import { readFont, Doc, pdfjs, RENDER_OPTS } from './document.js';
import * as redact from './pdf/redact.js';
import * as optimize from './pdf/optimize.js';
import * as formtools from './formtools.js';
import * as pdfa from './pdf/pdfa.js';
import * as marks from './pdf/marks.js';
import * as images from './pdf/images.js';
import * as snap from './pdf/snap.js';
import * as scanfix from './pdf/scanfix.js';
import { actionWizard, runAction } from './actions.js';
import { BOXES as boxes } from './pdf/boxes.js';
import { wordBoxes, rectsOverlap, quadFromRect, rectFromQuad, diffWords, prefixRatio } from './textutil.js';
import * as conv from './convert.js';
import { boundsOf } from './overlay.js';
import * as scan from './scan.js';
import { removeRecognizedText } from './pdf/content.js';
import { usableSkew, MIN_SKEW } from './pdf/deskew.js';

const STAMPS = [['APPROVED', [0.1, 0.55, 0.2]], ['NOT APPROVED', [0.8, 0.1, 0.1]], ['DRAFT', [0.176, 0.482, 0.784]], ['FINAL', [0.1, 0.55, 0.2]], ['CONFIDENTIAL', [0.8, 0.1, 0.1]], ['FOR INFORMATION', [0.176, 0.482, 0.784]], ['COMPLETED', [0.1, 0.55, 0.2]], ['RECEIVED', [0.45, 0.45, 0.47]], ['COPY', [0.45, 0.45, 0.47]], ['REJECTED', [0.8, 0.1, 0.1]]];
const IMG_FILTER = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }];
const SIZES = [['595.28x841.89', 'A4 portrait'], ['841.89x595.28', 'A4 landscape'], ['841.89x1190.55', 'A3 portrait'], ['612x792', 'Letter'], ['419.53x595.28', 'A5']];
const parseSize = (s) => { const [width, height] = s.split('x').map(Number); return { width, height }; };
const MM = 2.834645669;
/**
 * One color per tool group (decided 2026-11-26, Trello card "Neue Oberfläche"): the symbols in the tools pane and the
 * tiles on the home page. The dark appearance makes them a little lighter (see .tint in styles.css).
 */
export const GROUP_COLORS = {
  edit: '#d6336c', comment: '#e8a10c', stamp: '#e8a10c', convert: '#0e9aa7', create: '#e03131', combine: '#5c6ac4', organize: '#2f9e44',
  fillsign: '#9c36b5', certs: '#1c7ed6', form: '#7048e8', protect: '#3b5bdb', redact: '#c2255c', ocr: '#37b24d', compress: '#f76707',
  measure: '#1098ad', actions: '#74b816', compare: '#6741d9', access: '#228be6', preflight: '#0ca678', advanced: '#5c7080',
};
/** The message after form fields were renamed to keep same-named fields of different files apart. */
const renamedNote = (list) => `${list.length === 1 ? 'A form field was' : `${list.length} form fields were`} renamed to keep it apart from a field of the same name: ${list.slice(0, 3).map(([a, b]) => `${a} → ${b}`).join(', ')}${list.length > 3 ? ', ...' : ''}`;

export class Tools {
  constructor(app) {
    this.app = app; this.group = null; this.left = $('#left-panel');
    this.measure = { ratio: 1, unit: 'mm' };
    this.registerTools();
    this.groups = this.defineGroups();
    for (const g of this.groups) g.color = GROUP_COLORS[g.id] || GROUP_COLORS.advanced;
  }
  get doc() { return this.app.doc; }
  get viewer() { return this.app.viewer; }
  get overlay() { return this.app.overlay; }
  guard(fn) { return async (...a) => { try { return await fn(...a); } catch (e) { errToast(e); return undefined; } }; }
  mutate(fn, o) { return this.doc.mutate(fn, o); }
  range(label = 'Pages') { return { k: 'range', label, value: `1-${this.doc.numPages}`, placeholder: 'e.g. 1-3, 5' }; }
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
        R('Microsoft Word (.docx)', 'convert', () => this.exportAs('docx')), R('Microsoft Excel (.xlsx)', 'convert', () => this.exportAs('xlsx')), R('Microsoft PowerPoint (.pptx)', 'convert', () => this.exportAs('pptx')), R('PNG image', 'img', () => this.exportAs('png')), R('JPEG image', 'img', () => this.exportAs('jpeg')), R('HTML web page', 'convert', () => this.exportAs('html')), R('Rich Text (.rtf)', 'convert', () => this.exportAs('rtf')), R('Plain text (.txt)', 'text', () => this.exportAs('txt')), R('Markdown (.md)', 'text', () => this.exportAs('md')), R('All images...', 'img', () => this.exportImages()), R('PDF/A...', 'preflight', () => this.pdfa()),
      ] },
      { id: 'create', label: 'Create PDF', icon: 'blank', desc: 'From files, scanner, clipboard', items: [
        R('From file...', 'open', () => this.createFromFile(), false), R('Several files as separate PDFs...', 'pages', () => this.createSeparate(), false), R('From scanner...', 'scan', () => this.createFromScanner(), false), R('From clipboard', 'dup', () => this.createFromClipboard(), false), R('Blank page', 'blank', () => this.createBlank(), false),
      ] },
      { id: 'combine', label: 'Combine files', icon: 'combine', desc: 'Several files into one PDF', direct: this.guard(() => this.combine()), noDoc: true },
      { id: 'organize', label: 'Organize pages', icon: 'pages', desc: 'Move, rotate, delete, split', onOpen: () => this.app.organizer.show(), onClose: () => this.app.organizer.hide(), items: [
        R('Split document...', 'split', () => this.split()), R('Reverse pages...', 'reverse', () => this.reversePagesDialog()), R('Insert pages from file...', 'insert', () => this.insertFromFile(this.viewer.current + 1)), R('Insert blank page', 'blank', () => this.insertBlankAt(this.viewer.current + 1)),
      ] },
      { id: 'fillsign', label: 'Fill and sign', icon: 'sign', desc: 'Fill in and sign forms', extra: () => this.signSummary(), items: [
        T('fs-text', 'Enter text', 'text'), T('fs-check', 'Check mark', 'check'), T('fs-cross', 'Cross', 'cross'), T('fs-dot', 'Points', 'dot'), T('fs-date', 'Date', 'date'), T('fs-line', 'Line', 'line'), R('Place signature', 'sign', () => this.placeSignature('signature')), R('Place initials', 'sign', () => this.placeSignature('initials')), R('Set up signature...', 'gear', () => this.signSetup('signature')), R('Set up initials...', 'gear', () => this.signSetup('initials')),
      ] },
      { id: 'certs', label: 'Use certificates', icon: 'cert', desc: 'Sign digitally and validate', items: [
        T('digital-sign', 'Sign digitally', 'cert'), R('Sign digitally (invisible)...', 'cert', () => this.digitalSign(null)), T('certify-sign', 'Certify (visible signature)', 'cert'), R('Certify (invisible signature)...', 'cert', () => this.digitalSign(null, true)), R('Create digital ID...', 'plus', () => this.createId(), false), R('Validate all signatures', 'preflight', () => this.app.panels.show('signatures')),
      ] },
      { id: 'form', label: 'Prepare form', icon: 'form', desc: 'Create fields, manage data', extra: () => this.formFieldsList(), items: [
        { sub: 'Fields' }, R('Detect fields automatically...', 'search', () => this.app.fieldDetect.start()), R('Convert XFA form...', 'form', () => this.convertXfaDialog()), T('form-text', 'Text box', 'textbox'), T('form-multiline', 'Multiline text field', 'textbox'), T('form-checkbox', 'Check box', 'chk'), T('form-radio', 'Radio button', 'radio'), T('form-dropdown', 'Dropdown', 'dd'), T('form-list', 'List box', 'list'), T('form-button', 'Button', 'btn'), T('form-date', 'Date field', 'date'), T('form-image', 'Image field', 'img'), T('form-table', 'Text field table', 'list'), T('form-signature', 'Signature field', 'cert'),
        { sub: 'Behaviour' }, R('Field properties...', 'gear', () => formtools.fieldProperties(this)), R('Calculation order...', 'list', () => formtools.calculationOrder(this)), R('Tab order...', 'list', () => formtools.tabOrder(this)),
        { sub: 'Form data' }, R('Highlight form fields', 'highlight', () => this.toggleFormHighlight()), R('Export data...', 'share', () => formtools.exportFormData(this)), R('Import data...', 'open', () => formtools.importFormData(this)), R('Reset form...', 'undo', () => this.resetForm()), R('Flatten form...', 'compress', () => this.flattenForm()),
      ] },
      { id: 'protect', label: 'Protect', icon: 'lock', desc: 'Passwords and permissions', items: [
        R('Password protection...', 'lock', () => this.encryptDialog()), R('Remove security...', 'lock', () => this.removeSecurity()), R('Sanitize document...', 'redact', () => this.sanitize()),
      ] },
      { id: 'redact', label: 'Redact', icon: 'redact', desc: 'Permanently remove content', extra: () => h('div', { class: 'lp-note' }, 'Marks stay editable until you choose "Apply redactions". After that, the content is permanently removed from the document.'), items: [
        T('redact-text', 'Mark up text', 'text'), T('redact-area', 'Mark area', 'rect'), R('Mark pages...', 'pages', () => this.redactPages()), R('Find and mark...', 'search', () => this.searchRedact()), R('Redaction properties...', 'gear', () => this.redactProperties(), false), R('Apply redactions', 'check', () => this.applyRedactions()),
      ] },
      { id: 'ocr', label: 'Scan & OCR', icon: 'scan', desc: 'Recognize text in scans', items: [R('Recognize text...', 'scan', () => this.ocr()), R('Recognize text in several files...', 'scan', () => this.ocrFiles(), false), R('Review recognized text...', 'search', () => this.ocrReview()), R('Enhance scanned pages...', 'bg', () => this.enhanceScanDialog()), R('Straighten photo (perspective)...', 'crop', () => this.perspectiveDialog()), R('Straighten page...', 'rotR', () => this.deskew()), R('Create from scanner...', 'scan', () => this.createFromScanner(), false)] },
      { id: 'compress', label: 'Compress PDF', icon: 'compress', desc: 'Reduce file size', items: [R('Reduce file size...', 'compress', () => this.compress()), R('Advanced optimization...', 'gear', () => this.compressAdvanced())] },
      { id: 'measure', label: 'Measure', icon: 'measure', desc: 'Distance, perimeter, area', items: [T('measure-dist', 'Distance', 'line'), T('measure-perimeter', 'Perimeter', 'polyline'), T('measure-area', 'Area', 'poly'), R('Set scale...', 'ruler', () => this.scaleDialog()), R('Snap to lines and points', 'chk', () => this.toggleSnap()), R('Export measurements (CSV)...', 'share', () => this.exportMeasurements())] },
      { id: 'actions', label: 'Action wizard', icon: 'list', desc: 'Run steps on several files', direct: this.guard(() => actionWizard(this.app)), noDoc: true },
      { id: 'compare', label: 'Compare files', icon: 'compare', desc: 'Differences between two PDFs', direct: this.guard(() => this.compare()) },
      { id: 'access', label: 'Accessibility', icon: 'access', desc: 'Tag, check and read out loud', items: [R('Accessibility check', 'preflight', () => this.accessCheck()), R('Automatically tag document', 'access', () => this.autoTagDialog()), R('Tag form fields and links', 'form', () => this.tagFieldsDialog()), R('Alternate text for images...', 'img', () => this.altTextDialog()), R('Tags panel', 'list', () => this.app.panels.show('tags')), R('Set title and language...', 'text', () => this.titleLang()), R('Read page aloud', 'speak', () => this.app.speak('page')), R('Stop reading', 'x', () => this.app.speak('stop'))] },
      { id: 'preflight', label: 'Print production', icon: 'preflight', desc: 'Preflight and fonts', items: [R('Preflight report', 'preflight', () => this.preflight()), R('Check PDF/A compliance', 'preflight', () => this.pdfaCheck()), R('Crop for prepress...', 'crop', () => this.cropDialog()), R('Set page boxes...', 'boxes', () => this.pageBoxesDialog()), R('Convert to grayscale...', 'bg', () => this.grayscaleDialog()), R('Fix hairlines...', 'line', () => this.hairlinesDialog()), R('Printer marks...', 'crop', () => this.printerMarksDialog())] },
      { id: 'advanced', label: 'Document check and JavaScript', icon: 'js', desc: 'Open options, scripts', items: [R('Open options...', 'gear', () => this.initialView()), R('Document JavaScript...', 'js', () => this.javascript()), R('Document properties...', 'info', () => this.app.run('properties'))] },
    ];
  }

  // --- Left pane -----------------------------------------------------------------------
  /** All tools: the groups with their colored symbols; the search field above filters groups and tools while typing. */
  renderAll() {
    const search = h('input', { class: 'lp-search', type: 'search', placeholder: 'Search tools', spellcheck: 'false', 'aria-label': 'Search tools', value: this.toolQuery || '', data: { toolSearch: '1' } });
    const body = h('div', { class: 'lp-body' });
    const fill = () => body.replaceChildren(...this.toolRows(search.value));
    search.addEventListener('input', () => { this.toolQuery = search.value; fill(); });
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (search.value) { search.value = ''; this.toolQuery = ''; fill(); } else search.blur(); }
      else if (e.key === 'Enter') { e.preventDefault(); body.querySelector('.lp-item')?.click(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); body.querySelector('.lp-item')?.focus(); }
    });
    // Arrow keys move through the list, up from the first row back into the search field.
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = [...body.querySelectorAll('.lp-item')]; const k = rows.indexOf(document.activeElement);
      if (k < 0) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'ArrowUp' && k === 0) search.focus(); else rows[Math.max(0, Math.min(rows.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
    this.left.replaceChildren(h('div', { class: 'lp-head' }, h('span', { class: 't' }, 'All tools'), ibtn('chevL', 'Hide', () => this.app.run('toggle-left'))),
      h('label', { class: 'lp-find' }, icon('search'), search), body);
    fill();
  }
  /** Rows of the list: all groups, or for a search the matching groups and then the matching tools of every group. */
  toolRows(q) {
    const groups = this.groups.filter((g) => !g.hidden);
    const row = (g) => h('button', { class: 'lp-item tint', type: 'button', data: { group: g.id }, style: { '--gc': g.color }, onclick: () => this.openGroup(g.id) }, icon(g.icon), g.label);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return groups.map(row);
    const hit = (s) => words.every((w) => s.toLowerCase().includes(w));
    const tools = []; const seen = new Set();
    for (const g of this.groups) {
      for (const it of g.items || []) {
        const key = `${g.id}|${it.label}`;
        if (it.sub || seen.has(key) || !hit(it.label)) continue;
        seen.add(key); tools.push([g, it]);
      }
    }
    const out = groups.filter((g) => hit(`${g.label} ${g.desc || ''}`)).map(row);
    if (tools.length) {
      out.push(h('div', { class: 'lp-sub' }, 'Tools'), ...tools.map(([g, it]) => h('button', { class: 'lp-item tint', type: 'button', data: it.tool ? { tool: it.tool, group: g.id } : { action: it.label, group: g.id }, style: { '--gc': g.color }, onclick: () => { this.toolQuery = ''; this.runItem(g, it); if (!this.group) this.renderAll(); } },
        icon(it.icon), h('span', { class: 'lp-l' }, it.label), h('small', { class: 'lp-g' }, g.label))));
    }
    if (!out.length) out.push(emptyState('search', 'No tool matches', 'Try another word, or search all commands in the title bar.'));
    return out;
  }
  /** A tool chosen in the search: tools on the page open their group first; commands run directly. */
  runItem(g, it) {
    if (it.tool) { this.openGroup(g.id); if (this.overlay.tool !== it.tool) this.selectTool(it.tool); return; }
    if (it.needsDoc && !this.doc) { toast('Please open a document first.'); return; }
    it.run();
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
    const body = h('div', { class: 'lp-body tint', style: { '--gc': g.color } }, (g.items || []).map((it) => {
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
    if (t.startsWith('measure-')) this.snapGeom(this.viewer.current);
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
    reg('certify-sign', (i, rect) => this.digitalSign({ page: i, rect }, true), { needsDrag: true });
    for (const t of ['text', 'multiline', 'checkbox', 'radio', 'dropdown', 'list', 'button', 'signature']) reg(`form-${t}`, (i, rect, p0) => this.addField(t, i, rect, p0));
    reg('form-date', (i, rect, p0) => formtools.dateField(this, i, rect, p0));
    reg('form-image', (i, rect, p0) => formtools.imageField(this, i, rect, p0));
    reg('form-table', (i, rect) => formtools.fieldTable(this, i, rect), { needsDrag: true });
    reg('measure-dist', (i, rect, p0, e, p1) => this.measureDistance(i, p0, p1), { needsDrag: true, keep: true });
    reg('place-stamp', (i, rect, p0) => this.placeStamp(i, rect, p0));
    click('fs-text', (i, p) => this.fsText(i, p));
    click('fs-check', (i, p) => this.fsMark(i, p, 'check'));
    click('fs-cross', (i, p) => this.fsMark(i, p, 'cross'));
    click('fs-dot', (i, p) => ov().add({ type: 'ellipse', page: i, rect: [p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], color: [0, 0, 0], fill: [0, 0, 0], width: 1, opacity: 1, contents: '' }));
    click('fs-date', (i, p) => this.fsDate(i, p));
    // A line, e.g. to strike out a field or underline a signature; Shift keeps it horizontal or vertical.
    reg('fs-line', (i, rect, p0, e, p1) => (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 2 ? null : ov().add({ type: 'line', page: i, rect, points: [p0, p1], color: [0, 0, 0], width: 1.2, opacity: 1, contents: '' })), { needsDrag: true, keep: true });
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

  /**
   * Header & footer, watermark, background and Bates numbers can be changed and removed after they were added:
   * when the document already has marks of the kind, the user chooses Update (the dialog opens with the settings
   * the marks were made with and replaces them), Remove, or Add another. Returns {replace, s (settings), range} or null.
   */
  async markChoice(kind, label) {
    const m = (await ops.listMarks(this.doc.bytes)).find((x) => x.kind === kind);
    if (!m) return { replace: false, s: {} };
    const where = m.pages.length === this.doc.numPages ? 'on all pages' : `on page${m.pages.length > 1 ? 's' : ''} ${marks.rangeText(m.pages)}`;
    const c = await messageBox(label, `This document already has ${label.toLowerCase()} ${where}. Update it, remove it, or add another?`, ['Update', 'Remove', 'Add another', 'Cancel'], { cancel: 3 });
    if (c === 3) return null;
    if (c === 1) {
      await this.mutate((b) => ops.removeMarks(b, kind));
      toast(`${label} removed`, 'ok');
      return null;
    }
    return c === 0 ? { replace: true, s: m.settings || {}, range: marks.rangeText(m.pages) } : { replace: false, s: {} };
  }
  rangeFrom(m) { const f = this.range(); if (m.range) f.value = m.range; return f; }
  async headerFooter() {
    const m = await this.markChoice('HeaderFooter', 'Header & footer');
    if (!m) return;
    const s = m.s; const v = (k, d) => s[k] ?? d;
    const r = await formDialog('Header & footer', [
      { type: 'info', label: 'Placeholders: {page}, {pages}, {date}, {file}' },
      { k: 'left', label: 'Header left', value: v('left', '') }, { k: 'center', label: 'Header center', value: v('center', '') }, { k: 'right', label: 'Header right', value: v('right', '') },
      { k: 'footLeft', label: 'Footer left', value: v('footLeft', '') }, { k: 'footCenter', label: 'Footer center', value: v('footCenter', '') }, { k: 'footRight', label: 'Footer right', value: v('footRight', m.replace ? '' : 'Page {page} of {pages}') },
      { k: 'size', label: 'Font size', type: 'number', value: v('size', 10), min: 4, max: 72 }, { k: 'color', label: 'Color', type: 'color', value: v('color', '#181210') }, { k: 'margin', label: 'Margin (mm)', type: 'number', value: v('margin', 10), min: 0 }, { k: 'startNumber', label: 'First number', type: 'number', value: v('startNumber', 1), min: 0 }, this.rangeFrom(m),
    ], { validate: this.validateRange, ok: m.replace ? 'Update' : 'Add' });
    if (!r) return;
    const settings = { ...r }; delete settings.range;
    await this.mutate((b) => ops.addHeaderFooter(b, { ...r, margin: r.margin * MM, pages: this.pagesOf(r), fileName: this.doc.name, replace: m.replace, settings }, readFont));
  }
  async pageNumbers() {
    const r = await formDialog('Insert page numbers', [
      { k: 'pos', label: 'Position', type: 'select', options: [['footCenter', 'Bottom center'], ['footRight', 'Bottom right'], ['footLeft', 'Bottom left'], ['center', 'Top center'], ['right', 'Top right'], ['left', 'Top left']], value: 'footCenter' },
      { k: 'fmt', label: 'Format', type: 'select', options: [['{page}', '1'], ['Page {page}', 'Page 1'], ['Page {page} of {pages}', 'Page 1 of 5'], ['{page}/{pages}', '1/5']], value: '{page}' }, this.range(),
    ], { validate: this.validateRange, ok: 'Insert' });
    if (!r) return;
    // Page numbers are a header or footer: "Header & footer" changes or removes them later.
    await this.mutate((b) => ops.addHeaderFooter(b, { [r.pos]: r.fmt, pages: this.pagesOf(r), settings: { [r.pos]: r.fmt, size: 10, margin: 28 / MM } }, readFont));
  }
  async watermark() {
    const m = await this.markChoice('Watermark', 'Watermark');
    if (!m) return;
    const s = m.s; const v = (k, d) => s[k] ?? d;
    const r = await formDialog('Watermark', [
      { k: 'kind', label: 'Type', type: 'select', options: [['text', 'Text'], ['image', 'Image from file']], value: v('kind', 'text') },
      { k: 'text', label: 'Text', value: v('text', 'CONFIDENTIAL') }, { k: 'size', label: 'Font size', type: 'number', value: v('size', 64), min: 6, max: 300 }, { k: 'color', label: 'Color', type: 'color', value: v('color', '#0e7c86') },
      { k: 'scale', label: 'Image size (%)', type: 'number', value: v('scale', 50), min: 1, max: 500 }, { k: 'opacity', label: 'Opacity (%)', type: 'number', value: v('opacity', 30), min: 1, max: 100 }, { k: 'rotation', label: 'Rotation (degrees)', type: 'number', value: v('rotation', 45), min: -180, max: 180 },
      { k: 'position', label: 'Position', type: 'select', options: [['center', 'Center'], ['top', 'Top'], ['bottom', 'Bottom'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']], value: v('position', 'center') },
      { k: 'behind', label: 'Behind the page content', type: 'checkbox', value: v('behind', false) }, this.rangeFrom(m),
    ], { validate: (x) => this.validateRange(x) || (x.kind === 'text' && !x.text.trim() ? 'Please enter text.' : null), ok: m.replace ? 'Update' : 'Add' });
    if (!r) return;
    const settings = { ...r }; delete settings.range;
    const o = { size: r.size, color: r.color, opacity: r.opacity / 100, rotation: r.rotation, position: r.position, behind: r.behind, pages: this.pagesOf(r), replace: m.replace, settings };
    if (r.kind === 'image') { const im = await this.chooseImage('Watermark image'); if (!im) return; Object.assign(o, { image: im.bytes, mime: im.mime, scale: r.scale / 100 }); } else o.text = r.text;
    await this.mutate((b) => ops.addWatermark(b, o, readFont));
  }
  async background() {
    const m = await this.markChoice('Background', 'Background');
    if (!m) return;
    const s = m.s;
    const r = await formDialog('Background', [{ k: 'color', label: 'Color', type: 'color', value: s.color ?? '#eef8f8' }, { k: 'opacity', label: 'Opacity (%)', type: 'number', value: s.opacity ?? 100, min: 1, max: 100 }, this.rangeFrom(m)], { validate: this.validateRange, ok: m.replace ? 'Update' : 'Add' });
    if (r) await this.mutate((b) => ops.addBackground(b, { color: r.color, opacity: r.opacity / 100, pages: this.pagesOf(r), replace: m.replace, settings: { color: r.color, opacity: r.opacity } }));
  }
  async bates() {
    const m = await this.markChoice('Bates', 'Bates numbering');
    if (!m) return;
    const s = m.s; const v = (k, d) => s[k] ?? d;
    const r = await formDialog('Bates numbering', [{ k: 'prefix', label: 'Prefix', value: v('prefix', 'DP-') }, { k: 'suffix', label: 'Suffix', value: v('suffix', '') }, { k: 'start', label: 'Start number', type: 'number', value: v('start', 1), min: 0 }, { k: 'digits', label: 'Digits', type: 'number', value: v('digits', 6), min: 1, max: 15 }, { k: 'position', label: 'Position', type: 'select', options: [['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-right', 'Top right'], ['top-left', 'Top left'], ['bottom', 'Bottom center']], value: v('position', 'bottom-right') }, this.rangeFrom(m)], { validate: this.validateRange, ok: m.replace ? 'Update' : 'Add' });
    if (!r) return;
    const settings = { ...r }; delete settings.range;
    await this.mutate((b) => ops.addBates(b, { ...r, pages: this.pagesOf(r), replace: m.replace, settings }, readFont));
  }
  async pageLabels() {
    const r = await formDialog('Page labels', [{ k: 'from', label: 'From page', type: 'number', value: 1, min: 1, max: this.doc.numPages }, { k: 'style', label: 'Style', type: 'select', options: [['D', '1, 2, 3'], ['r', 'i, ii, iii'], ['R', 'I, II, III'], ['a', 'a, b, c'], ['A', 'A, B, C']], value: 'D' }, { k: 'prefix', label: 'Prefix' }, { k: 'start', label: 'Start with', type: 'number', value: 1, min: 1 }]);
    if (!r) return;
    const ranges = r.from > 1 ? [{ from: 0, style: 'D' }, { from: r.from - 1, style: r.style, prefix: r.prefix, start: r.start }] : [{ from: 0, style: r.style, prefix: r.prefix, start: r.start }];
    await this.mutate((b) => ops.setPageLabels(b, ranges));
  }

  async reversePagesDialog(list) {
    const r = await formDialog('Reverse pages', [{ type: 'info', label: 'The chosen pages change places in reverse order; the other pages stay where they are.' }, { ...this.range(), value: list?.length > 1 ? marks.rangeText(list) : `1-${this.doc.numPages}` }], { validate: (v) => this.validateRange(v) || (this.pagesOf(v).length < 2 ? 'Please choose at least two pages.' : null), ok: 'Reverse' });
    if (r) await this.mutate((b) => ops.reversePages(b, this.pagesOf(r)));
  }
  /** Set page boxes: crop, bleed, trim, art or media box from margins, or back to its default. */
  async pageBoxesDialog() {
    const i = this.viewer.current;
    const cur = await ops.readPageBoxes(this.doc.bytes, i);
    const mm = (v) => Math.round((v / MM) * 10) / 10;
    const fmt = (r) => `${mm(r[2] - r[0])} x ${mm(r[3] - r[1])} mm`;
    const facts = h('table', { class: 'tbl' }, boxes.map(([k, l]) => h('tr', {}, h('th', {}, l), h('td', {}, `${fmt(cur.boxes[k])}${cur.own[k] || k === 'MediaBox' ? '' : ' (not set)'}`))));
    const margins = (k) => { const m = cur.boxes.MediaBox; const b = cur.boxes[k]; return { left: mm(b[0] - m[0]), bottom: mm(b[1] - m[1]), right: mm(m[2] - b[2]), top: mm(m[3] - b[3]) }; };
    const m0 = margins('TrimBox');
    const r = await formDialog('Set page boxes', [
      { type: 'info', label: `Boxes of page ${i + 1}:` }, { type: 'node', node: facts },
      { k: 'box', label: 'Box', type: 'select', options: boxes.filter(([k]) => k !== 'MediaBox'), value: 'TrimBox' },
      { k: 'mode', label: 'Action', type: 'select', options: [['margins', 'Set from margins (inward from the media box)'], ['remove', 'Remove (back to its default)']], value: 'margins' },
      { k: 'top', label: 'Top (mm)', type: 'number', value: m0.top, min: 0, step: 0.1, showIf: (v) => v.mode === 'margins' }, { k: 'bottom', label: 'Bottom (mm)', type: 'number', value: m0.bottom, min: 0, step: 0.1, showIf: (v) => v.mode === 'margins' },
      { k: 'left', label: 'Left (mm)', type: 'number', value: m0.left, min: 0, step: 0.1, showIf: (v) => v.mode === 'margins' }, { k: 'right', label: 'Right (mm)', type: 'number', value: m0.right, min: 0, step: 0.1, showIf: (v) => v.mode === 'margins' }, this.range(),
    ], { validate: this.validateRange, ok: 'Apply' });
    if (!r) return;
    const spec = r.mode === 'remove' ? { remove: true } : { margins: [r.left, r.bottom, r.right, r.top].map((v) => (v || 0) * MM) };
    await this.mutate((b) => ops.setPageBox(b, this.pagesOf(r), r.box, spec));
    toast(`${boxes.find(([k]) => k === r.box)[1]} ${r.mode === 'remove' ? 'removed' : 'set'}`, 'ok');
  }

  /** Print production: convert every colour (text, graphics, images) to gray. */
  async grayscaleDialog() {
    const r = await formDialog('Convert to grayscale', [
      { type: 'info', label: 'Text, graphics and images become gray by their brightness; pure black stays black. No colour profile is used, so the result is not calibrated for a press.' },
      { k: 'images', label: 'Convert images too', type: 'checkbox', value: true }, { k: 'annotations', label: 'Convert comments and form fields too', type: 'checkbox', value: true }, this.range(),
    ], { validate: this.validateRange, ok: 'Convert' });
    if (!r) return;
    let res = null;
    await this.mutate(async (b) => { res = await ops.convertToGray(b, this.pagesOf(r), { images: r.images, annotations: r.annotations, codec: imageCodec }); return res; });
    const left = res.imagesLeft ? ` ${res.imagesLeft} image${res.imagesLeft === 1 ? '' : 's'} could not be converted.` : '';
    toast(res.colours || res.images ? `Converted to grayscale: ${res.colours} colour${res.colours === 1 ? '' : 's'}, ${res.images} image${res.images === 1 ? '' : 's'}.${left}` : `Nothing to convert.${left}`, res.colours || res.images ? 'ok' : undefined);
  }
  /** Print production: lines thinner than a printer holds get a chosen width. */
  async hairlinesDialog() {
    const r = await formDialog('Fix hairlines', [
      { type: 'info', label: 'Lines thinner than the limit (on the page, after any scaling) and lines without a width get the new width.' },
      { k: 'narrower', label: 'Lines thinner than (pt)', type: 'number', value: 0.25, min: 0, max: 10, step: 0.01 }, { k: 'width', label: 'New width (pt)', type: 'number', value: 0.5, min: 0.01, max: 10, step: 0.01 }, this.range(),
    ], { validate: (v) => this.validateRange(v) || (!(v.width > 0) ? 'Please enter a width above 0.' : null), ok: 'Fix' });
    if (!r) return;
    let res = null;
    await this.mutate(async (b) => { res = await ops.fixHairlines(b, this.pagesOf(r), { narrowerThan: r.narrower, width: r.width }); return res; });
    toast(res.lines ? `${res.lines} line${res.lines === 1 ? '' : 's'} on ${res.pages} page${res.pages === 1 ? '' : 's'} fixed` : 'There are no hairlines on these pages.', res.lines ? 'ok' : undefined);
  }
  /** Print production: trim and bleed marks, registration targets, colour bars and page information. */
  async printerMarksDialog() {
    const m = await this.markChoice('PrinterMarks', 'Printer marks');
    if (!m) return;
    const s = m.s; const v = (k, dflt) => s[k] ?? dflt;
    const r = await formDialog('Printer marks', [
      { k: 'trim', label: 'Trim marks', type: 'checkbox', value: v('trim', true) }, { k: 'bleed', label: 'Bleed marks', type: 'checkbox', value: v('bleed', true) },
      { k: 'registration', label: 'Registration marks', type: 'checkbox', value: v('registration', true) }, { k: 'colorBars', label: 'Colour bars', type: 'checkbox', value: v('colorBars', true) },
      { k: 'pageInfo', label: 'Page information', type: 'checkbox', value: v('pageInfo', true) },
      { k: 'lineWeight', label: 'Line weight', type: 'select', options: [[0.125, '0.125 pt'], [0.25, '0.25 pt'], [0.5, '0.5 pt'], [1, '1 pt']], value: v('lineWeight', 0.25) },
      { k: 'room', label: 'Enlarge the page to make room for the marks', type: 'checkbox', value: v('room', true) }, this.rangeFrom(m),
    ], { validate: (x) => this.validateRange(x) || (!(x.trim || x.bleed || x.registration || x.colorBars || x.pageInfo) ? 'Please choose at least one kind of mark.' : null), ok: m.replace ? 'Update' : 'Add' });
    if (!r) return;
    const settings = { ...r }; delete settings.range;
    await this.mutate((b) => ops.addPrinterMarks(b, this.pagesOf(r), { ...r, lineWeight: +r.lineWeight, makeRoom: r.room ? 36 : null, label: this.doc.name, date: new Date().toLocaleString('en-GB'), replace: m.replace, settings }));
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
      if (!f) return;
      let renamed = [];
      await this.mutate(async (b) => { const r = await ops.insertPdf(b, f.bytes, at, undefined, undefined, fileBase(f.name)); renamed = r.renamed; return r; });
      if (renamed.length) toast(renamedNote(renamed));
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
        await window.dp.writeFile(inFolder(dir, `${base}_Part${String(i + 1).padStart(String(ranges.length).length, '0')}.pdf`), await ops.extractPages(bytes, ranges[i]));
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
      for (let i = 0; i < files.length; i++) { const name = files[i].split(/[\\/]/).pop(); items.push({ bytes: await conv.fileToPdf(files[i]), title: fileBase(name) }); p((i + 1) / files.length / 2, name); }
      return ops.mergePdfs(items, { report: true });
    });
    await this.app.openBytes(out.bytes, 'Combined.pdf', { unsaved: true });
    if (out.renamed.length) toast(renamedNote(out.renamed));
  }

  // --- Comments -------------------------------------------------------------------------
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

  // --- Certificates ------------------------------------------------------------------------
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
  async digitalSign(visible, certify = false) {
    const doc = this.doc;
    if (doc.security) throw new Error('Protected documents cannot be signed. Please remove the security first.');
    if (certify && doc.signed) throw new Error('This document is already signed. Only the first signature can certify a document.');
    let path = this.app.settings.lastPfx;
    const stat = path ? await window.dp.fileStat(path) : null;
    if (!stat) { [path] = await window.dp.openDialog({ title: 'Choose digital ID', filters: [{ name: 'Digital ID', extensions: ['pfx', 'p12'] }] }); if (!path) return; }
    const r = await formDialog('Sign digitally', [{ type: 'info', label: `Digital ID: ${path.split(/[\\/]/).pop()}` }, { k: 'password', label: 'ID password', type: 'password', required: true }, { k: 'reason', label: 'Reason', value: certify ? 'I am the author of this document' : 'I approve this document' }, { k: 'location', label: 'Location' }, ...(certify ? [{ k: 'mdp', label: 'Changes allowed after certifying', type: 'select', options: [['1', 'No changes'], ['2', 'Filling in forms and signing'], ['3', 'Filling in forms, signing and comments']], value: '2' }] : [])], { ok: 'Sign' });
    if (!r) return;
    const target = await window.dp.saveDialog({ title: 'Save signed document', defaultPath: doc.suggestedPath('_signed') });
    if (!target) return;
    const p12 = await window.dp.readFile(path);
    // On top of the file as it is saved: earlier signatures stay valid.
    const out = await busy(certify ? 'Certifying document' : 'Signing document', async () => signPdf(await doc.buildOutput({ noEncrypt: true, incremental: true }), { p12, password: r.password, reason: r.reason, location: r.location, visible: visible || undefined, certify: certify ? +r.mdp : undefined }));
    await window.dp.writeFile(target, out);
    this.app.settings.lastPfx = path; await this.app.saveSettings();
    doc.dirty = false;
    await this.app.closeDoc(doc, true);
    await this.app.openPath(target);
    this.app.panels.show('signatures');
    toast(certify ? 'Document certified' : 'Document signed', 'ok');
  }

  // --- Forms --------------------------------------------------------------------------
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
        { label: 'Properties...', run: this.guard(() => formtools.fieldProperties(this, f.name)) },
        { label: f.required ? 'Make optional' : 'Make required', run: this.guard(async () => { await this.mutate((b) => ops.setFieldFlags(b, f.name, { required: !f.required })); this.renderGroup(); }) },
        { label: f.readOnly ? 'Make editable' : 'Read-only', run: this.guard(async () => { await this.mutate((b) => ops.setFieldFlags(b, f.name, { readOnly: !f.readOnly })); this.renderGroup(); }) },
        { label: 'Delete field', run: this.guard(async () => { await this.mutate((b) => ops.removeFormField(b, f.name)); this.renderGroup(); }) },
      ])))));
  }
  toggleFormHighlight() { this.app.formHighlight = !this.app.formHighlight; document.body.classList.toggle('form-hl', this.app.formHighlight); this.viewer.invalidate(); }
  exportForm() { return formtools.exportFormData(this); }
  fieldPropertiesFor(name) { return this.guard(() => formtools.fieldProperties(this, name))(); }
  importForm() { return formtools.importFormData(this); }
  async exportFormJson() {
    await this.doc.commitForms();
    const data = await ops.exportFormData(this.doc.bytes);
    const p = await window.dp.saveDialog({ title: 'Export form data', defaultPath: `${fileBase(this.doc.name)}_Data.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (p) { await window.dp.writeFile(p, new TextEncoder().encode(JSON.stringify(data, null, 2))); toast('Data exported', 'ok'); }
  }
  async importFormJson() {
    const [p] = await window.dp.openDialog({ title: 'Import form data', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!p) return;
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await window.dp.readFile(p))); } catch { throw new Error('The file does not contain valid JSON.'); }
    await this.mutate((b) => ops.importFormData(b, data));
  }
  async resetForm() { const c = await messageBox('Reset form', 'Clear all entered values?', ['Reset', 'Cancel'], { primary: 1 }); if (c === 0) await this.mutate((b) => ops.resetForm(b)); }
  async flattenForm() { const c = await messageBox('Flatten form', 'The fields are drawn permanently into the pages and can no longer be filled in afterwards.', ['Flatten', 'Cancel'], { primary: 1 }); if (c === 0) { await this.mutate((b) => ops.flattenForms(b)); if (this.group?.id === 'form') this.renderGroup(); } }

  /** XFA forms: dynamic ones become normal pages and form fields; static ones keep their pages and lose the XFA part. */
  async convertXfaDialog() {
    const doc = this.doc;
    const info = await ops.xfaInfo(doc.bytes);
    if (!info) { toast('This document has no XFA form.'); return; }
    const text = info.isStatic ? 'This is a static XFA form: its pages and fields are already in the document. The XFA part is removed, so every program shows and fills in the same form.' : 'This is a dynamic XFA form: other programs only show a placeholder page. Its layout is turned into normal pages with form fields, filled in with the data it contains. Scripts in the form are not taken over; check the result.';
    if (await messageBox('Convert XFA form', text, ['Convert', 'Cancel'], { primary: 0, cancel: 1 }) !== 0) return;
    let res = null;
    const ok = await busy('Converting form', () => this.mutate(async (b) => { res = await ops.convertXfa(b, readFont); return res; }));
    if (!ok) return;
    doc.xfa = false; doc.fullSave = true;
    this.app.renderBanner();
    toast(res.kind === 'static' ? 'XFA part removed; the form fields stay.' : `Form converted: ${res.pages} page${res.pages === 1 ? '' : 's'}, ${res.fields} field${res.fields === 1 ? '' : 's'}`, 'ok');
  }

  // --- Protection -----------------------------------------------------------------------------
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
      { k: 'metadata', label: 'Metadata', type: 'checkbox', value: true }, { k: 'attachments', label: 'Attachments', type: 'checkbox', value: true }, { k: 'comments', label: 'Comments', type: 'checkbox', value: true }, { k: 'javascript', label: 'JavaScript and actions', type: 'checkbox', value: true }, { k: 'links', label: 'Links', type: 'checkbox' }, { k: 'forms', label: 'Flatten form fields', type: 'checkbox' }, { k: 'thumbs', label: 'Thumbnails', type: 'checkbox', value: true },
    ], { ok: 'Sanitize' });
    if (!r) return;
    if (await this.mutate((b) => ops.sanitizeDocument(b, r))) this.doc.fullSave = true;
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
  /** How applied redactions look: fill colour (none = no box), overlay text, its colour, size (0 = fit), alignment, repeated. */
  redactLook() { return { fill: [0, 0, 0], text: '', textColor: [1, 1, 1], size: 0, align: 1, repeat: false, ...(this.app.settings.redactLook || {}) }; }
  async redactProperties() {
    const l = this.redactLook();
    const r = await formDialog('Redaction properties', [
      { type: 'info', label: 'How applied redactions look. The content under the marks is removed in any case.' },
      { k: 'box', label: 'Draw a box', type: 'checkbox', value: !!l.fill },
      { k: 'fill', label: 'Box colour', type: 'color', value: rgbToHex(l.fill || [0, 0, 0]) },
      { k: 'text', label: 'Overlay text', value: l.text, placeholder: 'e.g. REDACTED' },
      { k: 'textColor', label: 'Text colour', type: 'color', value: rgbToHex(l.textColor) },
      { k: 'size', label: 'Font size (0 = fit the box)', type: 'number', value: l.size, min: 0, max: 72 },
      { k: 'align', label: 'Alignment', type: 'select', options: [['0', 'Left'], ['1', 'Centre'], ['2', 'Right']], value: String(l.align) },
      { k: 'repeat', label: 'Repeat the text to fill the box', type: 'checkbox', value: l.repeat },
    ], { ok: 'Save' });
    if (!r) return;
    this.app.settings.redactLook = { fill: r.box ? hexToRgb(r.fill) : null, text: r.text || '', textColor: hexToRgb(r.textColor), size: Math.max(0, +r.size || 0), align: +r.align, repeat: !!r.repeat };
    await this.app.saveSettings();
    toast('Redaction properties saved', 'ok');
  }
  async applyRedactions() {
    const doc = this.doc;
    const marks = doc.allAnnots().filter((a) => a.type === 'redact');
    if (!marks.length) { toast('No redactions are marked.'); return; }
    const c = await messageBox('Apply redactions', 'The marked content will be permanently removed from the document: text, images and graphics under the marks, and comments, links and form fields that overlap them. The rest of the page stays as it is.', ['Apply', 'Cancel'], { primary: 1 });
    if (c !== 0) return;
    if (!(await doc.allowEdit())) return;
    await doc.commitForms();
    const byPage = new Map();
    for (const a of marks) {
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(...a.quads.map((q) => ({ rect: rectFromQuad(q) })));
    }
    let report = null;
    const ok = await busy('Applying redactions', () => doc.mutate(async (bytes) => {
      // The words under the marks: document information and tags that repeat them are removed too.
      const words = [];
      for (const [p, list] of byPage) for (const w of wordBoxes(await doc.pageText(p))) if (list.some((m) => rectsOverlap(w.rect, m.rect, 1))) words.push(w.text);
      const res = await redact.applyRedactions(bytes, byPage, { codec: imageCodec, removedText: words, look: this.redactLook() });
      // Independent check with PDF.js: no text may be left under the marks.
      const pdf = await pdfjs.getDocument({ data: res.bytes.slice(), ...RENDER_OPTS }).promise;
      try {
        for (const [p, list] of byPage) {
          const left = wordBoxes(await (await pdf.getPage(p + 1)).getTextContent()).filter((w) => list.some((m) => { const cx = w.rect[0] + (w.rect[2] - w.rect[0]) / 2; const cy = w.rect[1] + (w.rect[3] - w.rect[1]) / 2; return cx > m.rect[0] && cx < m.rect[2] && cy > m.rect[1] && cy < m.rect[3]; }));
          if (left.length) throw new Error(`The redaction could not be verified: text was still found under a mark on page ${p + 1}, so nothing was changed.`);
        }
      } finally { pdf.loadingTask.destroy(); }
      report = res.report;
      return res.bytes;
    }, { skipCheck: true }));
    if (!ok || !report) return;
    for (const [p, list] of byPage) doc.annots.set(p, doc.list(p).filter((a) => a.type !== 'redact' && !list.some((m) => rectsOverlap(boundsOf(a), m.rect))));
    doc.fullSave = true;
    doc.emit('reload', { annotOnly: true });
    const parts = [`Text: ${report.glyphs} character(s)`, `images: ${report.imagesCleared} cleared, ${report.imagesRemoved} removed`, `graphics: ${report.paths}`];
    if (report.annotations) parts.push(`comments, links and fields: ${report.annotations}`);
    if (report.metadata.length) parts.push(`also removed from: ${report.metadata.join(', ')}`);
    let note = '';
    if (report.stillHolding?.bookmarks) note = `\n\nThe removed text still appears in ${report.stillHolding.bookmarks} bookmark title(s). Check them before passing the document on.`;
    await messageBox('Redactions applied', `Removed on ${report.pages} page(s). ${parts.join('; ')}.${note}\n\nPlease save to keep the result.`);
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
    // pre: steps before recognition that should be one step together with it.
    let pre = 0;
    if (o.redo) {
      const r = await removeRecognizedText(doc.bytes, pages);
      if (r.count && await doc.mutate(() => r.bytes, { skipCheck: !!o.skipCheck })) { pre++; this.app.editor.invalidate(); }
    }
    // Preference: rotate skewed scans straight themselves before reading. Straight pages and pages with normal
    // text stay unchanged.
    if (this.app.settings.ocrDeskew && !o.noDeskew) {
      const skewed = await busy('Looking for skewed pages', () => scan.skewedScans(this.app, pages));
      if (this.doc !== doc) return 0;
      if (skewed.length && await this.straighten(skewed, { skipCheck: !!o.skipCheck, noOcr: true })) pre++;
    }
    const found = await busy('Recognizing text', (progress) => scan.recognize(this.app, pages, { lang, dpi: o.dpi || 'auto', progress }));
    if (this.doc !== doc) return 0;
    doc.ocrOffered = true;
    if (!found.length) {
      for (let k = 0; k < pre; k++) await doc.undo();
      if (!o.quiet) toast('No new text was recognized.'); this.app.renderBanner(); return 0;
    }
    const ok = await doc.mutate((b) => ops.addInvisibleText(b, found, readFont), { skipCheck: !!o.skipCheck });
    if (!ok) return 0;
    // Kept for "Review recognized text": the words with how sure the recognition was.
    if (doc.ocrBytes !== undefined && doc.ocrBytes !== doc.undoStack[doc.undoStack.length - 1]?.bytes) doc.ocrWords = null;
    doc.ocrWords = doc.ocrWords || new Map();
    for (const x of found) doc.ocrWords.set(x.page, x);
    doc.ocrBytes = doc.bytes;
    if (pre) doc.undoStack.splice(-pre, pre);
    this.app.editor.invalidate();
    this.app.renderBanner();
    if (!o.silent) toast(`Text recognized on ${found.length} page(s). It is now searchable and can be changed under "Edit PDF".`, 'ok');
    // Note about clearly skewed pages: they were read straightened, the image itself is still skewed.
    const tilted = found.filter((x) => Math.abs(x.skew || 0) >= 1);
    if (tilted.length && !o.silent) toast(`${tilted.length === 1 ? 'Page' : 'Pages'} ${tilted.map((x) => doc.label(x.page)).join(', ')} ${tilted.length === 1 ? 'was' : 'were'} scanned at an angle. The text was read anyway and lies over the image. "Straighten page" under "Scan & OCR" rotates the image straight.`);
    return found.length;
  }

  /** Recognize text in several files: each file (PDF or image) is read and saved as a searchable PDF in a folder. */
  async ocrFiles() {
    const paths = await window.dp.openDialog({ title: 'Recognize text in several files', multi: true, filters: [{ name: 'PDF and images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'gif', 'webp'] }] });
    if (!paths.length) return;
    const r = await formDialog('Recognize text in several files', [{ type: 'info', label: `${paths.length} file${paths.length === 1 ? '' : 's'}. Each one is saved as a searchable PDF ("_OCR") in the folder you choose next.` }, { k: 'lang', label: 'Language', type: 'select', options: scan.OCR_LANGS, value: this.app.settings.ocrLang || 'deu+eng' }], { ok: 'Next' });
    if (!r) return;
    const dir = await window.dp.folderDialog('Choose the folder for the searchable PDFs');
    if (!dir) return;
    const done = []; const failed = [];
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop();
      const open = this.app.docs.find((x) => x.path && x.path.toLowerCase() === p.toLowerCase());
      try {
        const d = open || (/\.pdf$/i.test(p) ? await this.app.openPath(p) : await this.app.openBytes(await conv.fileToPdf(p), `${fileBase(name)}.pdf`, { unsaved: true }));
        if (!d) throw new Error('The file could not be opened.');
        this.app.activate(d);
        await d.scanCheck?.catch(() => {});
        await this.recognizeText([...Array(d.numPages).keys()], { lang: r.lang, quiet: true, silent: true, skipCheck: true });
        let out = inFolder(dir, `${fileBase(name)}_OCR.pdf`);
        for (let n = 2; await window.dp.fileStat(out); n++) out = inFolder(dir, `${fileBase(name)}_OCR (${n}).pdf`);
        await window.dp.writeFile(out, await d.buildOutput({ noEncrypt: true }));
        done.push(out);
        if (!open) await this.app.closeDoc(d, true);
      } catch (e) { failed.push(`${name}: ${e.message}`); }
    }
    if (failed.length) await messageBox('Recognize text in several files', `${done.length} file${done.length === 1 ? '' : 's'} saved. ${failed.length} could not be read:\n${failed.slice(0, 8).join('\n')}`);
    else toast(`${done.length} searchable PDF${done.length === 1 ? '' : 's'} saved`, 'ok');
    if (done.length) window.dp.openPath(dir);
  }
  /** Review recognized text: the words the recognition was least sure of, each with its picture, to correct. */
  async ocrReview() {
    const doc = this.doc;
    if (!doc.ocrWords?.size) { toast('Recognize the text first: the review shows the words recognized since the document was opened.'); return; }
    if (doc.ocrBytes !== doc.bytes) { toast('The document changed after the text was recognized. Recognize it again (with "Recognize again") to review it.'); return; }
    const r = await formDialog('Review recognized text', [{ k: 'limit', label: 'Show words recognized with less than', type: 'select', options: [[70, '70 % certainty (uncertain words)'], [90, '90 % certainty'], [101, 'All words']], value: 70 }], { ok: 'Show' });
    if (!r) return;
    const list = [];
    for (const [page, entry] of [...doc.ocrWords.entries()].sort((a, b) => a[0] - b[0])) entry.words.forEach((w, k) => { if (w.conf !== undefined && w.conf < +r.limit && /\S/.test(w.text)) list.push({ page, k, w }); });
    if (!list.length) { toast('All recognized words are above this certainty.', 'ok'); return; }
    const shown = list.slice(0, 200);
    const canvases = new Map();
    const rows = [];
    for (const it of shown) {
      if (!canvases.has(it.page)) canvases.set(it.page, await this.viewer.renderToCanvas(it.page, 150));
      const { canvas, viewport } = canvases.get(it.page);
      const w = it.w; const hgt = w.height;
      const a = viewport.convertToViewportPoint(w.x - 2, w.y - hgt * 0.3); const b = viewport.convertToViewportPoint(w.x + w.width + 2, w.y + hgt * 0.9);
      const x = Math.min(a[0], b[0]); const y = Math.min(a[1], b[1]); const cw = Math.max(1, Math.abs(b[0] - a[0])); const ch = Math.max(1, Math.abs(b[1] - a[1]));
      const pic = h('canvas', { class: 'ocr-word', width: Math.round(cw), height: Math.round(ch) });
      pic.getContext('2d').drawImage(canvas, x, y, cw, ch, 0, 0, pic.width, pic.height);
      const input = h('input', { type: 'text', value: w.text, spellcheck: 'true', data: { ocrPage: String(it.page), ocrIndex: String(it.k) } });
      const band = w.conf >= 90 ? 'ok' : w.conf >= 70 ? 'warn' : 'bad';
      rows.push(h('div', { class: 'ocr-row' }, pic, input, h('span', { class: `badge ${band}`, title: 'Certainty of the recognition' }, `${Math.round(w.conf)} %`), h('small', {}, `Page ${doc.label(it.page)}`)));
    }
    for (const c of canvases.values()) c.canvas.width = 0;
    const box = h('div', { class: 'ocr-review' }, rows);
    const note = list.length > shown.length ? ` The first ${shown.length} of ${list.length} words are shown.` : '';
    if (await messageBox('Review recognized text', h('div', {}, h('p', {}, `Compare each word with its picture and correct it where it was read wrongly. Red: less than 70 % certain, yellow: 70 to 89 %.${note}`), box), ['Apply', 'Cancel'], { primary: 0, wide: true, cancel: 1 }) !== 0) return;
    const changed = new Set();
    for (const inp of box.querySelectorAll('input')) {
      const entry = doc.ocrWords.get(+inp.dataset.ocrPage); const w = entry.words[+inp.dataset.ocrIndex];
      const v = inp.value.trim();
      if (v && v !== w.text) { w.text = v; w.conf = 100; changed.add(+inp.dataset.ocrPage); }
    }
    if (!changed.size) { toast('Nothing was changed.'); return; }
    const pages = [...changed];
    const ok = await doc.mutate(async (b) => {
      const removed = await removeRecognizedText(b, pages);
      return ops.addInvisibleText(removed.bytes, pages.map((p) => doc.ocrWords.get(p)), readFont);
    });
    if (ok) { doc.ocrBytes = doc.bytes; this.app.editor.invalidate(); toast(`Recognized text corrected on ${pages.length} page${pages.length === 1 ? '' : 's'}`, 'ok'); }
  }
  /** Enhance scanned pages: even lighting and white paper, or black and white, and fewer specks. */
  async enhanceScanDialog() {
    const r = await formDialog('Enhance scanned pages', [
      { k: 'mode', label: 'Result', type: 'select', options: [['clean', 'Clean up (paper white, stronger contrast, colours stay)'], ['bw', 'Black and white']], value: 'clean' },
      { k: 'denoise', label: 'Remove specks and noise', type: 'checkbox', value: true },
      { type: 'info', label: 'The scan images are cleaned where they are: recognized text, comments and form fields stay.' }, this.range(),
    ], { validate: this.validateRange, ok: 'Enhance' });
    if (!r) return;
    let res = null;
    await busy('Enhancing scans', () => this.mutate(async (b) => { res = await ops.enhanceScans(b, this.pagesOf(r), { mode: r.mode, denoise: r.denoise, codec: imageCodec }); return res; }));
    const extra = [res.notScans.length ? `${res.notScans.length} page${res.notScans.length === 1 ? ' is' : 's are'} not a scan` : '', res.left ? `${res.left} image${res.left === 1 ? '' : 's'} could not be changed` : ''].filter(Boolean).join(', ');
    toast(res.images ? `${res.pages} page${res.pages === 1 ? '' : 's'} enhanced${extra ? ` (${extra})` : ''}` : `Nothing was enhanced${extra ? `: ${extra}` : '.'}`, res.images ? 'ok' : undefined);
  }
  /**
   * Straighten a photographed page (perspective): the sheet's corners are found (or placed by hand on the preview)
   * and the area inside them becomes the page, upright and rectangular.
   */
  async perspectiveDialog(preset) {
    const doc = this.doc; const i = this.viewer.current;
    const v = doc.pages[i].view;
    const dpi = Math.max(72, Math.min(200, (2000 * 72) / Math.max(v[2] - v[0], v[3] - v[1])));
    const { canvas } = await this.viewer.renderToCanvas(i, dpi);
    const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
    const img = { width: canvas.width, height: canvas.height, data: ctx2.getImageData(0, 0, canvas.width, canvas.height).data };
    const found = scanfix.detectDocument(img);
    const W = canvas.width; const H = canvas.height;
    let q = preset || found || [[W * 0.05, H * 0.05], [W * 0.95, H * 0.05], [W * 0.95, H * 0.95], [W * 0.05, H * 0.95]];
    const k = Math.min(1, 560 / W, 440 / H);
    const view = h('canvas', { width: Math.round(W * k), height: Math.round(H * k) });
    view.getContext('2d').drawImage(canvas, 0, 0, view.width, view.height);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pq-svg'); svg.setAttribute('width', view.width); svg.setAttribute('height', view.height);
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    svg.append(poly);
    const handles = q.map((_, n) => h('div', { class: 'pq-handle', data: { corner: String(n) }, title: ['Top left', 'Top right', 'Bottom right', 'Bottom left'][n] }));
    const draw = () => {
      poly.setAttribute('points', q.map(([x, y]) => `${x * k},${y * k}`).join(' '));
      handles.forEach((el, n) => { el.style.left = `${q[n][0] * k}px`; el.style.top = `${q[n][1] * k}px`; });
    };
    handles.forEach((el, n) => el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const r0 = view.getBoundingClientRect();
      const move = (m) => { q = q.slice(); q[n] = [Math.max(0, Math.min(W, (m.clientX - r0.left) / k)), Math.max(0, Math.min(H, (m.clientY - r0.top) / k))]; draw(); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    }));
    const stage = h('div', { class: 'pq-stage', style: { width: `${view.width}px`, height: `${view.height}px` } }, view, svg, handles);
    draw();
    const msg = found ? 'The corners of the sheet were found. Drag a corner to correct it.' : 'The sheet could not be found automatically. Drag the four corners onto the corners of the sheet.';
    if (await messageBox('Straighten photo (perspective)', h('div', {}, h('p', {}, msg), stage), ['Straighten', 'Cancel'], { primary: 0, wide: true, cancel: 1 }) !== 0) { canvas.width = 0; return false; }
    let out;
    try { out = scanfix.warp(img, q); } catch (e) { canvas.width = 0; throw e; }
    canvas.width = 0;
    const c = document.createElement('canvas'); c.width = out.width; c.height = out.height;
    c.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    const jpeg = await canvasBytes(c, 'image/jpeg', 0.9);
    c.width = 0;
    const hadText = (await doc.pageText(i)).items.some((x) => x.str?.trim());
    await this.mutate((b) => ops.setPagePicture(b, i, jpeg, (out.width / dpi) * 72, (out.height / dpi) * 72), { pages: [i] });
    this.app.editor.invalidate();
    // The recognized text went with the old picture: read the straightened page again.
    if (hadText) await this.recognizeText([i], { quiet: true });
    toast('Page straightened', 'ok');
    return true;
  }

  // --- Straighten skewed scans -------------------------------------------------------------
  /**
   * Rotates the image of scanned pages straight. list: [{ page, angle }] (angle: skew in degrees, positive
   * clockwise). Pages that had recognized text are read again afterwards; everything together is one step
   * for "Undo". Returns the number of straightened pages.
   */
  async straighten(list, o = {}) {
    const doc = this.doc;
    if (!list.length) return 0;
    const edit = await loadForEdit(doc.bytes);
    const jobs = [];
    await busy('Straightening pages', async (progress) => {
      for (let k = 0; k < list.length; k++) {
        const { page, angle } = list[k];
        progress(k / list.length, `Page ${doc.label(page)} (${k + 1} of ${list.length})`);
        const info = await scan.pageInfo(doc, page, edit);
        // Resolution of the new image: like the previous one, between 150 and 300 dpi.
        const dpi = Math.round(Math.min(300, Math.max(150, info.dpi || 200)));
        jobs.push({ page, jpeg: await scan.straightenedPage(this.app, page, angle, dpi), hadText: info.hasText });
      }
    });
    if (this.doc !== doc) return 0;
    const ok = await doc.mutate((b) => ops.setPageImages(b, jobs), { pages: jobs.map((j) => j.page), skipCheck: !!o.skipCheck });
    if (!ok) return 0;
    this.app.editor.invalidate();
    // The previously recognized text matched the skewed image and was removed with it: read again.
    const again = jobs.filter((j) => j.hadText).map((j) => j.page);
    if (again.length && !o.noOcr) { const n = await this.recognizeText(again, { skipCheck: true, quiet: true, silent: true, noDeskew: true }); if (n) doc.undoStack.splice(-1, 1); }
    return jobs.length;
  }

  /** Command "Straighten page": detected angle with preview, can be corrected by hand. */
  async deskew() {
    const doc = this.doc;
    if (!(await doc.allowEdit())) return;
    const cur = this.viewer.current;
    const scanPages = async (pages) => { const edit = await loadForEdit(doc.bytes); const out = []; for (const p of pages) if (scan.isScanPage(await scan.pageInfo(doc, p, edit))) out.push(p); return out; };
    if (!(await scanPages([cur])).length) {
      await messageBox('Straighten page', `Page ${doc.label(cur)} is not a scan: it contains normal text or no page-filling image and stays unchanged.\n\nOnly the image of a scanned or photographed page can be straightened.`);
      return;
    }
    const measured = await busy('Determining angle', () => scan.pageSkew(this.app, cur));
    const auto = usableSkew(measured);
    const { canvas: base } = await this.viewer.renderToCanvas(cur, 50, { noAnnots: true });
    const view = h('canvas', { class: 'deskew-view', width: base.width, height: base.height });
    const angleIn = h('input', { type: 'number', step: '0.1', min: '-15', max: '15', value: auto.toFixed(1), data: { field: 'angle' }, 'aria-label': 'Skew in degrees' });
    const draw = () => {
      const a = parseFloat(angleIn.value) || 0; const c = view.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#fff'; c.fillRect(0, 0, view.width, view.height);
      c.translate(view.width / 2, view.height / 2); c.rotate((-a * Math.PI) / 180); c.drawImage(base, -base.width / 2, -base.height / 2);
      c.setTransform(1, 0, 0, 1, 0, 0);
      // Guide lines: they show whether the lines are horizontal.
      c.strokeStyle = 'rgba(14,124,134,.4)'; c.lineWidth = 1;
      for (let y = 30; y < view.height; y += 30) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(view.width, y + 0.5); c.stroke(); }
    };
    angleIn.addEventListener('input', draw);
    const note = auto ? `Detected skew: ${auto.toFixed(1)} degrees.` : Math.abs(measured.angle) < MIN_SKEW && measured.confidence > 0 ? 'The page is already straight. You can still enter an angle by hand.' : 'The skew could not be determined reliably (e.g. a photo without text lines). Please set the angle by hand.';
    const node = h('div', { class: 'deskew' }, view,
      h('div', { class: 'deskew-row' }, h('label', {}, h('span', {}, 'Skew in degrees (positive: rotated clockwise)'), angleIn), h('button', { class: 'btn', type: 'button', data: { act: 'auto' }, onclick: () => { angleIn.value = auto.toFixed(1); draw(); } }, 'Automatic')),
      h('div', { class: 'lp-note', data: { note: '1' } }, `${note} The preview shows the page after rotating.`));
    draw();
    const r = await formDialog('Straighten page', [
      { type: 'node', node }, { ...this.range('Pages'), value: String(cur + 1) },
      { type: 'info', label: `The angle above applies to page ${doc.label(cur)}. Other selected pages are straightened with their own automatically detected angle. Pages that are not scans and pages that are already straight stay unchanged. The image of the page is recalculated; recognized text is read again afterwards.` },
    ], { ok: 'Straighten', wide: true, validate: (v) => this.validateRange(v) || (!Number.isFinite(parseFloat(angleIn.value)) || Math.abs(parseFloat(angleIn.value)) > 15 ? 'Please enter an angle between -15 and 15 degrees.' : null) });
    base.width = 0;
    if (!r) return;
    const pages = this.pagesOf(r); const manual = parseFloat(angleIn.value) || 0;
    const list = [];
    if (pages.includes(cur) && Math.abs(manual) >= 0.05) list.push({ page: cur, angle: manual });
    const others = pages.filter((p) => p !== cur);
    if (others.length) list.push(...await busy('Looking for skewed pages', () => scan.skewedScans(this.app, others)));
    list.sort((p, q) => p.page - q.page);
    if (!list.length) { toast('The selected pages are already straight or are not scans. Nothing was changed.'); return; }
    const n = await this.straighten(list, { skipCheck: true });
    if (n) toast(`${n === 1 ? 'Page' : `${n} pages`} straightened${pages.length > n ? `, ${pages.length - n} unchanged (straight or not a scan)` : ''}. With "Undo" (Ctrl+Z) you can take this back.`, 'ok');
  }

  // --- Exports ----------------------------------------------------------------------------
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
      await busy('Creating images', (p) => conv.pageImages(this.app, { dpi: +r.dpi, mime: `image/${fmt}` }, (i, bytes) => window.dp.writeFile(inFolder(dir, `${base}_P${String(i + 1).padStart(3, '0')}.${ext}`), bytes), p));
      toast('Images saved', 'ok'); window.dp.openPath(dir);
      return;
    }
    const meta = { docx: ['Microsoft Word', conv.toDocx], xlsx: ['Microsoft Excel', conv.toXlsx], pptx: ['Microsoft PowerPoint', conv.toPptx], html: ['HTML', conv.toHtml], rtf: ['Rich Text', conv.toRtf], txt: ['Text', conv.toText], md: ['Markdown', conv.toMarkdown] }[fmt];
    let mode;
    if (fmt === 'pptx') { const r = await formDialog('Export as PowerPoint', [{ k: 'mode', label: 'Content', type: 'select', options: [['exact', 'Page as image (exact)'], ['edit', 'Text and images (editable)']], value: 'exact' }], { ok: 'Next' }); if (!r) return; mode = r.mode; }
    const p = await window.dp.saveDialog({ title: `Export as ${meta[0]}`, defaultPath: doc.path ? doc.path.replace(/\.pdf$/i, `.${fmt}`) : `${base}.${fmt}`, filters: [{ name: meta[0], extensions: [fmt] }] });
    if (!p) return;
    const data = await busy('Exporting document', (pr) => meta[1](this.app, pr, mode));
    await window.dp.writeFile(p, data);
    toast('Export complete', 'ok');
    window.dp.reveal(p);
  }
  /** Export all images: every image the pages use, once, as JPEG (unchanged), PNG (with transparency) or JPEG 2000. */
  async exportImages() {
    const doc = this.doc;
    if (!doc) { toast('Please open a document first.'); return; }
    const r = await formDialog('Export all images', [{ type: 'info', label: 'Every image is saved once, in its original quality: JPEG images unchanged, other images as PNG with their transparency.' }, { k: 'minSide', label: 'Skip images smaller than (pixels)', type: 'number', value: 8, min: 1, max: 10000 }, this.range()], { validate: this.validateRange, ok: 'Next' });
    if (!r) return;
    const dir = await window.dp.folderDialog('Choose destination folder');
    if (!dir) return;
    const base = fileBase(doc.name);
    const res = await busy('Exporting images', async (p) => {
      const d = await loadForEdit(await doc.buildOutput({ noEncrypt: true }));
      const out = await images.exportImages(d, this.pagesOf(r), { minSide: r.minSide || 1, codec: imageCodec, progress: (k, n) => p(k / n, `Image ${k} of ${n}`) });
      const count = {};
      for (const im of out.images) {
        count[im.page] = (count[im.page] || 0) + 1;
        await window.dp.writeFile(inFolder(dir, `${base}_P${String(im.page + 1).padStart(3, '0')}_${count[im.page]}.${im.ext}`), im.data);
      }
      return out;
    });
    if (!res.images.length && !res.skipped.length) { toast('These pages contain no images.'); return; }
    const msg = `${res.images.length} image${res.images.length === 1 ? '' : 's'} saved`;
    if (res.skipped.length) await messageBox('Export all images', `${msg}. ${res.skipped.length} could not be exported:\n${[...new Set(res.skipped.map((x) => `Page ${x.page + 1}: ${x.reason}`))].slice(0, 8).join('\n')}`);
    else toast(msg, 'ok');
    if (res.images.length) window.dp.openPath(dir);
  }
  /** Save as PDF/A: the document is checked against PDF/A-2b or -3b, converted where possible, and what remains is listed. */
  async pdfa() {
    const doc = this.doc;
    const r = await formDialog('Save as PDF/A', [
      { k: 'level', label: 'Standard', type: 'select', options: pdfa.LEVELS, value: this.app.settings.pdfaLevel || '2b' },
      { type: 'info', label: 'The document is checked against the standard and converted where this does not change how the pages look (identification, colour profile, scripts and actions, comments, image settings). Problems that remain, such as fonts that are not embedded, are listed before saving. This is not a certified validation.' },
    ], { ok: 'Convert' });
    if (!r) return;
    this.app.settings.pdfaLevel = r.level; await this.app.saveSettings();
    const icc = await window.dp.srgbIcc();
    const res = await busy('Converting to PDF/A', async () => pdfa.convertPdfA(await doc.buildOutput({ noEncrypt: true }), r.level, icc, fileBase(doc.name)));
    const label = pdfa.LEVELS.find(([k]) => k === r.level)[1];
    const body = h('div', {},
      h('p', {}, res.remaining.length ? `${label}: ${res.remaining.length} problem(s) could not be fixed. The file can be saved, but it does not meet the standard.` : `The document meets the checked rules of ${label}.`),
      res.remaining.length ? h('ul', { class: 'pdfa-issues' }, res.remaining.map((i) => h('li', {}, `${i.message} (clause ${i.clause})`))) : null,
      res.fixed.length ? h('details', {}, h('summary', {}, `Fixed (${res.fixed.length})`), h('ul', {}, res.fixed.map((t) => h('li', {}, t)))) : null);
    if (await messageBox('Save as PDF/A', body, ['Save', 'Cancel'], { primary: 0 }) !== 0) return;
    const p = await window.dp.saveDialog({ title: 'Save PDF/A', defaultPath: doc.suggestedPath('_PDFA') });
    if (!p) return;
    await window.dp.writeFile(p, res.bytes);
    toast(`${label} saved`, 'ok');
  }

  /** Checks the document against PDF/A-2b and -3b without changing it. */
  async pdfaCheck() {
    const doc = this.doc;
    const bytes = await doc.buildOutput({ noEncrypt: true });
    const [a2, a3] = await busy('Checking PDF/A', async () => [await pdfa.verifyPdfA(bytes, '2b'), await pdfa.verifyPdfA(bytes, '3b')]);
    const list = (title, issues) => h('div', {}, h('h4', {}, `${title}: ${issues.length ? `${issues.length} problem(s)` : 'no problems found'}`),
      issues.length ? h('ul', { class: 'pdfa-issues' }, issues.map((i) => h('li', {}, `${i.message} (clause ${i.clause}${i.fixable ? ', fixed by Save as PDF/A' : ''})`))) : null);
    await messageBox('PDF/A check', h('div', {}, list('PDF/A-2b', a2), list('PDF/A-3b', a3)), ['OK'], { wide: true });
  }

  // --- Create PDF ----------------------------------------------------------------------
  async createFromFile() {
    const paths = await window.dp.openDialog({ title: 'Create PDF from file', multi: true, filters: conv.CREATE_FILTERS });
    for (const p of paths) {
      const bytes = await busy('Creating PDF', () => conv.fileToPdf(p));
      await this.app.openBytes(bytes, `${fileBase(p.split(/[\\/]/).pop())}.pdf`, { unsaved: true, fromImage: /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(p) });
    }
  }
  /** Several files (images, Office, text, PDF) become one PDF each, saved in a folder. */
  async createSeparate() {
    const paths = await window.dp.openDialog({ title: 'Create separate PDFs from files', multi: true, filters: conv.CREATE_FILTERS });
    if (!paths.length) return;
    const dir = await window.dp.folderDialog('Choose the folder for the PDFs');
    if (!dir) return;
    const done = []; const failed = [];
    await busy('Creating PDFs', async (progress) => {
      for (let k = 0; k < paths.length; k++) {
        const p = paths[k]; const name = p.split(/[\\/]/).pop();
        progress(k / paths.length, name);
        try {
          const bytes = await conv.fileToPdf(p);
          let out = inFolder(dir, `${fileBase(name)}.pdf`);
          for (let n = 2; (await window.dp.fileStat(out)) || done.includes(out); n++) out = inFolder(dir, `${fileBase(name)} (${n}).pdf`);
          await window.dp.writeFile(out, bytes);
          done.push(out);
        } catch (e) { failed.push(`${name}: ${e.message}`); }
      }
    });
    if (failed.length) await messageBox('Create separate PDFs', `${done.length} PDF${done.length === 1 ? '' : 's'} created. ${failed.length} file${failed.length === 1 ? '' : 's'} could not be converted:\n${failed.slice(0, 8).join('\n')}`);
    else toast(`${done.length} PDF${done.length === 1 ? '' : 's'} created`, 'ok');
    if (done.length) window.dp.openPath(dir);
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

  // --- Compress -----------------------------------------------------------------------
  /** Reduce file size with ready-made settings. */
  async compress() {
    const doc = this.doc;
    if (!doc) { toast('Please open a document first.'); return; }
    const r = await formDialog('Reduce file size', [
      { k: 'level', label: 'Settings', type: 'select', options: [['standard', 'Standard (recommended): images to 150 ppi'], ['mobile', 'Mobile (smallest, for screens): images to 96 ppi'], ['high', 'High quality (printing): images to 300 ppi']], value: 'standard' },
      { type: 'info', label: 'Images are reduced to the resolution at which the pages show them, black-and-white scans are stored as Group 4, and unused data is removed. Text and graphics stay as they are.' },
    ], { ok: 'Compress' });
    if (!r) return;
    await this.runOptimizer(optimize.PRESETS[r.level] || optimize.PRESETS.standard);
  }

  /** Advanced optimization: every setting of the optimizer; the last choice is remembered. */
  async compressAdvanced() {
    if (!this.doc) { toast('Please open a document first.'); return; }
    const s = { ...optimize.PRESETS.standard, ...(this.app.settings.optimize || {}) };
    const comp = [['jpeg', 'JPEG'], ['flate', 'Lossless (Flate)'], ['retain', 'Keep']];
    const quality = [[25, 'Minimum'], [45, 'Low'], [60, 'Medium'], [80, 'High'], [95, 'Maximum']];
    const imageFields = (key, label) => [
      { type: 'info', label },
      { k: `${key}Down`, label: 'Reduce resolution', type: 'checkbox', value: s[key].downsample },
      { k: `${key}Target`, label: 'To (ppi)', type: 'number', value: s[key].target, min: 36, max: 2400 },
      { k: `${key}Above`, label: 'For images above (ppi)', type: 'number', value: s[key].above, min: 36, max: 3600 },
      ...(key === 'mono' ? [{ k: 'monoComp', label: 'Compression', type: 'select', options: [['g4', 'CCITT Group 4 (lossless)'], ['retain', 'Keep']], value: s.mono.compression }]
        : [{ k: `${key}Comp`, label: 'Compression', type: 'select', options: comp, value: s[key].compression }, { k: `${key}Quality`, label: 'JPEG quality', type: 'select', options: quality, value: s[key].quality }]),
    ];
    const r = await formDialog('Advanced optimization', [
      ...imageFields('color', 'Colour images'), ...imageFields('gray', 'Greyscale images'), ...imageFields('mono', 'Black-and-white images'),
      { type: 'info', label: 'Discard' },
      { k: 'discardThumbnails', label: 'Page thumbnails', type: 'checkbox', value: s.discardThumbnails },
      { k: 'discardAlternates', label: 'Alternate images', type: 'checkbox', value: s.discardAlternates },
      { k: 'discardTags', label: 'Document tags (accessibility structure)', type: 'checkbox', value: s.discardTags },
      { k: 'discardFormActions', label: 'Form submission, import and reset actions', type: 'checkbox', value: s.discardFormActions },
      { k: 'discardPrintSettings', label: 'Print settings', type: 'checkbox', value: s.discardPrintSettings },
      { k: 'discardExternalRefs', label: 'Links to other documents and programs', type: 'checkbox', value: s.discardExternalRefs },
      { k: 'discardSearchIndex', label: 'Embedded search index', type: 'checkbox', value: s.discardSearchIndex },
      { type: 'info', label: 'Clean up' },
      { k: 'removeUnused', label: 'Remove images and forms the pages never draw', type: 'checkbox', value: s.removeUnused },
      { k: 'removeInvalidLinks', label: 'Remove links to pages that do not exist', type: 'checkbox', value: s.removeInvalidLinks },
      { k: 'flateUnencoded', label: 'Compress uncompressed data', type: 'checkbox', value: s.flateUnencoded },
      { k: 'lzwToFlate', label: 'Store LZW-compressed data with Flate', type: 'checkbox', value: s.lzwToFlate },
    ], { ok: 'Optimize', wide: true });
    if (!r) return;
    const img = (key) => ({ downsample: !!r[`${key}Down`], target: +r[`${key}Target`], above: Math.max(+r[`${key}Above`], +r[`${key}Target`]), compression: r[`${key}Comp`], quality: +r[`${key}Quality`] || 60 });
    const settings = {
      color: img('color'), gray: img('gray'), mono: { downsample: !!r.monoDown, target: +r.monoTarget, above: Math.max(+r.monoAbove, +r.monoTarget), compression: r.monoComp },
      ...Object.fromEntries(['discardThumbnails', 'discardAlternates', 'discardTags', 'discardFormActions', 'discardPrintSettings', 'discardExternalRefs', 'discardSearchIndex', 'removeUnused', 'removeInvalidLinks', 'flateUnencoded', 'lzwToFlate'].map((k) => [k, !!r[k]])),
    };
    this.app.settings.optimize = settings; await this.app.saveSettings();
    await this.runOptimizer(settings);
  }

  async runOptimizer(settings) {
    const doc = this.doc;
    const before = doc.bytes.length;
    let report = null;
    const ok = await busy('Compressing PDF', (progress) => this.mutate(async (b) => {
      const res = await optimize.optimizePdf(b, settings, { codec: imageCodec, progress });
      report = res.report;
      return res.bytes;
    }));
    if (!ok || !report) return;
    // The next save writes the whole file again, or the old data would stay in it.
    doc.fullSave = true;
    const lines = [`Before: ${fmtSize(before)}`, `After: ${fmtSize(doc.bytes.length)}`, `Images: ${report.resampled} reduced, ${report.recompressed} recompressed (of ${report.images})`];
    const more = [[report.unused, 'unused images and forms removed'], [report.thumbnails, 'page thumbnails removed'], [report.invalidLinks, 'invalid links removed'], [report.streamsCompressed + report.lzwConverted, 'data streams compressed'], [report.formActions, 'form actions removed'], [report.externalRefs, 'links to other documents removed']].filter(([n]) => n);
    for (const [n, t] of more) lines.push(`${n} ${t}`);
    if (report.tags) lines.push('Document tags removed');
    await messageBox('PDF compressed', `${lines.join('\n')}\n\nPlease save to keep the result.`);
  }

  /** Runs action steps on files without the wizard (tests). */
  runAction(steps, files, dir) { return runAction(this.app, steps, files, dir); }

  // --- Measure -----------------------------------------------------------------------------
  /** Snapping for the measure tools: the page's geometry is read once per page and document state. */
  snapGeom(i) {
    const d = this.doc;
    if (!d) return null;
    if (!this.snapCache || this.snapCache.bytes !== d.bytes) this.snapCache = { bytes: d.bytes, pages: new Map(), doc: null, loading: null };
    const c = this.snapCache;
    if (c.pages.has(i)) return c.pages.get(i);
    if (!c.doc) { if (!c.loading) c.loading = loadForEdit(d.bytes).then((x) => { c.doc = x; }).catch(() => {}); return null; }
    let g = null;
    try { g = snap.pageGeometry(c.doc.getPage(i)); } catch { g = null; }
    c.pages.set(i, g);
    return g;
  }
  snapFor(i, p, tol) { return this.app.settings.measureSnap === false ? null : snap.snapPoint(this.snapGeom(i), p, tol); }
  async toggleSnap() {
    this.app.settings.measureSnap = this.app.settings.measureSnap === false;
    await this.app.saveSettings();
    toast(this.app.settings.measureSnap ? 'Measure tools snap to lines and points' : 'Snapping turned off', 'ok');
  }
  /** The measurements of the document (distance, perimeter, area) as a CSV file for a spreadsheet. */
  async exportMeasurements() {
    const kinds = { Distance: 'distance', Perimeter: 'perimeter', Area: 'area' };
    const per = {}; const rows = [];
    for (const a of this.doc.allAnnots()) {
      if (!kinds[a.subject]) continue;
      const v = snap.parseMeasurement(a.contents);
      if (!v) continue;
      per[a.page] = per[a.page] || 0;
      rows.push({ page: a.page, index: per[a.page]++, type: kinds[a.subject], ...v, label: a.contents || '', author: a.author || '' });
    }
    if (!rows.length) { toast('This document has no measurements.'); return; }
    const p = await window.dp.saveDialog({ title: 'Export measurements', defaultPath: this.doc.suggestedPath('_Measurements').replace(/.pdf$/i, '.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!p) return;
    await window.dp.writeFile(p, new TextEncoder().encode(`﻿${snap.measurementsCsv(rows)}`));
    toast(`${rows.length} measurement${rows.length === 1 ? '' : 's'} exported`, 'ok');
  }
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

  // --- Compare ------------------------------------------------------------------------
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

  // --- Reports ---------------------------------------------------------------------------
  report(title, rows) {
    const label = { ok: 'Passed', bad: 'Failed', warn: 'Note' };
    return messageBox(title, h('table', { class: 'tbl' }, rows.map(([s, a, b]) => h('tr', {}, h('td', {}, h('span', { class: `badge ${s}` }, label[s])), h('td', {}, a), h('td', {}, b || '')))), ['Close'], { wide: true });
  }
  /** Accessibility check: the rules of the common checkers, with a fix where DocPilot has one. */
  async accessCheck() {
    const d = this.doc;
    const pageText = [];
    for (let p = 0; p < d.numPages; p++) pageText.push(p < 300 ? (await d.pageText(p)).items.some((x) => x.str?.trim()) : true);
    const rows = await ops.accessibilityReport(d.bytes, { permissions: d.permissions || null, pageText, hasJS: !!d.hasJS });
    const fixes = {
      'tagged-pdf': ['Tag', () => this.autoTagDialog()], 'tagged-content': ['Tag', () => this.autoTagDialog()], 'image-only': ['Recognize text', () => this.ocr()],
      language: ['Set', () => this.titleLang()], title: ['Set', () => this.titleLang()], 'tab-order': ['Fix', () => this.mutate((b) => ops.fixAccessibility(b))],
      'tagged-fields': ['Tag', () => this.tagFieldsDialog()], 'tagged-annotations': ['Tag', () => this.tagFieldsDialog()], 'figures-alt': ['Add', () => this.altTextDialog()],
      'heading-nesting': ['Tags', () => this.app.panels.show('tags')], 'reading-order': ['Tags', () => this.app.panels.show('tags')],
    };
    const label = { passed: 'Passed', failed: 'Failed', manual: 'Check manually', skipped: 'Not applicable' };
    const cls = { passed: 'ok', failed: 'bad', manual: 'warn', skipped: '' };
    const count = (st) => rows.filter((x) => x.status === st).length;
    const table = h('table', { class: 'tbl access-report' }, rows.map((x) => h('tr', { data: { rule: x.id, status: x.status } },
      h('td', {}, h('span', { class: `badge ${cls[x.status]}` }, label[x.status])), h('td', {}, h('b', {}, x.name), h('br'), h('small', {}, x.status === 'failed' ? x.fix : x.description)), h('td', {}, x.detail || ''),
      h('td', {}, x.status !== 'passed' && x.status !== 'skipped' && fixes[x.id] ? h('button', { class: 'btn', type: 'button', onclick: (e) => { e.target.closest('.dlg').querySelector('.f .btn').click(); setTimeout(() => this.guard(fixes[x.id][1])(), 0); } }, fixes[x.id][0]) : ''))));
    await messageBox('Accessibility check', h('div', {}, h('p', {}, `${count('passed')} passed, ${count('failed')} failed, ${count('manual')} to check manually.`), table), ['Close'], { wide: true });
  }
  /** Gives an untagged document tags: headings, paragraphs, figures, form fields and links. */
  async autoTagDialog() {
    const r = await formDialog('Automatically tag document', [{ type: 'info', label: 'Text becomes paragraphs and headings (from the size and weight of the text), images become figures, lines and decoration are marked as decoration. Form fields and links get tags too. The reading order follows the page content; check it in the Tags panel. Afterwards, add alternate text to the images.' }], { ok: 'Tag' });
    if (!r) return;
    let res = null;
    await this.mutate(async (b) => { res = await ops.autoTag(b); return res; });
    toast(`Tagged: ${res.headings} heading${res.headings === 1 ? '' : 's'}, ${res.paragraphs} paragraph${res.paragraphs === 1 ? '' : 's'}, ${res.figures} figure${res.figures === 1 ? '' : 's'}, ${res.fields} form field${res.fields === 1 ? '' : 's'}`, 'ok');
    this.app.panels.show('tags');
  }
  async tagFieldsDialog() {
    let res = null;
    await this.mutate(async (b) => { res = await ops.tagFormFields(b); return res; });
    toast(res.fields || res.links ? `Tagged: ${res.fields} form field${res.fields === 1 ? '' : 's'}, ${res.links} link${res.links === 1 ? '' : 's'}` : 'All form fields and links are already tagged.', 'ok');
  }
  /** Alternate text for every figure: a picture of it and a text field. */
  async altTextDialog() {
    let figures = (await ops.readTags(this.doc.bytes)).length ? [] : null;
    if (figures === null) {
      if (await messageBox('Alternate text for images', 'Alternate text is stored in the tags of the document, and this document has none yet. Tag it now?', ['Tag', 'Cancel'], { primary: 0 }) !== 0) return;
      await this.mutate((b) => ops.autoTag(b));
    }
    const { findTags } = await import('./pdf/a11y.js');
    figures = findTags(await ops.readTags(this.doc.bytes), (n) => n.role === 'Figure' && n.ref);
    if (!figures.length) { toast('This document has no figures.'); return; }
    const rows = [];
    for (const [k, fg] of figures.entries()) {
      let pic = null;
      if (fg.page !== null && fg.bbox && k < 60) {
        try {
          const { canvas, viewport } = await this.viewer.renderToCanvas(fg.page, 60);
          const a = viewport.convertToViewportPoint(fg.bbox[0], fg.bbox[1]); const b = viewport.convertToViewportPoint(fg.bbox[2], fg.bbox[3]);
          const x = Math.min(a[0], b[0]); const y = Math.min(a[1], b[1]); const w = Math.max(1, Math.abs(a[0] - b[0])); const ht = Math.max(1, Math.abs(a[1] - b[1]));
          const s = Math.min(1, 120 / Math.max(w, ht));
          pic = h('canvas', { width: Math.round(w * s), height: Math.round(ht * s), class: 'alt-pic' });
          pic.getContext('2d').drawImage(canvas, x, y, w, ht, 0, 0, pic.width, pic.height);
        } catch { pic = null; }
      }
      const input = h('textarea', { rows: 2, placeholder: 'Describe the image', data: { altRef: fg.ref } }); input.value = fg.alt || '';
      rows.push(h('div', { class: 'alt-row' }, pic || h('div', { class: 'alt-pic empty' }, 'Figure'), h('div', {}, h('small', {}, `Page ${(fg.page ?? 0) + 1}`), input)));
    }
    const box = h('div', { class: 'alt-list' }, rows);
    if (await messageBox('Alternate text for images', h('div', {}, h('p', {}, 'Describe what each image shows for people who cannot see it. Leave decorative images empty.'), box), ['Save', 'Cancel'], { primary: 0, wide: true, cancel: 1 }) !== 0) return;
    const map = Object.fromEntries([...box.querySelectorAll('textarea')].map((t) => [t.dataset.altRef, t.value]));
    await this.mutate((b) => ops.setAltTexts(b, map));
    toast('Alternate text saved', 'ok');
  }
  async titleLang() {
    const m = (await this.doc.pdf.getMetadata()).info;
    const r = await formDialog('Title and language', [{ k: 'title', label: 'Title', value: m.Title || fileBase(this.doc.name), required: true }, { k: 'lang', label: 'Language', type: 'select', options: [['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['de-CH', 'German (Switzerland)'], ['de-DE', 'German'], ['fr-CH', 'French'], ['it-CH', 'Italian']], value: 'en-GB' }]);
    // The window shows the title instead of the file name (accessibility); pages with annotations follow the tags.
    if (r) await this.mutate(async (b) => ops.fixAccessibility(await ops.setLanguage(await ops.setMetadata(b, { title: r.title }), r.lang)));
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
      { type: 'info', label: `${list.length ? `Existing scripts: ${list.map((s) => s.name).join(', ')}. They stay in the document.` : 'No scripts.'} ${this.app.policy?.allowJavaScript ? 'Scripts only run when JavaScript is turned on in Preferences, and then in isolation without access to files or the internet.' : 'Scripts are not run in DocPilot, for security reasons.'}` },
      { k: 'name', label: 'Script name', value: list[0]?.name || 'Script1', required: true }, { k: 'code', label: 'Code (empty = delete)', type: 'textarea', value: list[0]?.code || '' },
    ], { wide: true, ok: 'Save' });
    if (r) await this.mutate((b) => ops.setDocumentJavascript(b, r.name, r.code));
  }
}

// "Detect fields automatically": looks for form positions on the pages, shows them as a preview and creates the
// selected fields in one step. The detection itself is in pdf/formdetect.js.
import { h, $, busy, formDialog, messageBox, toast, errToast } from './util.js';
import { loadForEdit, addFormFields, listFieldWidgets } from './pdf/ops.js';
import { interpret } from './pdf/content.js';
import { pageGraphics, rasterLines, detectFields } from './pdf/formdetect.js';
import { wordBoxes, prefixRatio } from './textutil.js';

const TYPE = { text: 'Text field', multiline: 'Multiline text field', checkbox: 'Check box', radio: 'Radio button', signature: 'Signature field' };
// Resolution at which a scanned form is searched for lines.
const SCAN_DPI = 150;

export class FieldDetector {
  constructor(app) { this.app = app; this.items = null; this.bar = null; }
  get doc() { return this.app.doc; }
  get viewer() { return this.app.viewer; }
  get active() { return !!this.items; }

  /** Command from "Prepare form": choose pages, detect, show preview. */
  async start() {
    this.cancel();
    const doc = this.doc;
    if (!(await doc.allowEdit())) return;
    const T = this.app.tools;
    const r = await formDialog('Detect fields automatically', [
      { type: 'info', label: 'Looks for places to fill in on the selected pages: lines and underscores, empty boxes and table cells, check boxes, radio buttons and signature lines. The fields found are shown as a preview first. Only what you confirm is created.' },
      T.range(),
    ], { validate: T.validateRange, ok: 'Recognize' });
    if (!r) return;
    const pages = T.pagesOf(r);
    const res = await busy('Detecting fields', (p) => this.detect(doc, pages, p));
    if (doc !== this.doc) return;
    const notes = [];
    if (res.rotated.length) notes.push(`Rotated pages are not evaluated (page ${res.rotated.map((i) => doc.label(i)).join(', ')}).`);
    if (res.noText.length) notes.push(`Page ${res.noText.map((i) => doc.label(i)).join(', ')}: scanned and without recognized text. Fields there get no names from the labels; run "Recognize text" under "Scan & OCR" first.`);
    if (!res.items.length) {
      await messageBox('Detect fields automatically', ['No new form positions were found on the selected pages.', ...notes].join('\n\n'));
      return;
    }
    this.items = res.items.map((it) => ({ ...it, on: true }));
    this.notes = notes;
    this.owner = doc;
    this.showBar();
    for (const n of this.viewer.nodes) if (n.layers) this.paintPage(n.i);
    const first = this.items[0];
    this.viewer.goto(first.page, { pdfY: first.rect[3] + 60, noHistory: true });
  }

  /** Detects the fields of the pages. Returns { items, rotated, noText }. */
  async detect(doc, pages, progress) {
    const d = await loadForEdit(doc.bytes);
    const { names, widgets } = await listFieldWidgets(doc.bytes);
    const taken = new Set(names.map((n) => n.toLowerCase()));
    const items = []; const rotated = []; const noText = [];
    for (let k = 0; k < pages.length; k++) {
      const i = pages[k];
      progress?.(k / pages.length, `Page ${doc.label(i)} of ${doc.numPages}`);
      if (doc.pages[i].rotate % 360 !== 0) { rotated.push(i); continue; }
      const view = doc.pages[i].view;
      const page = { width: view[2] - view[0], height: view[3] - view[1] };
      const pg = d.getPage(i);
      const words = wordBoxes(await doc.pageText(i)).filter((w) => Math.abs(w.angle) < 0.02).map((w) => ({ text: w.text, rect: w.rect, y: w.y, height: w.height }));
      const g = pageGraphics(pg);
      const images = interpret(pg).items.filter((o) => o.kind === 'image').map((o) => o.bbox);
      const size = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
      // Scanned page: an image (or several strips) covers the page. Lines are then in the image.
      const scan = images.reduce((s, b) => s + size(b), 0) >= page.width * page.height * 0.6;
      let lines = g.lines;
      if (scan) {
        lines = lines.concat(await this.scanLines(i));
        if (!words.length) noText.push(i);
      }
      const found = detectFields({ words, lines, circles: g.circles, images: scan ? [] : images, page, existing: widgets.filter((w) => w.page === i).map((w) => w.rect), taken, tol: scan ? 2.4 : 1.5, scan, ratio: prefixRatio });
      for (const f of found) items.push({ ...f, page: i });
    }
    return { items, rotated, noText };
  }

  /** Lines of a scanned page: render the page, look for long thin strokes in the grayscale image. */
  async scanLines(i) {
    const { canvas, viewport } = await this.viewer.renderToCanvas(i, SCAN_DPI, { noAnnots: true });
    const W = canvas.width; const H = canvas.height;
    const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H);
    for (let k = 0; k < g.length; k++) g[k] = (data[k * 4] * 77 + data[k * 4 + 1] * 150 + data[k * 4 + 2] * 29) >> 8;
    canvas.width = 0;
    const px = rasterLines({ g, width: W, height: H }, { minLen: Math.round(SCAN_DPI * 0.07), maxThick: Math.round(SCAN_DPI * 0.035) });
    return px.map((l) => {
      const a = viewport.convertToPdfPoint(l.x0, l.y0); const b = viewport.convertToPdfPoint(l.x1, l.y1);
      return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
    });
  }

  // --- Vorschau ---------------------------------------------------------------------------
  showBar() {
    this.hideBar();
    this.info = h('span', { class: 'txt' });
    this.applyBtn = h('button', { class: 'btn primary', type: 'button', data: { act: 'apply' }, onclick: () => this.apply() });
    this.allBtn = h('button', { class: 'btn', type: 'button', data: { act: 'toggle-all' }, onclick: () => { const on = !this.items.every((x) => x.on); for (const x of this.items) x.on = on; this.refresh(); } });
    this.bar = h('div', { id: 'detectbar', role: 'toolbar', 'aria-label': 'Detected form fields' }, this.info, this.allBtn, this.applyBtn, h('button', { class: 'btn', type: 'button', data: { act: 'cancel' }, onclick: () => this.cancel() }, 'Cancel'));
    $('#findbar').parentElement.append(this.bar);
    this.onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.scrim')) this.cancel(); };
    document.addEventListener('keydown', this.onKey);
    this.updateBar();
  }
  hideBar() {
    if (this.bar) this.bar.remove();
    this.bar = null;
    if (this.onKey) document.removeEventListener('keydown', this.onKey);
    this.onKey = null;
  }
  updateBar() {
    if (!this.bar) return;
    const n = this.items.length; const on = this.items.filter((x) => x.on).length;
    this.info.textContent = `${n === 1 ? '1 field' : `${n} fields`} detected, ${on} selected. Click a field to deselect or select it again.`;
    this.applyBtn.textContent = on === 1 ? 'Create 1 field' : `Create ${on} fields`;
    this.applyBtn.disabled = !on;
    this.allBtn.textContent = this.items.every((x) => x.on) ? 'Deselect all' : 'Select all';
  }
  refresh() { this.updateBar(); for (const n of this.viewer.nodes) if (n.layers) this.paintPage(n.i); }

  /** Draws the detected fields of a page (called by the page view after every redraw). */
  paintPage(i) {
    const n = this.viewer.node(i);
    if (!n?.el) return;
    [...n.el.children].filter((c) => c.classList.contains('fd-layer')).forEach((c) => c.remove());
    if (!this.items || this.owner !== this.doc || !n.layers) return;
    const list = this.items.filter((x) => x.page === i);
    if (!list.length) return;
    const layer = h('div', { class: 'fd-layer' });
    for (const it of list) {
      const css = this.viewer.rectToCss(i, it.rect);
      const title = `${TYPE[it.type]}: ${it.name}${it.type === 'radio' ? ` (${it.value})` : ''}`;
      const small = it.type === 'checkbox' || it.type === 'radio' || css.height < 13 || css.width < 46;
      const el = h('div', { class: `fd-box ${it.type} ${it.on ? '' : 'off'}`, title: `${title}\nClick to ${it.on ? 'deselect' : 'select'} the field${it.on ? '' : ' again'}.`, data: { name: it.name, type: it.type }, style: { left: `${css.left}px`, top: `${css.top}px`, width: `${css.width}px`, height: `${css.height}px` } },
        small ? null : h('span', { class: 'tag' }, it.name));
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
      el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); it.on = !it.on; this.refresh(); });
      layer.append(el);
    }
    n.el.append(layer);
  }

  cancel() {
    if (!this.items) return;
    this.items = null; this.owner = null;
    this.hideBar();
    for (const n of this.viewer.nodes) if (n.el) [...n.el.children].filter((c) => c.classList.contains('fd-layer')).forEach((c) => c.remove());
  }
  /** The document was changed or switched: the preview is no longer right. */
  docChanged() { if (this.items && !this.applying) this.cancel(); }

  /** Creates the selected fields: one step for "Undo". */
  async apply() {
    const chosen = this.items.filter((x) => x.on);
    if (!chosen.length || this.applying) return;
    const notes = this.notes || [];
    this.applying = true;
    try {
      const pages = [...new Set(chosen.map((x) => x.page))];
      const ok = await this.doc.mutate((b) => addFormFields(b, chosen.map((x) => ({ page: x.page, rect: x.rect, type: x.type, name: x.name, value: x.value }))), { pages, skipCheck: true });
      if (!ok) return;
      this.applying = false;
      this.cancel();
      if (this.app.tools.group?.id === 'form') this.app.tools.renderGroup();
      toast(`${chosen.length === 1 ? '1 field' : `${chosen.length} fields`} created. With "Undo" (Ctrl+Z) you take them all back in one step.`);
      if (notes.length) await messageBox('Detect fields automatically', notes.join('\n\n'));
    } catch (e) { errToast(e); } finally { this.applying = false; }
  }
}

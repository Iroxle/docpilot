// Print: the dialog, and the sheets as images for the printer. The pages are rendered as shown (with comments and
// form values) and placed on the sheets by the print layout (src/pdf/imposition.js): one page per sheet (fit,
// actual size, shrink oversized pages, custom scale), several pages per sheet, or a booklet.
import { busy, canvasBytes, formDialog, toast } from './util.js';
import { parseRange, loadForEdit, saveDoc } from './pdf/ops.js';
import { layoutSheets, keepFormFieldsOnly, PAPERS } from './pdf/imposition.js';
import { Doc } from './document.js';

/** Paper size from the locale: Letter in North America, otherwise A4. */
const defaultPaper = () => (/^(en-US|en-CA|es-MX|fr-CA)$/.test(navigator.language) ? 'letter' : 'a4');

/** The print dialog fields (also used by the action wizard tests). */
export function printFields(app, printers) {
  const d = app.doc; const s = app.settings;
  const lay = (v) => v.layout;
  return [
    { k: 'deviceName', label: 'Printer', type: 'select', options: printers.map((p) => [p.name, p.displayName]), value: (printers.find((p) => p.isDefault) || printers[0]).name },
    { k: 'copies', label: 'Copies', type: 'number', value: 1, min: 1, max: 999 },
    { k: 'which', label: 'Pages', type: 'select', options: [['all', 'All'], ['current', 'Current page'], ['range', 'Range']], value: 'all' },
    { k: 'range', label: 'Range', value: `1-${d.numPages}`, placeholder: 'e.g. 1-3, 5' },
    { k: 'subset', label: 'Subset', type: 'select', options: [['all', 'All'], ['odd', 'Odd pages only'], ['even', 'Even pages only']], value: 'all' },
    { k: 'reverse', label: 'Reverse pages', type: 'checkbox', value: false },
    { k: 'paper', label: 'Paper', type: 'select', options: PAPERS.map(([k, l]) => [k, l]), value: s.printPaper || defaultPaper() },
    { k: 'layout', label: 'Page layout', type: 'select', options: [['size', 'One page per sheet'], ['multiple', 'Several pages per sheet'], ['booklet', 'Booklet']], value: 'size' },
    { k: 'fit', label: 'Size', type: 'select', options: [['fit', 'Fit to page'], ['actual', 'Actual size'], ['shrink', 'Shrink oversized pages'], ['custom', 'Custom scale']], value: 'fit', showIf: (v) => lay(v) === 'size' },
    { k: 'scale', label: 'Scale (%)', type: 'number', value: 100, min: 1, max: 1000, showIf: (v) => lay(v) === 'size' && v.fit === 'custom' },
    { k: 'perSheet', label: 'Pages per sheet', type: 'select', options: [[2, '2'], [4, '4'], [6, '6'], [9, '9'], [16, '16']], value: 2, showIf: (v) => lay(v) === 'multiple' },
    { k: 'order', label: 'Page order', type: 'select', options: [['horizontal', 'Horizontal'], ['horizontal-reversed', 'Horizontal reversed'], ['vertical', 'Vertical'], ['vertical-reversed', 'Vertical reversed']], value: 'horizontal', showIf: (v) => lay(v) === 'multiple' },
    { k: 'border', label: 'Print page border', type: 'checkbox', value: false, showIf: (v) => lay(v) === 'multiple' },
    { k: 'bookletSubset', label: 'Booklet sides', type: 'select', options: [['both', 'Both sides'], ['front', 'Front side only'], ['back', 'Back side only']], value: 'both', showIf: (v) => lay(v) === 'booklet' },
    { k: 'binding', label: 'Binding', type: 'select', options: [['left', 'Left'], ['right', 'Right']], value: 'left', showIf: (v) => lay(v) === 'booklet' },
    { k: 'orient', label: 'Orientation', type: 'select', options: [['auto', 'Automatic'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], value: 'auto', showIf: (v) => lay(v) !== 'booklet' },
    { k: 'color', label: 'Color', type: 'select', options: [['color', 'Color'], ['bw', 'Black and white']], value: 'color' },
    { k: 'duplex', label: 'Double-sided', type: 'select', options: [['simplex', 'No'], ['longEdge', 'Long edge'], ['shortEdge', 'Short edge']], value: 'simplex', showIf: (v) => lay(v) !== 'booklet' },
    { k: 'content', label: 'Print', type: 'select', options: [['annots', 'Document and comments'], ['doc', 'Document only'], ['fields', 'Form fields only']], value: s.printComments !== false ? 'annots' : 'doc' },
    { k: 'dpi', label: 'Quality', type: 'select', options: [[200, 'Normal (200 dpi)'], [300, 'High (300 dpi)'], [150, 'Draft (150 dpi)']], value: 200 },
  ];
}

/** The pages to print (0-based) for the dialog values. */
export function printPages(r, numPages, current) {
  let pages = r.which === 'all' ? [...Array(numPages).keys()] : r.which === 'current' ? [current] : parseRange(r.range, numPages);
  if (r.subset !== 'all') pages = pages.filter((p) => (p + 1) % 2 === (r.subset === 'odd' ? 1 : 0));
  if (r.reverse) pages.reverse();
  return pages;
}

/** The print layout settings for the dialog values. */
export function printSettings(r) {
  return {
    paper: PAPERS.find(([k]) => k === r.paper)?.[2], orientation: r.orient, layout: r.layout, size: r.fit, scale: +r.scale,
    perSheet: +r.perSheet, order: r.order, border: !!r.border, autoRotate: true, subset: r.bookletSubset, binding: r.binding,
  };
}

/** The document as it is printed: with or without comments, or only its form fields. Returns {source, done}. */
async function printSource(d, content) {
  if (content === 'annots' && !d.allAnnots().length) return { source: d, done: () => {} };
  let bytes = content === 'annots' ? await d.buildOutput({ noEncrypt: true }) : (await d.commitForms(), d.bytes);
  if (content === 'fields') { const doc = await loadForEdit(bytes); keepFormFieldsOnly(doc); bytes = await saveDoc(doc); }
  if (content === 'doc' && bytes === d.bytes) return { source: d, done: () => {} };
  const temp = new Doc({ name: d.name, bytes });
  const t = await temp.openPdf(temp.bytes); temp.pdf = t.pdf;
  return { source: temp, done: () => temp.pdf.loadingTask.destroy() };
}

/**
 * Renders the sheets as JPEG images: [{bytes, width, height}] in points. Each page is rendered at the resolution
 * it gets on the sheet and drawn there with its placement matrix (display space to sheet space).
 */
export async function renderSheets(pdf, sheets, o, progress) {
  const k = o.dpi / 72;
  const out = [];
  for (let si = 0; si < sheets.length; si++) {
    const sh = sheets[si];
    const [W, H] = sh.size;
    const c = document.createElement('canvas'); c.width = Math.ceil(W * k); c.height = Math.ceil(H * k);
    const g = c.getContext('2d', { alpha: false });
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    for (const pl of sh.placed) {
      const m = pl.matrix;
      const s = Math.hypot(m[0], m[1]);
      const proxy = await pdf.getPage(pl.page + 1);
      const r = k * s;
      const vp = proxy.getViewport({ scale: r });
      const pc = document.createElement('canvas'); pc.width = Math.ceil(vp.width); pc.height = Math.ceil(vp.height);
      const pg = pc.getContext('2d', { alpha: false });
      await proxy.render({ canvas: pc, canvasContext: pg, viewport: vp, intent: 'print', annotationMode: 2, annotationStorage: pdf.annotationStorage }).promise;
      const dh = vp.height / r;
      g.save();
      g.setTransform((k * m[0]) / r, (-k * m[1]) / r, (-k * m[2]) / r, (k * m[3]) / r, k * (m[2] * dh + m[4]), k * H - k * (m[3] * dh + m[5]));
      g.drawImage(pc, 0, 0);
      g.restore();
      pc.width = 0;
    }
    if (sh.borders.length) {
      g.strokeStyle = '#000'; g.lineWidth = Math.max(1, k * 0.5);
      for (const b of sh.borders) g.strokeRect(b[0] * k, (H - b[3]) * k, (b[2] - b[0]) * k, (b[3] - b[1]) * k);
    }
    if (o.gray) {
      const img = g.getImageData(0, 0, c.width, c.height); const px = img.data;
      for (let i = 0; i < px.length; i += 4) { const y = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]); px[i] = y; px[i + 1] = y; px[i + 2] = y; }
      g.putImageData(img, 0, 0);
    }
    out.push({ bytes: await canvasBytes(c, 'image/jpeg', 0.92), width: W, height: H });
    c.width = 0;
    progress?.((si + 1) / sheets.length, `Sheet ${si + 1} of ${sheets.length}`);
  }
  return out;
}

/** Print with the dialog; o.toPdf returns the printed sheets as a PDF instead (tests). */
export async function printDocument(app, preset = null, o = {}) {
  const d = app.doc;
  if (d.permissions && !d.permissions.includes(4) && !d.permissions.includes(2048)) { toast('Printing is not allowed for this document.', 'err'); return null; }
  const printers = o.toPdf ? [{ name: '', displayName: 'PDF', isDefault: true }] : await window.dp.printers();
  if (!printers.length) throw new Error('No printer was found.');
  const r = preset || await formDialog('Print', printFields(app, printers), { ok: 'Print', validate: (x) => { if (x.which !== 'range') return null; try { parseRange(x.range, d.numPages); return null; } catch (e) { return e.message; } } });
  if (!r) return null;
  if (r.paper !== app.settings.printPaper) { app.settings.printPaper = r.paper; app.saveSettings(); }
  const pages = printPages(r, d.numPages, app.viewer.current);
  if (!pages.length) throw new Error('No pages to print.');
  const res = await busy('Printing document', async (progress) => {
    const { source, done } = await printSource(d, r.content);
    try {
      const sizes = d.pages.map((pg) => { const w = pg.view[2] - pg.view[0]; const h = pg.view[3] - pg.view[1]; return (pg.rotate || 0) % 180 ? [h, w] : [w, h]; });
      const sheets = layoutSheets(sizes, pages, printSettings(r));
      const out = await renderSheets(source.pdf, sheets, { dpi: +r.dpi, gray: r.color === 'bw' }, progress);
      const landscape = out[0].width > out[0].height;
      // A booklet printed on both sides flips on the short edge, the fold of a sheet turned sideways.
      const duplexMode = r.layout === 'booklet' ? (r.bookletSubset === 'both' ? 'shortEdge' : 'simplex') : r.duplex;
      return window.dp.print(out, { deviceName: r.deviceName, copies: r.copies, fit: 'fit', landscape, color: r.color === 'color', duplexMode, toPdf: !!o.toPdf, sheets: sheets.length });
    } finally { done(); }
  });
  if (o.toPdf) return res;
  if (res.ok) toast('Print job sent', 'ok'); else throw new Error(`Printing failed: ${res.reason || 'unknown'}`);
  return res;
}

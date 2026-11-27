// Print layouts: where the pages go on the printed sheets. One page per sheet scaled to fit, at actual size, shrunk
// only when too large, or at a custom percentage; several pages per sheet (2, 4, 6, 9, 16 or a custom grid, in
// rows or columns, left to right or right to left, with borders and turned to suit the cells); and booklets for
// saddle stitching (two pages side by side on landscape sheets, padded to a multiple of four, both sides or one side
// at a time, bound on the left or on the right). Pages are given in display space (as shown, rotation applied); a
// placement is the matrix from a page's display space to the sheet. Also: a copy of the document with only its form
// fields, for "Print form fields only".
//
// Ported from PdfCraft's print crate (settings, sheets) (Copyright (c) 2026 ArtCraft Team and the PdfCraft
// contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFArray, PDFDict } from '@cantoo/pdf-lib';

/** The unprintable margin assumed around the sheet for Fit, Multiple and Booklet (points). */
export const MARGIN = 18;
const GAP = 6;
export const PAPERS = [['a4', 'A4', [595.28, 841.89]], ['a3', 'A3', [841.89, 1190.55]], ['a5', 'A5', [419.53, 595.28]], ['letter', 'Letter', [612, 792]], ['legal', 'Legal', [612, 1008]]];

/** The grid (columns x rows on a portrait sheet) for a number of pages per sheet. */
export function gridFor(perSheet) {
  const g = { 2: [1, 2], 4: [2, 2], 6: [2, 3], 9: [3, 3], 16: [4, 4] }[perSheet];
  if (g) return g;
  const c = Math.max(1, Math.ceil(Math.sqrt(perSheet)));
  return [c, Math.max(1, Math.ceil(perSheet / c))];
}

const oriented = (paper, o, landscapeWanted) => {
  const w = Math.min(...paper); const h = Math.max(...paper);
  if (o === 'portrait') return [w, h];
  if (o === 'landscape') return [h, w];
  return landscapeWanted ? [h, w] : [w, h];
};
const fitScale = ([dw, dh], [cw, ch]) => (dw <= 0 || dh <= 0 ? 1 : Math.min(cw / dw, ch / dh));

/** Places a page of display size [dw, dh] centred in cell (sheet space), scaled by s, turned 90 degrees counter-clockwise when rotate. */
function placeIn(page, [dw, dh], cell, s, rotate) {
  const cw = cell[2] - cell[0]; const ch = cell[3] - cell[1];
  const pw = (rotate ? dh : dw) * s; const ph = (rotate ? dw : dh) * s;
  const x = cell[0] + (cw - pw) / 2; const y = cell[1] + (ch - ph) / 2;
  const matrix = rotate ? [0, s, -s, 0, x + pw, y] : [s, 0, 0, s, x, y];
  return { page, matrix, clip: [0, 0, dw, dh] };
}
/** The bounding box of a rectangle (display space) on the sheet. */
export function placedBox(p) {
  const m = p.matrix; const [x0, y0, x1, y1] = p.clip;
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The sheets for printing. sizes: display size [w, h] of every page of the document; pages: the 0-based pages to
 * print in order. s: {paper: [w, h], orientation: 'auto'|'portrait'|'landscape', layout: 'size'|'multiple'|'booklet',
 * size: 'fit'|'actual'|'shrink'|'custom', scale (percent), perSheet, cols, rows, order:
 * 'horizontal'|'horizontal-reversed'|'vertical'|'vertical-reversed', border, autoRotate, subset: 'both'|'front'|'back',
 * binding: 'left'|'right'}. Returns [{size: [w, h], placed: [{page, matrix, clip}], borders: [[x0, y0, x1, y1]]}].
 */
export function layoutSheets(sizes, pages, s) {
  pages = pages.filter((p) => p >= 0 && p < sizes.length);
  if (!pages.length) throw new Error('No pages to print.');
  const paper = s.paper || PAPERS[0][2];
  if (!(paper[0] >= 72 && paper[1] >= 72)) throw new Error('Invalid paper size.');
  const orientation = s.orientation || 'auto';
  const sheets = [];
  if (!s.layout || s.layout === 'size') {
    for (const p of pages) {
      const d = sizes[p];
      const size = oriented(paper, orientation, d[0] > d[1]);
      const fit = fitScale(d, [size[0] - 2 * MARGIN, size[1] - 2 * MARGIN]);
      let k;
      switch (s.size || 'fit') {
        case 'actual': k = 1; break;
        case 'shrink': k = Math.min(fit, 1); break;
        case 'custom': if (!(s.scale > 0)) throw new Error('The scale must be more than 0%.'); k = s.scale / 100; break;
        default: k = fit;
      }
      sheets.push({ size, placed: [placeIn(p, d, [0, 0, size[0], size[1]], k, false)], borders: [] });
    }
    return sheets;
  }
  if (s.layout === 'multiple') {
    const custom = !!(s.cols && s.rows);
    const [cols, rows] = custom ? [s.cols, s.rows] : gridFor(s.perSheet || 2);
    if (!(cols >= 1 && rows >= 1 && cols <= 99 && rows <= 99)) throw new Error('Invalid number of pages per sheet.');
    const perSheet = Math.min(custom ? cols * rows : (s.perSheet || cols * rows), cols * rows);
    const first = sizes[pages[0]];
    let gc = cols; let gr = rows; let landscape = false;
    if (custom) landscape = orientation === 'landscape';
    else if (cols === rows) landscape = first[0] > first[1];
    else if (orientation === 'landscape' || (orientation === 'auto' && cols < rows)) { gc = rows; gr = cols; landscape = true; }
    const size = oriented(paper, custom ? (orientation === 'auto' ? 'portrait' : orientation) : orientation, landscape);
    const aw = size[0] - 2 * MARGIN; const ah = size[1] - 2 * MARGIN;
    const cw = (aw - GAP * (gc - 1)) / gc; const ch = (ah - GAP * (gr - 1)) / gr;
    if (cw <= 0 || ch <= 0) throw new Error('The page grid does not fit on the paper.');
    const order = s.order || 'horizontal';
    for (let si = 0; si * perSheet < pages.length; si++) {
      const sheet = { size, placed: [], borders: [] };
      for (let k = 0; k < perSheet; k++) {
        const p = pages[si * perSheet + k];
        if (p === undefined) break;
        let col; let row;
        if (order === 'horizontal-reversed') { col = gc - 1 - (k % gc); row = Math.floor(k / gc); }
        else if (order === 'vertical') { col = Math.floor(k / gr); row = k % gr; }
        else if (order === 'vertical-reversed') { col = gc - 1 - Math.floor(k / gr); row = k % gr; }
        else { col = k % gc; row = Math.floor(k / gc); }
        const x0 = MARGIN + col * (cw + GAP); const y1 = size[1] - MARGIN - row * (ch + GAP);
        const d = sizes[p];
        const rotate = s.autoRotate !== false && (d[0] > d[1]) !== (cw > ch) && Math.abs(d[0] - d[1]) > 1;
        const k2 = fitScale(rotate ? [d[1], d[0]] : d, [cw, ch]);
        const pl = placeIn(p, d, [x0, y1 - ch, x0 + cw, y1], k2, rotate);
        if (s.border) sheet.borders.push(placedBox(pl));
        sheet.placed.push(pl);
      }
      sheets.push(sheet);
    }
    return sheets;
  }
  if (s.layout === 'booklet') {
    const n4 = Math.ceil(pages.length / 4) * 4;
    const at = (i) => pages[i];
    const size = oriented(paper, 'landscape', true);
    const half = (size[0] - 2 * MARGIN) / 2;
    const cells = [[MARGIN, MARGIN, MARGIN + half, size[1] - MARGIN], [MARGIN + half, MARGIN, size[0] - MARGIN, size[1] - MARGIN]];
    const subset = s.subset || 'both';
    for (let k = 0; k < n4 / 4; k++) {
      const sides = [];
      if (subset !== 'back') sides.push([at(n4 - 1 - 2 * k), at(2 * k)]);
      if (subset !== 'front') sides.push([at(2 * k + 1), at(n4 - 2 - 2 * k)]);
      for (let [l, r] of sides) {
        if (s.binding === 'right') [l, r] = [r, l];
        const sheet = { size, placed: [], borders: [] };
        [[l, cells[0]], [r, cells[1]]].forEach(([p, cell]) => {
          if (p === undefined) return;
          const d = sizes[p];
          sheet.placed.push(placeIn(p, d, cell, fitScale(d, [cell[2] - cell[0], cell[3] - cell[1]]), false));
        });
        sheets.push(sheet);
      }
    }
    return sheets;
  }
  throw new Error(`Unknown print layout: ${s.layout}`);
}

/** The pages (0-based) of every sheet, in order; booklet blanks are left out. */
export const sheetPages = (sheets) => sheets.map((sh) => sh.placed.map((p) => p.page));

/**
 * "Print form fields only": the document without page content and without comments, keeping the form fields
 * (widget annotations) with their values, on pages of the same size. Changes the loaded document.
 */
export function keepFormFieldsOnly(doc) {
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const n = page.node;
    n.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('')));
    const annots = n.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray) {
      const keep = annots.asArray().filter((ref) => {
        const a = ctx.lookup(ref);
        return a instanceof PDFDict && a.lookup(PDFName.of('Subtype')) === PDFName.of('Widget');
      });
      if (keep.length) n.set(PDFName.of('Annots'), ctx.obj(keep)); else n.delete(PDFName.of('Annots'));
    }
  }
}

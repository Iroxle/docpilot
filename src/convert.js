// Export to Office, image and text formats, and PDF creation from other files.
import { canvasBytes, fileBase, mimeOf, normalizeImage, toBase64 } from './util.js';
import { buildBlocks, mapFamily } from './editor.js';
import { loadForEdit, imagesToPdf } from './pdf/ops.js';
import { interpret } from './pdf/content.js';
import { pageGraphics } from './pdf/formdetect.js';
import { detectTables, textRows, parseValue } from './pdf/tables.js';
import { wordBoxes } from './textutil.js';

const hex = (c) => (c || [0, 0, 0]).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

/**
 * Tables of a page together with the words outside of them. Lines come from the page content, for scanned
 * pages also from the image; tables without lines result from the alignment of the text.
 */
async function pageTables(app, parsed, i, content, items) {
  const words = wordBoxes(content).filter((w) => Math.abs(w.angle) < 0.02).map((w) => ({ text: w.text, rect: w.rect, y: w.y, height: w.height }));
  let lines = pageGraphics(parsed.getPage(i)).lines; let tol = 1.5;
  const info = app.doc.pages[i];
  const size = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const scan = items.filter((o) => o.kind === 'image').reduce((s, o) => s + size(o.bbox), 0) >= size(info.view) * 0.6;
  if (scan && info.rotate % 360 === 0) { lines = lines.concat(await app.fieldDetect.scanLines(i)); tol = 2.4; }
  const tables = detectTables({ words, lines, tol });
  const inTable = (r) => { const x = (r[0] + r[2]) / 2; const y = (r[1] + r[3]) / 2; return tables.some((t) => x > t.rect[0] - 1 && x < t.rect[2] + 1 && y > t.rect[1] - 1 && y < t.rect[3] + 1); };
  return { tables, loose: words.filter((w) => !inTable(w.rect)), inTable };
}

/** Splits a page into text and image blocks in reading order (coordinates from top left in pt). With withTables also into tables. */
async function pageModel(app, parsed, i, withImages, withTables = false) {
  const doc = app.doc; const viewer = app.viewer;
  const content = await doc.pageText(i);
  const page = doc.page(i);
  const vp1 = page.getViewport({ scale: 1, rotation: 0 });
  const W = vp1.width; const H = vp1.height; const off = [page.view[0], page.view[1]];
  const items = interpret(parsed.getPage(i)).items;
  const texts = items.filter((o) => o.kind === 'text');
  const fontAt = (r) => texts.find((o) => o.bbox[0] < r[2] && o.bbox[2] > r[0] && o.bbox[1] < r[3] && o.bbox[3] > r[1]);
  let textItems = content.items; let found = null;
  if (withTables) {
    found = await pageTables(app, parsed, i, content, items);
    // Text in tables is in the cells and not again as a paragraph.
    if (found.tables.length) textItems = content.items.filter((t) => { if (!t.str || !t.transform) return true; const s = Math.hypot(t.transform[2], t.transform[3]) || 10; return !found.inTable([t.transform[4], t.transform[5], t.transform[4] + t.width, t.transform[5] + s * 0.6]); });
  }
  const blocks = buildBlocks(textItems, true).map((b) => {
    const hit = texts.find((o) => o.bbox[0] < b.rect[2] && o.bbox[2] > b.rect[0] && o.bbox[1] < b.rect[3] && o.bbox[3] > b.rect[1]);
    return { kind: 'text', text: b.text, x: b.rect[0] - off[0], y: H - (b.rect[3] - off[1]), w: b.rect[2] - b.rect[0], h: b.rect[3] - b.rect[1], size: b.size, family: mapFamily(hit?.baseFont || ''), bold: /bold|black/i.test(hit?.baseFont || ''), italic: /italic|oblique/i.test(hit?.baseFont || ''), color: hit?.color };
  });
  if (withImages) {
    const imgs = items.filter((o) => o.kind === 'image' && o.bbox[2] - o.bbox[0] > 8 && o.bbox[3] - o.bbox[1] > 8);
    if (imgs.length) {
      const dpi = 150; const s = dpi / 72;
      const proxy = doc.page(i);
      const vp = proxy.getViewport({ scale: s, rotation: 0 });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await proxy.render({ canvas, canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
      for (const m of imgs) {
        const x = m.bbox[0] - off[0]; const y = H - (m.bbox[3] - off[1]); const w = m.bbox[2] - m.bbox[0]; const hh = m.bbox[3] - m.bbox[1];
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(hh * s));
        c.getContext('2d').drawImage(canvas, x * s, y * s, w * s, hh * s, 0, 0, c.width, c.height);
        blocks.push({ kind: 'image', x, y, w, h: hh, png: await canvasBytes(c, 'image/png') });
      }
      canvas.width = 0;
    }
  }
  for (const t of found?.tables || []) {
    const cells = t.cells.map((c) => {
      const hit = c.words.length ? fontAt(c.words[0].rect) : null;
      const sizes = c.words.map((w) => w.height).sort((p, q) => p - q);
      return { r: c.r, c: c.c, rowSpan: c.rowSpan, colSpan: c.colSpan, text: c.text, align: c.align, open: !!c.open, size: sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10, family: mapFamily(hit?.baseFont || ''), bold: /bold|black/i.test(hit?.baseFont || ''), italic: /italic|oblique/i.test(hit?.baseFont || ''), color: hit?.color };
    });
    blocks.push({ kind: 'table', ruled: t.ruled, x: t.rect[0] - off[0], y: H - (t.rect[3] - off[1]), w: t.rect[2] - t.rect[0], h: t.rect[3] - t.rect[1], rows: t.rows, cols: t.cols, colW: t.colX.slice(1).map((x, k) => x - t.colX[k]), rowH: t.rowY.slice(1).map((y, k) => t.rowY[k] - y), cells });
  }
  blocks.sort((a, b) => a.y - b.y || a.x - b.x);
  void viewer;
  return { W, H, blocks, tables: found?.tables || [], loose: found?.loose || [] };
}

async function allPages(app, progress, withImages = true, withTables = false) {
  const parsed = await loadForEdit(app.doc.bytes);
  const out = [];
  for (let i = 0; i < app.doc.numPages; i++) {
    out.push(await pageModel(app, parsed, i, withImages, withTables));
    progress?.((i + 1) / app.doc.numPages, `Page ${i + 1} of ${app.doc.numPages}`);
  }
  return out;
}

/** Real Word table: rows, columns, merged cells, alignment. Without lines in the PDF also without borders. */
function docxTable(D, b, margin) {
  const tw = (pt) => Math.max(1, Math.round(pt * 20));
  const none = { style: D.BorderStyle.NONE, size: 0, color: 'auto' };
  const single = { style: D.BorderStyle.SINGLE, size: 4, color: '808080' };
  const align = { right: D.AlignmentType.RIGHT, center: D.AlignmentType.CENTER, left: D.AlignmentType.LEFT };
  const rows = [];
  for (let r = 0; r < b.rows; r++) {
    const cells = b.cells.filter((c) => c.r === r).map((c) => {
      const border = b.ruled && !c.open ? single : none;
      return new D.TableCell({
        width: { size: tw(b.colW.slice(c.c, c.c + c.colSpan).reduce((s, v) => s + v, 0)), type: D.WidthType.DXA },
        columnSpan: c.colSpan > 1 ? c.colSpan : undefined, rowSpan: c.rowSpan > 1 ? c.rowSpan : undefined,
        borders: { top: border, bottom: border, left: border, right: border },
        margins: { top: 20, bottom: 20, left: 60, right: 60 },
        children: (c.text || '').split('\n').map((line) => new D.Paragraph({ alignment: align[c.align] || align.left, spacing: { before: 0, after: 0 }, children: [new D.TextRun({ text: line, font: c.family, size: Math.round(c.size * 2), bold: c.bold, italics: c.italic, color: hex(c.color) })] })),
      });
    });
    rows.push(new D.TableRow({ children: cells, height: { value: tw(b.rowH[r]), rule: D.HeightRule.ATLEAST } }));
  }
  return new D.Table({ rows, width: { size: tw(b.w), type: D.WidthType.DXA }, columnWidths: b.colW.map(tw), layout: D.TableLayoutType.FIXED, indent: { size: tw(Math.max(0, b.x - margin)), type: D.WidthType.DXA }, borders: b.ruled ? undefined : D.TableBorders.NONE });
}

export async function toDocx(app, progress) {
  const D = await import('docx');
  const pages = await allPages(app, progress, true, true);
  const sections = pages.map((p) => {
    const margin = Math.min(...p.blocks.map((b) => b.x), 72);
    const kids = p.blocks.flatMap((b, k) => {
      const prev = p.blocks[k - 1];
      const before = prev ? Math.max(0, (b.y - (prev.y + prev.h)) * 20) : 0;
      const spacing = { before: Math.min(before, 800), after: 0 };
      const indent = { left: Math.max(0, Math.round((b.x - margin) * 20)) };
      // Before a table, a tiny empty paragraph keeps the distance; after it, one closes the table.
      if (b.kind === 'table') return [new D.Paragraph({ spacing: { before: Math.max(0, spacing.before - 40), after: 0, line: 40, lineRule: D.LineRuleType.EXACT }, run: { size: 2 } }), docxTable(D, b, margin), new D.Paragraph({ spacing: { before: 0, after: 0, line: 40, lineRule: D.LineRuleType.EXACT }, run: { size: 2 } })];
      if (b.kind === 'image') return new D.Paragraph({ spacing, indent, children: [new D.ImageRun({ type: 'png', data: b.png, transformation: { width: Math.round(b.w * 1.3333), height: Math.round(b.h * 1.3333) } })] });
      return new D.Paragraph({ spacing, indent, children: [new D.TextRun({ text: b.text, font: b.family, size: Math.round(b.size * 2), bold: b.bold, italics: b.italic, color: hex(b.color) })] });
    });
    if (!kids.length) kids.push(new D.Paragraph({}));
    const m = Math.round(margin * 20);
    return { properties: { page: { size: { width: Math.round(p.W * 20), height: Math.round(p.H * 20) }, margin: { left: m, right: m, top: Math.round(Math.min(p.blocks[0]?.y ?? 72, 72) * 20), bottom: 400 } } }, children: kids };
  });
  const blob = await D.Packer.toBlob(new D.Document({ sections, creator: 'DocPilot' }));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Excel: one sheet per page. Tables are stored cell by cell, merged cells are merged, numbers and
 * dates are real values. Text outside the tables is kept line by line; sections of a
 * line with a large gap (e.g. "Total" and the amount) go into their own cells, below a table into its columns.
 */
export async function toXlsx(app, progress) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DocPilot';
  const parsed = await loadForEdit(app.doc.bytes);
  const thin = { style: 'thin', color: { argb: 'FF808080' } };
  for (let i = 0; i < app.doc.numPages; i++) {
    const ws = wb.addWorksheet(`Page ${i + 1}`);
    const model = await pageModel(app, parsed, i, false, true);
    const styleOf = new Map(model.blocks.filter((b) => b.kind === 'table').map((b, k) => [model.tables[k], b]));
    const parts = [...model.tables.map((t) => ({ top: t.rect[3], table: t })), ...textRows(model.loose).map((r) => ({ top: r.y + r.height, row: r }))].sort((p, q) => q.top - p.top);
    let row = 1; let last = null;
    const put = (r, c, text, o = {}) => {
      const cell = ws.getCell(r, c);
      const v = parseValue(text);
      if (v.value === '') return cell;
      cell.value = v.value;
      if (v.numFmt) cell.numFmt = v.numFmt;
      const horizontal = o.align && o.align !== 'left' ? o.align : (v.type === 'text' ? undefined : 'right');
      if (horizontal || /\n/.test(text)) cell.alignment = { horizontal, vertical: 'top', wrapText: /\n/.test(text) };
      if (o.bold) cell.font = { bold: true };
      return cell;
    };
    for (const p of parts) {
      if (p.table) {
        const t = p.table; const st = styleOf.get(t);
        if (row > 1) row++;
        for (const c of t.cells) {
          const cell = put(row + c.r, 1 + c.c, c.text, { align: c.align, bold: st?.cells.find((x) => x.r === c.r && x.c === c.c)?.bold });
          if (c.rowSpan > 1 || c.colSpan > 1) ws.mergeCells(row + c.r, 1 + c.c, row + c.r + c.rowSpan - 1, 1 + c.c + c.colSpan - 1);
          if (t.ruled && !c.open) cell.border = { top: thin, bottom: thin, left: thin, right: thin };
        }
        row += t.rows; last = t;
        continue;
      }
      // Line outside a table: directly below a table, the sections follow its columns.
      const under = last && last.rect[1] - p.row.y < p.row.height * 4 ? last : null;
      let col = 0;
      for (const s of p.row.segs) {
        const x = (s.x0 + s.x1) / 2;
        let k = col + 1;
        if (under && s.x1 > under.colX[0] && s.x0 < under.colX[under.cols]) { k = 1; while (k < under.cols && (s.x1 > under.colX[k] + 2 && x > under.colX[k])) k++; k = Math.max(k, col + 1); }
        put(row, k, s.text); col = k;
      }
      if (!under) last = null;
      row++;
    }
    ws.columns.forEach((c) => { let m = 8; c.eachCell?.({ includeEmpty: false }, (v) => { m = Math.max(m, Math.min(60, String(v.text ?? v.value ?? '').split('\n').reduce((q, l) => Math.max(q, l.length), 0) + 2)); }); c.width = m; });
    progress?.((i + 1) / app.doc.numPages, `Page ${i + 1} of ${app.doc.numPages}`);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
export async function toPptx(app, progress, mode = 'exact') {
  const PptxGen = (await import('pptxgenjs')).default;
  const pptx = new PptxGen();
  const first = app.doc.page(0).getViewport({ scale: 1, rotation: 0 });
  pptx.defineLayout({ name: 'BM', width: first.width / 72, height: first.height / 72 });
  pptx.layout = 'BM';
  const pages = mode === 'exact' ? null : await allPages(app, progress, true, true);
  for (let i = 0; i < app.doc.numPages; i++) {
    const slide = pptx.addSlide();
    if (pages) {
      for (const b of pages[i].blocks) {
        if (b.kind === 'image') slide.addImage({ data: `image/png;base64,${toBase64(b.png)}`, x: b.x / 72, y: b.y / 72, w: b.w / 72, h: b.h / 72 });
        else if (b.kind === 'table') {
          // Real table on the slide, with merged cells and alignment.
          const rows = [];
          for (let r = 0; r < b.rows; r++) rows.push(b.cells.filter((c) => c.r === r).map((c) => ({ text: c.text, options: { align: c.align, valign: 'top', bold: c.bold, italic: c.italic, color: hex(c.color), fontSize: Math.round(c.size * 10) / 10, fontFace: c.family, ...(c.colSpan > 1 ? { colspan: c.colSpan } : {}), ...(c.rowSpan > 1 ? { rowspan: c.rowSpan } : {}), border: b.ruled && !c.open ? { type: 'solid', pt: 0.75, color: '808080' } : { type: 'none' } } })));
          slide.addTable(rows, { x: b.x / 72, y: b.y / 72, w: b.w / 72, colW: b.colW.map((v) => v / 72), rowH: b.rowH.map((v) => v / 72) });
        } else slide.addText(b.text, { x: b.x / 72, y: b.y / 72, w: (b.w + 12) / 72, h: b.h / 72 + 0.1, fontFace: b.family, fontSize: b.size, bold: b.bold, italic: b.italic, color: hex(b.color), margin: 0, valign: 'top' });
      }
    } else {
      const { canvas } = await app.viewer.renderToCanvas(i, 150);
      slide.addImage({ data: `image/jpeg;base64,${toBase64(await canvasBytes(canvas, 'image/jpeg', 0.9))}`, x: 0, y: 0, w: first.width / 72, h: first.height / 72 });
      canvas.width = 0;
      progress?.((i + 1) / app.doc.numPages, `Page ${i + 1} of ${app.doc.numPages}`);
    }
  }
  const data = await pptx.write({ outputType: 'uint8array' });
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export async function toHtml(app, progress) {
  const pages = await allPages(app, progress);
  const body = pages.map((p, i) => `<section class="p" style="width:${p.W}pt;height:${p.H}pt" aria-label="Page ${i + 1}">${p.blocks.map((b) => (b.kind === 'image'
    ? `<img alt="" src="data:image/png;base64,${toBase64(b.png)}" style="left:${b.x}pt;top:${b.y}pt;width:${b.w}pt;height:${b.h}pt">`
    : `<p style="left:${b.x}pt;top:${b.y}pt;width:${b.w + 6}pt;font-family:'${b.family}';font-size:${b.size}pt;font-weight:${b.bold ? 700 : 400};font-style:${b.italic ? 'italic' : 'normal'};color:#${hex(b.color)}">${esc(b.text)}</p>`)).join('')}</section>`).join('\n');
  return new TextEncoder().encode(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(fileBase(app.doc.name))}</title><style>body{background:#ddd;margin:0;padding:12px}.p{position:relative;background:#fff;margin:0 auto 12px;overflow:hidden}.p p,.p img{position:absolute;margin:0;line-height:1.2}</style>\n${body}</html>`);
}
export async function toText(app, progress) {
  const pages = await allPages(app, progress, false);
  return new TextEncoder().encode(pages.map((p) => p.blocks.map((b) => b.text).join('\r\n')).join('\r\n\f\r\n'));
}
const rtfEsc = (s) => [...s].map((c) => { const o = c.codePointAt(0); if (c === '\\' || c === '{' || c === '}') return `\\${c}`; if (o > 126) return o > 65535 ? '?' : `\\u${o > 32767 ? o - 65536 : o}?`; return c; }).join('');
export async function toRtf(app, progress) {
  const pages = await allPages(app, progress, false);
  const body = pages.map((p) => p.blocks.map((b) => `{\\fs${Math.round(b.size * 2)}${b.bold ? '\\b' : ''}${b.italic ? '\\i' : ''} ${rtfEsc(b.text)}}\\par`).join('\n')).join('\n\\page\n');
  return new TextEncoder().encode(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\n${body}\n}`);
}

export async function pageImages(app, o, write, progress) {
  for (let i = 0; i < app.doc.numPages; i++) {
    const { canvas } = await app.viewer.renderToCanvas(i, o.dpi);
    await write(i, await canvasBytes(canvas, o.mime, 0.92));
    canvas.width = 0;
    progress?.((i + 1) / app.doc.numPages, `Page ${i + 1} of ${app.doc.numPages}`);
  }
}

// --- PDF erstellen -----------------------------------------------------------------------
const HTML_SHELL = (b) => `<!doctype html><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:11pt;line-height:1.35}table{border-collapse:collapse}td,th{border:1px solid #999;padding:3px 6px}img{max-width:100%}</style>${b}`;

/** Converts a file to a PDF. Returns the bytes of the PDF. */
export async function fileToPdf(path) {
  const name = path.split(/[\\/]/).pop();
  const ext = name.split('.').pop().toLowerCase();
  const bytes = await window.dp.readFile(path);
  if (ext === 'pdf') return bytes;
  if (mimeOf(name).startsWith('image/')) {
    const im = await normalizeImage(bytes, name);
    return imagesToPdf([im]);
  }
  if (['txt', 'log', 'csv', 'md'].includes(ext) && ext !== 'csv') {
    return window.dp.htmlToPdf(HTML_SHELL(`<pre style="white-space:pre-wrap;font-family:Consolas,monospace;font-size:10pt">${esc(new TextDecoder().decode(bytes))}</pre>`));
  }
  if (['html', 'htm'].includes(ext)) return window.dp.htmlToPdf(new TextDecoder().decode(bytes));
  const office = /^(docx?|rtf|odt|xlsx?|xlsm|ods|csv|pptx?|odp)$/.test(ext);
  if (office) {
    const available = await window.dp.officeAvailable();
    const need = /^(docx?|rtf|odt)$/.test(ext) ? 'Word.Application' : /^(xlsx?|xlsm|ods|csv)$/.test(ext) ? 'Excel.Application' : 'PowerPoint.Application';
    if (available.includes(need)) {
      try { return await window.dp.officeToPdf(path); } catch (e) { console.warn('Office conversion failed', e); }
    }
    if (ext === 'docx') {
      const mammoth = (await import('mammoth')).default;
      const r = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      return window.dp.htmlToPdf(HTML_SHELL(r.value));
    }
    if (ext === 'xlsx') {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes);
      const html = wb.worksheets.map((ws) => { let t = `<h3>${esc(ws.name)}</h3><table>`; ws.eachRow((r) => { t += '<tr>'; for (let c = 1; c <= ws.columnCount; c++) t += `<td>${esc(r.getCell(c).text || '')}</td>`; t += '</tr>'; }); return `${t}</table>`; }).join('');
      return window.dp.htmlToPdf(HTML_SHELL(html), { landscape: true });
    }
    if (ext === 'csv') {
      const rows = new TextDecoder().decode(bytes).split(/\r?\n/).filter(Boolean).map((l) => l.split(/[;,]/));
      return window.dp.htmlToPdf(HTML_SHELL(`<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`), { landscape: true });
    }
    throw new Error(`.${ext} files require an installed copy of Microsoft Office.`);
  }
  throw new Error(`The file type .${ext} is not supported.`);
}
export const CREATE_FILTERS = [{ name: 'Supported files', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'txt', 'md', 'log', 'html', 'htm', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'ppt', 'pptx', 'odp'] }];

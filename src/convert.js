// Export to Office, image and text formats, and PDF creation from other files.
import { canvasBytes, fileBase, mimeOf, normalizeImage, toBase64 } from './util.js';
import { buildBlocks, mapFamily } from './editor.js';
import { loadForEdit, imagesToPdf } from './pdf/ops.js';
import { interpret } from './pdf/content.js';

const hex = (c) => (c || [0, 0, 0]).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

/** Splits a page into text and image blocks in reading order (coordinates from top left in pt). */
async function pageModel(app, parsed, i, withImages) {
  const doc = app.doc; const viewer = app.viewer;
  const content = await doc.pageText(i);
  const page = doc.page(i);
  const vp1 = page.getViewport({ scale: 1, rotation: 0 });
  const W = vp1.width; const H = vp1.height; const off = [page.view[0], page.view[1]];
  const items = interpret(parsed.getPage(i)).items;
  const texts = items.filter((o) => o.kind === 'text');
  const blocks = buildBlocks(content.items).map((b) => {
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
  blocks.sort((a, b) => a.y - b.y || a.x - b.x);
  void viewer;
  return { W, H, blocks };
}

async function allPages(app, progress, withImages = true) {
  const parsed = await loadForEdit(app.doc.bytes);
  const out = [];
  for (let i = 0; i < app.doc.numPages; i++) {
    out.push(await pageModel(app, parsed, i, withImages));
    progress?.((i + 1) / app.doc.numPages, `Page ${i + 1} of ${app.doc.numPages}`);
  }
  return out;
}

export async function toDocx(app, progress) {
  const D = await import('docx');
  const pages = await allPages(app, progress);
  const sections = pages.map((p) => {
    const margin = Math.min(...p.blocks.map((b) => b.x), 72);
    const kids = p.blocks.map((b, k) => {
      const prev = p.blocks[k - 1];
      const before = prev ? Math.max(0, (b.y - (prev.y + prev.h)) * 20) : 0;
      const spacing = { before: Math.min(before, 800), after: 0 };
      const indent = { left: Math.max(0, Math.round((b.x - margin) * 20)) };
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

/** Detects rows and columns from the text positions. */
export function tableFromItems(items) {
  const cells = items.filter((t) => t.str && t.str.trim()).map((t) => ({ text: t.str.trim(), x: t.transform[4], y: t.transform[5], w: t.width, size: Math.hypot(t.transform[2], t.transform[3]) || 10 }));
  cells.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const c of cells) {
    const r = rows.find((v) => Math.abs(v.y - c.y) < c.size * 0.5);
    if (r) r.cells.push(c); else rows.push({ y: c.y, cells: [c] });
  }
  rows.sort((a, b) => b.y - a.y);
  // Derive columns from the left edges of all cells.
  const xs = cells.map((c) => c.x).sort((a, b) => a - b);
  const cols = [];
  for (const x of xs) { const last = cols[cols.length - 1]; if (last && x - last.max < 12) { last.max = x; last.sum += x; last.n++; } else cols.push({ min: x, max: x, sum: x, n: 1 }); }
  const colX = cols.map((c) => c.min);
  const colOf = (x) => { let k = 0; for (let i = 0; i < colX.length; i++) if (x >= colX[i] - 2) k = i; return k; };
  return rows.map((r) => {
    const row = new Array(colX.length).fill(null);
    r.cells.sort((a, b) => a.x - b.x);
    for (const c of r.cells) { const k = colOf(c.x); row[k] = row[k] ? `${row[k]} ${c.text}` : c.text; }
    return row;
  });
}
export function parseCell(s) {
  if (s === null) return null;
  const t = s.replace(/['’\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
  return s;
}

export async function toXlsx(app, progress) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DocPilot';
  for (let i = 0; i < app.doc.numPages; i++) {
    const ws = wb.addWorksheet(`Page ${i + 1}`);
    const table = tableFromItems((await app.doc.pageText(i)).items);
    for (const row of table) ws.addRow(row.map(parseCell));
    ws.columns.forEach((c) => { let m = 8; c.eachCell?.({ includeEmpty: false }, (v) => { m = Math.max(m, String(v.value ?? '').length + 2); }); c.width = Math.min(60, m); });
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
  const pages = mode === 'exact' ? null : await allPages(app, progress);
  for (let i = 0; i < app.doc.numPages; i++) {
    const slide = pptx.addSlide();
    if (pages) {
      for (const b of pages[i].blocks) {
        if (b.kind === 'image') slide.addImage({ data: `image/png;base64,${toBase64(b.png)}`, x: b.x / 72, y: b.y / 72, w: b.w / 72, h: b.h / 72 });
        else slide.addText(b.text, { x: b.x / 72, y: b.y / 72, w: (b.w + 12) / 72, h: b.h / 72 + 0.1, fontFace: b.family, fontSize: b.size, bold: b.bold, italic: b.italic, color: hex(b.color), margin: 0, valign: 'top' });
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

// Preparing forms beyond the fields themselves: formats, validation and calculations (as the standard AF
// scripts), the calculation order, the tab order, tables of text fields, date and image fields, and form data
// exchange as FDF, XFDF, XML, CSV and tab-delimited text.
//
// Ported from PdfCraft's forms and xfdf crates (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors,
// MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFNumber, StandardFonts, rgb, decodePDFRawStream } from '@cantoo/pdf-lib';
import { loadForEdit, saveDoc, fieldKind } from './ops.js';
import * as af from './afcalc.js';

const N = (s) => PDFName.of(s);
const lookup = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const dictOf = (ctx, v) => { const d = lookup(ctx, v); return d instanceof PDFDict ? d : null; };
async function edit(bytes, fn) { const d = await loadForEdit(bytes); const extra = await fn(d); const out = await saveDoc(d); return extra === undefined ? out : { bytes: out, ...extra }; }
/** A JavaScript string for a PDF: hex, so no character can end the string early. */
const jsString = (js) => PDFHexString.of(Array.from(new TextEncoder().encode(js), (b) => b.toString(16).padStart(2, '0')).join(''));
const jsAction = (ctx, js) => ctx.obj({ S: 'JavaScript', JS: jsString(js) });

/** The JavaScript of an action (string or stream). */
function actionJs(ctx, a) {
  const d = dictOf(ctx, a);
  if (!d) return '';
  const js = lookup(ctx, d.get(N('JS')));
  if (js instanceof PDFString || js instanceof PDFHexString) return js.decodeText();
  if (js instanceof PDFStream) {
    try {
      const b = js instanceof PDFRawStream ? decodePDFRawStream(js).decode() : js.getContents();
      return b[0] === 0xfe && b[1] === 0xff ? new TextDecoder('utf-16be').decode(b.subarray(2)) : new TextDecoder('latin1').decode(b);
    } catch { return ''; }
  }
  return '';
}

/** The event scripts of a field: its own /AA and, for a field merged with its widget, the same dictionary. */
function fieldScripts(ctx, field) {
  const aa = dictOf(ctx, field.acroField.dict.get(N('AA')));
  const get = (k) => (aa ? actionJs(ctx, aa.get(N(k))) : '');
  return { Format: get('F'), Keystroke: get('K'), Validate: get('V'), Calculate: get('C') };
}

const typeOf = (f) => fieldKind(f).replace('PDF', '');

/**
 * The form's fields with their recognised format, validation and calculation, and the calculation order:
 * {fields: [{name, type, format, validate, calculate, other}], order: [names]}. other lists events whose script is
 * not one of the standard calls (it only runs when JavaScript is allowed).
 */
export async function readFormActions(bytes) {
  const d = await loadForEdit(bytes);
  return formActionsOf(d);
}
export function formActionsOf(d) {
  const ctx = d.context;
  const form = d.getForm();
  const fields = form.getFields().map((f) => {
    const s = fieldScripts(ctx, f);
    const a = af.readActions(s);
    const other = Object.entries(s).filter(([k, js]) => js && !(k === 'Format' || k === 'Keystroke' ? a.format : k === 'Validate' ? a.validate : a.calculate)).map(([k]) => k);
    return { name: f.getName(), type: typeOf(f), ...a, other };
  });
  const co = lookup(ctx, form.acroForm.dict.get(N('CO')));
  const byRef = new Map(form.getFields().map((f) => [f.ref.tag, f.getName()]));
  const order = co instanceof PDFArray ? co.asArray().map((r) => (r instanceof PDFRef ? byRef.get(r.tag) : null)).filter(Boolean) : [];
  return { fields, order };
}

/** Sets a field's format, validation and calculation (null removes one) and keeps the calculation order. */
export const setFieldActions = (bytes, name, o) => edit(bytes, (d) => {
  const ctx = d.context;
  const form = d.getForm();
  const f = form.getField(name);
  const dict = f.acroField.dict;
  let aa = dictOf(ctx, dict.get(N('AA')));
  if (!aa) { aa = ctx.obj({}); dict.set(N('AA'), aa); }
  if ('format' in o) {
    const js = af.formatJs(o.format);
    if (js && js[0]) aa.set(N('F'), jsAction(ctx, js[0])); else aa.delete(N('F'));
    if (js && js[1]) aa.set(N('K'), jsAction(ctx, js[1])); else aa.delete(N('K'));
  }
  if ('validate' in o) { const js = af.validateJs(o.validate); if (js) aa.set(N('V'), jsAction(ctx, js)); else aa.delete(N('V')); }
  if ('calculate' in o) {
    const js = af.calculateJs(o.calculate);
    if (js) aa.set(N('C'), jsAction(ctx, js)); else aa.delete(N('C'));
    const acro = form.acroForm.dict;
    let co = lookup(ctx, acro.get(N('CO')));
    if (!(co instanceof PDFArray)) { co = ctx.obj([]); acro.set(N('CO'), co); }
    const i = co.asArray().findIndex((r) => r instanceof PDFRef && r.tag === f.ref.tag);
    if (js && i < 0) co.push(f.ref);
    if (!js && i >= 0) co.remove(i);
  }
  if (!aa.entries().length) dict.delete(N('AA'));
});

/** Sets the calculation order (/CO) to these field names. */
export const setCalculationOrder = (bytes, names) => edit(bytes, (d) => {
  const form = d.getForm();
  form.acroForm.dict.set(N('CO'), d.context.obj(names.map((n) => form.getField(n).ref)));
});

/** Problems of a calculation order: a field that reads a calculated field coming after it. */
export function calculationOrderProblems(fields, order) {
  const calc = new Map(fields.filter((f) => f.calculate).map((f) => [f.name, f]));
  const pos = new Map(order.map((n, i) => [n, i]));
  const out = [];
  for (const name of order) {
    const f = calc.get(name);
    if (!f) continue;
    for (const r of af.calculationReads(f.calculate)) if (calc.has(r) && (pos.get(r) ?? Infinity) > pos.get(name)) out.push(`"${name}" is calculated before "${r}", which it reads.`);
  }
  return out;
}

/** Tab order of pages: 'rows' (/R), 'columns' (/C) or 'structure' (/S). */
export const setTabOrder = (bytes, pages, mode) => edit(bytes, (d) => {
  const v = { rows: 'R', columns: 'C', structure: 'S' }[mode];
  for (const i of pages) d.getPage(i).node.set(N('Tabs'), N(v));
});

/**
 * A table of text fields: rect divided into rows x columns, one text field per cell named "<column> <row>"
 * (columns: names of the columns). Refused as a whole when a name is taken.
 */
export const addFieldTable = (bytes, pageIdx, rect, o) => edit(bytes, async (d) => {
  const form = d.getForm(); const page = d.getPage(pageIdx);
  const font = await d.embedFont(StandardFonts.Helvetica);
  const cols = o.columns.length; const rows = o.rows;
  const [x0, y0, x1, y1] = rect; const cw = (x1 - x0) / cols; const rh = (y1 - y0) / rows;
  if (cw < 6 || rh < 6) throw new Error('The cells would be too small.');
  const names = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) names.push(`${o.columns[c]} ${r + 1}`);
  if (names.some((n) => n.includes('.'))) throw new Error('Column names cannot contain a period.');
  const taken = names.find((n) => form.getFieldMaybe(n));
  if (taken) throw new Error(`A field named "${taken}" already exists.`);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const f = form.createTextField(`${o.columns[c]} ${r + 1}`);
    f.addToPage(page, { x: x0 + c * cw, y: y1 - (r + 1) * rh, width: cw, height: rh, borderWidth: 1, borderColor: rgb(0.57, 0.56, 0.56), backgroundColor: rgb(1, 1, 1) });
    f.setFontSize(Math.max(6, Math.min(11, Math.round(rh * 0.6))));
    f.updateAppearances(font);
  }
  return { names };
});

/** A date field: a text field that takes and shows dates in this format (e.g. dd/mm/yyyy). */
export const addDateField = (bytes, pageIdx, rect, name, format = 'dd/mm/yyyy') => edit(bytes, async (d) => {
  const form = d.getForm();
  if (form.getFieldMaybe(name)) throw new Error(`A field named "${name}" already exists.`);
  const [x0, y0, x1, y1] = rect;
  const f = form.createTextField(name);
  f.addToPage(d.getPage(pageIdx), { x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderWidth: 1, borderColor: rgb(0.57, 0.56, 0.56), backgroundColor: rgb(1, 1, 1) });
  f.updateAppearances(await d.embedFont(StandardFonts.Helvetica));
  const js = af.formatJs({ type: 'date', format });
  f.acroField.dict.set(N('AA'), d.context.obj({ F: jsAction(d.context, js[0]), K: jsAction(d.context, js[1]) }));
});

const IMAGE_SCRIPT = 'event.target.buttonImportIcon();';
/** An image field: a button that shows a picture; clicking it while filling in chooses the picture. */
export const addImageField = (bytes, pageIdx, rect, name) => edit(bytes, (d) => {
  const form = d.getForm();
  if (form.getFieldMaybe(name)) throw new Error(`A field named "${name}" already exists.`);
  const [x0, y0, x1, y1] = rect;
  const b = form.createButton(name);
  b.addToPage('', d.getPage(pageIdx), { x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderWidth: 1, borderColor: rgb(0.57, 0.56, 0.56), backgroundColor: rgb(0.95, 0.96, 0.97) });
  const w = b.acroField.getWidgets()[0];
  const mk = dictOf(d.context, w.dict.get(N('MK'))) || d.context.obj({});
  mk.set(N('TP'), PDFNumber.of(1));
  w.dict.set(N('MK'), mk);
  w.dict.set(N('A'), jsAction(d.context, IMAGE_SCRIPT));
});

/** Whether a field is an image field (a button whose action imports its icon). */
export const isImageScript = (js) => /buttonImportIcon\s*\(/.test(js || '');

/** Puts a picture into an image field (or any button): it fills the button, keeping its proportions. */
export const setButtonImage = (bytes, name, image, mime) => edit(bytes, async (d) => {
  const ctx = d.context;
  const f = d.getForm().getField(name);
  const img = mime === 'image/png' ? await d.embedPng(image) : await d.embedJpg(image);
  for (const w of f.acroField.getWidgets()) {
    const r = w.getRectangle();
    const s = Math.min(r.width / img.width, r.height / img.height);
    const iw = img.width * s; const ih = img.height * s;
    const ops = `q ${iw} 0 0 ${ih} ${(r.width - iw) / 2} ${(r.height - ih) / 2} cm /Img Do Q`;
    const ap = ctx.register(ctx.flateStream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, r.width, r.height], Resources: { XObject: { Img: img.ref } } }));
    w.dict.set(N('AP'), ctx.obj({ N: ap }));
    const mk = dictOf(ctx, w.dict.get(N('MK'))) || ctx.obj({});
    mk.set(N('I'), ap); mk.set(N('TP'), PDFNumber.of(1));
    w.dict.set(N('MK'), mk);
  }
});

// --- Form data exchange ----------------------------------------------------------------------------

/** The form's values: [{name, type, value}] with value a string, a list (multiple choice) or true/false (check box). */
async function formValues(bytes) {
  const d = await loadForEdit(bytes);
  const out = [];
  for (const f of d.getForm().getFields()) {
    const t = typeOf(f); const name = f.getName();
    if (t === 'TextField') out.push({ name, value: f.getText() || '' });
    else if (t === 'CheckBox') out.push({ name, value: f.isChecked() ? (onValue(f) || 'Yes') : 'Off' });
    else if (t === 'RadioGroup') out.push({ name, value: f.getSelected() || 'Off' });
    else if (t === 'Dropdown' || t === 'OptionList') { const s = f.getSelected(); out.push({ name, value: s.length > 1 ? s : s[0] || '' }); }
  }
  return out;
}
function onValue(cb) {
  try { const w = cb.acroField.getWidgets()[0]; const n = w.getOnValue(); return n ? n.decodeText() : null; } catch { return null; }
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pdfStr = (s) => (/^[\x20-\x7e]*$/.test(s) ? `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})` : `<FEFF${Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`);
const csvCell = (s, sep) => (/[",\t\r\n]/.test(s) || (sep === ',' && s.includes(',')) ? `"${s.replace(/"/g, '""')}"` : s);

/** Nested field tree from qualified names ("a.b.c"). */
function tree(values) {
  const root = new Map();
  for (const v of values) {
    let node = root; const parts = v.name.split('.');
    parts.forEach((p, i) => { if (!node.has(p)) node.set(p, { kids: new Map(), value: undefined }); const n = node.get(p); if (i === parts.length - 1) n.value = v.value; node = n.kids; });
  }
  return root;
}

/** Form data as a file: format fdf, xfdf, xml, csv or txt; file is the PDF's file name. Returns the text. */
export async function exportFormDataAs(bytes, format, file = '') {
  const values = await formValues(bytes);
  const str = (v) => (Array.isArray(v) ? v.join(', ') : String(v));
  if (format === 'fdf') {
    const fieldPdf = (name, n) => {
      const kids = [...n.kids].map(([k, c]) => fieldPdf(k, c));
      const v = n.value === undefined ? '' : Array.isArray(n.value) ? ` /V [${n.value.map(pdfStr).join(' ')}]` : /^(Off|Yes)$/.test(n.value) || values.some((x) => x.value === n.value && /^[A-Za-z0-9]+$/.test(n.value) && false) ? ` /V /${n.value}` : ` /V ${pdfStr(n.value)}`;
      return `<< /T ${pdfStr(name)}${v}${kids.length ? ` /Kids [${kids.join(' ')}]` : ''} >>`;
    };
    const fields = [...tree(values)].map(([k, n]) => fieldPdf(k, n));
    return `%FDF-1.2\n%âãÏÓ\n1 0 obj\n<< /FDF << /Fields [${fields.join('\n')}]${file ? ` /F ${pdfStr(file)}` : ''} >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  }
  if (format === 'xfdf') {
    const fieldXml = (name, n, ind) => {
      const kids = [...n.kids].map(([k, c]) => fieldXml(k, c, `${ind}  `)).join('');
      const vals = n.value === undefined ? '' : (Array.isArray(n.value) ? n.value : [n.value]).map((v) => `${ind}  <value>${xmlEsc(v)}</value>\n`).join('');
      return `${ind}<field name="${xmlEsc(name)}">\n${vals}${kids}${ind}</field>\n`;
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n${file ? `  <f href="${xmlEsc(file)}"/>\n` : ''}  <fields>\n${[...tree(values)].map(([k, n]) => fieldXml(k, n, '    ')).join('')}  </fields>\n</xfdf>\n`;
  }
  if (format === 'xml') {
    const valid = (n) => /^[A-Za-z_][\w.-]*$/.test(n) && !/^xml/i.test(n);
    const items = values.map((v) => (valid(v.name) ? `  <${v.name}>${xmlEsc(str(v.value))}</${v.name}>` : `  <field name="${xmlEsc(v.name)}">${xmlEsc(str(v.value))}</field>`));
    return `<?xml version="1.0" encoding="UTF-8"?>\n<fields>\n${items.join('\n')}\n</fields>\n`;
  }
  const sep = format === 'csv' ? ',' : '\t';
  return `${values.map((v) => csvCell(v.name, sep)).join(sep)}\r\n${values.map((v) => csvCell(str(v.value), sep)).join(sep)}\r\n`;
}

/** Splits CSV or tab-delimited text into rows of cells (quotes as in RFC 4180). */
function delimited(text, sep) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && !cell) q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/** Reads a PDF string or name from FDF text at position i: [value, end]. */
function fdfValue(t, i) {
  while (/\s/.test(t[i])) i++;
  if (t[i] === '(') {
    let out = ''; let depth = 1; i++;
    while (i < t.length && depth) {
      const c = t[i++];
      if (c === '\\') { const e = t[i++]; if (/[0-7]/.test(e)) { let o = e; while (o.length < 3 && /[0-7]/.test(t[i])) o += t[i++]; out += String.fromCharCode(parseInt(o, 8)); } else out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] ?? e; }
      else if (c === '(') { depth++; out += c; } else if (c === ')') { depth--; if (depth) out += c; } else out += c;
    }
    return [out.startsWith('þÿ') ? Array.from({ length: (out.length - 2) / 2 }, (_, k) => String.fromCharCode(out.charCodeAt(2 + 2 * k) * 256 + out.charCodeAt(3 + 2 * k))).join('') : out, i];
  }
  if (t[i] === '<' && t[i + 1] !== '<') {
    const e = t.indexOf('>', i); const hex = t.slice(i + 1, e).replace(/\s/g, '');
    const bytes = hex.match(/../g)?.map((h) => parseInt(h, 16)) || [];
    const s = bytes[0] === 0xfe && bytes[1] === 0xff ? Array.from({ length: (bytes.length - 2) / 2 }, (_, k) => String.fromCharCode(bytes[2 + 2 * k] * 256 + bytes[3 + 2 * k])).join('') : String.fromCharCode(...bytes);
    return [s, e + 1];
  }
  if (t[i] === '/') { const m = /^\/([^\s/[\]()<>]+)/.exec(t.slice(i)); return [m ? m[1].replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) : '', i + (m ? m[0].length : 1)]; }
  if (t[i] === '[') { const list = []; i++; for (;;) { while (/\s/.test(t[i])) i++; if (t[i] === ']' || i >= t.length) return [list, i + 1]; const [v, e] = fdfValue(t, i); list.push(v); i = e; } }
  return ['', i + 1];
}

/** Values from a form data file ({name: value}): format by extension (fdf, xfdf, xml, csv, txt, json). */
export function parseFormData(text, format) {
  const out = {};
  if (format === 'json') return JSON.parse(text);
  if (format === 'fdf') {
    // Fields with /T and /V, nested through /Kids: names are joined with periods.
    const walk = (from, prefix) => {
      let i = from;
      while (i < text.length) {
        const open = text.indexOf('<<', i); const close = text.indexOf('>>', i);
        if (close >= 0 && (open < 0 || close < open)) return close + 2;
        if (open < 0) return text.length;
        i = open + 2;
        let name = null; let value;
        for (;;) {
          while (/\s/.test(text[i])) i++;
          if (text.startsWith('>>', i)) { i += 2; break; }
          if (text.startsWith('/T', i) && /[\s(<]/.test(text[i + 2])) { [name] = fdfValue(text, i + 2); i = fdfValue(text, i + 2)[1]; continue; }
          if (text.startsWith('/V', i) && /[\s(<[/]/.test(text[i + 2])) { [value, i] = fdfValue(text, i + 2); continue; }
          if (text.startsWith('/Kids', i)) { i = text.indexOf('[', i) + 1; const full = name === null ? prefix : prefix ? `${prefix}.${name}` : name; for (;;) { while (/\s/.test(text[i])) i++; if (text[i] === ']') { i++; break; } if (!text.startsWith('<<', i)) { i++; continue; } i = walk(i, full); } continue; }
          if (text.startsWith('<<', i)) { i = walk(i, prefix); continue; }
          i++;
        }
        if (name !== null && value !== undefined) out[prefix ? `${prefix}.${name}` : name] = value;
      }
      return i;
    };
    const start = text.indexOf('/Fields');
    if (start >= 0) {
      let i = text.indexOf('[', start) + 1;
      for (;;) { while (/\s/.test(text[i])) i++; if (text[i] === ']' || i >= text.length) break; if (!text.startsWith('<<', i)) { i++; continue; } i = walk(i, ''); }
    }
    return out;
  }
  if (format === 'xfdf') {
    const re = /<field\s+name="([^"]*)"\s*>|<\/field>|<value>([\s\S]*?)<\/value>/g;
    const stack = []; let m; const vals = new Map();
    while ((m = re.exec(text))) {
      if (m[1] !== undefined) stack.push(xmlText(m[1]));
      else if (m[0] === '</field>') stack.pop();
      else if (stack.length) { const k = stack.join('.'); vals.set(k, [...(vals.get(k) || []), xmlText(m[2])]); }
    }
    for (const [k, v] of vals) out[k] = v.length > 1 ? v : v[0];
    return out;
  }
  if (format === 'xml') {
    const body = text.replace(/<\?xml[^>]*>/, '');
    for (const m of body.matchAll(/<field\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/field>/g)) out[xmlText(m[1])] = xmlText(m[2]);
    for (const m of body.matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) if (m[1] !== 'field' && m[1] !== 'fields') out[m[1]] = xmlText(m[2]);
    return out;
  }
  const rows = delimited(text, format === 'csv' ? ',' : '\t');
  if (rows.length >= 2) rows[0].forEach((name, k) => { if (name) out[name] = rows[1][k] ?? ''; });
  return out;
}

export const FORM_DATA_FORMATS = [['xfdf', 'XFDF'], ['fdf', 'FDF'], ['xml', 'XML'], ['csv', 'CSV (comma-separated)'], ['txt', 'Text (tab-delimited)'], ['json', 'JSON']];

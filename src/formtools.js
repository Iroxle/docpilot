// Prepare form: field properties (format, validation, calculation), calculation order, tab order, tables of
// text fields, date and image fields, and form data in several formats.
import { h, toast, formDialog, messageBox, ibtn, fileBase } from './util.js';
import * as fa from './pdf/formauthor.js';
import * as af from './pdf/afcalc.js';
import * as ops from './pdf/ops.js';

const SEPARATORS = [['0', '1,234.56'], ['1', '1234.56'], ['2', '1.234,56'], ['3', '1234,56'], ['4', "1'234.56"]];
const DATE_FORMATS = ['dd/mm/yyyy', 'dd.mm.yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd', 'd mmmm yyyy', 'mmmm d, yyyy', 'dd-mmm-yy'];
const TIME_FORMATS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];

/** Field properties: format, validation and calculation of a text field (and of other fields' calculation). */
export async function fieldProperties(tools, name) {
  const doc = tools.doc;
  await doc.commitForms();
  const info = await fa.readFormActions(doc.bytes);
  if (!info.fields.length) { toast('This document has no form fields yet.'); return; }
  let field = info.fields.find((f) => f.name === name);
  if (!field) {
    const pick = await formDialog('Field properties', [{ k: 'name', label: 'Field', type: 'select', options: info.fields.map((f) => [f.name, `${f.name} (${f.type.replace(/Field$/, '')})`]) }], { ok: 'Next' });
    if (!pick) return;
    field = info.fields.find((f) => f.name === pick.name);
  }
  const fmt = field.format || { type: 'none' };
  const calc = field.calculate;
  const others = info.fields.filter((f) => f.name !== field.name).map((f) => f.name);
  const text = field.type === 'TextField';
  const is = (...t) => (v) => t.includes(v.format);
  const r = await formDialog(`Field properties: ${field.name}`, [
    ...(field.other.length ? [{ type: 'info', label: `This field also has scripts for: ${field.other.join(', ')}. They only run when JavaScript is allowed in Preferences.` }] : []),
    ...(text ? [
      { k: 'format', label: 'Format', type: 'select', options: [['none', 'None'], ['number', 'Number'], ['percent', 'Percentage'], ['date', 'Date'], ['time', 'Time'], ['special', 'Special'], ['mask', 'Custom mask']], value: fmt.type },
      { k: 'decimals', label: 'Decimal places', type: 'number', value: fmt.decimals ?? 2, min: 0, max: 10, showIf: is('number', 'percent') },
      { k: 'sep', label: 'Separator style', type: 'select', options: SEPARATORS, value: String(fmt.sep ?? 0), showIf: is('number', 'percent') },
      { k: 'neg', label: 'Negative numbers', type: 'select', options: [['0', '-1,234.00'], ['2', '(1,234.00)']], value: String(fmt.neg === 2 || fmt.neg === 3 ? 2 : 0), showIf: is('number') },
      { k: 'currency', label: 'Currency symbol (e.g. CHF, €)', value: (fmt.currency || '').trim(), showIf: is('number') },
      { k: 'prepend', label: 'Symbol before the number', type: 'checkbox', value: fmt.currency ? !!fmt.prepend : false, showIf: is('number') },
      { k: 'date', label: 'Date format', type: 'select', options: [...new Set([...(fmt.type === 'date' ? [fmt.format] : []), ...DATE_FORMATS])], value: fmt.type === 'date' ? fmt.format : DATE_FORMATS[0], showIf: is('date') },
      { k: 'time', label: 'Time format', type: 'select', options: [...new Set([...(fmt.type === 'time' ? [fmt.format] : []), ...TIME_FORMATS])], value: fmt.type === 'time' ? fmt.format : TIME_FORMATS[0], showIf: is('time') },
      { k: 'special', label: 'Special format', type: 'select', options: [['0', 'Zip code (99999)'], ['1', 'Zip code + 4'], ['2', 'Phone number (999) 999-9999'], ['3', 'Social security number']], value: String(fmt.special ?? 2), showIf: is('special') },
      { k: 'mask', label: 'Mask (9 digit, A letter, O letter or digit, X any)', value: fmt.mask || '', placeholder: 'e.g. AAA-9999', showIf: is('mask') },
      { k: 'validate', label: 'Value must lie in a range', type: 'checkbox', value: !!field.validate },
      { k: 'min', label: 'Smallest value (empty: none)', value: field.validate?.min ?? '', showIf: (v) => v.validate },
      { k: 'max', label: 'Largest value (empty: none)', value: field.validate?.max ?? '', showIf: (v) => v.validate },
    ] : [{ type: 'info', label: 'Formats and value ranges are for text fields. This field can be calculated.' }]),
    { k: 'calc', label: 'Calculate', type: 'select', options: [['none', 'Not calculated'], ['simple', 'Value of other fields'], ['notation', 'Simplified notation']], value: calc ? (calc.notation ? 'notation' : 'simple') : 'none' },
    { k: 'op', label: 'Operation', type: 'select', options: af.CALC_OPS, value: calc?.op || 'SUM', showIf: (v) => v.calc === 'simple' },
    { k: 'fields', label: `Fields (comma-separated; available: ${others.slice(0, 12).join(', ')}${others.length > 12 ? ', ...' : ''})`, value: calc?.fields?.join(', ') || '', showIf: (v) => v.calc === 'simple' },
    { k: 'notation', label: 'Expression, e.g. Quantity * Price (\\ before a space in a name)', value: calc?.notation || '', showIf: (v) => v.calc === 'notation' },
  ], {
    ok: 'Save', wide: true,
    validate: (v) => {
      if (v.calc === 'simple') { const missing = v.fields.split(',').map((s) => s.trim()).filter((s) => s && !others.some((o) => o === s || o.startsWith(`${s}.`))); if (missing.length) return `No field named: ${missing.join(', ')}`; if (!v.fields.trim()) return 'Please list the fields.'; }
      if (v.calc === 'notation') { const names = af.notationTokens(v.notation).filter((t) => t.name !== undefined).map((t) => t.name); const missing = names.filter((s) => !others.some((o) => o === s || o.startsWith(`${s}.`))); if (missing.length) return `No field named: ${missing.join(', ')}`; if (af.evalNotation(v.notation, () => 1) === null) return 'The expression cannot be read.'; }
      if (v.format === 'mask' && !v.mask.trim()) return 'Please enter a mask.';
      if (v.validate && v.min.trim() !== '' && af.makeNumber(v.min) === null) return 'The smallest value is not a number.';
      if (v.validate && v.max.trim() !== '' && af.makeNumber(v.max) === null) return 'The largest value is not a number.';
      return null;
    },
  });
  if (!r) return;
  const o = {};
  if (text) {
    o.format = { none: null, number: { type: 'number', decimals: +r.decimals || 0, sep: +r.sep, neg: +r.neg, currency: r.currency ? (r.prepend ? `${r.currency} ` : ` ${r.currency}`) : '', prepend: !!r.prepend }, percent: { type: 'percent', decimals: +r.decimals || 0, sep: +r.sep }, date: { type: 'date', format: r.date }, time: { type: 'time', format: r.time }, special: { type: 'special', special: +r.special }, mask: { type: 'mask', mask: r.mask.trim() } }[r.format];
    o.validate = r.validate ? { min: r.min.trim() === '' ? null : af.makeNumber(r.min), max: r.max.trim() === '' ? null : af.makeNumber(r.max) } : null;
  }
  o.calculate = r.calc === 'simple' ? { op: r.op, fields: r.fields.split(',').map((s) => s.trim()).filter(Boolean) } : r.calc === 'notation' ? { notation: r.notation.trim() } : null;
  await tools.mutate((b) => fa.setFieldActions(b, field.name, o));
  toast('Field properties saved', 'ok');
  if (tools.group?.id === 'form') tools.renderGroup();
}

/** The calculation order: calculated fields are recalculated in this order. */
export async function calculationOrder(tools) {
  const info = await fa.readFormActions(tools.doc.bytes);
  const calc = info.fields.filter((f) => f.calculate);
  if (!calc.length) { toast('This document has no calculated fields.'); return; }
  const order = [...info.order.filter((n) => calc.some((f) => f.name === n)), ...calc.map((f) => f.name).filter((n) => !info.order.includes(n))];
  const list = h('div', {}); const warn = h('div', { class: 'lp-note' });
  const draw = () => {
    list.replaceChildren(...order.map((n, i) => h('div', { class: 'kv', data: { calc: n } }, h('span', { class: 'g' }, `${i + 1}. ${n}`),
      ibtn('chevU', 'Earlier', () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); } }),
      ibtn('chevD', 'Later', () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); } }))));
    const p = fa.calculationOrderProblems(info.fields, order);
    warn.textContent = p.length ? `Check the order: ${p.join(' ')}` : 'Fields that read other calculated fields come after them.';
  };
  draw();
  const r = await formDialog('Calculation order', [{ type: 'node', node: h('div', {}, list, warn) }], { ok: 'Save' });
  if (r) await tools.mutate((b) => fa.setCalculationOrder(b, order));
}

/** Tab order of the fields: by rows, by columns or by document structure. */
export async function tabOrder(tools) {
  const r = await formDialog('Tab order', [
    { k: 'mode', label: 'Order', type: 'select', options: [['rows', 'By rows (left to right, top to bottom)'], ['columns', 'By columns (top to bottom, left to right)'], ['structure', 'By document structure']], value: 'rows' },
    tools.range('Pages'),
  ], { ok: 'Apply', validate: tools.validateRange });
  if (r) { await tools.mutate((b) => fa.setTabOrder(b, tools.pagesOf(r), r.mode)); toast('Tab order set', 'ok'); }
}

/** A table of text fields in a dragged area. */
export async function fieldTable(tools, i, rect) {
  const r = await formDialog('Text field table', [
    { k: 'columns', label: 'Column names (comma-separated)', value: 'Item, Quantity, Price', required: true },
    { k: 'rows', label: 'Rows', type: 'number', value: 5, min: 1, max: 100 },
    { type: 'info', label: 'Each cell gets a text field named after its column and row, e.g. "Quantity 2".' },
  ], { ok: 'Add' });
  if (!r) return;
  const columns = r.columns.split(',').map((s) => s.trim()).filter(Boolean);
  if (!columns.length) throw new Error('Please name at least one column.');
  await tools.mutate((b) => fa.addFieldTable(b, i, rect, { rows: Math.max(1, Math.round(r.rows)), columns }), { pages: [i] });
  if (tools.group?.id === 'form') tools.renderGroup();
}

async function uniqueName(tools, base) {
  const taken = new Set((await ops.listFormFields(tools.doc.bytes)).map((f) => f.name));
  let n = 1; while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}
const boxAt = (rect, p0, w, hgt) => rect || [p0[0], p0[1] - hgt, p0[0] + w, p0[1]];

/** A date field: takes and shows dates in the chosen format. */
export async function dateField(tools, i, rect, p0) {
  const r = await formDialog('Add date field', [
    { k: 'name', label: 'Field name', value: await uniqueName(tools, 'Date'), required: true },
    { k: 'format', label: 'Date format', type: 'select', options: DATE_FORMATS, value: DATE_FORMATS[0] },
  ], { ok: 'Add' });
  if (!r) return;
  await tools.mutate((b) => fa.addDateField(b, i, boxAt(rect, p0, 110, 22), r.name, r.format), { pages: [i] });
  if (tools.group?.id === 'form') tools.renderGroup();
}

/** An image field: a button that shows a picture chosen while filling in. */
export async function imageField(tools, i, rect, p0) {
  const r = await formDialog('Add image field', [{ k: 'name', label: 'Field name', value: await uniqueName(tools, 'Image'), required: true }, { type: 'info', label: 'While filling in, a click on the field chooses the picture.' }], { ok: 'Add' });
  if (!r) return;
  await tools.mutate((b) => fa.addImageField(b, i, boxAt(rect, p0, 120, 90), r.name), { pages: [i] });
  if (tools.group?.id === 'form') tools.renderGroup();
}

const extOf = (p) => (p.match(/\.([^.\\/]+)$/)?.[1] || '').toLowerCase();

/** Exports the form data as XFDF, FDF, XML, CSV, tab-delimited text or JSON. */
export async function exportFormData(tools) {
  const doc = tools.doc;
  await doc.commitForms();
  const r = await formDialog('Export form data', [{ k: 'format', label: 'Format', type: 'select', options: fa.FORM_DATA_FORMATS, value: tools.app.settings.formDataFormat || 'xfdf' }], { ok: 'Export' });
  if (!r) return;
  tools.app.settings.formDataFormat = r.format; await tools.app.saveSettings();
  const p = await window.dp.saveDialog({ title: 'Export form data', defaultPath: `${fileBase(doc.name)}_Data.${r.format}`, filters: [{ name: fa.FORM_DATA_FORMATS.find(([k]) => k === r.format)[1], extensions: [r.format] }] });
  if (!p) return;
  const text = r.format === 'json' ? JSON.stringify(await ops.exportFormData(doc.bytes), null, 2) : await fa.exportFormDataAs(doc.bytes, r.format, doc.name);
  await window.dp.writeFile(p, r.format === 'fdf' ? Uint8Array.from(text, (c) => c.charCodeAt(0) & 255) : new TextEncoder().encode(text));
  toast('Data exported', 'ok');
}

/** Imports form data from any of the formats (by file extension). */
export async function importFormData(tools) {
  const [p] = await window.dp.openDialog({ title: 'Import form data', filters: [{ name: 'Form data', extensions: fa.FORM_DATA_FORMATS.map(([k]) => k) }] });
  if (!p) return;
  const ext = extOf(p);
  const bytes = await window.dp.readFile(p);
  let text = '';
  if (ext === 'fdf') for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  else text = new TextDecoder().decode(bytes);
  let data;
  try { data = fa.parseFormData(text, fa.FORM_DATA_FORMATS.some(([k]) => k === ext) ? ext : 'json'); } catch { throw new Error('The file does not contain readable form data.'); }
  const names = new Set((await ops.listFormFields(tools.doc.bytes)).map((f) => f.name));
  const unknown = Object.keys(data).filter((k) => !names.has(k));
  await tools.mutate((b) => ops.importFormData(b, data));
  const used = Object.keys(data).length - unknown.length;
  if (unknown.length) await messageBox('Form data imported', `${used} value(s) imported. Not in this form: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? ', ...' : ''}`);
  else toast(`${used} value(s) imported`, 'ok');
}

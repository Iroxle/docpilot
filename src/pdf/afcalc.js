// Form formatting, validation and calculation without a JavaScript engine.
// Forms carry these as JavaScript calls to the standard AF functions (AFNumber_Format, AFPercent_Format,
// AFDate_FormatEx, AFTime_FormatEx, AFSpecial_Format, AFSpecial_KeystrokeEx, AFRange_Validate,
// AFSimple_Calculate) and as simplified field notation. This module recognises them, runs them natively
// (format for display, keystroke check on commit, validation, calculation) and writes them when a form is
// authored. Other scripts are left as they are: they only run when JavaScript is allowed.
//
// Ported from PdfCraft's forms crate (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors, MIT
// license, see THIRD_PARTY_NOTICES.md).

export const DATE_PRESETS = ['m/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy', 'yy-mm-dd', 'mmm-yy', 'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy', 'm/d/yy h:MM tt', 'm/d/yy HH:MM'];
export const TIME_PRESETS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SPECIAL_MASKS = ['99999', '99999-9999', '(999) 999-9999', '999-99-9999'];
export const CALC_OPS = [['SUM', 'Sum (+)'], ['PRD', 'Product (x)'], ['AVG', 'Average'], ['MIN', 'Minimum'], ['MAX', 'Maximum']];

// --- Numbers -----------------------------------------------------------------------------------------

/** AFMakeNumber: a number from typed text (currency symbols, group separators, spaces and % ignored). */
export function makeNumber(s) {
  let t = String(s ?? '').trim().replace(/[\s$€£¥'%]/g, '');
  if (!t) return null;
  const neg = t.startsWith('(') && t.endsWith(')');
  t = t.replace(/^\(+|\)+$/g, '');
  const c = t.lastIndexOf(','); const d = t.lastIndexOf('.');
  // "1.234,56" or "1234,56": the comma is the decimal separator when it comes last.
  if (c >= 0 && d >= 0 && c > d) t = t.replace(/\./g, '').replace(',', '.');
  else if (c >= 0 && d < 0 && t.length - c - 1 !== 3) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

/** A number as JavaScript prints it (integers without a fraction). */
export const jsNumber = (v) => (Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : String(v));

/** A number with decimals places in separator style sep (0 "1,234.56", 1 "1234.56", 2 "1.234,56", 3 "1234,56", 4 "1'234.56"). */
export function numberText(v, decimals, sep) {
  const p = 10 ** decimals;
  const scaled = Math.abs(v) * p;
  const r = Number.isFinite(scaled) ? Math.round(scaled) / p : Math.abs(v);
  const s = r.toFixed(decimals);
  const [int, frac = ''] = s.split('.');
  const [g, dec] = { 1: [null, '.'], 2: ['.', ','], 3: [null, ','], 4: ["'", '.'] }[sep] || [',', '.'];
  const grouped = g ? int.replace(/\B(?=(\d{3})+(?!\d))/g, g) : int;
  return frac ? `${grouped}${dec}${frac}` : grouped;
}

// --- Dates -------------------------------------------------------------------------------------------

const daysIn = (y, m) => (m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
function weekday(y, m, d) { const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]; if (m < 3) y -= 1; return (((y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + d) % 7) + 7) % 7; }
const monthNamed = (w) => { const l = w.toLowerCase(); if (l.length < 3) return null; const i = MONTHS.findIndex((m) => m.toLowerCase().startsWith(l.slice(0, 3)) && m.toLowerCase().startsWith(l)); return i >= 0 ? i + 1 : null; };

/** The fields of a date format in order: [{kind, width, joined, literal}] (kind y, m, d, H, M, s or # for literal digits). */
function order(fmt) {
  const out = []; const cleaned = fmt.replace(/dddd/g, ' ').replace(/ddd/g, ' ');
  let i = 0;
  while (i < cleaned.length) {
    const c = cleaned[i];
    let n = 1; while (cleaned[i + n] === c) n++;
    if (/\d/.test(c)) {
      let j = i; while (/\d/.test(cleaned[j] || '')) j++;
      out.push({ kind: '#', literal: +cleaned.slice(i, j), width: 0, joined: false }); i = j; continue;
    }
    const kind = { y: 'y', m: 'm', d: 'd', H: 'H', h: 'H', M: 'M', s: 's' }[c];
    if (kind) {
      const fixed = (kind === 'y' && (n === 2 || n === 4)) || (kind !== 'y' && n === 2) ? n : 0;
      const prev = out[out.length - 1];
      if (prev && prev.kind !== '#' && i > 0 && /[ymdHhMs]/.test(cleaned[i - 1])) prev.joined = true;
      out.push({ kind, width: kind === 'm' && n >= 3 ? 0 : fixed, joined: false, literal: 0, name: kind === 'm' && n >= 3 });
    }
    i += n;
  }
  return out;
}

/** Reads typed text with a date/time format, leniently (any separators, month names, two-digit years). */
export function parseDate(text, fmt) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const pm = /pm\b/.test(lower) || /\dp$/.test(lower); const am = /am\b/.test(lower) || /\da$/.test(lower);
  const nums = []; let month = null;
  for (const tok of t.match(/\d+|[^\W\d_]+/gu) || []) {
    if (/^\d/.test(tok)) nums.push(tok);
    else { const m = monthNamed(tok); if (m) month = m; }
  }
  const parts = order(fmt);
  const takes = (p) => ['y', 'd', 'H', 'M', 's'].includes(p.kind) || (p.kind === 'm' && month === null);
  const dateFields = parts.filter((p) => takes(p) && !['H', 'M', 's'].includes(p.kind)).length;
  // Digits typed together ("20261018") are split along the fields written side by side in the format.
  if (nums.length < dateFields && nums.length) {
    const split = [];
    let k = 0;
    for (const p of parts.filter(takes)) {
      if (!nums[k]) break;
      if (p.joined && p.width && nums[k].length > p.width) { split.push(nums[k].slice(0, p.width)); nums[k] = nums[k].slice(p.width); } else { split.push(nums[k]); k++; }
    }
    if (k < nums.length) split.push(...nums.slice(k));
    nums.splice(0, nums.length, ...split);
  }
  const dt = { y: 0, m: 1, d: 1, hh: 0, mm: 0, ss: 0 }; let haveY = false;
  for (const p of parts) {
    if (p.kind === '#') { if (nums.length && +nums[0] === p.literal) nums.shift(); continue; }
    if (p.kind === 'm') { if (month !== null) dt.m = month; else { if (!nums.length) return null; dt.m = +nums.shift(); } continue; }
    if (p.kind === 'd') { if (!nums.length) return null; dt.d = +nums.shift(); continue; }
    if (p.kind === 'y') { if (!nums.length) return null; const y = +nums.shift(); dt.y = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y; haveY = true; continue; }
    const key = { H: 'hh', M: 'mm', s: 'ss' }[p.kind];
    if (nums.length) dt[key] = +nums.shift();
  }
  if (nums.length) return null;
  if (!haveY) dt.y = 2000;
  if (pm && dt.hh < 12) dt.hh += 12;
  if (am && dt.hh === 12) dt.hh = 0;
  if (/[ymd]/.test(fmt) && (dt.m < 1 || dt.m > 12 || dt.d < 1 || dt.d > daysIn(dt.y, dt.m))) return null;
  if (dt.hh > 23 || dt.mm > 59 || dt.ss > 59) return null;
  return dt;
}

/** Writes a date/time with the format letters (yyyy yy mmmm mmm mm m dddd ddd dd d HH H hh h MM M ss s tt t). */
export function formatDate(dt, fmt) {
  let out = ''; let i = 0;
  const pad = (v, n) => String(v).padStart(n, '0');
  while (i < fmt.length) {
    const c = fmt[i]; let n = 1; while (fmt[i + n] === c) n++;
    const h12 = dt.hh % 12 === 0 ? 12 : dt.hh % 12;
    if (c === 'y') out += n >= 4 ? pad(dt.y, 4) : pad(((dt.y % 100) + 100) % 100, 2);
    else if (c === 'm') out += n >= 4 ? MONTHS[dt.m - 1] : n === 3 ? MONTHS[dt.m - 1].slice(0, 3) : n === 2 ? pad(dt.m, 2) : String(dt.m);
    else if (c === 'd') out += n >= 4 ? DAYS[weekday(dt.y, dt.m, dt.d)] : n === 3 ? DAYS[weekday(dt.y, dt.m, dt.d)].slice(0, 3) : n === 2 ? pad(dt.d, 2) : String(dt.d);
    else if (c === 'H') out += n === 2 ? pad(dt.hh, 2) : String(dt.hh);
    else if (c === 'h') out += n === 2 ? pad(h12, 2) : String(h12);
    else if (c === 'M') out += n === 2 ? pad(dt.mm, 2) : String(dt.mm);
    else if (c === 's') out += n === 2 ? pad(dt.ss, 2) : String(dt.ss);
    else if (c === 't') out += n >= 2 ? (dt.hh < 12 ? 'am' : 'pm') : (dt.hh < 12 ? 'a' : 'p');
    else out += c.repeat(n);
    i += n;
  }
  return out;
}

// --- Masks, formats, keystrokes, validation ----------------------------------------------------------

function applyMask(mask, text) {
  const src = [...String(text)].filter((c) => /[\p{L}\p{N}]/u.test(c)); let k = 0; let out = '';
  for (const mc of mask) {
    if ('9AOX'.includes(mc)) {
      const c = src[k++];
      if (c === undefined) return null;
      if ((mc === '9' && !/\d/.test(c)) || (mc === 'A' && !/\p{L}/u.test(c))) return null;
      out += c;
    } else out += mc;
  }
  return k === src.length ? out : null;
}

/** The text shown for a value (the Format event). format: {type, ...} from parseFormat. */
export function formatValue(f, value) {
  const v = String(value ?? '');
  if (!v || !f || f.type === 'none') return v;
  if (f.type === 'number') {
    const x = makeNumber(v); if (x === null) return v;
    let body = numberText(x, f.decimals, f.sep);
    if (f.currency) body = f.prepend ? `${f.currency}${body}` : `${body}${f.currency}`;
    return x < 0 ? (f.neg === 2 || f.neg === 3 ? `(${body})` : `-${body}`) : body;
  }
  if (f.type === 'percent') { const x = makeNumber(v); return x === null ? v : `${x < 0 ? '-' : ''}${numberText(x * 100, f.decimals, f.sep)}%`; }
  if (f.type === 'date' || f.type === 'time') { const dt = parseDate(v, f.format); return dt ? formatDate(dt, f.format) : v; }
  if (f.type === 'special') return applyMask(SPECIAL_MASKS[Math.min(3, f.special)], v) ?? v;
  if (f.type === 'mask') return applyMask(f.mask, v) ?? v;
  return v;
}

/** The Keystroke event on commit: {value} to store, or {error} with the message. */
export function keystroke(f, field, value) {
  const v = String(value ?? '');
  const bad = { error: `The value entered does not match the format of the field [ ${field} ]` };
  if (!f || f.type === 'none') return { value: v };
  if (!v.trim()) return { value: '' };
  if (f.type === 'number' || f.type === 'percent') { const x = makeNumber(v); return x === null ? bad : { value: jsNumber(x) }; }
  if (f.type === 'date' || f.type === 'time') return parseDate(v, f.format) ? { value: v.trim() } : { error: `Invalid date/time: please make sure that the date/time exists. Field [ ${field} ] should match format ${f.format}` };
  if (f.type === 'special') { const m = SPECIAL_MASKS[Math.min(3, f.special)]; return applyMask(m, v) !== null ? { value: v.trim() } : bad; }
  if (f.type === 'mask') return applyMask(f.mask, v) !== null ? { value: v.trim() } : bad;
  return { value: v };
}

/** The Validate event: null, or the message when the value is out of range. */
export function validate(r, value) {
  if (!r || (r.min === null && r.max === null) || !String(value ?? '').trim()) return null;
  const x = makeNumber(value);
  if (x === null) return null;
  if ((r.min === null || x >= r.min) && (r.max === null || x <= r.max)) return null;
  if (r.min !== null && r.max !== null) return `Invalid value: must be greater than or equal to ${jsNumber(r.min)} and less than or equal to ${jsNumber(r.max)}.`;
  return r.min !== null ? `Invalid value: must be greater than or equal to ${jsNumber(r.min)}.` : `Invalid value: must be less than or equal to ${jsNumber(r.max)}.`;
}

// --- Reading the scripts -----------------------------------------------------------------------------

/** The script without comments; strings stay. */
function stripComments(js) {
  let out = ''; let i = 0;
  while (i < js.length) {
    const c = js[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < js.length && js[j] !== c) j += js[j] === '\\' ? 2 : 1; out += js.slice(i, j + 1); i = j + 1; continue; }
    if (c === '/' && js[i + 1] === '/') { while (i < js.length && js[i] !== '\n') i++; continue; }
    if (c === '/' && js[i + 1] === '*') { const e = js.indexOf('*/', i + 2); i = e < 0 ? js.length : e + 2; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}

const unescapeJs = (s) => s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\(.)/g, (_, a, b, c, d) => (a ? String.fromCodePoint(parseInt(a, 16)) : b || c ? String.fromCharCode(parseInt(b || c, 16)) : ({ n: '\n', r: '\r', t: '\t' }[d] ?? d)));

/** The arguments of the first call of name (numbers, strings, booleans, lists), or null. */
function call(js, name) {
  const src = stripComments(js);
  const re = new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  const args = [];
  const skip = () => { while (/\s/.test(src[i] || '')) i++; };
  const value = () => {
    skip();
    const c = src[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; const s = unescapeJs(src.slice(i + 1, j)); i = j + 1; return s; }
    if (c === '[' || src.startsWith('new Array', i)) {
      i = c === '[' ? i + 1 : src.indexOf('(', i) + 1;
      const close = c === '[' ? ']' : ')'; const list = [];
      for (;;) { skip(); if (src[i] === close) { i++; break; } if (i >= src.length) return undefined; list.push(value()); skip(); if (src[i] === ',') i++; }
      return list;
    }
    const w = /^[^,)\]\s]+/.exec(src.slice(i));
    if (!w) return undefined;
    i += w[0].length;
    if (w[0] === 'true') return true;
    if (w[0] === 'false') return false;
    const n = Number(w[0]);
    return Number.isFinite(n) ? n : undefined;
  };
  for (;;) {
    skip();
    if (src[i] === ')') break;
    if (i >= src.length) return null;
    const v = value();
    if (v === undefined) return null;
    args.push(v);
    skip();
    if (src[i] === ',') i++;
    else if (src[i] !== ')') return null;
  }
  return args;
}
const byte = (v) => Math.max(0, Math.min(255, Math.trunc(+v || 0)));

/** The Format tab of a Format (or Keystroke) script: {type: number|percent|date|time|special|mask, ...} or null. */
export function parseFormat(js) {
  if (!js) return null;
  let a;
  if ((a = call(js, 'AFNumber_Format'))) return { type: 'number', decimals: byte(a[0]), sep: byte(a[1]), neg: byte(a[2]), currency: typeof a[4] === 'string' ? a[4] : '', prepend: a[5] === undefined ? true : !!a[5] };
  if ((a = call(js, 'AFPercent_Format'))) return { type: 'percent', decimals: byte(a[0]), sep: byte(a[1]) };
  if ((a = call(js, 'AFDate_FormatEx')) && typeof a[0] === 'string') return { type: 'date', format: a[0] };
  if ((a = call(js, 'AFDate_Format')) && DATE_PRESETS[byte(a[0])]) return { type: 'date', format: DATE_PRESETS[byte(a[0])] };
  if ((a = call(js, 'AFTime_FormatEx')) && typeof a[0] === 'string') return { type: 'time', format: a[0] };
  if ((a = call(js, 'AFTime_Format')) && TIME_PRESETS[byte(a[0])]) return { type: 'time', format: TIME_PRESETS[byte(a[0])] };
  if ((a = call(js, 'AFSpecial_Format'))) return { type: 'special', special: Math.min(3, byte(a[0])) };
  if ((a = call(js, 'AFSpecial_KeystrokeEx')) && typeof a[0] === 'string') return { type: 'mask', mask: a[0] };
  return null;
}

/** The Validate tab: {min, max} (null for an open end) or null. */
export function parseValidate(js) {
  const a = js && call(js, 'AFRange_Validate');
  if (!a) return null;
  const n = (v) => (Number.isFinite(+v) ? +v : null);
  return { min: a[0] ? n(a[1]) : null, max: a[2] ? n(a[3]) : null };
}

/** The Calculate tab: {op, fields} for AFSimple_Calculate, {notation} for simplified field notation, or null. */
export function parseCalculate(js) {
  if (!js) return null;
  const sfn = /\/\*\*\s*BVCALC\s([\s\S]*?)\sEVCALC\s*\*\*\//.exec(js);
  if (sfn && sfn[1].trim()) return { notation: sfn[1].trim() };
  const a = call(js, 'AFSimple_Calculate');
  if (!a || !CALC_OPS.some(([k]) => k === a[0])) return null;
  const fields = Array.isArray(a[1]) ? a[1].filter((x) => typeof x === 'string') : typeof a[1] === 'string' ? a[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
  return fields ? { op: a[0], fields } : null;
}

/** Recognised actions of a field from its event scripts ({Format, Keystroke, Validate, Calculate} as PDF.js gives them). */
export function readActions(actions) {
  const first = (k) => (Array.isArray(actions?.[k]) ? actions[k].join('\n') : actions?.[k] || '');
  const format = parseFormat(first('Format')) || parseFormat(first('Keystroke'));
  return { format, validate: parseValidate(first('Validate')), calculate: parseCalculate(first('Calculate')) };
}

// --- Simplified field notation -----------------------------------------------------------------------

/** Tokens of simplified field notation: numbers, operators + - * / ( ) and field names (\ escapes a space or operator). */
export function notationTokens(src) {
  const out = []; let i = 0;
  const breaks = (c) => /\s/.test(c) || '+-*/()'.includes(c);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/()'.includes(c)) { out.push({ op: c }); i++; continue; }
    if (/[\d.]/.test(c)) { let j = i; while (/[\d.]/.test(src[j] || '')) j++; out.push({ num: parseFloat(src.slice(i, j)) }); i = j; continue; }
    let name = '';
    while (i < src.length && !breaks(src[i])) { if (src[i] === '\\' && i + 1 < src.length) { name += src[i + 1]; i += 2; } else name += src[i++]; }
    out.push({ name });
  }
  return out;
}

/** Evaluates simplified field notation; valueOf(name) gives a field's number. null when it cannot be read. */
export function evalNotation(src, valueOf) {
  const t = notationTokens(src); let i = 0;
  const factor = (d) => {
    if (d > 64) return null;
    const x = t[i];
    if (!x) return null;
    if (x.num !== undefined) { i++; return x.num; }
    if (x.name !== undefined) { i++; return valueOf(x.name); }
    if (x.op === '+' || x.op === '-') { i++; const v = factor(d + 1); return v === null ? null : x.op === '-' ? -v : v; }
    if (x.op === '(') { i++; const v = expr(d + 1); if (t[i]?.op !== ')') return null; i++; return v; }
    return null;
  };
  const term = (d) => { let v = factor(d); while (v !== null && (t[i]?.op === '*' || t[i]?.op === '/')) { const o = t[i++].op; const r = factor(d); if (r === null) return null; v = o === '*' ? v * r : v / r; } return v; };
  const expr = (d) => { let v = term(d); while (v !== null && (t[i]?.op === '+' || t[i]?.op === '-')) { const o = t[i++].op; const r = term(d); if (r === null) return null; v = o === '+' ? v + r : v - r; } return v; };
  const v = expr(0);
  return v !== null && i === t.length && Number.isFinite(v) ? v : null;
}

/** The fields a calculation reads. */
export const calculationReads = (c) => (!c ? [] : c.fields ? [...new Set(c.fields)] : [...new Set(notationTokens(c.notation).filter((x) => x.name !== undefined).map((x) => x.name))]);

/** The Calculate event: the new value, given values(name) (every field named name or below it). */
export function calculate(c, values) {
  if (!c) return null;
  const num = (s) => makeNumber(s) ?? 0;
  if (c.notation) { const v = evalNotation(c.notation, (n) => num(values(n)[0])); return v === null ? null : jsNumber(v); }
  const xs = c.fields.flatMap((f) => values(f)).map(num);
  if (c.op === 'PRD' && !xs.length) return '0';
  let v;
  if (c.op === 'SUM' || c.op === 'AVG') v = xs.reduce((a, b) => a + b, 0);
  else if (c.op === 'PRD') v = xs.reduce((a, b) => a * b, 1);
  else if (c.op === 'MIN') v = xs.length ? Math.min(...xs) : 0;
  else v = xs.length ? Math.max(...xs) : 0;
  if (c.op === 'AVG') v = xs.length ? v / xs.length : 0;
  return Number.isFinite(v) ? jsNumber(v) : '0';
}

// --- Writing the scripts -----------------------------------------------------------------------------

const jsStr = (s) => `"${[...String(s)].map((c) => (c === '"' || c === '\\' ? `\\${c}` : c === '\n' ? '\\n' : c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}` : c)).join('')}"`;
const notationName = (n) => [...n].map((c, i) => ((/\s/.test(c) || '+-*/()\\'.includes(c) || (i === 0 && /[\d.]/.test(c))) ? `\\${c}` : c)).join('');

/** The Format and Keystroke scripts of a format, or null. */
export function formatJs(f) {
  if (!f || f.type === 'none') return null;
  if (f.type === 'number') { const args = `${f.decimals}, ${f.sep}, ${f.neg}, 0, ${jsStr(f.currency || '')}, ${!!f.prepend}`; return [`AFNumber_Format(${args});`, `AFNumber_Keystroke(${args});`]; }
  if (f.type === 'percent') return [`AFPercent_Format(${f.decimals}, ${f.sep});`, `AFPercent_Keystroke(${f.decimals}, ${f.sep});`];
  if (f.type === 'date') return [`AFDate_FormatEx(${jsStr(f.format)});`, `AFDate_KeystrokeEx(${jsStr(f.format)});`];
  if (f.type === 'time') return [`AFTime_FormatEx(${jsStr(f.format)});`, `AFTime_KeystrokeEx(${jsStr(f.format)});`];
  if (f.type === 'special') return [`AFSpecial_Format(${f.special});`, `AFSpecial_Keystroke(${f.special});`];
  if (f.type === 'mask') return ['', `AFSpecial_KeystrokeEx(${jsStr(f.mask)});`];
  return null;
}

export const validateJs = (r) => (!r || (r.min === null && r.max === null) ? null : `AFRange_Validate(${r.min !== null}, ${r.min ?? 0}, ${r.max !== null}, ${r.max ?? 0});`);

/** The Calculate script; simplified field notation is kept in a comment with its translation after it. */
export function calculateJs(c) {
  if (!c) return null;
  if (c.notation) {
    const js = notationTokens(c.notation).map((x) => (x.name !== undefined ? `AFMakeNumber(this.getField(${jsStr(x.name)}).value)` : x.num !== undefined ? String(x.num) : x.op)).join(' ');
    return `/** BVCALC ${c.notation} EVCALC **/ event.value = ${js};`;
  }
  return `AFSimple_Calculate(${jsStr(c.op)}, new Array(${c.fields.map(jsStr).join(', ')}));`;
}

export { notationName };

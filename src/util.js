// Interface helpers: elements, icons, dialogs, messages.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/**
 * On a Mac, texts in the interface name the Mac keys and settings: Cmd (⌘) instead of Ctrl, ⌥ for Alt,
 * ⇧ for Shift, ⌫ for Del, macOS instead of Windows. Applied to all texts and tooltips created with h().
 */
export const MAC = globalThis.dp?.platform === 'darwin';
const MAC_TEXT = [
  [/\bCtrl\+(Alt\+)?(Shift\+)?/g, (_m, alt, shift) => `${alt ? '⌥' : ''}${shift ? '⇧' : ''}⌘`],
  [/^Del$/, '⌫'],
  [/Same as Windows/g, 'Same as macOS'],
  [/the Windows setting \(Colors > Mode\)/g, 'the macOS setting (System Settings > Appearance)'],
  [/the Windows policy \(HKLM\\SOFTWARE\\Policies\\DocPilot\)/g, 'a configuration profile (com.docpilot.app)'],
];
export const macText = (s) => (MAC && typeof s === 'string' ? MAC_TEXT.reduce((t, [re, to]) => t.replace(re, to), s) : s);

/** A file in a folder chosen in a dialog, with the system's separator (\\ on Windows, / on a Mac). */
export const inFolder = (dir, name) => (dir.includes('\\') ? `${dir}\\${name}` : `${dir}/${name}`);

export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'data') Object.entries(v).forEach(([a, b]) => { e.dataset[a] = b; });
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'title') e.title = macText(v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'type') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(macText(String(c))));
  return e;
}

const P = {
  open: 'M3 7V5a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v1M3 8h15l-2 8H4z', save: 'M4 4h10l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM6 4v4h7V4M6 17v-6h8v6',
  print: 'M6 7V3h8v4M5 14H3V8a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v6h-2M6 12h8v5H6z', undo: 'M7 5 3 9l4 4M3 9h9a4 4 0 0 1 0 8H8', redo: 'm13 5 4 4-4 4M17 9H8a4 4 0 0 0 0 8h4',
  search: 'M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3zM13.5 13.5 18 18', x: 'M5 5l10 10M15 5 5 15', plus: 'M10 4v12M4 10h12', minus: 'M4 10h12', chevR: 'm8 5 5 5-5 5', chevL: 'm12 5-5 5 5 5', chevU: 'm5 12 5-5 5 5', chevD: 'm5 8 5 5 5-5',
  arrow: 'M4 3l11 7-5 1.5L8 17z', hand: 'M7 10V5a1 1 0 0 1 2 0v4-5a1 1 0 0 1 2 0v5-4a1 1 0 0 1 2 0v5-3a1 1 0 0 1 2 0v6c0 3-2 5-5 5s-4-1-5-3l-3-4c-.5-1 .8-2 2-1z', zoom: 'M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3zM13.5 13.5 18 18M9 6v6M6 9h6',
  note: 'M3 4h14v10H9l-4 3v-3H3zM6 8h8M6 11h5', highlight: 'M12 3l5 5-7 7H6v-3zM3 18h14', draw: 'M3 17s2-1 3-2L16 5a1.5 1.5 0 0 0-2-2L4 13c-1 1-1 4-1 4zM12 5l2 2', text: 'M4 5V3h12v2M10 3v14M7 17h6', textbox: 'M3 4h14v12H3zM7 7h6M10 7v6', sign: 'M3 15c3-8 5-10 6-9s-2 8 0 8 2-4 3-4 1 3 3 3 2-1 2-1M3 18h14',
  edit: 'M4 16v-3L13 4l3 3-9 9zM11.5 5.5l3 3', convert: 'M4 7h10l-3-3M16 13H6l3 3', tools: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z', pages: 'M6 3h9v12H6zM3 6v11h9', combine: 'M3 3h6v6H3zM11 11h6v6h-6zM9 6h5v4M11 14H6v-4', comment: 'M3 4h14v10h-7l-4 3v-3H3z',
  lock: 'M5 9h10v8H5zM7 9V6a3 3 0 0 1 6 0v3', redact: 'M3 5h14M3 10h14M3 15h14M6 8h8v4H6z', scan: 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4M3 10h14', compress: 'M7 3v5H3M13 3v5h4M7 17v-5H3M13 17v-5h4', measure: 'M2 13 13 2l5 5L7 18zM5 10l2 2M8 7l2 2M11 4l2 2',
  compare: 'M3 3h6v14H3zM11 3h6v14h-6zM5 7h2M13 7h2M5 11h2M13 11h2', access: 'M10 2a1.6 1.6 0 1 0 0 3.2A1.6 1.6 0 0 0 10 2zM3 7l7 1 7-1M10 8v4l-3 6M10 12l3 6', form: 'M3 3h14v14H3zM6 7h8M6 10h8M6 13h4', preflight: 'M10 2 3 5v5c0 4 3 7 7 8 4-1 7-4 7-8V5zM7 10l2 2 4-4', js: 'M6 4H5a2 2 0 0 0-2 2v2l-1 2 1 2v2a2 2 0 0 0 2 2h1M14 4h1a2 2 0 0 1 2 2v2l1 2-1 2v2a2 2 0 0 1-2 2h-1',
  thumbs: 'M3 3h5v6H3zM12 3h5v6h-5zM3 11h5v6H3zM12 11h5v6h-5z', bookmark: 'M5 3h10v14l-5-3-5 3z', clip: 'M15 9l-6 6a3.5 3.5 0 0 1-5-5l7-7a2.3 2.3 0 0 1 3.3 3.3L8 12.5a1.2 1.2 0 0 1-1.6-1.6L12 5', layers: 'M10 3 2 7l8 4 8-4zM2 11l8 4 8-4M2 14l8 4 8-4', cert: 'M10 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM7 11l-1 7 4-2 4 2-1-7', info: 'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM10 9v5M10 6v.5',
  rotR: 'M15 8a6 6 0 1 0 1 5M16 3v5h-5', rotL: 'M5 8a6 6 0 1 1-1 5M4 3v5h5', trash: 'M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11', dup: 'M7 7h10v10H7zM4 13V3h10', extract: 'M6 3h8v5M10 8v9M6 13l4 4 4-4', fit: 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4', width: 'M2 10h16M5 7l-3 3 3 3M15 7l3 3-3 3', more: 'M4 10h.01M10 10h.01M16 10h.01', menu: 'M3 5h14M3 10h14M3 15h14',
  rect: 'M3 5h14v10H3z', ellipse: 'M10 4c4.5 0 8 2.7 8 6s-3.5 6-8 6-8-2.7-8-6 3.5-6 8-6z', line: 'M4 16 16 4', arr: 'M4 16 16 4M9 4h7v7', poly: 'M10 3l7 5-3 9H6L3 8z', polyline: 'M3 15l5-9 4 7 5-9', cloud: 'M6 15a3 3 0 0 1-.5-6A4.5 4.5 0 0 1 14 7.6 3.7 3.7 0 0 1 14.5 15z', eraser: 'M8 17l-5-5 8-8 6 6-7 7zM6 9l5 5', stamp: 'M8 9a2 2 0 1 1 4 0c0 2-1 3-1 4h4l1 2H4l1-2h4c0-1-1-2-1-4zM4 17h12', caret: 'M4 15 10 5l6 10', replace: 'M3 10h14M7 5h6M7 15h6', check: 'M4 10l4 4 8-9', cross: 'M5 5l10 10M15 5 5 15', dot: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', date: 'M3 5h14v12H3zM3 9h14M7 3v4M13 3v4',
  link: 'M8 12l4-4M7 9l-2 2a3 3 0 0 0 4 4l2-2M13 11l2-2a3 3 0 0 0-4-4L9 7', img: 'M3 4h14v12H3zM3 13l4-4 3 3 3-2 4 4M13 7h.01', crop: 'M5 2v13h13M2 5h13v13', header: 'M3 3h14v14H3zM3 7h14M3 13h14', watermark: 'M10 3s5 5 5 9a5 5 0 0 1-10 0c0-4 5-9 5-9z', bg: 'M3 3h14v14H3zM3 9l6-6M3 15 15 3M9 17l8-8', bates: 'M3 5v10M6 5v10M9 5v10M13 5v10M17 5v10', blank: 'M5 2h7l4 4v12H5zM12 2v4h4', split: 'M10 2v16M3 6h4M3 14h4M13 6h4M13 14h4', insert: 'M5 2h7l4 4v12H5zM10 8v6M7 11h6',
  chk: 'M3 3h14v14H3zM6 10l3 3 5-6', radio: 'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', list: 'M3 3h14v14H3zM6 7h8M6 10h8M6 13h8', dd: 'M3 6h14v8H3zM12 9l1.5 2 1.5-2', btn: 'M2 6h16v8H2zM7 10h6', speak: 'M3 8v4h3l4 4V4L6 8zM13 7a4 4 0 0 1 0 6M15 5a7 7 0 0 1 0 10', snapshot: 'M3 6h3l2-2h4l2 2h3v11H3zM10 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', gear: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v3M10 15v3M2 10h3M15 10h3M4 4l2 2M14 14l2 2M16 4l-2 2M6 14l-2 2', ruler: 'M2 7h16v6H2zM5 7v3M8 7v2M11 7v3M14 7v2', share: 'M14 3l4 4-4 4M18 7h-6a6 6 0 0 0-6 6v4',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('class', 'ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.info);
  s.append(p);
  return s;
}
export const ibtn = (name, title, onclick, extra = {}) => h('button', { class: 'ib', title, onclick, type: 'button', ...extra }, icon(name));

function toastRoot() {
  let r = $('#toasts');
  if (!r) { r = h('div', { id: 'toasts' }); document.body.append(r); }
  return r;
}
export function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}`, role: 'status' }, msg);
  toastRoot().append(t);
  setTimeout(() => t.remove(), type === 'err' ? 7000 : 3200);
}
export const errToast = (e) => { console.error(e); toast(e && e.message ? e.message : String(e), 'err'); };

function scrim(dlg, onEsc) {
  const s = h('div', { class: 'scrim' }, dlg);
  s.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') onEsc(); });
  document.body.append(s);
  return s;
}

/** Progress indicator for longer operations. */
export async function busy(title, fn) {
  const bar = h('i');
  const label = h('div', {}, 'Please wait...');
  const s = scrim(h('div', { class: 'dlg', role: 'dialog' }, h('h3', {}, title), h('div', { class: 'b' }, label, h('div', { class: 'prog' }, bar))), () => {});
  await new Promise((r) => setTimeout(r, 20));
  try {
    return await fn((p, text) => { if (p !== null && p !== undefined) bar.style.width = `${Math.round(p * 100)}%`; if (text) label.textContent = text; });
  } finally { s.remove(); }
}

export function messageBox(title, body, buttons = ['OK'], opts = {}) {
  return new Promise((res) => {
    const close = (v) => { s.remove(); res(v); };
    const content = typeof body === 'string' ? h('div', { style: { whiteSpace: 'pre-wrap' } }, body) : body;
    const f = h('div', { class: 'f' }, buttons.map((b, i) => h('button', { class: `btn ${i === (opts.primary ?? 0) ? 'primary' : ''}`, type: 'button', onclick: () => close(i) }, b)));
    const s = scrim(h('div', { class: `dlg ${opts.wide ? 'wide' : ''}`, role: 'alertdialog' }, h('h3', {}, title), h('div', { class: 'b' }, content), f), () => close(opts.cancel ?? buttons.length - 1));
    setTimeout(() => { const b = $('.btn.primary', f); if (b) b.focus(); }, 10);
  });
}

/**
 * fields: [{k,label,type,value,options,placeholder,min,max,step,required,info}]
 * Returns: values as an object or null if cancelled. validate(v) may return an error message.
 */
export function formDialog(title, fields, opts = {}) {
  return new Promise((res) => {
    const inputs = {};
    const rows = fields.map((f) => {
      if (f.type === 'info') return h('div', { class: 'fr info' }, f.label);
      if (f.type === 'node') return h('div', { class: 'fr full' }, f.node);
      let inp;
      switch (f.type) {
        case 'select':
          inp = h('select', {}, f.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(f.value) }, l); }));
          break;
        case 'textarea': inp = h('textarea', { placeholder: f.placeholder }); inp.value = f.value ?? ''; break;
        case 'checkbox': inp = h('input', { type: 'checkbox', checked: !!f.value }); break;
        case 'color': inp = h('input', { type: 'color', value: f.value || '#000000' }); break;
        case 'range': inp = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: f.value }); break;
        default: inp = h('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder, min: f.min, max: f.max, step: f.step, spellcheck: 'false' });
      }
      inp.dataset.field = f.k;
      inputs[f.k] = inp;
      return h('label', { class: `fr ${f.type === 'checkbox' ? 'chk' : ''}` }, h('span', {}, f.label), inp);
    });
    // Rows shown only for some choices: showIf(values).
    const update = () => { const v = read(); fields.forEach((f, i) => { if (f.showIf) rows[i].hidden = !f.showIf(v); }); };
    const err = h('div', { class: 'err' });
    const read = () => Object.fromEntries(fields.filter((f) => f.k && inputs[f.k]).map((f) => {
      const i = inputs[f.k];
      return [f.k, f.type === 'checkbox' ? i.checked : (f.type === 'number' || f.type === 'range') ? parseFloat(i.value) : i.value];
    }));
    const close = (v) => { s.remove(); res(v); };
    const submit = (e) => {
      e?.preventDefault();
      const v = read();
      for (const f of fields) if (f.required && !String(v[f.k] ?? '').trim()) { err.textContent = `Please fill in "${f.label}".`; inputs[f.k].focus(); return; }
      const m = opts.validate && opts.validate(v);
      if (m) { err.textContent = m; return; }
      close(v);
    };
    const form = h('form', { onsubmit: submit, style: { display: 'contents' } },
      h('h3', {}, title), h('div', { class: 'b' }, rows, err),
      h('div', { class: 'f' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit', 'data-ok': '1' }, opts.ok || 'OK')));
    const s = scrim(h('div', { class: `dlg ${opts.wide ? 'wide' : ''}`, role: 'dialog' }, form), () => close(null));
    if (fields.some((f) => f.showIf)) { form.addEventListener('input', update); form.addEventListener('change', update); update(); }
    setTimeout(() => { const first = $('input,select,textarea', s); if (first) { first.focus(); if (first.select) first.select(); } }, 10);
  });
}

export function contextMenu(x, y, items) {
  $$('.ctx').forEach((c) => c.remove());
  const m = h('div', { class: 'ctx' }, items.filter(Boolean).map((i) => (i === '-' ? h('hr') : h('button', { type: 'button', disabled: i.disabled, onclick: () => { m.remove(); i.run(); } }, i.label))));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}

export const hexToRgb = (s) => { const n = parseInt(s.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
export const rgbToHex = (c) => (c ? `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : '#000000');
export const cssColor = (c) => (c ? `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})` : 'none');
export const fileBase = (n) => n.replace(/\.[^.]+$/, '');
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '');
export const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export function canvasBytes(canvas, mime = 'image/jpeg', q = 0.92) {
  return new Promise((res, rej) => canvas.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('The image could not be created.'))), mime, q));
}
export const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(s); };
export const mimeOf = (name) => (/\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.(gif|bmp|webp|tiff?)$/i.test(name) ? 'image/other' : 'application/octet-stream');

/** Converts any image to PNG or JPEG so it can be embedded in a PDF. */
export async function normalizeImage(bytes, name) {
  const mime = mimeOf(name);
  if (mime === 'image/png' || mime === 'image/jpeg') return { bytes, mime };
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return { bytes: await canvasBytes(c, 'image/png'), mime: 'image/png' };
}

/** Decodes and encodes JPEG images with the browser, for the PDF code (redaction, compression). */
export const imageCodec = {
  async decodeJpeg(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const d = g.getImageData(0, 0, c.width, c.height);
    return { width: d.width, height: d.height, data: d.data };
  },
  async encodeJpeg(rgba, width, height, quality = 0.85) {
    const c = new OffscreenCanvas(width, height);
    c.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const b = await c.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await b.arrayBuffer());
  },
};

// XFA forms into normal pages and form fields. A dynamic XFA form is a PDF shell around an XML template; programs
// without an XFA engine only show its placeholder page. The template is read, laid out and written as ordinary pages
// with static text, lines and boxes and AcroForm fields (text, multiline, number, date, check box, radio buttons,
// dropdown, list, button, signature), filled with the values of its data. A static XFA form already has its pages and
// fields: only the XFA part is removed, so every program shows and fills the same form.
//
// Layout: the first page area gives the page size and content area; subforms are laid out by their layout attribute:
// "position" (children at their x and y), "tb" (top to bottom), "lr-tb" (left to right, wrapping), "table" and "row"
// (columns from columnWidths). Margins, captions (left, top, right, bottom, with reserve), fonts, paragraph alignment,
// hidden and invisible objects and page breaks (break before) are followed. Top-to-bottom content that does not fit
// continues on a new page. Repeating subforms get one instance per data group (within occur min and max). Fields are
// bound to the data by name (normal binding), globally, or by a data reference.
//
// Ported from PdfCraft's xfa crate (parse, layout, data, pdf) (Copyright (c) 2026 ArtCraft Team and the PdfCraft
// contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFArray, PDFStream, PDFRawStream, PDFDict, PDFRef, PDFString, PDFHexString, PDFContentStream, PDFDocument, StandardFonts, rgb, decodePDFRawStream } from '@cantoo/pdf-lib';
import { parseXml, kids, kid, textContent } from './xml.js';

const N = (s) => PDFName.of(s);
const look = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return s; };
const utf8 = (b) => new TextDecoder('utf-8').decode(b);
const streamText = (s) => {
  const b = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s instanceof PDFContentStream ? s.getUnencodedContents() : s.getContents();
  try { return utf8(b); } catch { return latin1(b); }
};

/** A measurement such as "12.7mm", "72pt", "1in", "2.54cm" in points (bare numbers are points); null otherwise. */
export function measure(s) {
  if (s === undefined || s === null) return null;
  const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(String(s));
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const k = { '': 1, pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72, px: 0.75, pc: 12 }[m[2].toLowerCase()];
  return k === undefined ? null : Math.max(-100000, Math.min(100000, v * k));
}

/**
 * The XFA of a loaded document: {template, datasets, isStatic} with the packets as text, or null when the document
 * has no XFA. Static: the AcroForm already has fields with widgets on the pages.
 */
export function readXfa(doc) {
  const ctx = doc.context;
  const af = look(ctx, doc.catalog.get(N('AcroForm')));
  if (!(af instanceof PDFDict)) return null;
  const x = look(ctx, af.get(N('XFA')));
  const packets = {};
  let whole = '';
  if (x instanceof PDFArray) {
    for (let i = 0; i + 1 < x.size(); i += 2) {
      const name = look(ctx, x.get(i)); const s = look(ctx, x.get(i + 1));
      const t = s instanceof PDFStream ? streamText(s) : '';
      const key = name instanceof PDFString || name instanceof PDFHexString ? name.decodeText() : '';
      packets[key] = t; whole += t;
    }
  } else if (x instanceof PDFStream) whole = streamText(x);
  else return null;
  // Packets of a single stream (or missing names): find them in the XML.
  const grab = (local) => { const m = new RegExp(`<(?:[\\w-]+:)?${local}[\\s>][\\s\\S]*?</(?:[\\w-]+:)?${local}>`).exec(whole); return m ? m[0] : ''; };
  const template = packets.template || grab('template');
  const datasets = packets.datasets || grab('datasets');
  const fields = look(ctx, af.get(N('Fields')));
  const widgets = doc.getPages().some((p) => { const a = look(ctx, p.node.get(N('Annots'))); return a instanceof PDFArray && a.asArray().some((r) => look(ctx, look(ctx, r).get(N('Subtype'))) === N('Widget')); });
  const needsRendering = look(ctx, doc.catalog.get(N('NeedsRendering')))?.asBoolean?.() === true;
  return { template, datasets, isStatic: !needsRendering && widgets && fields instanceof PDFArray && fields.size() > 0 };
}

// --- Data ----------------------------------------------------------------------------------------------------
const dataKids = (d, name) => kids(d).filter((c) => c.local === name);
function dataRoot(datasetsXml, rootName) {
  const ds = datasetsXml ? parseXml(datasetsXml) : null;
  const data = ds ? (ds.local === 'data' ? ds : kid(ds, 'data')) : null;
  if (!data) return null;
  const first = kids(data)[0];
  return first && first.local === rootName ? first : data;
}
function findGlobal(d, name) { if (!d) return null; for (const c of kids(d)) { if (c.local === name) return c; const r = findGlobal(c, name); if (r) return r; } return null; }
function resolveRef(root, ref) {
  // "$.a.b" relative to the scope, "$data.x.y" or "$record.x" from the data root; [n] picks an instance.
  const parts = ref.replace(/^\$(data|record)?\.?/, '').split('.').filter(Boolean);
  let cur = root;
  for (const p of parts) {
    const m = /^([^[]+)(?:\[(\d+|\*)\])?$/.exec(p);
    if (!m || !cur) return null;
    const list = dataKids(cur, m[1]);
    cur = list[m[2] && m[2] !== '*' ? +m[2] : 0] || null;
  }
  return cur;
}

// --- Template model --------------------------------------------------------------------------------------------
const hidden = (el) => el.attrs.presence === 'hidden' || el.attrs.presence === 'inactive';
const invisible = (el) => el.attrs.presence === 'invisible';
function fontOf(el, inherited) {
  const f = kid(el, 'font');
  if (!f) return inherited;
  return { size: measure(f.attrs.size) ?? inherited.size, bold: f.attrs.weight ? f.attrs.weight === 'bold' : inherited.bold, italic: f.attrs.posture ? f.attrs.posture === 'italic' : inherited.italic, family: f.attrs.typeface || inherited.family };
}
const alignOf = (el, d = 'left') => kid(el, 'para')?.attrs.hAlign || d;
function marginOf(el) {
  const m = kid(el, 'margin');
  const g = (k) => measure(m?.attrs[k]) || 0;
  return { t: g('topInset'), b: g('bottomInset'), l: g('leftInset'), r: g('rightInset') };
}
/** The text of a value: text, rich text (exData, tags removed, paragraphs on lines), numbers and dates. */
function valueText(v) {
  if (!v) return '';
  for (const c of kids(v)) {
    if (c.local === 'exData') {
      const parts = [];
      const walk = (e) => { for (const k of e.children || []) { if (k.name === '#text') parts.push(k.text.replace(/\s+/g, ' ')); else { if (/^(p|br|div|li)$/.test(k.local) && parts.length) parts.push('\n'); walk(k); } } };
      walk(c);
      return parts.join('').replace(/ *\n */g, '\n').trim();
    }
    if (['text', 'integer', 'decimal', 'float', 'date', 'time', 'dateTime', 'boolean'].includes(c.local)) return textContent(c);
  }
  return '';
}
/** Lines of text wrapped to width with the measure function. */
export function wrapLines(text, width, size, bold, measureText) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!(width > 0)) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const t = line + word;
      if (line.trim() && measureText(t.trimEnd(), size, bold) > width) { out.push(line.trimEnd()); line = word.trimStart(); } else line = t;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Lays out an XFA template: {pages: [{size: [w, h], items: [...]}], fields: n}. Items are in page coordinates with
 * the origin top left: {kind: 'text', x, y, w, h, lines, size, bold, italic, align} | {kind: 'rect', x, y, w, h} |
 * {kind: 'line', x1, y1, x2, y2} | {kind: 'field', type, name, x, y, w, h, value, options, multiline, on, group}.
 * measureText(text, size, bold) gives text widths (an estimate is used without it).
 */
export function layoutXfa(templateXml, datasetsXml, measureText = (t, s) => t.length * s * 0.5) {
  const tpl = parseXml(templateXml);
  if (!tpl) throw new Error('The XFA form has no template.');
  const rootSub = tpl.local === 'subform' ? tpl : kid(tpl, 'subform');
  if (!rootSub) throw new Error('The XFA template has no form.');
  const data = dataRoot(datasetsXml, rootSub.attrs.name);
  // Page size and content area of the first page area.
  const pageArea = (rootSub ? kids(kid(rootSub, 'pageSet'), 'pageArea')[0] : null) || null;
  const medium = pageArea ? kid(pageArea, 'medium') : null;
  let pw = measure(medium?.attrs.short) || 612; let ph = measure(medium?.attrs.long) || 792;
  if (medium?.attrs.orientation === 'landscape') [pw, ph] = [ph, pw];
  const ca = pageArea ? kid(pageArea, 'contentArea') : null;
  const area = ca ? { x: measure(ca.attrs.x) || 0, y: measure(ca.attrs.y) || 0, w: measure(ca.attrs.w) || pw, h: measure(ca.attrs.h) || ph } : { x: 18, y: 18, w: pw - 36, h: ph - 36 };
  // Static content of the page area (master page): drawn on every page.
  const master = [];
  const pages = [];
  const newPage = () => { const p = { size: [pw, ph], items: [] }; pages.push(p); return p; };
  const names = new Map();
  const unique = (n) => { const k = names.get(n) || 0; names.set(n, k + 1); return k ? `${n}-${k + 1}` : n; };
  let fieldCount = 0;
  const baseFont = { size: 10, bold: false, italic: false, family: 'Helvetica' };

  const bindValue = (el, scope, name) => {
    const b = kid(el, 'bind');
    const match = b?.attrs.match || 'once';
    if (match === 'none') return null;
    let node = null;
    if (match === 'dataRef' && b.attrs.ref) node = resolveRef(b.attrs.ref.startsWith('$.') ? scope : data, b.attrs.ref);
    else if (match === 'global') node = findGlobal(data, name);
    else if (name && scope) node = dataKids(scope, name)[0] || null;
    return node ? textContent(node) : null;
  };

  /** A placed box: {w, h, place(x, y, out)} for an element; null for hidden elements. */
  function box(el, scope, path, font, availW) {
    if (hidden(el)) return null;
    const vis = !invisible(el);
    const f = fontOf(el, font);
    const tag = el.local;
    if (tag === 'draw') return drawBox(el, f, availW, vis);
    if (tag === 'field') return fieldBox(el, scope, path, f, availW, vis, null);
    if (tag === 'exclGroup') return groupBox(el, scope, path, f, availW, vis);
    if (tag === 'subform' || tag === 'area' || tag === 'subformSet') return containerBox(el, scope, path, f, availW);
    return null;
  }
  function drawBox(el, f, availW, vis) {
    const v = kid(el, 'value');
    const shape = v ? kids(v).find((c) => ['rectangle', 'line', 'arc'].includes(c.local)) : null;
    let w = measure(el.attrs.w); let hh = measure(el.attrs.h);
    const m = marginOf(el);
    if (shape?.local === 'line') {
      w = w ?? 0; hh = hh ?? 0;
      const slope = shape.attrs.slope === '/' ? '/' : '\\';
      return { w, h: hh, x: measure(el.attrs.x) || 0, y: measure(el.attrs.y) || 0, place: (x, y, out) => { if (!vis) return; out.push(slope === '/' ? { kind: 'line', x1: x, y1: y + hh, x2: x + w, y2: y } : { kind: 'line', x1: x, y1: y, x2: x + w, y2: y + hh }); } };
    }
    if (shape?.local === 'rectangle' || shape?.local === 'arc') {
      w = w ?? 0; hh = hh ?? 0;
      return { w, h: hh, x: measure(el.attrs.x) || 0, y: measure(el.attrs.y) || 0, place: (x, y, out) => { if (vis) out.push({ kind: 'rect', x, y, w, h: hh }); } };
    }
    const text = valueText(v);
    const width = w ?? Math.min(availW || 500, Math.max(...text.split('\n').map((l) => measureText(l, f.size, f.bold)), 1) + m.l + m.r + 2);
    const lines = wrapLines(text, width - m.l - m.r, f.size, f.bold, measureText);
    hh = hh ?? Math.max(measure(el.attrs.minH) || 0, lines.length * f.size * 1.2 + m.t + m.b);
    return { w: width, h: hh, x: measure(el.attrs.x) || 0, y: measure(el.attrs.y) || 0, place: (x, y, out) => { if (vis && text) out.push({ kind: 'text', x: x + m.l, y: y + m.t, w: width - m.l - m.r, h: hh - m.t - m.b, lines, size: f.size, bold: f.bold, italic: f.italic, align: alignOf(el) }); } };
  }
  function uiKind(el) {
    const ui = kid(el, 'ui');
    const u = ui ? kids(ui)[0] : null;
    return { kind: u?.local || 'textEdit', ui: u };
  }
  function fieldBox(el, scope, path, f, availW, vis, group) {
    const { kind, ui } = uiKind(el);
    const name = el.attrs.name || '';
    const cap = kid(el, 'caption');
    const capText = cap && !hidden(cap) ? valueText(kid(cap, 'value')) : '';
    const capFont = cap ? fontOf(cap, f) : f;
    const placement = cap?.attrs.placement || 'left';
    const multiline = kind === 'textEdit' && ui?.attrs.multiLine === '1';
    const lineH = f.size * 1.2 + 4;
    let w = measure(el.attrs.w) ?? measure(el.attrs.minW) ?? (kind === 'checkButton' ? 12 + (capText ? measureText(capText, capFont.size, capFont.bold) + 6 : 0) : Math.min(availW || 200, 200));
    let hh = measure(el.attrs.h) ?? Math.max(measure(el.attrs.minH) || 0, multiline ? lineH * 3 : kind === 'checkButton' ? Math.max(12, capFont.size * 1.4) : lineH + (capText && placement === 'top' ? capFont.size * 1.3 : 0));
    const m = marginOf(el);
    const reserve = measure(cap?.attrs.reserve);
    // Value: the data, else the template's default.
    const bound = bindValue(el, scope, name);
    const items = kids(el, 'items');
    let value = bound ?? valueText(kid(el, 'value'));
    let on = null; let options = null;
    if (kind === 'checkButton') {
      const vals = items[0] ? kids(items[0]).map(textContent) : ['1', '0'];
      on = vals[0] ?? '1';
      value = group ? null : String(value) === String(on);
    } else if (kind === 'choiceList') {
      const disp = items[0] ? kids(items[0]).map(textContent) : [];
      const save = items[1] ? kids(items[1]).map(textContent) : disp;
      options = disp;
      const k = save.indexOf(value);
      if (k >= 0) value = disp[k];
    }
    const type = kind === 'checkButton' ? (group ? 'radio' : 'checkbox') : kind === 'choiceList' ? (ui?.attrs.open === 'always' || ui?.attrs.open === 'multiSelect' ? 'list' : 'dropdown') : kind === 'button' ? 'button' : kind === 'signature' ? 'signature' : 'text';
    const full = [...path, name || 'Field'].filter(Boolean).join('.');
    return { w, h: hh, x: measure(el.attrs.x) || 0, y: measure(el.attrs.y) || 0, name: full, on, value, place: (x, y, out) => {
      let fx = x + m.l; let fy = y + m.t; let fw = w - m.l - m.r; let fh = hh - m.t - m.b;
      if (capText && vis) {
        const cw = reserve ?? (type === 'checkbox' || type === 'radio' ? fw - 14 : Math.min(fw * 0.5, measureText(capText, capFont.size, capFont.bold) + 6));
        const ch = reserve ?? capFont.size * 1.3;
        const text = (cx, cy, ww, h0) => out.push({ kind: 'text', x: cx, y: cy, w: ww, h: h0, lines: wrapLines(capText, ww, capFont.size, capFont.bold, measureText), size: capFont.size, bold: capFont.bold, italic: capFont.italic, align: alignOf(cap) });
        if (type === 'checkbox' || type === 'radio') { text(fx + 14, fy + (fh - capFont.size * 1.2) / 2, fw - 14, fh); fw = 12; fh = Math.min(fh, 12); }
        else if (placement === 'top') { text(fx, fy, fw, ch); fy += ch; fh -= ch; }
        else if (placement === 'bottom') { text(fx, fy + fh - ch, fw, ch); fh -= ch; }
        else if (placement === 'right') { text(fx + fw - cw, fy + (fh - capFont.size * 1.2) / 2, cw, fh); fw -= cw; }
        else { text(fx, fy + (fh - capFont.size * 1.2) / 2, cw, fh); fx += cw; fw -= cw; }
      }
      if (fw < 2 || fh < 2 || !vis) return;
      fieldCount++;
      out.push({ kind: 'field', type, name: group ? group : unique(full), x: fx, y: fy, w: fw, h: fh, value, options, multiline, on, size: f.size, hidden: !vis, readOnly: el.attrs.access === 'readOnly' || el.attrs.access === 'protected', tooltip: textContent(kid(kid(el, 'assist'), 'toolTip')) || capText || null });
    } };
  }
  function groupBox(el, scope, path, f, availW, vis) {
    const name = el.attrs.name || 'Group';
    const gname = unique([...path, name].join('.'));
    const bound = bindValue(el, scope, name);
    const inner = containerBox(el, scope, path, f, availW, (child) => (child.local === 'field' ? fieldBox(child, scope, path, fontOf(child, f), availW, vis && !invisible(child), gname) : null));
    const selected = bound ?? kids(el, 'field').map((c) => valueText(kid(c, 'value'))).find(Boolean) ?? null;
    return { ...inner, place: (x, y, out) => { const before = out.length; inner.place(x, y, out); for (let k = before; k < out.length; k++) if (out[k].kind === 'field' && out[k].group === undefined && out[k].name === gname) { out[k].group = gname; out[k].selected = selected; } } };
  }
  /** The instances of a repeating subform: one per data group with its name (within occur min and max). */
  function instances(el, scope) {
    const occ = kid(el, 'occur');
    const name = el.attrs.name;
    const min = occ ? Math.max(0, parseInt(occ.attrs.min ?? '1', 10)) : 1;
    const maxA = occ?.attrs.max; const max = maxA === undefined ? Math.max(1, min) : maxA === '-1' ? Infinity : parseInt(maxA, 10);
    const initial = occ ? parseInt(occ.attrs.initial ?? String(min), 10) : 1;
    const groups = name && scope ? dataKids(scope, name) : [];
    const n = Math.min(max, Math.max(min, groups.length || initial));
    return Array.from({ length: Math.max(0, n) }, (_, k) => groups[k] || (name ? null : scope));
  }
  function containerBox(el, scope, path, f, availW, childFn) {
    const layout = el.attrs.layout || 'position';
    const m = marginOf(el);
    const myW = measure(el.attrs.w);
    const innerW = (myW ?? availW ?? area.w) - m.l - m.r;
    const nm = el.local === 'subform' ? el.attrs.name : null;
    const cpath = nm ? [...path, nm] : path;
    const kidsBoxes = [];
    const ownFont = fontOf(el, f);
    for (const c of kids(el)) {
      if (!['subform', 'field', 'draw', 'exclGroup', 'area', 'subformSet'].includes(c.local)) continue;
      if (childFn) { const b = childFn(c); if (b) kidsBoxes.push(b); continue; }
      if (c.local === 'subform' && c.attrs.name) {
        instances(c, scope).forEach((inst) => { const b = box(c, inst ?? scope, cpath, ownFont, innerW); if (b) { b.breakBefore = breakBefore(c); kidsBoxes.push(b); } });
      } else { const b = box(c, scope, cpath, ownFont, innerW); if (b) { b.breakBefore = breakBefore(c); kidsBoxes.push(b); } }
    }
    let w; let hh; const pos = [];
    if (layout === 'tb') {
      let y = 0;
      for (const b of kidsBoxes) { pos.push([0, y]); y += b.h; }
      w = myW ?? Math.max(innerW, ...kidsBoxes.map((b) => b.w)) + m.l + m.r; hh = y;
    } else if (layout === 'lr-tb' || layout === 'rl-tb' || layout === 'row') {
      let x = 0; let y = 0; let rowH = 0;
      const widths = layout === 'row' && el.colWidths ? el.colWidths : null;
      kidsBoxes.forEach((b, k) => {
        const bw = widths?.[k] ?? b.w;
        if (layout !== 'row' && x > 0 && x + bw > innerW + 0.5) { x = 0; y += rowH; rowH = 0; }
        pos.push([layout === 'rl-tb' ? innerW - x - bw : x, y]); if (widths) b.w = bw;
        x += bw; rowH = Math.max(rowH, b.h);
      });
      w = myW ?? (layout === 'row' ? x : innerW) + m.l + m.r; hh = y + rowH;
    } else if (layout === 'table') {
      const cols = (el.attrs.columnWidths || '').trim().split(/\s+/).map(measure).filter((v) => v !== null);
      let y = 0;
      for (const b of kidsBoxes) { pos.push([0, y]); y += b.h; }
      w = myW ?? (cols.length ? cols.reduce((s, v) => s + v, 0) : innerW) + m.l + m.r; hh = y;
    } else {
      for (const b of kidsBoxes) pos.push([b.x || 0, b.y || 0]);
      w = myW ?? Math.max(0, ...kidsBoxes.map((b, k) => pos[k][0] + b.w)) + m.l + m.r;
      hh = Math.max(0, ...kidsBoxes.map((b, k) => pos[k][1] + b.h));
    }
    const h0 = measure(el.attrs.h) ?? Math.max(measure(el.attrs.minH) || 0, hh + m.t + m.b);
    return { w, h: h0, x: measure(el.attrs.x) || 0, y: measure(el.attrs.y) || 0, flow: layout === 'tb' ? { kids: kidsBoxes, m } : null, place: (x, y, out) => { kidsBoxes.forEach((b, k) => b.place(x + m.l + pos[k][0], y + m.t + pos[k][1], out)); } };
  }
  function breakBefore(el) {
    const bb = kid(el, 'breakBefore'); const br = kid(el, 'break');
    return (bb && (bb.attrs.targetType === 'pageArea' || bb.attrs.targetType === 'contentArea')) || (br && (br.attrs.before === 'pageArea' || br.attrs.before === 'contentArea'));
  }
  // Tables: rows get the column widths of their table.
  const markTables = (el) => { for (const c of kids(el)) { if (c.local === 'subform' && c.attrs.layout === 'table') { const cols = (c.attrs.columnWidths || '').trim().split(/\s+/).map(measure).filter((v) => v !== null); for (const r of kids(c, 'subform')) if (r.attrs.layout === 'row') r.colWidths = cols; } markTables(c); } };
  markTables(rootSub);
  // Master page content: draws and fields of the page area are on every page.
  if (pageArea) for (const c of kids(pageArea)) { if (c.local === 'draw' || c.local === 'field') { const b = box(c, data, [], baseFont, area.w); if (b) b.place(b.x || 0, b.y || 0, master); } }
  // Flow: top-to-bottom content continues on a new page; a positioned page subform is one page each.
  let page = newPage(); let cursor = area.y;
  const flow = (b, x) => {
    if (b.breakBefore && cursor > area.y + 0.5) { page = newPage(); cursor = area.y; }
    if (cursor + b.h > area.y + area.h + 0.5 && cursor > area.y + 0.5) {
      if (b.flow && b.h > area.h) { cursor += b.flow.m.t; for (const k of b.flow.kids) flow(k, x + b.flow.m.l); cursor += b.flow.m.b; return; }
      page = newPage(); cursor = area.y;
    } else if (b.flow && b.h > area.h) { cursor += b.flow.m.t; for (const k of b.flow.kids) flow(k, x + b.flow.m.l); cursor += b.flow.m.b; return; }
    b.place(x, cursor, page.items);
    cursor += b.h;
  };
  const root = containerBox(rootSub, data, [], baseFont, area.w);
  const rootLayout = rootSub.attrs.layout || 'position';
  if (rootLayout === 'tb' && root.flow) { cursor += root.flow.m.t; for (const k of root.flow.kids) flow(k, area.x + root.flow.m.l); }
  else root.place(area.x, area.y, page.items);
  // Empty last page (after a break) goes.
  if (pages.length > 1 && !pages[pages.length - 1].items.length) pages.pop();
  for (const p of pages) p.items.unshift(...master.map((it) => ({ ...it, name: it.kind === 'field' ? unique(it.name) : it.name })));
  return { pages, fields: fieldCount };
}

/**
 * Converts the XFA of a loaded document. Returns {bytes, kind: 'static'|'dynamic', pages, fields}. fonts: async
 * (doc, bold, text) => pdf-lib font for text that the standard fonts cannot write (optional).
 */
export async function convertXfa(doc, o = {}) {
  const x = readXfa(doc);
  if (!x) throw new Error('This document has no XFA form.');
  if (x.isStatic && !o.relayout) {
    const af = doc.catalog.lookup(N('AcroForm'));
    af.delete(N('XFA'));
    doc.catalog.delete(N('NeedsRendering'));
    return { bytes: await doc.save({ updateFieldAppearances: false }), kind: 'static', pages: doc.getPageCount(), fields: doc.getForm().getFields().length };
  }
  const out = await PDFDocument.create();
  const reg = await out.embedFont(StandardFonts.Helvetica); const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const winAnsi = (t) => [...t].every((c) => { try { reg.encodeText(c); return true; } catch { return false; } });
  const fontFor = async (b, t) => (winAnsi(t) || !o.fonts ? (b ? bold : reg) : (await o.fonts(out, b, t)) || (b ? bold : reg));
  const clean = (t) => [...t].map((c) => (winAnsi(c) ? c : '?')).join('');
  const measureText = (t, size, b) => (b ? bold : reg).widthOfTextAtSize(clean(t), size);
  const lay = layoutXfa(x.template, x.datasets, measureText);
  const form = out.getForm();
  const radios = new Map();
  // A field name that clashes with the name of a group of fields becomes a flat name.
  const taken = new Set();
  const make = (name, fn) => {
    try { const f = fn(name); taken.add(name); return f; } catch {
      let flat = name.replace(/\./g, '_'); for (let k = 2; taken.has(flat); k++) flat = `${name.replace(/\./g, '_')}-${k}`;
      taken.add(flat); return fn(flat);
    }
  };
  for (const pg of lay.pages) {
    const [W, H] = pg.size;
    const p = out.addPage([W, H]);
    for (const it of pg.items) {
      if (it.kind === 'text') {
        let y = H - it.y - it.size;
        for (const line of it.lines) {
          const font = await fontFor(it.bold, line);
          const t = font === reg || font === bold ? clean(line) : line;
          const lw = font.widthOfTextAtSize(t, it.size);
          const lx = it.align === 'center' ? it.x + (it.w - lw) / 2 : it.align === 'right' ? it.x + it.w - lw : it.x;
          if (t.trim()) p.drawText(t, { x: lx, y, size: it.size, font, color: rgb(0, 0, 0) });
          y -= it.size * 1.2;
        }
      } else if (it.kind === 'rect') p.drawRectangle({ x: it.x, y: H - it.y - it.h, width: it.w, height: it.h, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
      else if (it.kind === 'line') p.drawLine({ start: { x: it.x1, y: H - it.y1 }, end: { x: it.x2, y: H - it.y2 }, thickness: 0.5, color: rgb(0, 0, 0) });
      else if (it.kind === 'field') {
        const rect = { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h, borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 0.5 };
        let fld;
        if (it.type === 'radio') {
          let g = radios.get(it.name);
          if (!g) { g = make(it.name, (n) => form.createRadioGroup(n)); radios.set(it.name, g); }
          g.addOptionToPage(String(it.on || `Option${g.getOptions().length + 1}`), p, rect);
          if (it.selected !== null && it.selected !== undefined && String(it.selected) === String(it.on)) g.select(String(it.on));
          fld = g;
        } else if (it.type === 'checkbox') { fld = make(it.name, (n) => form.createCheckBox(n)); fld.addToPage(p, rect); if (it.value) fld.check(); }
        else if (it.type === 'dropdown' || it.type === 'list') {
          fld = make(it.name, (n) => (it.type === 'dropdown' ? form.createDropdown(n) : form.createOptionList(n)));
          if (it.options?.length) fld.setOptions(it.options.map(clean));
          fld.addToPage(p, { ...rect, font: reg });
          if (it.value && it.options?.includes(it.value)) fld.select(clean(it.value));
        } else if (it.type === 'button') { fld = make(it.name, (n) => form.createButton(n)); fld.addToPage(it.tooltip || 'Button', p, { ...rect, font: reg }); }
        else if (it.type === 'signature') { fld = make(it.name, (n) => form.createTextField(n)); fld.addToPage(p, { ...rect, font: reg }); }
        else {
          fld = make(it.name, (n) => form.createTextField(n));
          if (it.multiline) fld.enableMultiline();
          fld.addToPage(p, { ...rect, font: reg });
          if (it.value) fld.setText(clean(String(it.value)));
          fld.setFontSize(Math.min(it.size || 10, Math.max(6, it.h * 0.6)));
        }
        if (it.readOnly) fld.enableReadOnly();
        // The tooltip describes the field (also to screen readers); viewers read it from the widget too.
        if (it.tooltip && fld?.acroField) for (const dct of [fld.acroField.dict, ...fld.acroField.getWidgets().map((w) => w.dict)]) dct.set(N('TU'), PDFHexString.fromText(it.tooltip));
      }
    }
  }
  form.updateFieldAppearances(reg);
  // The document information comes along.
  const t = doc.getTitle(); if (t) out.setTitle(t);
  const a = doc.getAuthor(); if (a) out.setAuthor(a);
  const s = doc.getSubject(); if (s) out.setSubject(s);
  return { bytes: await out.save(), kind: 'dynamic', pages: lay.pages.length, fields: lay.fields };
}

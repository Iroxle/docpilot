// Accessibility: automatic tagging, tags for form fields and links, alternate text, reading the tag tree, and the
// accessibility check report.
//
// - Auto-tag gives an untagged document a structure tree: every text object becomes a paragraph, or a heading when
//   its size or weight sets it apart from the body text (level 1 at 1.6 times the body size, level 2 at 1.25 times
//   or a short bold line); images become figures (their alternate text is added afterwards); painted paths,
//   shadings and forms outside text are marked as artifacts (decoration). Content that is already marked (page marks
//   such as headers, recognized text) keeps its marks. The reading order is the order of the page content. Form
//   fields become /Form elements and links /Link elements that point at their annotations; pages with annotations
//   get the tab order of the structure.
// - The check report goes through the rules of the common accessibility checkers (document, page content, forms,
//   alternate text, tables, lists, headings); rules only a person can judge are listed as "check manually".
// Content streams are changed in place: marked-content operators are inserted around the tagged operators, every
// other byte stays.
//
// Ported from PdfCraft's a11y crate (autotag, autotag_roles, autotag_fields, alt, tags, report) (Copyright (c) 2026
// ArtCraft Team and the PdfCraft contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFStream, PDFRawStream, PDFRef, PDFString, PDFHexString, PDFContentStream, PDFBool, decodePDFRawStream } from '@cantoo/pdf-lib';
import { tokenize } from './content.js';

const N = (s) => PDFName.of(s);
const look = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : null);
const textOf = (o) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null);
const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return s; };
const bytesOf = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
export const HEADINGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
export const TAG_TYPES = ['Document', 'Part', 'Sect', 'Div', 'P', 'H', ...HEADINGS, 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot', 'Figure', 'Formula', 'Form', 'Link', 'Annot', 'Note', 'Caption', 'BlockQuote', 'Quote', 'Span', 'TOC', 'TOCI', 'Index', 'Reference', 'Art', 'NonStruct'];

function streamData(s) {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFContentStream) return s.getUnencodedContents();
  if (s instanceof PDFStream) return s.getContents();
  return new Uint8Array(0);
}
function contentList(page) {
  const ctx = page.node.context;
  const c = page.node.get(N('Contents'));
  const v = look(ctx, c);
  if (v instanceof PDFArray) return v.asArray().map((r) => ({ ref: r, s: look(ctx, r) }));
  return c ? [{ ref: c, s: v }] : [];
}
const isMarkStream = (ctx, s) => s instanceof PDFStream && (s.dict.get(N('DPMark')) || s.dict.get(N('PCMark')));
const strLen = (a) => (a.t === 'str' ? a.v.length : a.t === 'arr' ? a.v.reduce((n, x) => n + (x.t === 'str' ? x.v.length : 0), 0) : 0);

/** Plans the tags of one content stream: the text objects, images and painted paths, with their evidence. */
function planStream(ctx, data, res, fontsBold, state) {
  const ops = tokenize(data);
  const items = [];
  const xo = res instanceof PDFDict ? look(ctx, res.get(N('XObject'))) : null;
  const fonts = res instanceof PDFDict ? look(ctx, res.get(N('Font'))) : null;
  let bt = null; let pathStart = null;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const v = op.args.map((a) => a.v);
    switch (op.op) {
      case 'q': state.stack.push(state.ctm); break;
      case 'Q': if (state.stack.length) state.ctm = state.stack.pop(); break;
      case 'cm': if (v.length === 6) state.ctm = mul(v, state.ctm); break;
      // Only artifacts (page marks, decoration) stay as they are; text in other marked content (recognized text,
      // edited paragraphs, layers) is tagged inside it.
      case 'BDC': case 'BMC': { const art = op.args[0]?.v === 'Artifact'; state.marked.push(art); if (art) state.markDepth++; break; }
      case 'EMC': if (state.marked.length && state.marked.pop()) state.markDepth--; break;
      case 'BT': bt = { start: op.start, chars: 0, size: 0, bold: false, tm: [1, 0, 0, 1, 0, 0], fontSize: 0, inMarked: state.markDepth > 0 }; break;
      case 'Tf': if (bt) { bt.fontSize = v[1] || 0; const f = fonts instanceof PDFDict && v[0] ? look(ctx, fonts.get(N(v[0]))) : null; bt.bold = fontsBold(f); } break;
      case 'Tm': if (bt && v.length === 6) bt.tm = v; break;
      case 'Tj': case 'TJ': case '\'': case '"': {
        if (!bt) break;
        const n = op.args.reduce((s, a) => s + strLen(a), 0);
        bt.chars += n;
        const size = Math.abs(bt.fontSize) * scaleOf(bt.tm) * scaleOf(state.ctm);
        if (n && size > bt.size) bt.size = size;
        bt.boldAll = (bt.boldAll ?? true) && bt.bold;
        break;
      }
      case 'ET':
        if (bt && bt.chars > 0 && !bt.inMarked) items.push({ kind: 'text', start: bt.start, end: op.end, chars: bt.chars, size: bt.size, bold: !!bt.boldAll });
        bt = null;
        break;
      case 'm': case 're': if (!bt && pathStart === null) pathStart = op.start; break;
      case 'n': pathStart = null; break;
      case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'S': case 's':
        if (!bt && state.markDepth === 0) items.push({ kind: 'artifact', start: pathStart ?? op.start, end: op.end });
        pathStart = null;
        break;
      case 'sh': if (!bt && state.markDepth === 0) items.push({ kind: 'artifact', start: op.start, end: op.end }); break;
      case 'BI': if (!bt && state.markDepth === 0) items.push({ kind: 'figure', start: op.start, end: op.end, box: unitBox(state.ctm) }); break;
      case 'Do': {
        if (bt || state.markDepth > 0) break;
        const s = xo instanceof PDFDict && v[0] ? look(ctx, xo.get(N(v[0]))) : null;
        const sub = s instanceof PDFStream ? nameOf(look(ctx, s.dict.get(N('Subtype')))) : null;
        if (sub === 'Image') items.push({ kind: 'figure', start: op.start, end: op.end, box: unitBox(state.ctm) });
        else if (sub === 'Form') items.push({ kind: 'artifact', start: op.start, end: op.end });
        break;
      }
      default:
    }
  }
  return items;
}
const unitBox = (m) => {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};

/** The body text size: the size most characters are set in. */
function bodySize(items) {
  const by = new Map();
  for (const it of items) if (it.kind === 'text') { const k = Math.round(it.size * 2); by.set(k, (by.get(k) || 0) + it.chars); }
  let best = null; for (const [k, n] of by) if (!best || n > best[1]) best = [k, n];
  return best ? best[0] / 2 : 11;
}
/** The tag of a text object: H1, H2 or P. */
export function textRole(it, body) {
  const short = it.chars < 200;
  if (short && it.size >= body * 1.6) return 'H1';
  if (short && (it.size >= body * 1.25 || (it.bold && it.size >= body - 0.01 && it.chars < 80))) return 'H2';
  return 'P';
}

const isBold = (ctx) => (f) => {
  if (!(f instanceof PDFDict)) return false;
  const base = nameOf(look(ctx, f.get(N('BaseFont')))) || '';
  if (/bold|black|heavy|semibold|demi/i.test(base)) return true;
  const desc = look(ctx, f.get(N('FontDescriptor')));
  const w = desc instanceof PDFDict ? look(ctx, desc.get(N('FontWeight'))) : null;
  return w instanceof PDFNumber && w.asNumber() >= 600;
};

/** The struct tree root of a document, or null. */
export const structRoot = (doc) => { const r = look(doc.context, doc.catalog.get(N('StructTreeRoot'))); return r instanceof PDFDict ? r : null; };
export const isTagged = (doc) => {
  const mi = look(doc.context, doc.catalog.get(N('MarkInfo')));
  return !!structRoot(doc) && mi instanceof PDFDict && look(doc.context, mi.get(N('Marked'))) === PDFBool.True;
};

/** Adds a struct element; returns its reference. */
function elem(ctx, type, parent, extra = {}) {
  const d = ctx.obj({ Type: 'StructElem', S: type, P: parent, ...extra });
  return ctx.register(d);
}
function pushKid(ctx, parentRef, kid) {
  const p = ctx.lookup(parentRef);
  const k = p.get(N('K'));
  if (!k) p.set(N('K'), ctx.obj([kid]));
  else if (look(ctx, k) instanceof PDFArray) look(ctx, k).push(kid);
  else p.set(N('K'), ctx.obj([k, kid]));
}
/** The parent tree as a list of [key, value] (flattened, kids followed). */
function parentTreeNums(ctx, root) {
  const pt = look(ctx, root.get(N('ParentTree')));
  const out = [];
  const walk = (n, depth) => {
    if (!(n instanceof PDFDict) || depth > 32) return;
    const nums = look(ctx, n.get(N('Nums')));
    if (nums instanceof PDFArray) for (let i = 0; i + 1 < nums.size(); i += 2) out.push([look(ctx, nums.get(i)).asNumber(), nums.get(i + 1)]);
    const kids = look(ctx, n.get(N('Kids')));
    if (kids instanceof PDFArray) for (const k of kids.asArray()) walk(look(ctx, k), depth + 1);
  };
  walk(pt, 0);
  return out;
}
function writeParentTree(ctx, root, nums) {
  nums.sort((a, b) => a[0] - b[0]);
  const flat = []; for (const [k, v] of nums) flat.push(PDFNumber.of(k), v);
  root.set(N('ParentTree'), ctx.register(ctx.obj({ Nums: flat })));
  root.set(N('ParentTreeNextKey'), PDFNumber.of(nums.length ? nums[nums.length - 1][0] + 1 : 0));
}

/** Annotation elements (form fields, links) of a page, appended to parent; returns the parent tree entries. */
function tagAnnotations(ctx, page, pageRef, parentRef, nextKey, o) {
  const annots = look(ctx, page.node.get(N('Annots')));
  const entries = []; let n = 0;
  if (!(annots instanceof PDFArray)) return { entries, count: 0 };
  for (const aRef of annots.asArray()) {
    const a = look(ctx, aRef);
    if (!(a instanceof PDFDict) || a.get(N('StructParent')) !== undefined) continue;
    const sub = nameOf(look(ctx, a.get(N('Subtype'))));
    let type = null;
    if (sub === 'Widget' && o.fields !== false) type = 'Form';
    else if (sub === 'Link' && o.links !== false) type = 'Link';
    if (!type || !(aRef instanceof PDFRef)) continue;
    const extra = {};
    if (type === 'Form') {
      // The field's tooltip (or its name) describes it to a screen reader.
      let f = a; let tu = null; let name = null;
      for (let d = 0; f instanceof PDFDict && d < 16; d++) { tu = tu || textOf(look(ctx, f.get(N('TU')))); name = name || textOf(look(ctx, f.get(N('T')))); f = look(ctx, f.get(N('Parent'))); }
      if (tu || name) extra.Alt = PDFHexString.fromText(tu || name);
    }
    const e = elem(ctx, type, parentRef, { Pg: pageRef, ...extra });
    ctx.lookup(e).set(N('K'), ctx.obj({ Type: 'OBJR', Obj: aRef, Pg: pageRef }));
    pushKid(ctx, parentRef, e);
    a.set(N('StructParent'), PDFNumber.of(nextKey + n));
    entries.push([nextKey + n, e]);
    n++;
  }
  if (n) page.node.set(N('Tabs'), N('S'));
  return { entries, count: n };
}

/**
 * Tags an untagged document. Returns {pages, paragraphs, headings, figures, artifacts, fields, links}.
 * o: {fields, links} (both on by default).
 */
export function autoTag(doc, o = {}) {
  const ctx = doc.context;
  if (structRoot(doc)) throw new Error('The document is already tagged. Check its tags in the Tags panel instead.');
  const pages = doc.getPages();
  const bold = isBold(ctx);
  const plans = pages.map((page) => {
    const state = { ctm: [1, 0, 0, 1, 0, 0], stack: [], marked: [], markDepth: 0 };
    const res = page.node.Resources();
    return contentList(page).map((x) => {
      if (!(x.s instanceof PDFStream) || isMarkStream(ctx, x.s)) return { ...x, items: [] };
      const data = streamData(x.s);
      return { ...x, data, items: planStream(ctx, data, res, bold, state) };
    });
  });
  const all = plans.flat().flatMap((x) => x.items);
  if (!all.some((it) => it.kind === 'text' || it.kind === 'figure') && !pages.some((p) => look(ctx, p.node.get(N('Annots'))) instanceof PDFArray)) throw new Error('The document has no text or images to tag. Recognize the text of scans first.');
  const body = bodySize(all);
  const rootRef = ctx.register(ctx.obj({ Type: 'StructTreeRoot' }));
  const root = ctx.lookup(rootRef);
  const docElem = elem(ctx, 'Document', rootRef);
  root.set(N('K'), ctx.obj([docElem]));
  const out = { pages: 0, paragraphs: 0, headings: 0, figures: 0, artifacts: 0, fields: 0, links: 0 };
  const nums = [];
  let key = 0;
  pages.forEach((page, pi) => {
    const pageRef = page.ref;
    let mcid = 0; const kids = [];
    const streams = plans[pi];
    let changed = false;
    const newRefs = streams.map((st) => {
      if (!st.items.length) return st.ref;
      const edits = [];
      for (const it of st.items) {
        if (it.kind === 'artifact') { edits.push({ at: it.start, text: '/Artifact BMC\n', o: 1 }, { at: it.end, text: '\nEMC', o: 0 }); out.artifacts++; continue; }
        const type = it.kind === 'figure' ? 'Figure' : textRole(it, body);
        const id = mcid++;
        edits.push({ at: it.start, text: `/${type} <</MCID ${id}>> BDC\n`, o: 1 }, { at: it.end, text: '\nEMC', o: 0 });
        const extra = it.kind === 'figure' ? { A: ctx.obj({ O: 'Layout', BBox: it.box.map((v) => Math.round(v * 100) / 100) }) } : {};
        const e = elem(ctx, type, docElem, { Pg: pageRef, K: PDFNumber.of(id), ...extra });
        kids.push(e);
        if (type === 'P') out.paragraphs++; else if (type === 'Figure') out.figures++; else out.headings++;
      }
      edits.sort((a, b) => a.at - b.at || a.o - b.o);
      const parts = []; let at = 0;
      for (const e of edits) { parts.push(latin1(st.data.subarray(at, e.at)), e.text); at = e.at; }
      parts.push(latin1(st.data.subarray(at)));
      const ns = ctx.flateStream(bytesOf(parts.join('')));
      for (const [k, v] of st.s.dict.entries()) if (!['Filter', 'DecodeParms', 'Length', 'DL'].includes(k.decodeText())) ns.dict.set(k, v);
      changed = true;
      return ctx.register(ns);
    });
    if (changed) page.node.set(N('Contents'), ctx.obj(newRefs));
    for (const e of kids) pushKid(ctx, docElem, e);
    if (mcid) {
      page.node.set(N('StructParents'), PDFNumber.of(key));
      nums.push([key, ctx.obj(kids)]);
      key++;
      out.pages++;
    }
    const an = tagAnnotations(ctx, page, pageRef, docElem, key, o);
    for (const [k, e] of an.entries) { nums.push([k, e]); if (nameOf(ctx.lookup(e).get(N('S'))) === 'Form') out.fields++; else out.links++; }
    key += an.count;
  });
  writeParentTree(ctx, root, nums);
  doc.catalog.set(N('StructTreeRoot'), rootRef);
  doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
  return out;
}

/** Tags the form fields (and links) that have no tag yet in a tagged document. Returns {fields, links}. */
export function tagFormFields(doc, o = {}) {
  const ctx = doc.context;
  const root = structRoot(doc);
  if (!root) throw new Error('The document is not tagged yet. Tag it first (Automatically tag document).');
  const nums = parentTreeNums(ctx, root);
  let key = Math.max(nums.reduce((m, [k]) => Math.max(m, k + 1), 0), look(ctx, root.get(N('ParentTreeNextKey')))?.asNumber?.() || 0);
  let target = root.get(N('K'));
  const tk = look(ctx, target);
  if (tk instanceof PDFArray) target = tk.get(0);
  if (!(target instanceof PDFRef)) { target = elem(ctx, 'Document', ctx.getObjectRef(root) || root); root.set(N('K'), ctx.obj([target])); }
  const out = { fields: 0, links: 0 };
  for (const page of doc.getPages()) {
    const an = tagAnnotations(ctx, page, page.ref, target, key, o);
    for (const [k, e] of an.entries) { nums.push([k, e]); if (nameOf(ctx.lookup(e).get(N('S'))) === 'Form') out.fields++; else out.links++; }
    key += an.count;
  }
  writeParentTree(ctx, root, nums);
  return out;
}

/**
 * The tag tree: [{ref, type, alt, actualText, title, page (0-based or null), content (marked content count),
 * annots, children}]. depth limited.
 */
export function readTags(doc) {
  const ctx = doc.context;
  const root = structRoot(doc);
  if (!root) return [];
  const pageIndex = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]));
  const roleMap = look(ctx, root.get(N('RoleMap')));
  const seen = new Set();
  const node = (ref, depth, inheritedPage) => {
    const d = look(ctx, ref);
    if (!(d instanceof PDFDict) || depth > 64) return null;
    const key = ref instanceof PDFRef ? ref.toString() : null;
    if (key) { if (seen.has(key)) return null; seen.add(key); }
    let type = nameOf(look(ctx, d.get(N('S')))) || '?';
    const mapped = roleMap instanceof PDFDict ? nameOf(look(ctx, roleMap.get(N(type)))) : null;
    const pg = d.get(N('Pg'));
    const page = pg instanceof PDFRef ? pageIndex.get(pg.toString()) ?? inheritedPage : inheritedPage;
    const a = look(ctx, d.get(N('A')));
    const attrs = a instanceof PDFArray ? a.asArray().map((x) => look(ctx, x)) : [a];
    const bb = attrs.map((x) => (x instanceof PDFDict ? look(ctx, x.get(N('BBox'))) : null)).find((x) => x instanceof PDFArray);
    const bbox = bb ? bb.asArray().map((x) => look(ctx, x)?.asNumber?.() ?? 0) : null;
    const n = { ref: key, type, role: mapped || type, alt: textOf(look(ctx, d.get(N('Alt')))), actualText: textOf(look(ctx, d.get(N('ActualText')))), title: textOf(look(ctx, d.get(N('T')))), page: page ?? null, bbox, content: 0, annots: 0, children: [] };
    const k = look(ctx, d.get(N('K')));
    const kids = k instanceof PDFArray ? k.asArray() : k !== undefined ? [d.get(N('K'))] : [];
    for (const kid of kids) {
      const v = look(ctx, kid);
      if (v instanceof PDFNumber) n.content++;
      else if (v instanceof PDFDict && nameOf(look(ctx, v.get(N('Type')))) === 'MCR') n.content++;
      else if (v instanceof PDFDict && nameOf(look(ctx, v.get(N('Type')))) === 'OBJR') n.annots++;
      else if (v instanceof PDFDict) { const c = node(kid, depth + 1, page); if (c) n.children.push(c); }
    }
    return n;
  };
  const k = look(ctx, root.get(N('K')));
  const kids = k instanceof PDFArray ? k.asArray() : k ? [root.get(N('K'))] : [];
  return kids.map((x) => node(x, 0, null)).filter(Boolean);
}

/** All tags of a type (depth-first). */
export const findTags = (tree, pred) => { const out = []; const walk = (l) => { for (const n of l) { if (pred(n)) out.push(n); walk(n.children); } }; walk(tree); return out; };

const refOf = (doc, key) => {
  const m = /^(\d+) (\d+) R$/.exec(key || '');
  if (!m) throw new Error('Unknown tag.');
  return PDFRef.of(+m[1], +m[2]);
};
/** Sets (or with an empty text removes) the alternate text of a tag. */
export function setAlt(doc, key, alt) {
  const d = doc.context.lookup(refOf(doc, key));
  if (!(d instanceof PDFDict)) throw new Error('Unknown tag.');
  if (alt && alt.trim()) d.set(N('Alt'), PDFHexString.fromText(alt.trim())); else d.delete(N('Alt'));
}
/** Changes the type of a tag (e.g. P to H1). */
export function retag(doc, key, type) {
  if (!TAG_TYPES.includes(type)) throw new Error(`Unknown tag type: ${type}`);
  const d = doc.context.lookup(refOf(doc, key));
  if (!(d instanceof PDFDict)) throw new Error('Unknown tag.');
  d.set(N('S'), N(type));
}

// --- Check report ------------------------------------------------------------------------------------------
export const RULES = [
  ['permission-flag', 'Document', 'Accessibility permission', 'The security settings allow screen readers to read the content.', 'Remove the protection or allow content access for accessibility.'],
  ['image-only', 'Document', 'Not image-only', 'The pages are not only pictures of text.', 'Recognize the text (Scan & OCR).'],
  ['tagged-pdf', 'Document', 'Tagged PDF', 'The document is tagged.', 'Automatically tag the document.'],
  ['reading-order', 'Document', 'Logical reading order', 'The tags read in the order a sighted reader would.', 'Check the order in the Tags panel.'],
  ['language', 'Document', 'Primary language', 'The language of the text is set.', 'Set title and language.'],
  ['title', 'Document', 'Title', 'The document has a title, and the window shows it.', 'Set title and language.'],
  ['bookmarks', 'Document', 'Bookmarks', 'Documents of more than 20 pages have bookmarks.', 'Add bookmarks for the main sections.'],
  ['color-contrast', 'Document', 'Colour contrast', 'Text contrasts enough with its background.', 'Check the colours by eye or with a contrast tool.'],
  ['tagged-content', 'Page content', 'Tagged content', 'All page content is tagged or marked as decoration.', 'Automatically tag the document.'],
  ['tagged-annotations', 'Page content', 'Tagged annotations', 'Comments, links and form fields are tagged.', 'Tag form fields and links.'],
  ['tab-order', 'Page content', 'Tab order', 'Pages with annotations use the order of the tags.', 'Fix the tab order.'],
  ['character-encoding', 'Page content', 'Character encoding', 'The fonts map their characters to Unicode.', 'Recreate the PDF with fonts that map their characters.'],
  ['multimedia', 'Page content', 'Tagged multimedia', 'Multimedia objects are tagged.', 'Tag multimedia annotations.'],
  ['screen-flicker', 'Page content', 'Screen flicker', 'Nothing on the pages flickers.', 'Check animations and multimedia.'],
  ['scripts', 'Page content', 'Scripts', 'Scripts work with assistive technology.', 'Check the document JavaScript.'],
  ['timed-responses', 'Page content', 'Timed responses', 'Nothing requires a response within a time limit.', 'Check forms and scripts.'],
  ['navigation-links', 'Page content', 'Navigation links', 'Links that lead to the same place are not repeated needlessly.', 'Check the links.'],
  ['tagged-fields', 'Forms', 'Tagged form fields', 'Every form field is tagged.', 'Tag form fields.'],
  ['field-descriptions', 'Forms', 'Field descriptions', 'Every form field has a description (tooltip).', 'Add a tooltip in the field properties.'],
  ['figures-alt', 'Alternate text', 'Figures alternate text', 'Every figure has alternate text.', 'Add alternate text to images.'],
  ['nested-alt', 'Alternate text', 'Nested alternate text', 'Alternate text is not hidden by alternate text above it.', 'Remove the alternate text of the inner or outer tag.'],
  ['alt-associated', 'Alternate text', 'Associated with content', 'Alternate text belongs to content on a page.', 'Remove alternate text from empty tags.'],
  ['alt-hides-annotation', 'Alternate text', 'Hides annotation', 'Alternate text does not hide an annotation.', 'Remove the alternate text of tags that contain annotations.'],
  ['other-alt', 'Alternate text', 'Other elements alternate text', 'Formulas have alternate text.', 'Add alternate text in the Tags panel.'],
  ['table-rows', 'Tables', 'Rows', 'Table rows are children of a table (or its head, body or foot).', 'Fix the table tags in the Tags panel.'],
  ['table-cells', 'Tables', 'TH and TD', 'Header and data cells are children of a table row.', 'Fix the table tags in the Tags panel.'],
  ['table-headers', 'Tables', 'Headers', 'Every table has header cells.', 'Tag the header cells as TH.'],
  ['table-regularity', 'Tables', 'Regularity', 'Every row of a table has the same number of columns.', 'Fix the table tags in the Tags panel.'],
  ['table-summary', 'Tables', 'Summary', 'Every table has a summary (alternate text).', 'Add a summary in the Tags panel.'],
  ['list-items', 'Lists', 'List items', 'List items are children of a list.', 'Fix the list tags in the Tags panel.'],
  ['lbl-lbody', 'Lists', 'Lbl and LBody', 'Labels and list bodies are children of list items.', 'Fix the list tags in the Tags panel.'],
  ['heading-nesting', 'Headings', 'Appropriate nesting', 'Heading levels do not skip a level.', 'Change the heading levels in the Tags panel.'],
];
const MANUAL = new Set(['reading-order', 'color-contrast', 'screen-flicker', 'timed-responses', 'navigation-links']);

/** Page content operators that paint, and whether they are inside tagged or artifact marked content. */
function untaggedOps(ctx, page) {
  let untagged = 0;
  for (const x of contentList(page)) {
    if (!(x.s instanceof PDFStream)) continue;
    if (isMarkStream(ctx, x.s)) continue;
    const stack = [];
    for (const op of tokenize(streamData(x.s))) {
      if (op.op === 'BDC' || op.op === 'BMC') {
        const tag = op.args[0]?.v;
        const props = op.args[1];
        const mcid = props?.t === 'dict' && props.v.some((a, i) => a.t === 'name' && a.v === 'MCID' && props.v[i + 1]?.t === 'num');
        stack.push(tag === 'Artifact' || mcid);
      } else if (op.op === 'EMC') stack.pop();
      else if (['Tj', 'TJ', '\'', '"', 'Do', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'sh', 'BI'].includes(op.op) && !stack.some(Boolean)) untagged++;
    }
  }
  return untagged;
}

/**
 * The accessibility check report: [{id, category, name, description, fix, status: 'passed'|'failed'|'manual'|'skipped', detail}].
 * o: {permissions (PDF.js permission flags or null), pageText: [bool per page] (whether the page has text), hasJS}.
 */
export function checkReport(doc, o = {}) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const tree = readTags(doc);
  const all = findTags(tree, () => true);
  const res = new Map();
  const set = (id, status, detail = '') => res.set(id, { status, detail });
  set('permission-flag', o.permissions && !o.permissions.includes(512) && !o.permissions.includes(16) ? 'failed' : 'passed');
  const textless = (o.pageText || []).map((t, i) => (!t ? i : -1)).filter((i) => i >= 0);
  set('image-only', o.pageText && textless.length === pages.length ? 'failed' : 'passed', textless.length && textless.length < pages.length ? `${textless.length} page(s) without text` : '');
  set('tagged-pdf', isTagged(doc) ? 'passed' : 'failed');
  set('reading-order', 'manual');
  const lang = textOf(look(ctx, doc.catalog.get(N('Lang'))));
  set('language', lang ? 'passed' : 'failed', lang || '');
  const vp = look(ctx, doc.catalog.get(N('ViewerPreferences')));
  const showTitle = vp instanceof PDFDict && look(ctx, vp.get(N('DisplayDocTitle'))) === PDFBool.True;
  const title = doc.getTitle?.();
  set('title', title && showTitle ? 'passed' : 'failed', !title ? 'No title' : !showTitle ? 'The window shows the file name' : '');
  set('bookmarks', pages.length <= 20 || look(ctx, doc.catalog.get(N('Outlines'))) instanceof PDFDict ? 'passed' : 'failed');
  set('color-contrast', 'manual');
  let untagged = 0; let annotsUntagged = 0; let tabs = 0; let multimedia = 0; let widgets = 0; let widgetsUntagged = 0; let noTooltip = 0;
  pages.forEach((p) => {
    untagged += untaggedOps(ctx, p);
    const annots = look(ctx, p.node.get(N('Annots')));
    if (annots instanceof PDFArray && annots.size()) {
      if (nameOf(look(ctx, p.node.get(N('Tabs')))) !== 'S') tabs++;
      for (const ar of annots.asArray()) {
        const a = look(ctx, ar);
        if (!(a instanceof PDFDict)) continue;
        const sub = nameOf(look(ctx, a.get(N('Subtype'))));
        if (sub === 'Popup') continue;
        const flags = look(ctx, a.get(N('F')))?.asNumber?.() || 0;
        if (flags & 2) continue;
        const tagged = a.get(N('StructParent')) !== undefined;
        if (!tagged) annotsUntagged++;
        if (['Screen', 'Movie', 'Sound', 'RichMedia'].includes(sub) && !tagged) multimedia++;
        if (sub === 'Widget') {
          widgets++; if (!tagged) widgetsUntagged++;
          let f = a; let tu = null;
          for (let d = 0; f instanceof PDFDict && d < 16 && !tu; d++) { tu = textOf(look(ctx, f.get(N('TU')))); f = look(ctx, f.get(N('Parent'))); }
          if (!tu) noTooltip++;
        }
      }
    }
  });
  set('tagged-content', untagged ? 'failed' : 'passed', untagged ? `${untagged} untagged object(s)` : '');
  set('tagged-annotations', annotsUntagged ? 'failed' : 'passed', annotsUntagged ? `${annotsUntagged} untagged annotation(s)` : '');
  set('tab-order', tabs ? 'failed' : 'passed', tabs ? `${tabs} page(s)` : '');
  // Character encoding: composite and Type 3 fonts need a ToUnicode map; simple symbolic fonts without an encoding are doubtful.
  let unmapped = 0;
  const fontsSeen = new Set();
  const visit = (r, depth) => {
    r = look(ctx, r);
    if (!(r instanceof PDFDict) || depth > 8) return;
    const fonts = look(ctx, r.get(N('Font')));
    if (fonts instanceof PDFDict) for (const [, v] of fonts.entries()) {
      const k = v.toString(); if (fontsSeen.has(k)) continue; fontsSeen.add(k);
      const f = look(ctx, v); if (!(f instanceof PDFDict)) continue;
      const sub = nameOf(look(ctx, f.get(N('Subtype'))));
      if ((sub === 'Type0' || sub === 'Type3') && !f.get(N('ToUnicode'))) {
        const enc = nameOf(look(ctx, f.get(N('Encoding'))));
        const df = look(ctx, f.get(N('DescendantFonts')));
        const cid = df instanceof PDFArray ? look(ctx, df.get(0)) : null;
        const csi = cid instanceof PDFDict ? look(ctx, cid.get(N('CIDSystemInfo'))) : null;
        const ordering = csi instanceof PDFDict ? textOf(look(ctx, csi.get(N('Ordering')))) : null;
        if (!(enc && enc !== 'Identity-H' && enc !== 'Identity-V' && /^(GB1|CNS1|Japan1|Korea1)$/.test(ordering || ''))) unmapped++;
      }
    }
    const xo = look(ctx, r.get(N('XObject')));
    if (xo instanceof PDFDict) for (const [, v] of xo.entries()) { const s = look(ctx, v); if (s instanceof PDFStream && nameOf(look(ctx, s.dict.get(N('Subtype')))) === 'Form') visit(s.dict.get(N('Resources')), depth + 1); }
  };
  pages.forEach((p) => visit(p.node.Resources(), 0));
  set('character-encoding', unmapped ? 'failed' : 'passed', unmapped ? `${unmapped} font(s) without Unicode mapping` : '');
  set('multimedia', multimedia ? 'failed' : 'passed');
  set('screen-flicker', 'manual');
  set('scripts', o.hasJS ? 'manual' : 'passed');
  set('timed-responses', 'manual');
  set('navigation-links', 'manual');
  set('tagged-fields', !widgets ? 'skipped' : widgetsUntagged ? 'failed' : 'passed', widgetsUntagged ? `${widgetsUntagged} of ${widgets}` : '');
  set('field-descriptions', !widgets ? 'skipped' : noTooltip ? 'failed' : 'passed', noTooltip ? `${noTooltip} field(s) without a tooltip` : '');
  const figures = all.filter((n) => n.role === 'Figure');
  const noAlt = figures.filter((n) => !n.alt && !n.actualText);
  set('figures-alt', !figures.length ? 'skipped' : noAlt.length ? 'failed' : 'passed', noAlt.length ? `${noAlt.length} of ${figures.length}` : '');
  let nested = 0;
  const walkAlt = (list, above) => { for (const n of list) { if (n.alt && above) nested++; walkAlt(n.children, above || !!n.alt); } };
  walkAlt(tree, false);
  set('nested-alt', !all.length ? 'skipped' : nested ? 'failed' : 'passed');
  const subtreeHasContent = (n) => n.content > 0 || n.annots > 0 || n.children.some(subtreeHasContent);
  const emptyAlt = all.filter((n) => n.alt && !subtreeHasContent(n)).length;
  set('alt-associated', !all.length ? 'skipped' : emptyAlt ? 'failed' : 'passed');
  set('alt-hides-annotation', !all.length ? 'skipped' : all.some((n) => n.alt && n.annots && n.role !== 'Form' && n.role !== 'Link') ? 'failed' : 'passed');
  const formulas = all.filter((n) => n.role === 'Formula');
  set('other-alt', !formulas.length ? 'skipped' : formulas.some((n) => !n.alt) ? 'failed' : 'passed');
  const parentOf = new Map();
  const walkP = (list, parent) => { for (const n of list) { parentOf.set(n, parent); walkP(n.children, n); } };
  walkP(tree, null);
  const tables = all.filter((n) => n.role === 'Table');
  const rows = all.filter((n) => n.role === 'TR');
  const cells = all.filter((n) => n.role === 'TH' || n.role === 'TD');
  set('table-rows', !tables.length && !rows.length ? 'skipped' : rows.every((r) => ['Table', 'THead', 'TBody', 'TFoot'].includes(parentOf.get(r)?.role)) ? 'passed' : 'failed');
  set('table-cells', !cells.length ? 'skipped' : cells.every((c) => parentOf.get(c)?.role === 'TR') ? 'passed' : 'failed');
  set('table-headers', !tables.length ? 'skipped' : tables.every((t) => findTags([t], (n) => n.role === 'TH').length) ? 'passed' : 'failed');
  set('table-regularity', !tables.length ? 'skipped' : tables.every((t) => { const r = findTags(t.children, (n) => n.role === 'TR').map((x) => x.children.filter((c) => c.role === 'TH' || c.role === 'TD').length); return r.every((v) => v === r[0]); }) ? 'passed' : 'failed');
  set('table-summary', !tables.length ? 'skipped' : tables.every((t) => t.alt) ? 'passed' : 'failed');
  const lis = all.filter((n) => n.role === 'LI');
  set('list-items', !lis.length && !all.some((n) => n.role === 'L') ? 'skipped' : lis.every((n) => parentOf.get(n)?.role === 'L') ? 'passed' : 'failed');
  const lbl = all.filter((n) => n.role === 'Lbl' || n.role === 'LBody');
  set('lbl-lbody', !lbl.length ? 'skipped' : lbl.every((n) => parentOf.get(n)?.role === 'LI') ? 'passed' : 'failed');
  const levels = all.filter((n) => HEADINGS.includes(n.role)).map((n) => +n.role.slice(1));
  let skip = false; let prev = 0;
  for (const l of levels) { if (l > prev + 1) skip = true; prev = l; }
  set('heading-nesting', !levels.length ? 'skipped' : skip ? 'failed' : 'passed');
  return RULES.map(([id, category, name, description, fix]) => ({ id, category, name, description, fix, ...(MANUAL.has(id) ? { status: 'manual', detail: '' } : res.get(id)) }));
}

/** Fixes what needs no decision: tab order on pages with annotations, title shown in the window. */
export function fixSimple(doc) {
  const ctx = doc.context;
  let n = 0;
  for (const p of doc.getPages()) {
    const a = look(ctx, p.node.get(N('Annots')));
    if (a instanceof PDFArray && a.size() && nameOf(look(ctx, p.node.get(N('Tabs')))) !== 'S') { p.node.set(N('Tabs'), N('S')); n++; }
  }
  let vp = look(ctx, doc.catalog.get(N('ViewerPreferences')));
  if (!(vp instanceof PDFDict)) { vp = ctx.obj({}); doc.catalog.set(N('ViewerPreferences'), vp); }
  vp.set(N('DisplayDocTitle'), PDFBool.True);
  return n;
}

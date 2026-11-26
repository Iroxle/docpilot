// Copying pages between documents without losing what points into them: the basis of Combine files,
// Insert pages from file, Extract, Split, Duplicate and Replace pages.
//
// A page is deep-copied with everything it references (content, resources, fonts, images, annotations).
// The copy never follows /Parent from a page, so the source page tree does not come along, and it rewires
// what points back into the document:
// - an annotation's /P points at its new page;
// - link and GoTo destinations that target a copied page point at the copy; links to pages that were not
//   copied are dropped, so they do not dangle; named destinations become explicit ones;
// - form fields keep their hierarchy and are registered in the destination's /AcroForm. When only some
//   pages are copied, a field brings only the kids that lead to a widget on those pages;
// - structure-tree links (/StructParent(s)) and article beads (/B) are removed;
// - layers (optional content groups) used by the pages are registered with their default on/off state.
// Combine also gives every file a bookmark holding its own bookmarks, carries attachments and page labels,
// and stores fonts and images that several files share only once.
//
// Ported from PdfCraft's organize crate (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors,
// MIT license, see THIRD_PARTY_NOTICES.md).
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFNumber,
  PDFNull, PDFPageLeaf, decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { tokenize } from './content.js';

const N = (s) => PDFName.of(s);
const K = {
  Type: N('Type'), Subtype: N('Subtype'), Rect: N('Rect'), Parent: N('Parent'), Kids: N('Kids'), FT: N('FT'), T: N('T'), S: N('S'),
  D: N('D'), Dest: N('Dest'), A: N('A'), P: N('P'), AA: N('AA'), Annots: N('Annots'), Resources: N('Resources'), Fields: N('Fields'),
  Flags: N('Flags'), Names: N('Names'), Dests: N('Dests'), Count: N('Count'), First: N('First'), Last: N('Last'), Next: N('Next'),
  Prev: N('Prev'), Title: N('Title'), C: N('C'), F: N('F'), Outlines: N('Outlines'), AcroForm: N('AcroForm'), DR: N('DR'), DA: N('DA'),
  Font: N('Font'), OCProperties: N('OCProperties'), OCGs: N('OCGs'), ON: N('ON'), OFF: N('OFF'), Order: N('Order'), BaseState: N('BaseState'),
  EmbeddedFiles: N('EmbeddedFiles'), PageLabels: N('PageLabels'), Nums: N('Nums'), St: N('St'), Pages: N('Pages'), Contents: N('Contents'),
  XObject: N('XObject'), Info: N('Info'), AP: N('AP'),
};
const SKIP_ON_PAGE = new Set(['Parent', 'B', 'StructParents', 'Thumb', 'PieceInfo'].map(N));
const SKIP_ON_ANNOT = new Set(['StructParent', 'P'].map(N));
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'].map(N);
const MAX_DEPTH = 256;
// Keys that stay on the widget when a widget that is its own field is split into field and widget.
const WIDGET_KEYS = new Set(['Type', 'Subtype', 'Rect', 'P', 'AP', 'AS', 'MK', 'BS', 'Border', 'C', 'CA', 'F', 'H', 'R', 'NM', 'M',
  'StructParent', 'StructParents', 'OC', 'Tabs', 'A', 'Contents', 'BM', 'Lang', 'AF'].map(N));
// Additional actions of a field (keystroke, format, validate, calculate); the others belong to the widget.
const FIELD_TRIGGERS = new Set(['K', 'F', 'V', 'C'].map(N));

const nameOf = (ctx, v) => { const o = v instanceof PDFRef ? ctx.lookup(v) : v; return o instanceof PDFName ? o.decodeText() : undefined; };
const resolve = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const textOf = (o) => (o instanceof PDFString || o instanceof PDFHexString || o instanceof PDFName ? o.decodeText() : null);
const arrayOf = (ctx, v) => { const a = resolve(ctx, v); return a instanceof PDFArray ? a : null; };
const dictOf = (ctx, v) => { const d = resolve(ctx, v); return d instanceof PDFDict ? d : null; };
const isContainer = (o) => o instanceof PDFRef || o instanceof PDFArray || o instanceof PDFDict || o instanceof PDFStream;

/** All (key, value) pairs of a name tree, each node read once. */
export function nameTreeEntries(ctx, node, out = [], depth = 0, seen = new Set()) {
  if (depth > 32 || !node) return out;
  if (node instanceof PDFRef) { if (seen.has(node.tag)) return out; seen.add(node.tag); }
  const d = dictOf(ctx, node);
  if (!d) return out;
  const names = arrayOf(ctx, d.get(K.Names));
  if (names) for (let i = 0; i + 1 < names.size(); i += 2) { const k = textOf(resolve(ctx, names.get(i))); if (k !== null) out.push([k, names.get(i + 1)]); }
  const kids = arrayOf(ctx, d.get(K.Kids));
  if (kids) for (let i = 0; i < kids.size(); i++) nameTreeEntries(ctx, kids.get(i), out, depth + 1, seen);
  return out;
}

/** A named destination of the source (/Dests dictionary or /Names /Dests tree). */
function namedDest(ctx, name) {
  const catalog = dictOf(ctx, ctx.trailerInfo.Root);
  if (!catalog) return undefined;
  const dests = dictOf(ctx, catalog.get(K.Dests));
  if (dests) for (const [k, v] of dests.entries()) if (k.decodeText() === name) return resolve(ctx, v);
  const names = dictOf(ctx, catalog.get(K.Names));
  const tree = names && names.get(K.Dests);
  if (!tree) return undefined;
  const hit = nameTreeEntries(ctx, tree).find(([k]) => k === name);
  return hit ? resolve(ctx, hit[1]) : undefined;
}

class Copier {
  constructor(src, dst, pages = new Map(), map = new Map()) {
    this.src = src; this.dst = dst;
    this.map = map; // source ref tag -> destination ref
    this.pages = pages; // source page ref tag -> destination page ref
    this.annots = []; this.fields = []; this.ocgs = [];
    this.kept = null; // Set of source ref tags: the annotations of the copied pages and the fields above them
    this.depth = 0;
  }

  copyRef(r) {
    const hit = this.map.get(r.tag);
    if (hit) return hit;
    // Reserve the number first, so cycles (field and widget) end.
    const nu = this.dst.nextRef();
    this.map.set(r.tag, nu);
    const obj = this.src.lookup(r);
    if (obj instanceof PDFDict && nameOf(this.src, obj.get(K.Type)) === 'OCG') this.ocgs.push([r, nu]);
    this.dst.assign(nu, obj === undefined ? PDFNull : this.copyValue(obj, nu));
    return nu;
  }

  copyValue(o, self = null) {
    if (!isContainer(o)) return o;
    if (this.actsOnNone(o)) return PDFNull;
    if (this.depth >= MAX_DEPTH) throw new Error(`The pages refer to objects nested more than ${MAX_DEPTH} levels deep.`);
    this.depth++;
    try {
      if (o instanceof PDFRef) return this.copyRef(o);
      if (o instanceof PDFArray) { const a = PDFArray.withContext(this.dst); for (let i = 0; i < o.size(); i++) a.push(this.copyValue(o.get(i))); return a; }
      if (o instanceof PDFDict) return this.copyDict(o, self);
      if (!(o instanceof PDFRawStream) && typeof o.updateDict === 'function') o.updateDict();
      return PDFRawStream.of(this.copyDict(o.dict, null), o instanceof PDFRawStream ? o.contents : o.getContents());
    } finally { this.depth--; }
  }

  copyDict(d, self) {
    const type = nameOf(this.src, d.get(K.Type));
    const isAnnot = type === 'Annot' || (d.has(K.Subtype) && d.has(K.Rect) && !d.has(K.Type));
    const isField = d.has(K.FT) || (d.has(K.T) && d.has(K.Kids));
    const s = nameOf(this.src, d.get(K.S));
    const listsFields = s === 'SubmitForm' || s === 'ResetForm' || s === 'Hide';
    const out = PDFDict.withContext(this.dst);
    for (const [k, v] of d.entries()) {
      if (isAnnot && SKIP_ON_ANNOT.has(k)) continue;
      // Destinations are rewritten afterwards (they may target pages copied later).
      if (isAnnot && (k === K.Dest || k === K.A)) { out.set(k, v); continue; }
      if (this.kept && isField && k === K.Kids) {
        const kids = arrayOf(this.src, v);
        const keep = PDFArray.withContext(this.src);
        if (kids) for (let i = 0; i < kids.size(); i++) { const kid = kids.get(i); if (!(kid instanceof PDFRef) || this.kept.has(kid.tag)) keep.push(kid); }
        out.set(k, this.copyValue(keep));
        continue;
      }
      // Of some of the pages, an action lists only the fields on them: one left behind would come along.
      if (this.kept && listsFields && (k === K.Fields || k === K.T)) {
        const listed = arrayOf(this.src, v);
        const entries = listed ? Array.from({ length: listed.size() }, (_, i) => listed.get(i)) : [v];
        const keep = PDFArray.withContext(this.src);
        for (const e of entries) if (!(e instanceof PDFRef) || this.kept.has(e.tag)) keep.push(e);
        out.set(k, this.copyValue(keep));
        continue;
      }
      out.set(k, this.copyValue(v));
    }
    if (self) {
      if (isAnnot) this.annots.push(self);
      // A field (or widget) without a parent is a top-level field.
      if (isField && !d.has(K.Parent)) this.fields.push(self);
    }
    return out;
  }

  /** A reset or submit action that names only fields left behind: its copy would act on every field. */
  actsOnNone(o) {
    if (!this.kept) return false;
    let a = null;
    if (o instanceof PDFRef && !this.map.has(o.tag)) a = dictOf(this.src, o);
    else if (o instanceof PDFDict) a = o;
    if (!a) return false;
    const s = nameOf(this.src, a.get(K.S));
    if (s !== 'ResetForm' && s !== 'SubmitForm') return false;
    const flags = resolve(this.src, a.get(K.Flags));
    if (flags instanceof PDFNumber && (flags.asNumber() & 1)) return false;
    const v = a.get(K.Fields);
    if (!v) return false;
    const listed = arrayOf(this.src, v);
    const entries = listed ? Array.from({ length: listed.size() }, (_, i) => listed.get(i)) : [v];
    return entries.length > 0 && entries.every((e) => e instanceof PDFRef && !this.kept.has(e.tag));
  }

  /** A source destination mapped to the destination document, or undefined when its page was not copied. */
  mapDest(dest, depth = 0) {
    if (depth > 4 || dest === undefined || dest === null) return undefined;
    if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) return this.mapDest(namedDest(this.src, dest.decodeText()), depth + 1);
    if (dest instanceof PDFRef) return this.mapDest(this.src.lookup(dest), depth + 1);
    if (dest instanceof PDFDict) return this.mapDest(dest.get(K.D), depth + 1);
    if (dest instanceof PDFArray) {
      const page = dest.get(0);
      if (!(page instanceof PDFRef)) return undefined;
      const nu = this.pages.get(page.tag);
      if (!nu) return undefined;
      const a = PDFArray.withContext(this.dst);
      a.push(nu);
      for (let i = 1; i < dest.size(); i++) { const x = resolve(this.src, dest.get(i)); a.push(isContainer(x) ? PDFNull : x); }
      return a;
    }
    return undefined;
  }

  /** Rewrites /P, /Dest and GoTo actions of the copied annotations. */
  fixAnnotations(annotPages) {
    const list = this.annots; this.annots = [];
    for (const a of list) {
      const d = this.dst.lookup(a);
      if (!(d instanceof PDFDict)) continue;
      const p = annotPages.get(a.tag);
      if (p) d.set(K.P, p);
      const dest = d.get(K.Dest);
      if (dest !== undefined) { const nd = this.mapDest(resolve(this.src, dest)); if (nd) d.set(K.Dest, nd); else d.delete(K.Dest); }
      const act = d.get(K.A);
      if (act === undefined) continue;
      const ad = dictOf(this.src, act);
      if (!ad) { d.delete(K.A); continue; }
      if (nameOf(this.src, ad.get(K.S)) === 'GoTo') {
        const nd = this.mapDest(resolve(this.src, ad.get(K.D)));
        if (nd) d.set(K.A, this.dst.obj({ S: 'GoTo', D: nd })); else d.delete(K.A);
      } else if (this.actsOnNone(act)) d.delete(K.A);
      else {
        // Other actions (web links, scripts...) carry no page references; the copies share one map.
        const c = new Copier(this.src, this.dst, new Map(), this.map);
        c.kept = this.kept;
        d.set(K.A, c.copyValue(ad));
      }
    }
  }
}

/** The annotations on the pages and, above each widget, its fields up to the top one. */
function fieldsOn(ctx, pageNodes) {
  const kept = new Set();
  for (const page of pageNodes) {
    const annots = arrayOf(ctx, page.get(K.Annots));
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.get(i);
      let at = a instanceof PDFRef ? a : dictOf(ctx, a)?.get(K.Parent);
      for (let k = 0; k < MAX_DEPTH && at instanceof PDFRef && !kept.has(at.tag); k++) {
        kept.add(at.tag);
        at = dictOf(ctx, at)?.get(K.Parent);
      }
    }
  }
  return kept;
}

/** A page's resources together with the names that only its page-tree ancestors list. */
function resourcesWithAncestors(ctx, page) {
  const own = page.get(K.Resources);
  let merged = own !== undefined ? (dictOf(ctx, own)?.clone(ctx) || null) : null;
  let added = false;
  const seen = new Set();
  let parent = page.get(K.Parent);
  while (parent instanceof PDFRef && !seen.has(parent.tag) && seen.size < 256) {
    seen.add(parent.tag);
    const node = dictOf(ctx, parent);
    if (!node) break;
    parent = node.get(K.Parent);
    const theirs = dictOf(ctx, node.get(K.Resources));
    if (!theirs) continue;
    if (!merged) { merged = theirs.clone(ctx); continue; }
    for (const [cat, entries] of theirs.entries()) {
      const mine = merged.get(cat);
      if (mine === undefined) { merged.set(cat, entries); added = true; continue; }
      const names = dictOf(ctx, mine); const more = dictOf(ctx, entries);
      if (!names || !more) continue;
      const copy = names.clone(ctx);
      let grew = false;
      for (const [n, v] of more.entries()) if (!copy.has(n)) { copy.set(n, v); grew = true; }
      if (grew) { merged.set(cat, copy); added = true; }
    }
  }
  return added ? merged : null;
}

function addKid(ctx, fieldRef, kid) {
  const field = dictOf(ctx, fieldRef);
  if (!field) return;
  const v = field.get(K.Kids);
  const kids = arrayOf(ctx, v);
  if (kids) kids.push(kid); else field.set(K.Kids, ctx.obj([kid]));
}

/** Splits a combined field/widget dictionary into the field part and the widget part. */
function fieldAndWidget(ctx, d) {
  const field = PDFDict.withContext(ctx); const widget = PDFDict.withContext(ctx);
  for (const [k, v] of d.entries()) {
    if (k === K.AA) {
      const aa = dictOf(ctx, v);
      if (!aa) continue;
      const fa = PDFDict.withContext(ctx); const wa = PDFDict.withContext(ctx);
      for (const [t, act] of aa.entries()) (FIELD_TRIGGERS.has(t) ? fa : wa).set(t, act);
      if (fa.entries().length) field.set(K.AA, fa);
      if (wa.entries().length) widget.set(K.AA, wa);
    } else if (WIDGET_KEYS.has(k)) widget.set(k, v);
    else field.set(k, v);
  }
  return [field, widget];
}

/** A widget that is its own field becomes a parent field with the widget as its kid. */
function splitOwnField(ctx, fields, widgetRef) {
  const d = dictOf(ctx, widgetRef);
  if (!d) return;
  const [field, widget] = fieldAndWidget(ctx, d);
  const parent = ctx.register(field);
  field.set(K.Kids, ctx.obj([widgetRef]));
  widget.set(K.Parent, parent);
  ctx.assign(widgetRef, widget);
  const i = fields.findIndex((f) => f.tag === widgetRef.tag);
  if (i >= 0) fields[i] = parent;
}

const qualified = (prefix, name) => (prefix ? `${prefix}.${name}` : name);

/** Every fully-qualified field name of a field tree. */
function collectNames(ctx, node, prefix, out, seen, depth = 0) {
  if (depth > 64 || !(node instanceof PDFRef) || seen.has(node.tag)) return;
  seen.add(node.tag);
  const d = dictOf(ctx, node);
  if (!d) return;
  const t = textOf(resolve(ctx, d.get(K.T)));
  const name = t !== null ? qualified(prefix, t) : prefix;
  if (t !== null) out.add(name);
  const kids = arrayOf(ctx, d.get(K.Kids));
  if (kids) for (let i = 0; i < kids.size(); i++) collectNames(ctx, kids.get(i), name, out, seen, depth + 1);
}

/** The top-level fields of a document: those its form lists, and those behind widgets on its pages. */
function fieldRoots(doc) {
  const ctx = doc.context; const roots = []; const seen = new Set();
  const add = (r) => { if (r instanceof PDFRef && !seen.has(r.tag)) { seen.add(r.tag); roots.push(r); } };
  const form = dictOf(ctx, doc.catalog.get(K.AcroForm));
  const list = form && arrayOf(ctx, form.get(K.Fields));
  if (list) for (let i = 0; i < list.size(); i++) add(list.get(i));
  for (const page of doc.getPages()) {
    const annots = arrayOf(ctx, page.node.get(K.Annots));
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      let r = annots.get(i);
      if (!(r instanceof PDFRef)) continue;
      const w = dictOf(ctx, r);
      if (!w || nameOf(ctx, w.get(K.Subtype)) !== 'Widget') continue;
      for (let k = 0; k < 64; k++) { const p = dictOf(ctx, r)?.get(K.Parent); if (!(p instanceof PDFRef)) break; r = p; }
      add(r);
    }
  }
  return roots;
}

/** The fully-qualified field names a document uses. */
export function fieldNames(doc) {
  const out = new Set(); const seen = new Set();
  for (const r of fieldRoots(doc)) collectNames(doc.context, r, '', out, seen);
  return out;
}

/**
 * Renames incoming top-level fields whose fully-qualified names are already taken, so each stays its own
 * field: a colliding node's own /T becomes the first free "Name-1", "Name-2"... Returns [old, new] pairs.
 */
function resolveFieldConflicts(ctx, fields, taken) {
  const own = new Set(); const seenOwn = new Set();
  for (const f of fields) collectNames(ctx, f, '', own, seenOwn);
  const renamed = []; const seen = new Set();
  const walk = (node, prefix, depth) => {
    if (depth > 64 || !(node instanceof PDFRef) || seen.has(node.tag)) return;
    seen.add(node.tag);
    const d = dictOf(ctx, node);
    if (!d) return;
    const t = textOf(resolve(ctx, d.get(K.T)));
    let name = prefix;
    if (t !== null) {
      name = qualified(prefix, t);
      if (taken.has(name)) {
        let n = 1; let candidate;
        do { candidate = qualified(prefix, `${t}-${n++}`); } while (taken.has(candidate) || own.has(candidate));
        d.set(K.T, PDFHexString.fromText(candidate.slice(prefix ? prefix.length + 1 : 0)));
        renamed.push([name, candidate]);
        name = candidate;
      }
      taken.add(name);
    }
    const kids = arrayOf(ctx, d.get(K.Kids));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), name, depth + 1);
  };
  for (const f of fields) walk(f, '', 0);
  return renamed;
}

/** Adds top-level fields to the destination's /AcroForm /Fields; the default resources and appearance come along. */
function registerFields(dstDoc, fields, srcDoc, copier) {
  if (!fields.length) return;
  const ctx = dstDoc.context;
  let form = dictOf(ctx, dstDoc.catalog.get(K.AcroForm));
  if (!form) { form = ctx.obj({ Fields: [] }); dstDoc.catalog.set(K.AcroForm, ctx.register(form)); }
  let list = arrayOf(ctx, form.get(K.Fields));
  if (!list) { list = ctx.obj([]); form.set(K.Fields, list); }
  const listed = new Set();
  for (let i = 0; i < list.size(); i++) { const r = list.get(i); if (r instanceof PDFRef) listed.add(r.tag); }
  for (const f of fields) if (!listed.has(f.tag)) { listed.add(f.tag); list.push(f); }
  // Fonts named in the fields' default appearance live in the form's default resources.
  const srcForm = dictOf(srcDoc.context, srcDoc.catalog.get(K.AcroForm));
  if (!srcForm) return;
  if (!form.has(K.DA) && srcForm.get(K.DA)) form.set(K.DA, resolve(srcDoc.context, srcForm.get(K.DA)));
  const srcFonts = dictOf(srcDoc.context, dictOf(srcDoc.context, srcForm.get(K.DR))?.get(K.Font));
  if (!srcFonts) return;
  let dr = dictOf(ctx, form.get(K.DR));
  if (!dr) { dr = ctx.obj({}); form.set(K.DR, dr); }
  let fonts = dictOf(ctx, dr.get(K.Font));
  if (!fonts) { fonts = ctx.obj({}); dr.set(K.Font, fonts); }
  for (const [name, f] of srcFonts.entries()) if (!fonts.has(name)) fonts.set(name, copier.copyValue(f));
}

/** Registers copied layers in the destination's /OCProperties, keeping each layer's default visibility. */
function registerLayers(dstDoc, srcDoc, ocgs) {
  if (!ocgs.length) return;
  const sctx = srcDoc.context; const ctx = dstDoc.context;
  const srcConfig = dictOf(sctx, dictOf(sctx, srcDoc.catalog.get(K.OCProperties))?.get(N('D')));
  const tags = (a) => { const out = new Set(); if (a) for (let i = 0; i < a.size(); i++) { const r = a.get(i); if (r instanceof PDFRef) out.add(r.tag); } return out; };
  const srcOn = tags(srcConfig && arrayOf(sctx, srcConfig.get(K.ON)));
  const srcOff = tags(srcConfig && arrayOf(sctx, srcConfig.get(K.OFF)));
  const baseOff = srcConfig && nameOf(sctx, srcConfig.get(K.BaseState)) === 'OFF';
  const hidden = (r) => srcOff.has(r.tag) || (baseOff && !srcOn.has(r.tag));
  let props = dictOf(ctx, dstDoc.catalog.get(K.OCProperties));
  if (!props) { props = ctx.obj({}); dstDoc.catalog.set(K.OCProperties, props); }
  const list = (d, k) => { let a = arrayOf(ctx, d.get(k)); if (!a) { a = ctx.obj([]); d.set(k, a); } return a; };
  const all = list(props, K.OCGs);
  let config = dictOf(ctx, props.get(N('D')));
  if (!config) { config = ctx.obj({}); props.set(N('D'), config); }
  const on = list(config, K.ON); const off = list(config, K.OFF); const order = list(config, K.Order);
  const have = tags(all);
  for (const [from, to] of ocgs) {
    if (have.has(to.tag)) continue;
    have.add(to.tag);
    all.push(to); order.push(to);
    (hidden(from) ? off : on).push(to);
  }
}

/** The pages of a document in order, as references. */
const pageRefs = (doc) => doc.getPages().map((p) => p.ref);

/** Rebuilds the page tree flat with the pages in this order; inheritable attributes move onto the pages. */
export function rebuildPageTree(doc, refs) {
  const ctx = doc.context;
  const rootRef = doc.catalog.get(K.Pages);
  const root = ctx.lookup(rootRef, PDFDict);
  for (const r of refs) {
    const leaf = ctx.lookup(r);
    if (!(leaf instanceof PDFDict)) continue;
    for (const k of INHERITABLE) {
      if (leaf.has(k)) continue;
      const v = typeof leaf.getInheritableAttribute === 'function' ? leaf.getInheritableAttribute(k) : undefined;
      if (v !== undefined) leaf.set(k, v);
    }
    leaf.set(K.Parent, rootRef);
  }
  root.set(K.Kids, ctx.obj(refs));
  root.set(K.Count, PDFNumber.of(refs.length));
  for (const k of INHERITABLE) root.delete(k);
  root.delete(K.Parent);
  doc.pageCache.invalidate();
  doc.pageCount = undefined;
}

/**
 * Copies pages srcPages (0-based, in this order) of srcDoc into dstDoc at position at.
 * conflicts: 'rename' keeps incoming fields separate from same-named ones (Combine, Insert from file),
 * 'merge' lets them become one field (Duplicate, Replace, Extract, Split).
 * Returns the new page references, source page tag -> new page, and the renamed fields.
 */
export function importPages(dstDoc, srcDoc, srcPages, at, conflicts = 'merge', o = {}) {
  const src = srcDoc.context; const dst = dstDoc.context;
  const source = srcDoc.getPages();
  const bad = srcPages.find((i) => !(i >= 0 && i < source.length));
  if (bad !== undefined) throw new Error(`Page ${bad + 1} does not exist.`);
  const existing = pageRefs(dstDoc);
  const taken = conflicts === 'rename' ? fieldNames(dstDoc) : null;
  const copier = new Copier(src, dst);
  // Allocate every destination page first, so destinations between copied pages resolve.
  const targets = srcPages.map((i) => {
    const page = source[i];
    let nu = copier.pages.get(page.ref.tag);
    if (!nu) { nu = dst.nextRef(); copier.pages.set(page.ref.tag, nu); }
    return { page, nu };
  });
  // A copy within the same document (srcDoc parsed from the same bytes): links to the other pages point at them.
  if (o.samePages) for (const p of source) if (!copier.pages.has(p.ref.tag)) copier.pages.set(p.ref.tag, p.ref);
  if (new Set(srcPages).size < source.length) copier.kept = fieldsOn(src, targets.map((t) => t.page.node));
  const annotPages = new Map(); const newPages = []; const done = new Set();
  for (const { page, nu: first } of targets) {
    // A page listed twice: a second page object with copies of its own annotations; its widgets become
    // more widgets of the fields copied with the first copy (one field, one value, shown on both pages).
    const repeat = done.has(page.ref.tag);
    const nu = repeat ? dst.nextRef() : first;
    const own = repeat ? Object.assign(new Copier(src, dst, new Map(copier.pages)), { kept: copier.kept }) : null;
    const srcDict = page.node;
    const resources = resourcesWithAncestors(src, srcDict);
    const leaf = PDFPageLeaf.fromMapWithContext(new Map(), dst);
    for (const [k, v] of srcDict.entries()) {
      if (SKIP_ON_PAGE.has(k) || (k === K.Resources && resources)) continue;
      if (k !== K.Annots) { leaf.set(k, copier.copyValue(v)); continue; }
      const list = arrayOf(src, v);
      const out = PDFArray.withContext(dst);
      if (list) for (let i = 0; i < list.size(); i++) {
        const a = list.get(i);
        const resolved = resolve(src, a);
        if (!(resolved instanceof PDFDict)) continue;
        const widget = nameOf(src, resolved.get(K.Subtype)) === 'Widget';
        const field = widget ? resolved.get(K.Parent) : undefined;
        if (repeat && field instanceof PDFRef && copier.map.has(field.tag)) {
          const r = dst.nextRef();
          dst.assign(r, copier.copyValue(resolved, r));
          addKid(dst, copier.map.get(field.tag), r);
          annotPages.set(r.tag, nu); out.push(r);
          continue;
        }
        const ownField = widget && !resolved.has(K.Parent);
        if (repeat && ownField && a instanceof PDFRef && copier.map.has(a.tag)) {
          const parent = dictOf(dst, copier.map.get(a.tag))?.get(K.Parent);
          if (parent instanceof PDFRef) {
            const r = dst.nextRef();
            const [, w] = fieldAndWidget(dst, copier.copyValue(resolved, r));
            w.set(K.Parent, parent);
            copier.fields = copier.fields.filter((f) => f.tag !== r.tag);
            dst.assign(r, w);
            addKid(dst, parent, r);
            annotPages.set(r.tag, nu); out.push(r);
            continue;
          }
        }
        const c = ownField ? copier : (own || copier);
        let r;
        if (a instanceof PDFRef) r = c.copyRef(a);
        else { r = dst.nextRef(); dst.assign(r, c.copyValue(resolved, r)); }
        if (ownField && copier.fields.some((f) => f.tag === r.tag)) splitOwnField(dst, copier.fields, r);
        annotPages.set(r.tag, nu); out.push(r);
      }
      leaf.set(k, out);
    }
    if (resources) leaf.set(K.Resources, copier.copyValue(resources));
    for (const k of INHERITABLE) {
      if (leaf.has(k)) continue;
      const v = srcDict.getInheritableAttribute(k);
      if (v !== undefined) leaf.set(k, copier.copyValue(v));
    }
    leaf.set(K.Type, N('Page'));
    dst.assign(nu, leaf);
    if (own) { copier.annots.push(...own.annots); copier.fields.push(...own.fields); copier.ocgs.push(...own.ocgs); }
    done.add(page.ref.tag);
    newPages.push(nu);
  }
  copier.fixAnnotations(annotPages);
  const renamed = taken ? resolveFieldConflicts(dst, copier.fields, taken) : [];
  registerFields(dstDoc, copier.fields, srcDoc, copier);
  registerLayers(dstDoc, srcDoc, copier.ocgs);
  const pos = Math.max(0, Math.min(at, existing.length));
  rebuildPageTree(dstDoc, [...existing.slice(0, pos), ...newPages, ...existing.slice(pos)]);
  return { pages: newPages, pageMap: copier.pages, objects: copier.map, renamed };
}

// --- Bookmarks ------------------------------------------------------------------------------------

/** The bookmarks of src with destinations mapped through pageMap (source page tag -> copied page). */
function sourceOutline(srcDoc, pageMap) {
  const ctx = srcDoc.context;
  const outlines = dictOf(ctx, srcDoc.catalog.get(K.Outlines));
  const mapper = new Copier(ctx, null, pageMap);
  mapper.mapDest = function mapDest(dest, depth = 0) {
    if (depth > 4 || dest === undefined || dest === null) return undefined;
    if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) return this.mapDest(namedDest(ctx, dest.decodeText()), depth + 1);
    if (dest instanceof PDFRef) return this.mapDest(ctx.lookup(dest), depth + 1);
    if (dest instanceof PDFDict) return this.mapDest(dest.get(K.D), depth + 1);
    if (dest instanceof PDFArray) {
      const page = dest.get(0);
      const nu = page instanceof PDFRef ? pageMap.get(page.tag) : undefined;
      if (!nu) return undefined;
      const rest = [];
      for (let i = 1; i < dest.size(); i++) { const x = resolve(ctx, dest.get(i)); rest.push(isContainer(x) ? PDFNull : x); }
      return { page: nu, rest };
    }
    return undefined;
  };
  let budget = 10000;
  const level = (first, depth) => {
    const made = [];
    if (depth > 32) return made;
    const seen = new Set();
    let cur = first;
    while (cur instanceof PDFRef && !seen.has(cur.tag) && budget-- > 0) {
      seen.add(cur.tag);
      const item = dictOf(ctx, cur);
      if (!item) break;
      cur = item.get(K.Next);
      let target = item.get(K.Dest);
      if (target === undefined) {
        const a = dictOf(ctx, item.get(K.A));
        if (a && nameOf(ctx, a.get(K.S)) === 'GoTo') target = a.get(K.D);
      }
      const count = resolve(ctx, item.get(K.Count));
      made.push({
        title: resolve(ctx, item.get(K.Title)), color: resolve(ctx, item.get(K.C)), flags: resolve(ctx, item.get(K.F)),
        dest: target !== undefined ? mapper.mapDest(resolve(ctx, target)) : undefined,
        open: count instanceof PDFNumber && count.asNumber() > 0,
        children: level(item.get(K.First), depth + 1),
      });
    }
    return made;
  };
  return outlines ? level(outlines.get(K.First), 0) : [];
}

/** Bookmarks without those whose page was not copied, unless a bookmark below them stays. */
const keptBookmarks = (nodes) => nodes.map((n) => ({ ...n, children: keptBookmarks(n.children) })).filter((n) => n.dest || n.children.length);

function writeOutlineLevel(doc, parent, nodes) {
  const ctx = doc.context; const made = [];
  for (const node of nodes) {
    const ref = ctx.nextRef();
    const d = ctx.obj({});
    if (node.title instanceof PDFString || node.title instanceof PDFHexString) d.set(K.Title, node.title);
    else if (typeof node.title === 'string') d.set(K.Title, PDFHexString.fromText(node.title));
    if (node.color instanceof PDFArray) d.set(K.C, ctx.obj(Array.from({ length: node.color.size() }, (_, i) => node.color.get(i))));
    if (node.flags instanceof PDFNumber) d.set(K.F, node.flags);
    if (node.dest) d.set(K.Dest, ctx.obj([node.dest.page, ...(node.dest.rest.length ? node.dest.rest : [N('Fit')])]));
    d.set(K.Parent, parent);
    if (made.length) { d.set(K.Prev, made[made.length - 1]); ctx.lookup(made[made.length - 1], PDFDict).set(K.Next, ref); }
    ctx.assign(ref, d);
    const kids = writeOutlineLevel(doc, ref, node.children);
    if (kids) {
      d.set(K.First, kids.first); d.set(K.Last, kids.last);
      d.set(K.Count, PDFNumber.of(node.open ? kids.count : -kids.count));
    }
    made.push(ref);
  }
  return made.length ? { first: made[0], last: made[made.length - 1], count: made.length } : null;
}

function outlineRoot(doc) {
  const ctx = doc.context;
  let root = dictOf(ctx, doc.catalog.get(K.Outlines));
  if (!root) { root = ctx.obj({ Type: 'Outlines' }); doc.catalog.set(K.Outlines, ctx.register(root)); }
  return { ref: doc.catalog.get(K.Outlines), dict: root };
}

function outlineChildren(doc, root) {
  const ctx = doc.context; const out = []; const seen = new Set();
  let cur = root.get(K.First);
  while (cur instanceof PDFRef && !seen.has(cur.tag) && out.length < 100000) { seen.add(cur.tag); out.push(cur); cur = dictOf(ctx, cur)?.get(K.Next); }
  return out;
}

/** Links the top-level items of the outline in this order and sets the count. */
function relink(doc, root, items) {
  const ctx = doc.context;
  items.forEach((r, i) => {
    const d = ctx.lookup(r, PDFDict);
    d.set(K.Parent, root.ref);
    if (i > 0) d.set(K.Prev, items[i - 1]); else d.delete(K.Prev);
    if (i + 1 < items.length) d.set(K.Next, items[i + 1]); else d.delete(K.Next);
  });
  if (items.length) { root.dict.set(K.First, items[0]); root.dict.set(K.Last, items[items.length - 1]); root.dict.set(K.Count, PDFNumber.of(items.length)); }
  else { root.dict.delete(K.First); root.dict.delete(K.Last); root.dict.delete(K.Count); }
}

/** A collapsed bookmark titled after a file, pointing at its first page, with the file's own bookmarks below it. */
function fileBookmark(doc, parentRef, mark) {
  const ctx = doc.context;
  const ref = ctx.nextRef();
  const d = ctx.obj({ Title: PDFHexString.fromText(mark.title), Parent: parentRef, Dest: [mark.page, 'Fit'] });
  ctx.assign(ref, d);
  const kids = writeOutlineLevel(doc, ref, mark.outline);
  if (kids) { d.set(K.First, kids.first); d.set(K.Last, kids.last); d.set(K.Count, PDFNumber.of(-kids.count)); }
  return ref;
}

/** The page index a top-level bookmark points at, or -1. */
function bookmarkPage(doc, ref, index) {
  const ctx = doc.context;
  const d = dictOf(ctx, ref);
  if (!d) return -1;
  let t = d.get(K.Dest);
  if (t === undefined) { const a = dictOf(ctx, d.get(K.A)); if (a && nameOf(ctx, a.get(K.S)) === 'GoTo') t = a.get(K.D); }
  for (let k = 0; k < 4 && t !== undefined; k++) {
    t = resolve(ctx, t);
    if (t instanceof PDFName || t instanceof PDFString || t instanceof PDFHexString) t = namedDest(ctx, t.decodeText());
    else if (t instanceof PDFDict) t = t.get(K.D);
    else if (t instanceof PDFArray) { const p = t.get(0); return p instanceof PDFRef ? (index.get(p.tag) ?? -1) : -1; }
    else return -1;
  }
  return -1;
}

// --- Attachments ----------------------------------------------------------------------------------

function collectAttachments(dstDoc, srcDoc, out) {
  const ctx = srcDoc.context;
  const names = dictOf(ctx, srcDoc.catalog.get(K.Names));
  const tree = names && names.get(K.EmbeddedFiles);
  if (!tree) return;
  const copier = new Copier(ctx, dstDoc.context);
  for (const [k, v] of nameTreeEntries(ctx, tree)) out.push([k, copier.copyValue(v)]);
}

/** Writes attachments as a flat, sorted name tree; duplicate names get " (2)", " (3)"... */
function setAttachments(doc, entries) {
  if (!entries.length) return;
  const reserved = new Set(entries.map(([k]) => k)); const seen = new Set();
  const named = entries.map(([k, v]) => {
    let text = k; let n = 2;
    if (seen.has(text)) do { text = `${k} (${n++})`; } while (reserved.has(text) || seen.has(text));
    seen.add(text);
    return [text, v];
  }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ctx = doc.context;
  const tree = ctx.register(ctx.obj({ Names: named.flatMap(([k, v]) => [PDFHexString.fromText(k), v]) }));
  let names = dictOf(ctx, doc.catalog.get(K.Names));
  if (!names) { names = ctx.obj({}); doc.catalog.set(K.Names, names); }
  names.set(K.EmbeddedFiles, tree);
}

// --- Page labels ----------------------------------------------------------------------------------

/** The label ranges of a document: [{start, style, prefix, first}], or [] without labels. */
export function readLabelRanges(doc) {
  const ctx = doc.context;
  const tree = dictOf(ctx, doc.catalog.get(K.PageLabels));
  if (!tree) return [];
  const out = []; const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 32) return;
    if (node instanceof PDFRef) { if (seen.has(node.tag)) return; seen.add(node.tag); }
    const d = dictOf(ctx, node);
    if (!d) return;
    const nums = arrayOf(ctx, d.get(K.Nums));
    if (nums) for (let i = 0; i + 1 < nums.size(); i += 2) {
      const start = resolve(ctx, nums.get(i)); const label = dictOf(ctx, nums.get(i + 1));
      if (!(start instanceof PDFNumber) || !label) continue;
      const st = resolve(ctx, label.get(K.St));
      out.push({ start: start.asNumber(), style: nameOf(ctx, label.get(K.S)) || null, prefix: textOf(resolve(ctx, label.get(K.P))) || '', first: st instanceof PDFNumber ? st.asNumber() : 1 });
    }
    const kids = arrayOf(ctx, d.get(K.Kids));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
  };
  walk(tree, 0);
  return out.sort((a, b) => a.start - b.start);
}

/** How page i of a document with these ranges is labelled: {style, prefix, num}. */
function labelOf(ranges, i) {
  let r = null;
  for (const x of ranges) if (x.start <= i) r = x;
  // Without a range (or before the first one) a page shows its physical number, as does an empty prefix-only range.
  if (!r || (!r.style && !r.prefix)) return { style: 'D', prefix: '', num: i + 1 };
  return { style: r.style, prefix: r.prefix, num: r.first + (i - r.start) };
}

/** Writes per-page labels ([{style, prefix, num}] in page order) as ranges. */
function writeLabels(doc, labels) {
  const ctx = doc.context; const nums = [];
  let prev = null;
  labels.forEach((l, i) => {
    const continues = prev && prev.style === l.style && prev.prefix === l.prefix && (l.style ? l.num === prev.num + 1 : true);
    if (!continues) {
      const d = ctx.obj({});
      if (l.style) d.set(K.S, N(l.style));
      if (l.prefix) d.set(K.P, PDFHexString.fromText(l.prefix));
      if (l.style && l.num !== 1) d.set(K.St, PDFNumber.of(l.num));
      nums.push(PDFNumber.of(i), d);
    }
    prev = l;
  });
  doc.catalog.set(K.PageLabels, ctx.obj({ Nums: nums }));
}

// --- Shared resources, unused images, garbage ------------------------------------------------------

const RESOURCE_TYPES = new Set(['Font', 'FontDescriptor', 'ExtGState', 'Pattern', 'Encoding', 'CMap', 'Halftone']);
const COLOR_SPACES = new Set(['ICCBased', 'Indexed', 'Separation', 'DeviceN', 'CalRGB', 'CalGray', 'Lab', 'Pattern']);

function isResource(ctx, o) {
  if (o instanceof PDFStream) { const t = nameOf(ctx, o.dict.get(K.Type)); return t !== 'XRef' && t !== 'ObjStm'; }
  if (o instanceof PDFDict) {
    if (o.has(K.Rect) || o.has(N('Popup')) || o.has(N('IRT')) || o.has(K.FT) || o.has(K.Parent)) return false;
    const t = nameOf(ctx, o.get(K.Type));
    return (t !== undefined && RESOURCE_TYPES.has(t)) || o.has(N('ShadingType')) || o.has(N('FunctionType'));
  }
  if (o instanceof PDFArray) { const f = o.get(0); return f instanceof PDFName && COLOR_SPACES.has(f.decodeText()); }
  return false;
}

function hashBytes(b) {
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 16777619); h2 = Math.imul(h2 + b[i], 2246822507) ^ (h2 >>> 13); }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}:${b.length}`;
}
const keyOf = (o) => (o instanceof PDFStream ? `S${o.dict.toString()}|${hashBytes(o instanceof PDFRawStream ? o.contents : o.getContents())}` : `O${o.toString()}`);

/** Replaces references to the keys of replace (tag -> ref) everywhere and deletes the replaced objects. */
function rewriteRefs(ctx, replace) {
  const fix = (v) => (v instanceof PDFRef && replace.has(v.tag) ? replace.get(v.tag) : v);
  const visit = (o) => {
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i); const w = fix(v); if (w !== v) o.set(i, w); else visit(v); } }
    else if (o instanceof PDFDict) { for (const [k, v] of o.entries()) { const w = fix(v); if (w !== v) o.set(k, w); else visit(v); } }
    else if (o instanceof PDFStream) visit(o.dict);
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) if (!replace.has(ref.tag)) visit(obj);
  for (const k of ['Root', 'Info']) { const v = ctx.trailerInfo[k]; if (v instanceof PDFRef && replace.has(v.tag)) ctx.trailerInfo[k] = replace.get(v.tag); }
  for (const [tag, to] of replace) { const [num, gen] = tag.split(' ').map(Number); if (num !== to.objectNumber) ctx.delete(PDFRef.of(num, gen)); }
}

/** The references of page content streams: never merged, because editing a page may change them in place. */
function contentRefs(doc) {
  const ctx = doc.context; const out = new Set();
  for (const page of doc.getPages()) {
    const c = page.node.get(K.Contents);
    if (c instanceof PDFRef) out.add(c.tag);
    const a = arrayOf(ctx, c);
    if (a) for (let i = 0; i < a.size(); i++) { const r = a.get(i); if (r instanceof PDFRef) out.add(r.tag); }
  }
  return out;
}

/**
 * Merges resources that are byte for byte the same (fonts, images, colour profiles...) into one object, up to
 * a fixpoint (a font merges once its font file has). Only candidates (tags of objects an operation created)
 * are replaced; existing objects serve as the merge target and stay as they are.
 */
export function dedupeResources(doc, candidates = null) {
  const ctx = doc.context;
  const skip = contentRefs(doc);
  for (let round = 0; round < 8; round++) {
    const canon = new Map(); const replace = new Map();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (skip.has(ref.tag) || !isResource(ctx, obj)) continue;
      const key = keyOf(obj);
      const first = canon.get(key);
      if (!first) { canon.set(key, ref); continue; }
      if (!candidates || candidates.has(ref.tag)) replace.set(ref.tag, first);
      else if (candidates.has(first.tag)) { replace.set(first.tag, ref); canon.set(key, ref); }
    }
    if (!replace.size) break;
    rewriteRefs(ctx, replace);
    if (candidates) for (const tag of replace.keys()) candidates.delete(tag);
  }
}

const streamData = (s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getUnencodedContents?.() || s.getContents());

/**
 * The names drawn with Do from the XObject dictionary xo by content (a stream, an array of streams or bytes),
 * through the forms it draws that have no resources of their own (they draw from the same dictionary).
 * null when some content cannot be read.
 */
function drawnNames(ctx, contents, xo, names = new Set(), seen = new Set(), depth = 0) {
  const parts = [];
  if (contents instanceof Uint8Array) parts.push(contents);
  else {
    const c = resolve(ctx, contents);
    const list = c instanceof PDFArray ? c.asArray().map((x) => resolve(ctx, x)) : [c];
    for (const s of list) if (s instanceof PDFStream) { try { parts.push(streamData(s)); } catch { return null; } }
  }
  for (const bytes of parts) {
    let ops;
    try { ops = tokenize(bytes); } catch { return null; }
    for (const o of ops) {
      if (o.op !== 'Do' || o.args[0]?.t !== 'name') continue;
      const name = o.args[0].v;
      names.add(name);
      const ref = xo.get(N(name)); const f = resolve(ctx, ref);
      if (!(f instanceof PDFStream) || nameOf(ctx, f.dict.get(N('Subtype'))) !== 'Form' || f.dict.has(K.Resources)) continue;
      const key = ref instanceof PDFRef ? ref.tag : f;
      if (seen.has(key) || depth > 32) continue;
      seen.add(key);
      let b; try { b = streamData(f); } catch { return null; }
      if (!drawnNames(ctx, b, xo, names, seen, depth + 1)) return null;
    }
  }
  return names;
}

/** Drops page-resource images and forms that no page of the document draws (pages share their source's resources). */
export function pruneUnusedXObjects(doc) {
  const ctx = doc.context;
  // XObject dictionaries that something other than pages draws with (a form's, a pattern's or a comment's own resources) stay.
  const others = new Set();
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const res = o instanceof PDFStream ? dictOf(ctx, o.dict.get(K.Resources)) : null;
    const xo = res && dictOf(ctx, res.get(K.XObject));
    if (xo) others.add(xo);
  }
  const users = new Map(); // XObject dict -> Set of drawn names, or null when unknown
  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    const xo = res && dictOf(ctx, res.get(K.XObject));
    if (!xo || others.has(xo)) continue;
    const before = users.has(xo) ? users.get(xo) : new Set();
    if (before === null) continue;
    users.set(xo, drawnNames(ctx, page.node.get(K.Contents), xo, before));
  }
  let removed = 0;
  for (const [xo, names] of users) {
    if (!names) continue;
    for (const [k] of xo.entries()) if (!names.has(k.decodeText())) { xo.delete(k); removed++; }
  }
  return removed;
}

/** Removes objects that are no longer referenced. */
export function collectGarbage(doc) {
  const ctx = doc.context; const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o instanceof PDFRef) { if (seen.has(o.tag)) continue; seen.add(o.tag); stack.push(ctx.lookup(o)); continue; }
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) stack.push(o.get(i)); continue; }
    if (o instanceof PDFDict) { for (const [, v] of o.entries()) stack.push(v); continue; }
    if (o instanceof PDFStream) stack.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

const tagsOf = (doc) => new Set(doc.context.enumerateIndirectObjects().map(([r]) => r.tag));
const created = (doc, before) => new Set([...tagsOf(doc)].filter((t) => !before.has(t)));

// --- The operations -------------------------------------------------------------------------------

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator'];

/**
 * Combines documents into a new one. sources: [{title, doc, pages?}] (pages: 0-based, in this order; all if
 * omitted). Each file gets a top-level bookmark at its first page holding its own bookmarks (collapsed), form
 * fields with names already taken are renamed, attachments of files used whole come along, page labels are
 * kept, and resources shared by the files are stored once. Returns {doc, renamed}.
 */
export async function combine(sources) {
  const out = await PDFDocument.create({ updateMetadata: false });
  const marks = []; const attachments = []; const labels = []; let hasLabels = false; const renamed = [];
  for (const s of sources) {
    const n = s.doc.getPageCount();
    const pages = s.pages || Array.from({ length: n }, (_, i) => i);
    if (!pages.length) continue;
    const ranges = readLabelRanges(s.doc);
    if (ranges.length) hasLabels = true;
    for (const p of pages) labels.push(labelOf(ranges, p));
    const r = importPages(out, s.doc, pages, out.getPageCount(), 'rename');
    renamed.push(...r.renamed);
    marks.push({ title: s.title, page: r.pages[0], outline: sourceOutline(s.doc, r.pageMap) });
    if (new Set(pages).size === n) collectAttachments(out, s.doc, attachments);
  }
  dedupeResources(out);
  if (hasLabels) writeLabels(out, labels);
  if (marks.length) {
    const root = outlineRoot(out);
    relink(out, root, marks.map((m) => fileBookmark(out, root.ref, m)));
  }
  setAttachments(out, attachments);
  return { doc: out, renamed };
}

/** A new document with copies of pages of src (Extract pages, Split): bookmarks, labels and information come along. */
export async function extract(src, pages) {
  const out = await PDFDocument.create({ updateMetadata: false });
  const ranges = readLabelRanges(src);
  const r = importPages(out, src, pages, 0, 'merge');
  if (ranges.length) writeLabels(out, pages.map((p) => labelOf(ranges, p)));
  const outline = keptBookmarks(sourceOutline(src, r.pageMap));
  if (outline.length) {
    const root = outlineRoot(out);
    const kids = writeOutlineLevel(out, root.ref, outline);
    if (kids) { root.dict.set(K.First, kids.first); relink(out, root, outlineChildren(out, root.dict)); }
  }
  const info = dictOf(src.context, src.context.trailerInfo.Info);
  if (info) {
    const target = out.getInfoDict();
    for (const k of INFO_KEYS) { const v = resolve(src.context, info.get(N(k))); if (v instanceof PDFString || v instanceof PDFHexString) target.set(N(k), v); }
  }
  pruneUnusedXObjects(out);
  collectGarbage(out);
  return out;
}

/**
 * Insert pages from file: the pages of src at position at of dst, renaming fields whose names are taken; the
 * inserted file's bookmarks come along under one bookmark titled after the file. Returns {pages, renamed}.
 */
export function insertFile(dst, src, title, pages, at) {
  const before = tagsOf(dst);
  const r = importPages(dst, src, pages, at, 'rename');
  dedupeResources(dst, created(dst, before));
  const outline = sourceOutline(src, r.pageMap);
  if (outline.length && r.pages.length) {
    const root = outlineRoot(dst);
    const order = new Map(pageRefs(dst).map((p, i) => [p.tag, i]));
    const after = (order.get(r.pages[r.pages.length - 1].tag) ?? 0) + 1;
    const top = outlineChildren(dst, root.dict);
    const index = top.findIndex((b) => bookmarkPage(dst, b, order) >= after);
    const mark = fileBookmark(dst, root.ref, { title, page: r.pages[0], outline });
    top.splice(index < 0 ? top.length : index, 0, mark);
    relink(dst, root, top);
  }
  return r;
}

function removeKid(ctx, fieldRef, kid) {
  const kids = arrayOf(ctx, dictOf(ctx, fieldRef)?.get(K.Kids));
  if (!kids) return;
  for (let i = kids.size() - 1; i >= 0; i--) { const k = kids.get(i); if (k instanceof PDFRef && k.tag === kid.tag) kids.remove(i); }
}

/** Puts field nu where old was: among its parent's /Kids, or among the form's top-level fields. */
function replaceKid(ctx, fields, old, nu) {
  const parent = dictOf(ctx, nu)?.get(K.Parent);
  const list = parent instanceof PDFRef ? arrayOf(ctx, dictOf(ctx, parent)?.get(K.Kids)) : fields;
  if (list) for (let i = 0; i < list.size(); i++) { const k = list.get(i); if (k instanceof PDFRef && k.tag === old.tag) list.set(i, nu); }
}

/** The fully-qualified name of a field node and its top-level field. */
function nameAndTop(ctx, node) {
  const parts = []; const seen = new Set();
  let at = node;
  for (let i = 0; i < 32 && at instanceof PDFRef && !seen.has(at.tag); i++) {
    seen.add(at.tag);
    const d = dictOf(ctx, at);
    if (!d) return null;
    const t = textOf(resolve(ctx, d.get(K.T)));
    if (t !== null) parts.push(t);
    const parent = d.get(K.Parent);
    if (!(parent instanceof PDFRef)) return { name: parts.reverse().join('.'), top: at };
    at = parent;
  }
  return null;
}

/**
 * Makes the widgets on a page copied from the same document more widgets of the fields they were copied from,
 * so each field stays one field with one value shown on every page. A copied field is matched to the field of
 * the same fully-qualified name among the fields the form listed before the copy; the matched copies leave the form.
 */
function shareFieldsWithOriginals(doc, pageRef, before) {
  const ctx = doc.context;
  const list = arrayOf(ctx, dictOf(ctx, doc.catalog.get(K.AcroForm))?.get(K.Fields));
  if (!list) return;
  const originals = new Map(); const seen = new Set();
  const pending = [];
  for (let i = 0; i < list.size(); i++) { const r = list.get(i); if (r instanceof PDFRef && before.has(r.tag)) pending.push([r, '', 0]); }
  while (pending.length) {
    const [node, prefix, depth] = pending.pop();
    if (depth > 32 || seen.has(node.tag)) continue;
    seen.add(node.tag);
    const d = dictOf(ctx, node);
    if (!d) continue;
    const t = textOf(resolve(ctx, d.get(K.T)));
    const name = t !== null ? qualified(prefix, t) : prefix;
    if (t !== null && !originals.has(name)) originals.set(name, node);
    const kids = arrayOf(ctx, d.get(K.Kids));
    if (kids) for (let i = 0; i < kids.size(); i++) { const k = kids.get(i); if (k instanceof PDFRef) pending.push([k, name, depth + 1]); }
  }
  const annots = arrayOf(ctx, dictOf(ctx, pageRef)?.get(K.Annots));
  const shared = new Set(); const kept = new Set();
  if (annots) for (let i = 0; i < annots.size(); i++) {
    const widget = annots.get(i);
    const d = widget instanceof PDFRef ? dictOf(ctx, widget) : null;
    if (!d || nameOf(ctx, d.get(K.Subtype)) !== 'Widget') continue;
    const nt = nameAndTop(ctx, d.has(K.T) ? widget : d.get(K.Parent));
    if (!nt) continue;
    let original = originals.get(nt.name);
    if (!original) { kept.add(nt.top.tag); continue; }
    if (nameOf(ctx, dictOf(ctx, original)?.get(K.Subtype)) === 'Widget') {
      // An original that is its own widget becomes a field with that widget as its child.
      const slot = [original];
      splitOwnField(ctx, slot, original);
      replaceKid(ctx, list, original, slot[0]);
      original = slot[0];
      originals.set(nt.name, original);
    }
    const former = d.get(K.Parent);
    if (former instanceof PDFRef) removeKid(ctx, former, widget);
    const child = d.has(K.T) ? fieldAndWidget(ctx, d)[1] : d;
    child.set(K.Parent, original);
    ctx.assign(widget, child);
    addKid(ctx, original, widget);
    shared.add(nt.top.tag);
  }
  for (let i = list.size() - 1; i >= 0; i--) { const r = list.get(i); if (r instanceof PDFRef && shared.has(r.tag) && !kept.has(r.tag)) list.remove(i); }
}

const listedFields = (doc) => {
  const list = arrayOf(doc.context, dictOf(doc.context, doc.catalog.get(K.AcroForm))?.get(K.Fields));
  const out = new Set();
  if (list) for (let i = 0; i < list.size(); i++) { const r = list.get(i); if (r instanceof PDFRef) out.add(r.tag); }
  return out;
};

/** Copies of pages of doc after themselves (Duplicate pages): their widgets become more widgets of the same fields. */
export async function duplicate(doc, srcCopy, indices) {
  const before = tagsOf(doc);
  for (const i of [...new Set(indices)].sort((a, b) => b - a)) {
    const fields = listedFields(doc);
    const r = importPages(doc, srcCopy, [i], i + 1, 'merge', { samePages: true });
    shareFieldsWithOriginals(doc, r.pages[0], fields);
  }
  dedupeResources(doc, created(doc, before));
  collectGarbage(doc);
}

/** Copies pages of src into doc at position at, keeping field names (Replace pages). */
export function importKeepingNames(doc, src, pages, at) {
  const before = tagsOf(doc);
  const r = importPages(doc, src, pages, at, 'merge');
  dedupeResources(doc, created(doc, before));
  return r;
}

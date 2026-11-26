// What changed after a signature: the signed revision (the bytes the signature covers) is compared with the
// document as it is now, object by object, and every change is classified as form fill, comments, signatures,
// document information, page content or other. Approval signatures permit form fill, comments and further
// signatures; a certification permits what its level says (1: nothing, 2: form fill and signatures, 3: also
// comments). Changed page content is never permitted.
//
// Ported from PdfCraft's sign crate (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors, MIT license,
// see THIRD_PARTY_NOTICES.md).
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFNumber } from '@cantoo/pdf-lib';

const N = (s) => PDFName.of(s);
const lookup = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const dictOf = (ctx, v) => { const d = lookup(ctx, v); return d instanceof PDFDict ? d : null; };
const nameOf = (ctx, v) => { const o = lookup(ctx, v); return o instanceof PDFName ? o.decodeText() : undefined; };
const serialize = (o) => { if (!o) return null; const b = new Uint8Array(o.sizeInBytes()); o.copyBytesInto(b, 0); return b; };
const same = (a, b) => { const x = serialize(a); const y = serialize(b); if (!x || !y || x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
const refsIn = (ctx, v) => { const a = lookup(ctx, v); return a instanceof PDFArray ? a.asArray().filter((r) => r instanceof PDFRef).map((r) => r.objectNumber) : []; };
const load = (b) => PDFDocument.load(b, { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true });

export const KINDS = { form: 'form fill', comments: 'comments', signatures: 'signatures', info: 'document information', pages: 'page content', other: 'other changes' };

/** The kind of a new or changed annotation: signatures, form fill or comments. */
function annotKind(ctx, a) {
  const d = dictOf(ctx, a);
  if (!d) return KINDS.other;
  if (nameOf(ctx, d.get(N('Subtype'))) !== 'Widget') return KINDS.comments;
  let ft = nameOf(ctx, d.get(N('FT')));
  for (let p = d.get(N('Parent')), k = 0; !ft && p && k < 32; k++) { const pd = dictOf(ctx, p); ft = nameOf(ctx, pd?.get(N('FT'))); p = pd?.get(N('Parent')); }
  return ft === 'Sig' ? KINDS.signatures : KINDS.form;
}

/** The DocMDP level of a certification signature value (1, 2 or 3), or null for an approval signature. */
export function docMdpLevel(ctx, sig) {
  const refs = lookup(ctx, sig?.get(N('Reference')));
  if (!(refs instanceof PDFArray)) return null;
  for (const r of refs.asArray()) {
    const d = dictOf(ctx, r);
    if (nameOf(ctx, d?.get(N('TransformMethod'))) !== 'DocMDP') continue;
    const p = lookup(ctx, dictOf(ctx, d.get(N('TransformParams')))?.get(N('P')));
    return p instanceof PDFNumber ? Math.min(3, Math.max(1, p.asNumber())) : 2;
  }
  return null;
}

/**
 * The changes made after the signed revision (bytes of length signedLength) up to now (bytes): {kinds, allowed,
 * disallowed} with kinds from KINDS, judged under the DocMDP level p (null for an approval signature).
 */
export async function classifyChanges(bytes, signedLength, p = null) {
  let old; let now;
  try { old = await load(bytes.subarray(0, signedLength)); now = await load(bytes); } catch { return { kinds: [KINDS.other], allowed: [], disallowed: [KINDS.other] }; }
  const oc = old.context; const nc = now.context;
  const pages = old.getPages();
  const pageNums = new Set(pages.map((pg) => pg.ref.objectNumber));
  const contents = new Set(); const annotArrays = new Set(); const annotsOf = new Map(); const resources = new Set();
  for (const pg of pages) {
    const c = pg.node.get(N('Contents'));
    if (c instanceof PDFRef) contents.add(c.objectNumber);
    for (const n of refsIn(oc, c)) contents.add(n);
    const a = pg.node.get(N('Annots'));
    if (a instanceof PDFRef) annotArrays.add(a.objectNumber);
    annotsOf.set(pg.ref.objectNumber, new Set(refsIn(oc, a)));
    const r = pg.node.get(N('Resources'));
    if (r instanceof PDFRef) resources.add(r.objectNumber);
    const rd = dictOf(oc, r);
    if (rd) for (const [, cat] of rd.entries()) { if (cat instanceof PDFRef) resources.add(cat.objectNumber); const cd = dictOf(oc, cat); if (cd) for (const [, v] of cd.entries()) if (v instanceof PDFRef) resources.add(v.objectNumber); }
  }
  const catalogNum = oc.trailerInfo.Root?.objectNumber;
  const infoNum = oc.trailerInfo.Info?.objectNumber;
  const metaNum = old.catalog.get(N('Metadata'))?.objectNumber;
  const formNum = old.catalog.get(N('AcroForm'))?.objectNumber;
  const kinds = new Set();
  const oldObjs = new Map(oc.enumerateIndirectObjects().map(([r, o]) => [r.objectNumber, o]));
  for (const [ref, obj] of nc.enumerateIndirectObjects()) {
    const n = ref.objectNumber;
    const before = oldObjs.get(n);
    if (obj instanceof PDFStream && ['XRef', 'ObjStm'].includes(nameOf(nc, obj.dict.get(N('Type'))))) continue;
    if (before && same(before, obj)) continue;
    if (!before) {
      // New objects count through what refers to them; on their own only signature values and annotations tell.
      if (obj instanceof PDFDict && nameOf(nc, obj.get(N('Type'))) === 'Sig') kinds.add(KINDS.signatures);
      continue;
    }
    if (contents.has(n) || resources.has(n)) { kinds.add(KINDS.pages); continue; }
    if (pageNums.has(n)) {
      // A page that only lists more annotations: those are judged; anything else changed is page content.
      const was = before instanceof PDFDict ? before : null; const is = obj instanceof PDFDict ? obj : null;
      const keys = new Set([...(was?.keys() || []), ...(is?.keys() || [])].map((k) => k.decodeText()));
      for (const k of keys) {
        if (k === 'Annots') continue;
        if (!same(was?.get(N(k)), is?.get(N(k)))) { kinds.add(KINDS.pages); break; }
      }
      const had = annotsOf.get(n) || new Set();
      for (const a of refsIn(nc, is?.get(N('Annots')))) if (!had.has(a)) kinds.add(annotKind(nc, PDFRef.of(a)));
      if ([...had].some((a) => !refsIn(nc, is?.get(N('Annots'))).includes(a))) kinds.add(KINDS.comments);
      continue;
    }
    if (annotArrays.has(n)) { const had = new Set(refsIn(oc, before)); for (const a of refsIn(nc, obj)) if (!had.has(a)) kinds.add(annotKind(nc, PDFRef.of(a))); continue; }
    if (n === infoNum || n === metaNum) { kinds.add(KINDS.info); continue; }
    if (n === catalogNum) {
      const keys = new Set([...before.keys(), ...obj.keys()].map((k) => k.decodeText()));
      for (const k of keys) if (!['AcroForm', 'Perms', 'DSS', 'Metadata'].includes(k) && !same(before.get(N(k)), obj.get(N(k)))) kinds.add(KINDS.other);
      continue;
    }
    if (n === formNum) continue;
    if (obj instanceof PDFDict && (obj.has(N('FT')) || obj.has(N('T')) || nameOf(nc, obj.get(N('Subtype'))) === 'Widget')) { kinds.add(annotKind(nc, ref) === KINDS.signatures ? KINDS.signatures : KINDS.form); continue; }
    if (obj instanceof PDFDict && obj.has(N('Subtype')) && obj.has(N('Rect'))) { kinds.add(KINDS.comments); continue; }
    // Appearance streams of fields and comments change with them; anything else is another change.
    if (obj instanceof PDFStream && nameOf(nc, obj.dict.get(N('Subtype'))) === 'Form') { kinds.add(KINDS.form); continue; }
    kinds.add(KINDS.other);
  }
  const permitted = p === 1 ? [] : p === 2 ? [KINDS.form, KINDS.signatures] : [KINDS.form, KINDS.signatures, KINDS.comments, KINDS.info];
  const list = [...kinds];
  return { kinds: list, allowed: list.filter((k) => permitted.includes(k)), disallowed: list.filter((k) => !permitted.includes(k)) };
}

// Saving as an incremental update: the original bytes stay exactly as they are and only what changed is
// appended (new and changed objects, a cross-reference section and a trailer pointing back to the previous one).
// Existing digital signatures stay intact this way, more signatures can follow each other, and a damaged save
// can never harm the original part of the file.
//
// Ported from PdfCraft's cos crate (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors, MIT license,
// see THIRD_PARTY_NOTICES.md).
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFStream, PDFWriter, IncrementalDocumentSnapshot } from '@cantoo/pdf-lib';

const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return s; };

/** The offset of the last cross-reference section (the number after the last "startxref"), or -1. */
export function lastStartXref(bytes) {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail) || [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  return m ? Number(m[1]) : -1;
}

/** How many revisions a file has (incremental updates plus the original). */
export function revisionCount(bytes) { return (latin1(bytes).match(/%%EOF/g) || []).length; }

const serialize = (o) => { const b = new Uint8Array(o.sizeInBytes()); o.copyBytesInto(b, 0); return b; };
const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const isContainer = (o) => o instanceof PDFStream && ['ObjStm', 'XRef'].includes(o.dict.lookup(PDFName.of('Type'))?.decodeText?.());

/** Replaces references to the keys of map (tag -> ref) in every object and in the trailer. */
function renumber(ctx, map) {
  const fix = (v) => (v instanceof PDFRef && map.has(v.tag) ? map.get(v.tag) : v);
  const visit = (o) => {
    if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) { const v = o.get(i); const w = fix(v); if (w !== v) o.set(i, w); else visit(v); }
    else if (o instanceof PDFDict) for (const [k, v] of o.entries()) { const w = fix(v); if (w !== v) o.set(k, w); else visit(v); }
    else if (o instanceof PDFStream) visit(o.dict);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);
  for (const k of ['Root', 'Info']) ctx.trailerInfo[k] = fix(ctx.trailerInfo[k]);
}

/**
 * The bytes of original with doc's changes appended as an incremental update, or null when that is not possible
 * (an encrypted original, or no cross-reference to point back to). doc must have been read from original or from
 * a full save of it (its objects keep their numbers).
 */
export async function appendUpdate(original, doc) {
  const prev = lastStartXref(original);
  if (prev < 0) return null;
  let base;
  try { base = await PDFDocument.load(original, { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true }); } catch { return null; }
  if (base.isEncrypted) return null;
  await doc.flush();
  const ctx = doc.context;
  const baseObjs = new Map(); let baseMax = 0;
  for (const [ref, obj] of base.context.enumerateIndirectObjects()) { baseObjs.set(ref.objectNumber, { ref, obj, container: isContainer(obj) }); baseMax = Math.max(baseMax, ref.objectNumber); }
  // Object streams and cross-reference streams of earlier saves are not part of the document.
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) if (isContainer(obj) && !(baseObjs.get(ref.objectNumber)?.container && sameBytes(serialize(obj), serialize(baseObjs.get(ref.objectNumber).obj)))) ctx.delete(ref);
  ctx.largestObjectNumber = Math.max(ctx.largestObjectNumber, baseMax);
  // An object that took the number of one of the original's object streams moves to a new number: that number
  // must keep naming the stream the original's compressed objects live in.
  const moves = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const b = baseObjs.get(ref.objectNumber);
    if (b?.container && !isContainer(obj)) { const nu = ctx.nextRef(); ctx.assign(nu, obj); moves.set(ref.tag, nu); }
  }
  if (moves.size) { renumber(ctx, moves); for (const tag of moves.keys()) { const [n, g] = tag.split(' ').map(Number); ctx.delete(PDFRef.of(n, g)); } }
  const changed = new Set(); const present = new Set();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    present.add(ref.objectNumber);
    const b = baseObjs.get(ref.objectNumber);
    if (!b) { if (ref.objectNumber <= baseMax) changed.add(ref.objectNumber); continue; }
    if (b.container) continue;
    if (!sameBytes(serialize(b.obj), serialize(obj))) changed.add(ref.objectNumber);
  }
  const snapshot = new IncrementalDocumentSnapshot(baseMax, changed, original.length, prev, ctx);
  for (const b of baseObjs.values()) if (!b.container && !present.has(b.ref.objectNumber)) snapshot.markDeletedRef(b.ref);
  // The trailer's Size covers every number in use.
  ctx.largestObjectNumber = Math.max(ctx.largestObjectNumber, baseMax);
  const tail = await PDFWriter.forContextWithSnapshot(ctx, 2000, snapshot).serializeToBuffer();
  const out = new Uint8Array(original.length + tail.length);
  out.set(original, 0); out.set(tail, original.length);
  return out;
}

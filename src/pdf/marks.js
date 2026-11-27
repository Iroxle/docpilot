// Page marks: header and footer, watermark, background, Bates numbers and printer marks. Every mark is a content
// stream of its own, tagged /DPMark in its dictionary (PdfCraft's /PCMark is read too) and drawn as an artifact
// (marked content /Artifact), so it can be found again, changed and removed without touching the page content:
// - a mark on top is appended after the page content, which pdf-lib wraps in q/Q, so the mark does not inherit
//   graphics state the page leaves set;
// - a mark behind (background, watermark "behind the page") is put at the start of the content list, backgrounds
//   first, then watermarks, in the order they were added;
// - the dialog values are stored with the mark (/DPSettings), so "Update" opens with the settings it was made with;
// - removing drops the tagged streams; finding marks only reads the stream dictionaries, never the page content.
//
// Ported from PdfCraft's edit crate (marks, apply, place) (Copyright (c) 2026 ArtCraft Team and the PdfCraft
// contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import {
  PDFName, PDFArray, PDFStream, PDFRawStream, PDFContentStream, PDFRef, PDFHexString, PDFString, PDFOperator, pushGraphicsState, popGraphicsState,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

export const MARK_KINDS = {
  HeaderFooter: 'Header & footer', Watermark: 'Watermark', Background: 'Background', Bates: 'Bates numbering', PrinterMarks: 'Printer marks',
};
// Artifact types (ISO 32000, 14.8.2.2): page furniture is /Pagination, a background /Background, production aids /Page.
const ARTIFACT = { HeaderFooter: ['Pagination', 'Header'], Watermark: ['Pagination', 'Watermark'], Bates: ['Pagination', 'Footer'], Background: ['Background', null], PrinterMarks: ['Page', null] };
const BEHIND_ORDER = ['Background', 'Watermark'];
const DPMark = PDFName.of('DPMark');
const PCMark = PDFName.of('PCMark');
const DPSettings = PDFName.of('DPSettings');

const look = (ctx, o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const nameText = (n) => (n instanceof PDFName ? n.asString().replace(/^\//, '') : null);

/** The mark kind of a content stream (or of a reference to one), from its dictionary; null for page content. */
export function streamTag(ctx, obj) {
  const s = look(ctx, obj);
  if (!(s instanceof PDFStream)) return null;
  return nameText(s.dict.get(DPMark)) || nameText(s.dict.get(PCMark));
}

/** A stream that only saves or restores the graphics state ("q" or "Q", as pdf-lib wraps page content). */
export function isWrapper(ctx, obj) {
  const s = look(ctx, obj);
  let text = null;
  if (s instanceof PDFContentStream) text = s.getContentsString();
  else if (s instanceof PDFRawStream && s.contents.length < 64) {
    try { text = String.fromCharCode(...decodePDFRawStream(s).decode()); } catch { return false; }
  }
  return text !== null && /^\s*[qQ]\s*$/.test(text);
}

/** The settings stored with a mark stream, or null. */
export function streamSettings(ctx, obj) {
  const s = look(ctx, obj);
  const v = s instanceof PDFStream ? s.dict.get(DPSettings) : null;
  if (!(v instanceof PDFHexString || v instanceof PDFString)) return null;
  try { return JSON.parse(v.decodeText()); } catch { return null; }
}

/** The page's content streams as a list of objects (references or streams). */
function contentList(page) {
  const c = page.node.get(PDFName.of('Contents'));
  const v = look(page.doc.context, c);
  if (v instanceof PDFArray) return v.asArray();
  return c ? [c] : [];
}

/**
 * Draws a mark: fn() draws with pdf-lib's page drawing functions (drawText, drawImage, drawRectangle, pushOperators)
 * into a content stream of its own, which gets the tag and the settings. o: {behind, settings}.
 */
export function drawMark(page, kind, fn, o = {}) {
  const ctx = page.doc.context;
  // A fresh content stream appended to /Contents (pdf-lib wraps the existing content in q/Q first).
  page.getContentStream(false);
  const [type, subtype] = ARTIFACT[kind] || ['Pagination', null];
  const props = ctx.obj({ Type: type, ...(subtype ? { Subtype: subtype } : {}), DPMark: kind });
  page.pushOperators(pushGraphicsState(), PDFOperator.of('BDC', [PDFName.of('Artifact'), props]));
  fn();
  page.pushOperators(PDFOperator.of('EMC'), popGraphicsState());
  const stream = page.contentStream; const ref = page.contentStreamRef;
  stream.dict.set(DPMark, PDFName.of(kind));
  if (o.settings) stream.dict.set(DPSettings, PDFHexString.fromText(JSON.stringify(o.settings)));
  // Later drawing must not land in the mark.
  page.contentStream = undefined; page.contentStreamRef = undefined;
  if (o.behind) {
    const arr = look(ctx, page.node.get(PDFName.of('Contents')));
    const items = arr.asArray();
    const at = items.findIndex((x) => x === ref);
    arr.remove(at);
    // After the behind-marks already at the start that come first in the order (backgrounds before watermarks).
    const rank = BEHIND_ORDER.indexOf(kind);
    let k = 0;
    while (k < arr.size()) {
      if (isWrapper(ctx, arr.get(k))) { k++; continue; }
      const r = BEHIND_ORDER.indexOf(streamTag(ctx, arr.get(k)));
      if (r < 0 || r > rank) break;
      k++;
    }
    arr.insert(k, ref);
  }
  return ref;
}

/** Removes the marks of the given kinds from a page; returns how many streams were removed. */
export function removeMarksFromPage(page, kinds) {
  const ctx = page.doc.context;
  const want = new Set(Array.isArray(kinds) ? kinds : [kinds]);
  const list = contentList(page);
  const kept = list.filter((o) => !want.has(streamTag(ctx, o)));
  if (kept.length === list.length) return 0;
  page.node.set(PDFName.of('Contents'), ctx.obj(kept));
  return list.length - kept.length;
}

/** Removes marks of a kind from the pages (all pages when not given) of a loaded document. */
export function removeMarks(doc, kinds, pages) {
  let n = 0;
  for (const i of pages || doc.getPageIndices()) n += removeMarksFromPage(doc.getPage(i), kinds);
  return n;
}

/**
 * The marks in a loaded document: [{kind, label, pages: [indices], settings}] (settings of the first page that has
 * them). Only the stream dictionaries are read.
 */
export function listMarks(doc) {
  const ctx = doc.context;
  const out = new Map();
  doc.getPages().forEach((p, i) => {
    for (const o of contentList(p)) {
      const kind = streamTag(ctx, o);
      if (!kind) continue;
      let m = out.get(kind);
      if (!m) { m = { kind, label: MARK_KINDS[kind] || kind, pages: [], settings: streamSettings(ctx, o) }; out.set(kind, m); }
      if (m.pages[m.pages.length - 1] !== i) m.pages.push(i);
    }
  });
  return [...out.values()];
}

/** Page indices as a range text for a dialog ("1-3, 5"), 0-based input. */
export function rangeText(pages) {
  const out = [];
  for (let k = 0; k < pages.length;) {
    let j = k;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j > k ? `${pages[k] + 1}-${pages[j] + 1}` : `${pages[k] + 1}`);
    k = j + 1;
  }
  return out.join(', ');
}

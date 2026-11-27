// The fonts of a document for Document properties: name, type, encoding, whether it is embedded (fully or as a
// subset) and the pages that use it. Fonts are found in the resources of the pages and of the forms they draw (also
// in annotation appearances). Each font is listed once by name, type and embedding, sorted by name. Type 3 fonts
// are drawn by the document itself and count as embedded; a subset is recognised by its name prefix ("ABCDEF+").
//
// Ported from PdfCraft's render crate (inspect: fonts) (Copyright (c) 2026 ArtCraft Team and the PdfCraft
// contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFStream, PDFRef } from '@cantoo/pdf-lib';

const N = (s) => PDFName.of(s);
const look = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : null);

function fontInfo(ctx, f) {
  const base = nameOf(look(ctx, f.get(N('BaseFont')))) || '(unnamed)';
  const kind = nameOf(look(ctx, f.get(N('Subtype')))) || '';
  const enc = look(ctx, f.get(N('Encoding')));
  const encoding = enc instanceof PDFName ? nameOf(enc) : enc instanceof PDFStream ? 'Embedded CMap' : enc instanceof PDFDict ? 'Custom' : null;
  const descOf = (d) => { const x = d ? look(ctx, d.get(N('FontDescriptor'))) : null; return x instanceof PDFDict ? x : null; };
  const df = look(ctx, f.get(N('DescendantFonts')));
  const descendant = df instanceof PDFArray ? look(ctx, df.get(0)) : null;
  const desc = descOf(f) || descOf(descendant instanceof PDFDict ? descendant : null);
  const embedded = kind === 'Type3' || !!(desc && (desc.get(N('FontFile')) || desc.get(N('FontFile2')) || desc.get(N('FontFile3'))));
  const subset = /^[A-Z]{6}\+/.test(base);
  return { name: subset ? base.slice(7) : base, kind, encoding, embedded, subset };
}

/** The fonts of a loaded document: [{name, kind, encoding, embedded, subset, pages: [0-based]}]. */
export function listFonts(doc) {
  const ctx = doc.context;
  const out = new Map();
  const visitRes = (res, page, depth, seen) => {
    res = look(ctx, res);
    if (!(res instanceof PDFDict) || depth > 12) return;
    const fonts = look(ctx, res.get(N('Font')));
    if (fonts instanceof PDFDict) {
      for (const [, v] of fonts.entries()) {
        const f = look(ctx, v);
        if (!(f instanceof PDFDict)) continue;
        const info = fontInfo(ctx, f);
        const key = `${info.name}|${info.kind}|${info.embedded}`;
        let e = out.get(key);
        if (!e) { e = { ...info, pages: [] }; out.set(key, e); }
        if (!e.pages.includes(page)) e.pages.push(page);
        // Type 3 glyphs have resources of their own.
        if (info.kind === 'Type3') visitRes(f.get(N('Resources')), page, depth + 1, seen);
      }
    }
    const xo = look(ctx, res.get(N('XObject')));
    if (xo instanceof PDFDict) {
      for (const [, v] of xo.entries()) {
        const key = v instanceof PDFRef ? v.toString() : null;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const s = look(ctx, v);
        if (s instanceof PDFStream && nameOf(look(ctx, s.dict.get(N('Subtype')))) === 'Form') visitRes(s.dict.get(N('Resources')), page, depth + 1, seen);
      }
    }
  };
  doc.getPages().forEach((p, i) => {
    const seen = new Set();
    visitRes(p.node.Resources(), i, 0, seen);
    const annots = look(ctx, p.node.get(N('Annots')));
    if (annots instanceof PDFArray) {
      for (const a of annots.asArray()) {
        const ap = look(ctx, look(ctx, a)?.get?.(N('AP')));
        const n = ap instanceof PDFDict ? look(ctx, ap.get(N('N'))) : null;
        const streams = n instanceof PDFStream ? [n] : n instanceof PDFDict ? n.entries().map(([, v]) => look(ctx, v)).filter((x) => x instanceof PDFStream) : [];
        for (const s of streams) visitRes(s.dict.get(N('Resources')), i, 1, seen);
      }
    }
  });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A readable font type: "TrueType", "Type 1", "Type 3", "CID (Type 0)"... */
export const fontKind = (k) => ({ Type0: 'Composite (Type 0)', Type1: 'Type 1', MMType1: 'Multiple master', Type3: 'Type 3', TrueType: 'TrueType', CIDFontType0: 'CID Type 0', CIDFontType2: 'CID TrueType' }[k] || k || 'Unknown');

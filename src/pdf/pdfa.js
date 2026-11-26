// PDF/A (ISO 19005-2 and -3, conformance level b): checking a document against the rules that can be decided
// from its objects, and converting it, fixing what can be fixed without changing how the pages look (XMP
// identification, sRGB output intent, forbidden actions and scripts, annotation flags and appearances,
// Interpolate, alternate images, NeedAppearances, LZW, file identifier). Fonts that are not embedded cannot be
// fixed this way; they are reported.
//
// Ported from PdfCraft's preflight crate (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors, MIT
// license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFNumber, PDFString, PDFHexString, PDFBool, decodePDFRawStream } from '@cantoo/pdf-lib';
import { loadForEdit, saveDoc } from './ops.js';
import { tokenize, pageContentBytes } from './content.js';

const N = (s) => PDFName.of(s);
const lookup = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const dictOf = (ctx, v) => { const d = lookup(ctx, v); return d instanceof PDFDict ? d : null; };
const nameOf = (ctx, v) => { const o = lookup(ctx, v); return o instanceof PDFName ? o.decodeText() : undefined; };
const textOf = (ctx, v) => { const o = lookup(ctx, v); return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null; };
const cryptoRandomHex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return s; };

export const LEVELS = [['2b', 'PDF/A-2b'], ['3b', 'PDF/A-3b']];
const FORBIDDEN_ACTIONS = new Set(['JavaScript', 'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView', 'SetState', 'NOP']);
const NAMED_OK = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);
const FORBIDDEN_ANNOTS = new Set(['Sound', 'Movie', 'Screen', '3D', 'RichMedia']);

function streamText(s) { try { return latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()); } catch { return null; } }

/** The XMP packet of the catalog as text, or null. */
function xmpOf(doc) {
  const m = lookup(doc.context, doc.catalog.get(N('Metadata')));
  if (!(m instanceof PDFStream)) return null;
  const t = streamText(m);
  return t === null ? null : new TextDecoder().decode(Uint8Array.from(t, (c) => c.charCodeAt(0)));
}

/** Colour spaces the pages draw with directly: {rgb, cmyk, gray} (from content operators and images). */
function deviceColour(doc) {
  const ctx = doc.context; const used = { rgb: false, cmyk: false, gray: false, unread: false };
  const visitCS = (cs) => { const n = nameOf(ctx, cs) || nameOf(ctx, lookup(ctx, cs)?.get?.(0)); if (n === 'DeviceRGB') used.rgb = true; if (n === 'DeviceCMYK') used.cmyk = true; if (n === 'DeviceGray') used.gray = true; };
  for (const page of doc.getPages()) {
    let bytes; try { bytes = pageContentBytes(page); } catch { used.unread = true; continue; }
    let ops; try { ops = tokenize(bytes); } catch { used.unread = true; continue; }
    for (const o of ops) {
      if (o.op === 'rg' || o.op === 'RG') used.rgb = true;
      else if (o.op === 'k' || o.op === 'K') used.cmyk = true;
      else if ((o.op === 'cs' || o.op === 'CS') && o.args[0]?.t === 'name') { const n = o.args[0].v; if (n === 'DeviceRGB') used.rgb = true; if (n === 'DeviceCMYK') used.cmyk = true; }
    }
  }
  for (const [, o] of ctx.enumerateIndirectObjects()) if (o instanceof PDFStream && nameOf(ctx, o.dict.get(N('Subtype'))) === 'Image' && o.dict.get(N('ImageMask')) !== PDFBool.True) visitCS(o.dict.get(N('ColorSpace')));
  return used;
}

/** The output intent with S GTS_PDFA1: {profile components} or null. */
function pdfaIntent(doc) {
  const ctx = doc.context;
  const list = lookup(ctx, doc.catalog.get(N('OutputIntents')));
  if (!(list instanceof PDFArray)) return null;
  for (const i of list.asArray()) {
    const d = dictOf(ctx, i);
    if (nameOf(ctx, d?.get(N('S'))) !== 'GTS_PDFA1') continue;
    const p = lookup(ctx, d.get(N('DestOutputProfile')));
    const n = p instanceof PDFStream ? lookup(ctx, p.dict.get(N('N'))) : null;
    return { components: n instanceof PDFNumber ? n.asNumber() : 0 };
  }
  return null;
}

function* walkActions(ctx, a, seen = new Set()) {
  for (let k = 0; a && k < 64; k++) {
    if (a instanceof PDFRef) { if (seen.has(a.tag)) return; seen.add(a.tag); }
    const d = dictOf(ctx, a);
    if (!d) return;
    yield d;
    const next = lookup(ctx, d.get(N('Next')));
    if (next instanceof PDFArray) { for (const x of next.asArray()) yield* walkActions(ctx, x, seen); return; }
    a = d.get(N('Next'));
  }
}
const badAction = (ctx, d) => { const s = nameOf(ctx, d.get(N('S'))); return FORBIDDEN_ACTIONS.has(s) || (s === 'Named' && !NAMED_OK.has(nameOf(ctx, d.get(N('N'))))); };

/**
 * Checks a document against PDF/A-2b or -3b (level '2b' or '3b'). Returns issues [{clause, message, fixable}].
 * original: the file's bytes when they are at hand (header and identifier are checked on them).
 */
export async function verifyPdfA(bytes, level = '2b') {
  const doc = await loadForEdit(bytes);
  const ctx = doc.context; const issues = [];
  const add = (clause, message, fixable = true) => { if (!issues.some((i) => i.message === message)) issues.push({ clause, message, fixable }); };
  const head = latin1(bytes.subarray(0, 64));
  if (!/^%PDF-1\.[0-7]/.test(head)) add('6.1.2', 'The file does not start with a %PDF-1.0 to %PDF-1.7 header.');
  else if (!/^%PDF-1\.\d[\r\n]+%[\x80-\xff]{4}/.test(head)) add('6.1.2', 'The header is not followed by a comment of four bytes above 127.');
  const id = lookup(ctx, ctx.trailerInfo.ID);
  if (!(id instanceof PDFArray) || id.size() !== 2) add('6.1.3', 'The trailer has no file identifier (ID).');
  if (ctx.trailerInfo.Encrypt) add('6.1.3', 'The document is encrypted.');
  // Identification and metadata.
  const xmp = xmpOf(doc);
  const part = level === '3b' ? '3' : '2';
  if (!xmp) add('6.6.2.1', 'The document has no XMP metadata.');
  else {
    const p = /pdfaid:part(?:>|=")\s*(\d)/.exec(xmp)?.[1]; const c = /pdfaid:conformance(?:>|=")\s*([A-Za-z])/.exec(xmp)?.[1];
    if (p !== part || (c || '').toUpperCase() !== 'B') add('6.6.4', `The metadata does not identify the file as PDF/A-${part}b.`);
    const title = textOf(ctx, dictOf(ctx, ctx.trailerInfo.Info)?.get(N('Title')));
    if (title && !xmp.includes(title.replace(/&/g, '&amp;').replace(/</g, '&lt;'))) add('6.6.3', 'The title in the metadata and in the document information differ.');
  }
  // Colour: device colour needs an output intent of the same kind.
  const used = deviceColour(doc); const intent = pdfaIntent(doc);
  if ((used.rgb || used.cmyk || used.gray) && !intent) add('6.2.3', 'Device colour is used, but there is no PDF/A output intent.');
  if (used.cmyk && (!intent || intent.components !== 4)) add('6.2.4.3', 'DeviceCMYK is used: it needs a CMYK output intent (not added automatically).', false);
  if (used.rgb && intent && intent.components !== 3) add('6.2.4.3', 'DeviceRGB is used, but the PDF/A output intent is not an RGB profile.', false);
  // Objects: fonts, images, streams, actions, annotations.
  const fonts = new Set();
  // Every dictionary, also those written inside others (actions often are).
  const all = [];
  const collect = (v, depth) => {
    if (depth > 32) return;
    if (v instanceof PDFStream) { all.push([v, v.dict]); for (const [, x] of v.dict.entries()) collect(x, depth + 1); }
    else if (v instanceof PDFDict) { all.push([v, v]); for (const [, x] of v.entries()) collect(x, depth + 1); }
    else if (v instanceof PDFArray) for (const x of v.asArray()) collect(x, depth + 1);
  };
  for (const [, o] of ctx.enumerateIndirectObjects()) collect(o, 0);
  for (const [o, d] of all) {
    const type = nameOf(ctx, d.get(N('Type'))); const sub = nameOf(ctx, d.get(N('Subtype')));
    if (o instanceof PDFStream) {
      const f = lookup(ctx, d.get(N('Filter')));
      if ([f, ...(f instanceof PDFArray ? f.asArray() : [])].some((x) => nameOf(ctx, x) === 'LZWDecode' || nameOf(ctx, x) === 'LZW')) add('6.1.7', 'A stream is compressed with LZW.');
      if (d.has(N('F')) || d.has(N('FFilter'))) add('6.1.7', 'A stream refers to an external file.', false);
      if (sub === 'Image' && lookup(ctx, d.get(N('Interpolate'))) === PDFBool.True) add('6.2.8', 'An image asks for interpolation.');
      if (sub === 'Image' && d.has(N('Alternates'))) add('6.2.8', 'An image has alternate images.');
      if (d.has(N('OPI'))) add('6.2.8', 'An image or form uses OPI.');
      if (sub === 'PS' || d.has(N('Subtype2'))) add('6.2.9', 'The document contains PostScript.', false);
    }
    if (type === 'Font' && sub && sub !== 'Type3' && sub !== 'Type0') {
      const fd = dictOf(ctx, d.get(N('FontDescriptor')));
      const name = nameOf(ctx, d.get(N('BaseFont'))) || 'unnamed';
      if (!fd || !(fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3')))) fonts.add(name);
    }
    if (type === 'Font' && sub === 'Type0') {
      const df = dictOf(ctx, lookup(ctx, d.get(N('DescendantFonts')))?.get?.(0));
      const fd = df && dictOf(ctx, df.get(N('FontDescriptor')));
      if (!fd || !(fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3')))) fonts.add(nameOf(ctx, d.get(N('BaseFont'))) || 'unnamed');
    }
    if (d.has(N('S')) && (type === 'Action' || !type) && badAction(ctx, d)) add('6.5.1', `The document uses the action ${nameOf(ctx, d.get(N('S')))}${nameOf(ctx, d.get(N('S'))) === 'Named' ? ` (${nameOf(ctx, d.get(N('N')))})` : ''}, which PDF/A does not allow.`);
    if ((type === 'Annot' || d.has(N('Rect'))) && sub) {
      if (FORBIDDEN_ANNOTS.has(sub)) add('6.3.1', `The document has a ${sub} annotation, which PDF/A does not allow.`);
      if (sub !== 'Popup') {
        const flags = lookup(ctx, d.get(N('F'))); const fl = flags instanceof PDFNumber ? flags.asNumber() : 0;
        if (!(fl & 4) || (fl & (1 | 2 | 32 | 256))) add('6.3.2', 'An annotation is not set to print, or is hidden.');
        const r = lookup(ctx, d.get(N('Rect'))); const rr = r instanceof PDFArray ? r.asArray().map((x) => lookup(ctx, x)?.asNumber?.() ?? 0) : [0, 0, 0, 0];
        if (sub !== 'Link' && Math.abs(rr[2] - rr[0]) > 0 && Math.abs(rr[3] - rr[1]) > 0 && !dictOf(ctx, d.get(N('AP')))?.has(N('N'))) add('6.3.3', 'An annotation has no appearance.');
      }
      if (sub === 'FileAttachment' && level === '2b') add('6.8', 'A file attachment annotation: PDF/A-2 only allows embedded PDF/A files.', false);
    }
    if (type === 'Filespec' && level === '3b' && d.has(N('EF')) && !d.has(N('AFRelationship'))) add('6.8', 'An embedded file has no AFRelationship.');
  }
  if (fonts.size) add('6.2.11', `Fonts are not embedded: ${[...fonts].slice(0, 6).join(', ')}${fonts.size > 6 ? ', ...' : ''}.`, false);
  if (dictOf(ctx, doc.catalog.get(N('AA')))) add('6.5.2', 'The document has additional actions.');
  if (doc.getPages().some((p) => p.node.has(N('AA')))) add('6.5.2', 'A page has additional actions.');
  if (dictOf(ctx, dictOf(ctx, doc.catalog.get(N('Names')))?.get(N('JavaScript')))) add('6.5.1', 'The document has document-level JavaScript.');
  const form = dictOf(ctx, doc.catalog.get(N('AcroForm')));
  if (form && lookup(ctx, form.get(N('NeedAppearances'))) === PDFBool.True) add('6.4.1', 'The form asks viewers to make appearances (NeedAppearances).');
  if (form && form.has(N('XFA'))) add('6.4.2', 'The form contains XFA.');
  const ef = dictOf(ctx, dictOf(ctx, doc.catalog.get(N('Names')))?.get(N('EmbeddedFiles')));
  if (ef && level === '2b') add('6.8', 'The document has embedded files; PDF/A-2 only allows embedded PDF/A files (use PDF/A-3b for other files).', false);
  return issues;
}

/** Makes the XMP packet that identifies the file as PDF/A and repeats its document information. */
function xmpPacket(info, part) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = new Date().toISOString();
  const alt = (tag, v) => (v ? `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${esc(v)}</rdf:li></rdf:Alt></${tag}>` : '');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<pdfaid:part>${part}</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
${alt('dc:title', info.title)}${info.author ? `<dc:creator><rdf:Seq><rdf:li>${esc(info.author)}</rdf:li></rdf:Seq></dc:creator>` : ''}${alt('dc:description', info.subject)}
${info.keywords ? `<pdf:Keywords>${esc(info.keywords)}</pdf:Keywords>` : ''}<pdf:Producer>${esc(info.producer || 'DocPilot')}</pdf:Producer>
<xmp:CreatorTool>${esc(info.creator || 'DocPilot')}</xmp:CreatorTool><xmp:CreateDate>${info.created || now}</xmp:CreateDate><xmp:ModifyDate>${now}</xmp:ModifyDate>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Converts to PDF/A-2b or -3b, fixing what can be fixed without changing how the pages look. icc: an sRGB
 * profile for the output intent. Returns {bytes, fixed: [messages], remaining: issues}.
 */
export async function convertPdfA(bytes, level = '2b', icc = null, title = '') {
  const before = await verifyPdfA(bytes, level);
  const doc = await loadForEdit(bytes);
  const ctx = doc.context; const fixed = [];
  const part = level === '3b' ? '3' : '2';
  // Document information and the XMP that repeats it.
  if (!doc.getTitle()) doc.setTitle(title || 'Document');
  const info = { title: doc.getTitle(), author: doc.getAuthor(), subject: doc.getSubject(), keywords: doc.getKeywords(), creator: doc.getCreator(), producer: doc.getProducer() };
  doc.catalog.set(N('Metadata'), ctx.register(ctx.stream(new TextEncoder().encode(xmpPacket(info, part)), { Type: 'Metadata', Subtype: 'XML' })));
  fixed.push(`XMP metadata identifying the file as PDF/A-${part}b`);
  // Output intent.
  const intent = pdfaIntent(doc);
  if (!intent && icc) {
    const prof = ctx.register(ctx.flateStream(icc, { N: 3 }));
    doc.catalog.set(N('OutputIntents'), ctx.obj([ctx.register(ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'), Info: PDFString.of('sRGB IEC61966-2.1'), DestOutputProfile: prof }))]));
    fixed.push('sRGB output intent');
  }
  // Scripts and actions.
  const names = dictOf(ctx, doc.catalog.get(N('Names')));
  if (names?.has(N('JavaScript'))) { names.delete(N('JavaScript')); fixed.push('document-level JavaScript removed'); }
  for (const k of ['AA', 'OpenAction']) {
    const v = doc.catalog.get(N(k));
    if (!v) continue;
    if (k === 'OpenAction' && !dictOf(ctx, v)?.has(N('S'))) continue;
    if (k === 'AA' || [...walkActions(ctx, v)].some((d) => badAction(ctx, d))) { doc.catalog.delete(N(k)); fixed.push(k === 'AA' ? 'additional actions of the document removed' : 'opening action removed'); }
  }
  let actions = 0; let flags = 0; let images = 0; let lzw = 0; let ap = 0;
  for (const p of doc.getPages()) if (p.node.has(N('AA'))) { p.node.delete(N('AA')); actions++; }
  for (const [ref, o] of ctx.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    const sub = nameOf(ctx, d.get(N('Subtype')));
    for (const k of ['A', 'PA']) { const a = d.get(N(k)); if (a && [...walkActions(ctx, a)].some((x) => badAction(ctx, x))) { d.delete(N(k)); actions++; } }
    if ((d.has(N('FT')) || sub === 'Widget') && d.has(N('AA'))) { d.delete(N('AA')); actions++; }
    if ((nameOf(ctx, d.get(N('Type'))) === 'Annot' || d.has(N('Rect'))) && sub && sub !== 'Popup') {
      const f = lookup(ctx, d.get(N('F'))); const fl = f instanceof PDFNumber ? f.asNumber() : 0;
      const next = (fl | 4) & ~(1 | 2 | 32 | 256);
      if (next !== fl) { d.set(N('F'), PDFNumber.of(next)); flags++; }
      if (sub !== 'Link' && sub !== 'Widget' && !dictOf(ctx, d.get(N('AP')))?.has(N('N'))) {
        const r = lookup(ctx, d.get(N('Rect'))); const rr = r instanceof PDFArray ? r.asArray().map((x) => lookup(ctx, x)?.asNumber?.() ?? 0) : null;
        if (rr) { d.set(N('AP'), ctx.obj({ N: ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, Math.abs(rr[2] - rr[0]), Math.abs(rr[3] - rr[1])] })) })); ap++; }
      }
    }
    if (o instanceof PDFStream && sub === 'Image') {
      if (d.has(N('Interpolate'))) { d.delete(N('Interpolate')); images++; }
      if (d.has(N('Alternates'))) { d.delete(N('Alternates')); images++; }
    }
    if (d.has(N('OPI'))) { d.delete(N('OPI')); images++; }
    if (o instanceof PDFRawStream) {
      const f = lookup(ctx, d.get(N('Filter')));
      const names2 = f instanceof PDFArray ? f.asArray().map((x) => nameOf(ctx, x)) : [nameOf(ctx, f)];
      if (names2.length === 1 && (names2[0] === 'LZWDecode' || names2[0] === 'LZW')) {
        try {
          const data = decodePDFRawStream(o).decode();
          const nd = d.clone(ctx); nd.set(N('Filter'), N('FlateDecode')); nd.delete(N('Length'));
          const p = dictOf(ctx, d.get(N('DecodeParms'))); if (p) { const np = p.clone(ctx); np.delete(N('EarlyChange')); nd.set(N('DecodeParms'), np); }
          ctx.assign(ref, PDFRawStream.of(nd, ctx.flateStream(data).contents)); lzw++;
        } catch { /* stays; reported */ }
      }
    }
    if (level === '3b' && nameOf(ctx, d.get(N('Type'))) === 'Filespec' && d.has(N('EF')) && !d.has(N('AFRelationship'))) d.set(N('AFRelationship'), N('Unspecified'));
  }
  if (actions) fixed.push(`${actions} action(s) PDF/A does not allow removed`);
  if (flags) fixed.push(`${flags} annotation(s) set to print`);
  if (ap) fixed.push(`${ap} empty appearance(s) added`);
  if (images) fixed.push(`${images} image setting(s) removed (interpolation, alternates, OPI)`);
  if (lzw) fixed.push(`${lzw} LZW stream(s) stored with Flate`);
  const form = dictOf(ctx, doc.catalog.get(N('AcroForm')));
  if (form && lookup(ctx, form.get(N('NeedAppearances'))) === PDFBool.True) {
    try { doc.getForm().updateFieldAppearances(); } catch { /* fields keep their appearances */ }
    form.delete(N('NeedAppearances')); fixed.push('field appearances made');
  }
  if (!(lookup(ctx, ctx.trailerInfo.ID) instanceof PDFArray)) { const h = cryptoRandomHex(16); ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(h), PDFHexString.of(h)]); fixed.push('file identifier'); }
  const out = await saveDoc(doc, { useObjectStreams: true });
  const remaining = await verifyPdfA(out, level);
  return { bytes: out, fixed, before, remaining };
}

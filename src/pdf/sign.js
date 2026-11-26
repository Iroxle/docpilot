// Digital signatures according to PKCS#7 (adbe.pkcs7.detached) with PFX/P12 files.
import { PDFName, PDFArray, PDFDict, PDFHexString, PDFString, PDFNumber, PDFInvalidObject, StandardFonts, rgb } from '@cantoo/pdf-lib';
import forge from 'node-forge';
import { loadForEdit, wrapText, sanitizeFor, fieldKind, addAnnotTo } from './ops.js';
import { appendUpdate } from './incremental.js';
import { classifyChanges, docMdpLevel } from './sigchanges.js';

const SIG_HEX_LEN = 32768;

export const toBinary = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return s;
};
const fromBinary = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };

export function createDigitalId({ name, email, org, password, years = 5 }) {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 }, (err, keys) => {
      if (err) { reject(err); return; }
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
      cert.validity.notBefore = new Date(Date.now() - 86400000);
      cert.validity.notAfter = new Date(Date.now() + years * 365.25 * 86400000);
      const attrs = [{ name: 'commonName', value: name }];
      if (org) attrs.push({ name: 'organizationName', value: org });
      if (email) attrs.push({ name: 'emailAddress', value: email });
      cert.setSubject(attrs); cert.setIssuer(attrs);
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
        { name: 'extKeyUsage', emailProtection: true },
      ]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des', friendlyName: name });
      resolve(fromBinary(forge.asn1.toDer(p12).getBytes()));
    });
  });
}

export function readP12(p12Bytes, password) {
  let p12;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(p12Bytes)), false, password); }
  catch { throw new Error('The digital ID password is incorrect or the file is damaged.'); }
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
    || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBags.length || !keyBags[0].key) throw new Error('The digital ID does not contain a private key.');
  const key = keyBags[0].key;
  const certs = certBags.map((b) => b.cert).filter(Boolean);
  const own = certs.find((c) => c.publicKey.n && c.publicKey.n.equals(key.n));
  if (!own) throw new Error('The digital ID does not contain a matching certificate.');
  return { key, cert: own, chain: certs.filter((c) => c !== own), name: own.subject.getField('CN')?.value || 'Unknown' };
}

function findLast(bytes, needle) {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = bytes.length - n.length; i >= 0; i--) {
    for (let k = 0; k < n.length; k++) if (bytes[i + k] !== n[k]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Signs a PDF; the signature is appended as an incremental update, so earlier signatures stay valid.
 * o: {p12, password, reason, location, contact, visible:{page, rect, image, mime}, certify: 1|2|3}
 * certify makes it a certification signature (first signature only): 1 no changes allowed, 2 form fill and
 * signing, 3 also comments.
 */
export async function signPdf(bytes, o) {
  const id = readP12(o.p12, o.password);
  const now = new Date();
  if (id.cert.validity.notAfter < now || id.cert.validity.notBefore > now) throw new Error('The digital ID\'s certificate is no longer valid.');
  const doc = await loadForEdit(bytes);
  const ctx = doc.context;
  const form = doc.getForm();
  const placeholderContents = PDFInvalidObject.of(new TextEncoder().encode(`<${'0'.repeat(SIG_HEX_LEN)}>`));
  const BR = '/**********';
  const byteRange = PDFInvalidObject.of(new TextEncoder().encode(`[0 ${BR} ${BR} ${BR}]`));
  const sig = ctx.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    Name: PDFHexString.fromText(id.name), M: PDFString.fromDate(now),
  });
  sig.set(PDFName.of('ByteRange'), byteRange);
  sig.set(PDFName.of('Contents'), placeholderContents);
  if (o.reason) sig.set(PDFName.of('Reason'), PDFHexString.fromText(o.reason));
  if (o.location) sig.set(PDFName.of('Location'), PDFHexString.fromText(o.location));
  if (o.contact) sig.set(PDFName.of('ContactInfo'), PDFHexString.fromText(o.contact));
  const signedBefore = form.getFields().some((f) => fieldKind(f) === 'PDFSignature' && f.acroField.dict.get(PDFName.of('V')));
  if (o.certify) {
    if (signedBefore) throw new Error('Only the first signature of a document can certify it.');
    sig.set(PDFName.of('Reference'), ctx.obj([{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: o.certify, V: '1.2' } }]));
  }
  const sigRef = ctx.register(sig);
  if (o.certify) doc.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: sigRef }));

  const pageIdx = o.visible ? o.visible.page : 0;
  const page = doc.getPage(pageIdx);
  const rect = o.visible ? o.visible.rect : [0, 0, 0, 0];
  const existing = form.getFields().filter((f) => fieldKind(f) === 'PDFSignature').length;
  const fieldName = o.fieldName || `Signature${existing + 1}`;
  const widget = ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect, V: sigRef, T: PDFHexString.fromText(fieldName), F: 132, P: page.ref,
  });
  if (o.visible) {
    const [x0, y0, x1, y1] = rect; const w = x1 - x0; const h = y1 - y0;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const res = { Font: { F1: font.ref } };
    let ops = '';
    let textX = 4; let textW = w - 8;
    if (o.visible.image) {
      const img = o.visible.mime === 'image/png' ? await doc.embedPng(o.visible.image) : await doc.embedJpg(o.visible.image);
      res.XObject = { Im0: img.ref };
      const s = Math.min((w * 0.45) / img.width, h / img.height);
      ops += `q ${img.width * s} 0 0 ${img.height * s} 2 ${(h - img.height * s) / 2} cm /Im0 Do Q `;
      textX = w * 0.48; textW = w * 0.5;
    }
    const size = Math.max(5, Math.min(9, h / 6));
    const txt = `Digitally signed by ${id.name}\nDate: ${now.toLocaleString('en-GB')}${o.reason ? `\nReason: ${o.reason}` : ''}${o.location ? `\nLocation: ${o.location}` : ''}`;
    const lines = wrapText(font, sanitizeFor(font, txt), size, textW);
    let y = h - size - 2;
    ops += 'BT /F1 ' + size + ' Tf 0 0 0 rg ';
    for (const l of lines) { ops += `1 0 0 1 ${textX} ${y} Tm ${font.encodeText(l).toString()} Tj `; y -= size * 1.2; }
    ops += 'ET';
    const ap = ctx.flateStream(ops, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, w, h], Resources: res });
    widget.set(PDFName.of('AP'), ctx.obj({ N: ctx.register(ap) }));
  }
  const widgetRef = ctx.register(widget);
  addAnnotTo(page, widgetRef);
  form.acroForm.addField(widgetRef, []);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  void rgb; void PDFArray;

  // Appended to the file as it is: earlier signatures keep covering exactly what they signed.
  let saved = await appendUpdate(bytes, doc);
  if (!saved) {
    if (signedBefore) throw new Error('The document cannot be signed again without invalidating its signature.');
    saved = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, objectsPerTick: 2000 });
  }
  // Find ByteRange and Contents and insert the signature.
  const contentsPos = findLast(saved, `<${'0'.repeat(SIG_HEX_LEN)}>`);
  const brPos = findLast(saved, `[0 ${BR} ${BR} ${BR}]`);
  if (contentsPos < 0 || brPos < 0) throw new Error('Signature placeholder not found.');
  const gapEnd = contentsPos + SIG_HEX_LEN + 2;
  const brTemplateLen = `[0 ${BR} ${BR} ${BR}]`.length;
  const brText = `[0 ${contentsPos} ${gapEnd} ${saved.length - gapEnd}]`.padEnd(brTemplateLen, ' ');
  if (brText.length !== brTemplateLen) throw new Error('File is too large for the signature.');
  saved.set(new TextEncoder().encode(brText), brPos);
  const signedPart = new Uint8Array(contentsPos + saved.length - gapEnd);
  signedPart.set(saved.subarray(0, contentsPos), 0);
  signedPart.set(saved.subarray(gapEnd), contentsPos);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(toBinary(signedPart));
  p7.addCertificate(id.cert);
  id.chain.forEach((c) => p7.addCertificate(c));
  p7.addSigner({
    key: id.key, certificate: id.cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.signingTime, value: now },
      { type: forge.pki.oids.messageDigest },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const hex = forge.util.bytesToHex(der);
  if (hex.length > SIG_HEX_LEN) throw new Error('The certificate chain is too large for the signature space.');
  saved.set(new TextEncoder().encode(hex.padEnd(SIG_HEX_LEN, '0')), contentsPos + 1);
  return saved;
}

/** Validates all signatures. Returns integrity, coverage and signer for each signature. */
export function verifySignatures(bytes) {
  const src = toBinary(bytes);
  const out = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(src))) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const entry = { byteRange: [a, b, c, d], valid: false, covers: c + d >= bytes.length - 2 };
    try {
      if (c + d > bytes.length) throw new Error('File is truncated.');
      const hex = src.slice(a + b + 1, c - 1);
      const asn1 = forge.asn1.fromDer(forge.util.createBuffer(forge.util.hexToBytes(hex)), { parseAllBytes: false });
      const msg = forge.pkcs7.messageFromAsn1(asn1);
      const raw = msg.rawCapture;
      const cert = msg.certificates[0];
      const signerCert = msg.certificates.find((x) => {
        try { return forge.asn1.derToInteger && x.serialNumber === forge.util.bytesToHex(raw.serial); } catch { return false; }
      }) || cert;
      entry.name = signerCert.subject.getField('CN')?.value || 'Unknown';
      entry.issuer = signerCert.issuer.getField('CN')?.value || 'Unknown';
      entry.selfSigned = signerCert.isIssuer ? signerCert.isIssuer(signerCert) : false;
      entry.notAfter = signerCert.validity.notAfter.toISOString();
      entry.expired = signerCert.validity.notAfter < new Date();
      const fp = forge.md.sha256.create();
      fp.update(forge.asn1.toDer(forge.pki.certificateToAsn1(signerCert)).getBytes());
      entry.fingerprint = fp.digest().toHex().toUpperCase().match(/.{2}/g).join(':');

      const oid = forge.asn1.derToOid(raw.digestAlgorithm);
      const mdName = forge.pki.oids[oid];
      if (!forge.md[mdName]) throw new Error(`Algorithm ${mdName} is not supported.`);
      const md = forge.md[mdName].create();
      md.update(src.slice(a, a + b)); md.update(src.slice(c, c + d));
      const digest = md.digest().bytes();
      const attrs = raw.authenticatedAttributes;
      let attrDigest = null;
      for (const attr of attrs) {
        const type = forge.asn1.derToOid(attr.value[0].value);
        if (type === forge.pki.oids.messageDigest) attrDigest = attr.value[1].value[0].value;
        if (type === forge.pki.oids.signingTime) {
          const t = attr.value[1].value[0];
          entry.signedAt = (t.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(t.value) : forge.asn1.generalizedTimeToDate(t.value)).toISOString();
        }
      }
      entry.digestOk = attrDigest === digest;
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const md2 = forge.md[mdName].create();
      md2.update(forge.asn1.toDer(set).getBytes());
      entry.signatureOk = signerCert.publicKey.verify(md2.digest().bytes(), raw.signature);
      entry.valid = entry.digestOk && entry.signatureOk;
    } catch (e) { entry.error = e.message; }
    out.push(entry);
  }
  return out;
}

/**
 * The signatures with what changed after each of them: verifySignatures plus {certify (DocMDP level or null),
 * changes: {kinds, allowed, disallowed} (null when the signature covers the whole file)}.
 */
export async function signatureDetails(bytes) {
  const list = verifySignatures(bytes);
  let doc = null;
  try { doc = await loadForEdit(bytes); } catch { doc = null; }
  const perms = doc && doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  const mdp = perms && perms.get(PDFName.of('DocMDP'));
  const sigs = [];
  if (doc) for (const [ref, obj] of doc.context.enumerateIndirectObjects()) if (obj instanceof PDFDict && obj.get(PDFName.of('ByteRange'))) sigs.push([ref, obj]);
  for (const e of list) {
    const match = sigs.find(([, d]) => { const br = d.lookup(PDFName.of('ByteRange')); return br instanceof PDFArray && br.asArray().every((n, i) => n.asNumber?.() === e.byteRange[i]); });
    e.certify = match ? docMdpLevel(doc.context, match[1]) : null;
    if (match && mdp && mdp.tag !== match[0].tag) e.certify = null;
    const end = e.byteRange[2] + e.byteRange[3];
    e.changes = end >= bytes.length - 2 ? null : await classifyChanges(bytes, end, e.certify);
  }
  return list;
}

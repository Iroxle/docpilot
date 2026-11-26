// Redaction: what lies under the marked areas is removed from the file for good, not just covered.
// - text: glyphs whose boxes lie under a mark are cut out of Tj/TJ/'/" and replaced by a TJ displacement of the
//   same width, so the rest of the line stays exactly where it was (invisible text from text recognition too);
// - images: fully covered ones are removed, partly covered ones get the covered pixels cleared in a copy (when
//   the image cannot be decoded and stored again, it is removed); inline images under a mark are removed;
// - vector graphics: fully covered paths are removed, partly covered ones and shadings are clipped so nothing
//   shows inside the marks;
// - form XObjects under a mark are rewritten into new objects (pages sharing them keep theirs);
// - comments, links and form fields whose rectangle overlaps a mark are removed;
// - the marks become boxes in their fill colour with their overlay text.
// A verification pass reads every redacted page again; if any glyph or inline image is still under a mark, the
// whole operation fails and the document stays as it was. Document information, XMP metadata and tags that
// repeat the removed text are removed too.
//
// Ported from PdfCraft's redact crate (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors, MIT
// license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFNumber, PDFString, PDFHexString, StandardFonts, rgb, decodePDFRawStream } from '@cantoo/pdf-lib';
import { tokenize, mul, apply as at, inv, fontMetrics, pageContentBytes } from './content.js';
import { loadForEdit, saveDoc, sanitizeFor } from './ops.js';
import { decodeImage, fillPixels, encodeImage, deflate } from './imagedata.js';
import { collectGarbage } from './organize.js';

const N = (s) => PDFName.of(s);
const MAX_DEPTH = 50;
const lookup = (ctx, v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const dictOf = (ctx, v) => { const d = lookup(ctx, v); return d instanceof PDFDict ? d : null; };
const nameOf = (ctx, v) => { const o = lookup(ctx, v); return o instanceof PDFName ? o.decodeText() : undefined; };
const numsOf = (ctx, v) => { const a = lookup(ctx, v); return a instanceof PDFArray ? a.asArray().map((x) => { const n = lookup(ctx, x); return n instanceof PDFNumber ? n.asNumber() : 0; }) : null; };
const fmt = (v) => { const r = Math.round(v * 10000) / 10000; return Object.is(r, -0) || Math.abs(r) < 1e-9 ? '0' : String(r); };
const hex = (bytes) => `<${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}>`;
const bboxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const quadOf = (m, x0, y0, x1, y1) => [at(m, x0, y0), at(m, x1, y0), at(m, x1, y1), at(m, x0, y1)];
const overlaps = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1e-6 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1e-6;
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const interArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const inside = (p, r) => p[0] >= r[0] - 1e-6 && p[0] <= r[2] + 1e-6 && p[1] >= r[1] - 1e-6 && p[1] <= r[3] + 1e-6;

/** Whether the box lies completely in the union of the rectangles (exact for axis-aligned rectangles). */
function coveredBy(box, rects) {
  const xs = [...new Set([box[0], box[2], ...rects.flatMap((r) => [r[0], r[2]]).filter((x) => x > box[0] && x < box[2])])].sort((a, b) => a - b);
  const ys = [...new Set([box[1], box[3], ...rects.flatMap((r) => [r[1], r[3]]).filter((y) => y > box[1] && y < box[3])])].sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i++) for (let k = 0; k + 1 < ys.length; k++) {
    const c = [(xs[i] + xs[i + 1]) / 2, (ys[k] + ys[k + 1]) / 2];
    if (!rects.some((r) => inside(c, r))) return false;
  }
  return true;
}
/** Whether the parallelogram of the unit square under m lies completely under the rectangles. */
function quadCovered(m, rects) {
  if (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) return coveredBy(bboxOf(quadOf(m, 0, 0, 1, 1)), rects);
  for (let i = 0; i <= 8; i++) for (let k = 0; k <= 8; k++) if (!rects.some((r) => inside(at(m, i / 8, k / 8), r))) return false;
  return true;
}
/** A glyph lies under a mark when its centre does or the mark covers at least a tenth of it. */
const glyphHit = (box, rects) => {
  const c = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]; const a = area(box);
  return rects.some((r) => inside(c, r) || (a > 0 && interArea(box, r) >= 0.1 * a));
};

/** Operators that hide everything inside each rectangle: one even-odd clip per rectangle, in the current user space. */
function clipOut(rects, ctm, around) {
  const back = inv(ctm);
  if (!back.every(Number.isFinite)) return '';
  const big = [around[0] - 10, around[1] - 10, around[2] + 10, around[3] + 10];
  let s = '';
  for (const r of rects) {
    for (const poly of [[[big[0], big[1]], [big[2], big[1]], [big[2], big[3]], [big[0], big[3]]], [[r[0], r[1]], [r[0], r[3]], [r[2], r[3]], [r[2], r[1]]]]) {
      poly.forEach((p, k) => { const [u, v] = at(back, p[0], p[1]); s += `${fmt(u)} ${fmt(v)} ${k ? 'l' : 'm'} `; });
      s += 'h ';
    }
    s += 'W* n ';
  }
  return s;
}

function streamBytes(s) {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (typeof s.getUnencodedContents === 'function') return s.getUnencodedContents();
  return s.getContents();
}

/** Applies byte-range edits ({start, end, text}) to content bytes. */
function applyEdits(bytes, edits) {
  const sorted = edits.map((e, i) => ({ ...e, i })).sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start) || a.i - b.i);
  const parts = []; let pos = 0; let len = 0;
  for (const e of sorted) {
    if (e.start < pos) continue;
    parts.push(bytes.subarray(pos, e.start)); len += e.start - pos;
    const t = new Uint8Array(e.text.length + 2); t[0] = 32; for (let k = 0; k < e.text.length; k++) t[k + 1] = e.text.charCodeAt(k) & 255; t[t.length - 1] = 32;
    parts.push(t); len += t.length;
    pos = e.end;
  }
  parts.push(bytes.subarray(pos)); len += bytes.length - pos;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

class Scope {
  constructor(job, { bytes, resources, ctm, gs, depth = 0 }) {
    this.job = job; this.ctx = job.ctx; this.res = resources; this.depth = depth;
    this.bytes = bytes; this.edits = []; this.residue = 0; this.removed = 0;
    this.gs = { ctm, lw: 1, font: null, size: 0, tc: 0, tw: 0, th: 1, leading: 0, rise: 0, tr: 0, ...(gs || {}), ...(gs ? { ctm } : {}) };
    this.stack = []; this.tm = [1, 0, 0, 1, 0, 0]; this.tlm = this.tm; this.path = null; this.marks = []; this.fonts = new Map();
  }
  get apply() { return this.job.mode === 'apply'; }
  edit(start, end, text) { this.edits.push({ start, end, text }); }
  category(cat, create = false) {
    if (!this.res) return null;
    let d = dictOf(this.ctx, this.res.get(N(cat)));
    if (!d && create) { d = this.ctx.obj({}); this.res.set(N(cat), d); if (cat === 'XObject') this.job.owned.add(d); }
    return d;
  }
  uniqueName(cat, base) {
    const d = this.category(cat, true);
    let n = 1; while (d.has(N(`${base}${n}`))) n++;
    return `${base}${n}`;
  }
  hitsOf(box) { return this.job.regions.filter((r) => overlaps(box, r)); }
  /** Something under a mark was removed: marked-content properties around it must not keep its text. */
  removedHere() { this.removed++; for (const m of this.marks) if (m) m.hit = true; }

  font(name) {
    if (this.fonts.has(name)) return this.fonts.get(name);
    let info = null;
    const fd = dictOf(this.ctx, this.category('Font')?.get(N(name)));
    if (fd) {
      const ctx = this.ctx;
      const m = fontMetrics(fd);
      const sub = nameOf(ctx, fd.get(N('Subtype')));
      let asc = 0.9; let desc = -0.25; let widthScale = 1; let vertical = false;
      let descriptor = dictOf(ctx, fd.get(N('FontDescriptor')));
      if (sub === 'Type0') {
        const df = lookup(ctx, lookup(ctx, fd.get(N('DescendantFonts')))?.get?.(0));
        descriptor = dictOf(ctx, dictOf(ctx, df)?.get(N('FontDescriptor')));
        const enc = lookup(ctx, fd.get(N('Encoding')));
        if (enc instanceof PDFName) vertical = /-V$/.test(enc.decodeText());
        else if (enc instanceof PDFStream) { const wm = lookup(ctx, enc.dict.get(N('WMode'))); vertical = wm instanceof PDFNumber && wm.asNumber() === 1; }
      }
      if (descriptor) {
        const a = lookup(ctx, descriptor.get(N('Ascent'))); const d = lookup(ctx, descriptor.get(N('Descent')));
        if (a instanceof PDFNumber && a.asNumber() > 0) asc = Math.max(0.75, a.asNumber() / 1000);
        if (d instanceof PDFNumber && d.asNumber() < 0) desc = Math.min(-0.15, d.asNumber() / 1000);
      }
      if (sub === 'Type3') {
        const fm = numsOf(ctx, fd.get(N('FontMatrix'))) || [0.001, 0, 0, 0.001, 0, 0];
        widthScale = fm[0] * 1000;
        const bb = numsOf(ctx, fd.get(N('FontBBox')));
        if (bb && bb.some((v) => v)) { asc = Math.max(asc, bb[3] * fm[3]); desc = Math.min(desc, bb[1] * fm[3]); }
      }
      info = { m, asc, desc, widthScale, vertical };
    }
    this.fonts.set(name, info);
    return info;
  }

  async run() {
    const ops = tokenize(this.bytes);
    for (const o of ops) {
      const a = o.args; const n = a.map((x) => x.v);
      const g = this.gs;
      switch (o.op) {
        case 'q': this.stack.push({ ...g }); break;
        case 'Q': { const s = this.stack.pop(); if (s) this.gs = s; break; }
        case 'cm': if (n.length === 6) g.ctm = mul(n, g.ctm); break;
        case 'w': g.lw = n[0]; break;
        case 'gs': this.extGState(n[0]); break;
        case 'BT': this.tm = [1, 0, 0, 1, 0, 0]; this.tlm = this.tm; break;
        case 'Tf': g.font = n[0]; g.size = n[1]; break;
        case 'Tc': g.tc = n[0]; break;
        case 'Tw': g.tw = n[0]; break;
        case 'Tz': g.th = n[0] / 100; break;
        case 'TL': g.leading = n[0]; break;
        case 'Ts': g.rise = n[0]; break;
        case 'Tr': g.tr = n[0]; break;
        case 'Td': this.nextLine(n[0], n[1]); break;
        case 'TD': g.leading = -n[1]; this.nextLine(n[0], n[1]); break;
        case 'Tm': if (n.length === 6) { this.tlm = n.slice(0, 6); this.tm = this.tlm; } break;
        case 'T*': this.nextLine(0, -g.leading); break;
        case 'Tj': this.show(o, a[0]?.t === 'str' ? [a[0].v] : [], 'Tj'); break;
        case 'TJ': this.show(o, a[0]?.t === 'arr' ? a[0].v.map((e) => e.v) : [], 'TJ'); break;
        case "'": this.nextLine(0, -g.leading); this.show(o, a[0]?.t === 'str' ? [a[0].v] : [], "'"); break;
        case '"': g.tw = n[0]; g.tc = n[1]; this.nextLine(0, -g.leading); this.show(o, a[2]?.t === 'str' ? [a[2].v] : [], '"', n); break;
        case 'm': case 'l': case 'c': case 'v': case 'y': case 're': case 'h': this.pathOp(o, n); break;
        case 'W': case 'W*': if (this.path) this.path.clip = true; break;
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n': this.paint(o); break;
        case 'sh': if (this.apply && this.job.regions.length) { this.edit(o.start, o.start, `q ${clipOut(this.job.regions, g.ctm, this.job.around)}`); this.edit(o.end, o.end, 'Q'); } break;
        case 'Do': await this.xobject(o, n[0]); break;
        case 'BI': this.inlineImage(o); break;
        case 'BMC': this.marks.push(null); break;
        case 'BDC': this.marks.push({ op: o, tag: n[0], props: a[1], hit: false }); break;
        case 'EMC': { const m = this.marks.pop(); if (m && m.hit && this.apply) this.cleanMarked(m); break; }
        default: break;
      }
    }
    return this;
  }

  nextLine(tx, ty) { this.tlm = mul([1, 0, 0, 1, tx, ty], this.tlm); this.tm = this.tlm; }

  extGState(name) {
    const gs = dictOf(this.ctx, this.category('ExtGState')?.get(N(name)));
    if (!gs) return;
    const lw = lookup(this.ctx, gs.get(N('LW')));
    if (lw instanceof PDFNumber) this.gs.lw = lw.asNumber();
  }

  /** Marked content whose text was (partly) removed loses /ActualText, /Alt and /E, which would still hold it. */
  cleanMarked(m) {
    const p = m.props;
    let keep = '';
    if (p && p.t === 'dict') {
      for (let k = 0; k + 1 < p.v.length; k += 2) if (p.v[k].v === 'MCID' && p.v[k + 1].t === 'num') keep = `/MCID ${p.v[k + 1].v}`;
      const has = p.v.some((x, k) => k % 2 === 0 && ['ActualText', 'Alt', 'E'].includes(x.v));
      if (!has) return;
    } else if (!(p && p.t === 'name')) return;
    this.edit(m.op.start, m.op.end, keep ? `/${m.tag} <<${keep}>> BDC` : `/${m.tag} BMC`);
  }

  show(o, segs, kind, args) {
    const g = this.gs;
    const f = g.font ? this.font(g.font) : null;
    const M = mul(this.tm, g.ctm);
    const step = f?.m.cid ? 2 : 1;
    const asc = f ? f.asc : 0.9; const desc = f ? f.desc : -0.25;
    const parts = []; let removedAdv = 0; let adv = 0; let hits = 0;
    const flush = () => { if (removedAdv) { parts.push(fmt((-removedAdv * 1000) / (g.size * g.th))); removedAdv = 0; } };
    for (const seg of segs) {
      if (typeof seg === 'number') { flush(); parts.push(fmt(seg)); adv += (-seg / 1000) * g.size * g.th; continue; }
      let run = [];
      for (let i = 0; i + step <= seg.length; i += step) {
        const code = step === 2 ? seg[i] * 256 + seg[i + 1] : seg[i];
        const w = ((f ? f.m.width(code) * f.widthScale : 500) || 0) / 1000;
        const a = (w * g.size + g.tc + (step === 1 && code === 32 ? g.tw : 0)) * g.th;
        const box = bboxOf(quadOf(M, adv, g.rise + desc * g.size, adv + Math.max(w * g.size * g.th, 0), g.rise + asc * g.size));
        if (glyphHit(box, this.job.regions)) {
          hits++;
          if (run.length) { parts.push(hex(run)); run = []; }
          removedAdv += a;
        } else { flush(); for (let k = 0; k < step; k++) run.push(seg[i + k]); }
        adv += a;
      }
      if (run.length) { flush(); parts.push(hex(run)); }
    }
    flush();
    this.tm = mul([1, 0, 0, 1, adv, 0], this.tm);
    if (!hits) return;
    if (f?.vertical) throw new Error('A page has vertical text under a redaction mark, which cannot be placed exactly; nothing was changed.');
    if (!this.apply) { this.residue += hits; return; }
    this.job.report.glyphs += hits;
    this.removedHere();
    if (!(g.size * g.th)) { this.edit(o.start, o.end, kind === "'" || kind === '"' ? 'T*' : ''); return; }
    const tj = `[${parts.join(' ')}] TJ`;
    this.edit(o.start, o.end, kind === "'" ? `T* ${tj}` : kind === '"' ? `${fmt(args[0])} Tw ${fmt(args[1])} Tc T* ${tj}` : tj);
  }

  pathOp(o, n) {
    if (!this.path) this.path = { start: o.start, pts: [], clip: false };
    const c = this.gs.ctm; const add = (x, y) => this.path.pts.push(at(c, x, y));
    switch (o.op) {
      case 'm': case 'l': add(n[0], n[1]); break;
      case 'c': add(n[0], n[1]); add(n[2], n[3]); add(n[4], n[5]); break;
      case 'v': case 'y': add(n[0], n[1]); add(n[2], n[3]); break;
      case 're': add(n[0], n[1]); add(n[0] + n[2], n[1]); add(n[0], n[1] + n[3]); add(n[0] + n[2], n[1] + n[3]); break;
      default: break;
    }
  }

  paint(o) {
    const p = this.path; this.path = null;
    if (!p || !p.pts.length || !this.apply) return;
    if (o.op === 'n' && !p.clip) return;
    const c = this.gs.ctm;
    const stroke = /^[SsBb]/.test(o.op);
    const lw = stroke ? Math.max(this.gs.lw * Math.sqrt(Math.abs(c[0] * c[3] - c[1] * c[2])), 1) : 0;
    const b = bboxOf(p.pts); const box = [b[0] - lw, b[1] - lw, b[2] + lw, b[3] + lw];
    const hits = this.hitsOf(box);
    if (!hits.length) return;
    this.job.report.paths++;
    this.removedHere();
    if (coveredBy(box, hits)) {
      if (p.clip) this.edit(o.start, o.end, 'n'); else this.edit(p.start, o.end, '');
    } else if (p.clip) this.edit(o.start, o.end, 'n');
    else { this.edit(p.start, p.start, `q ${clipOut(hits, c, box)}`); this.edit(o.end, o.end, 'Q'); }
  }

  inlineImage(o) {
    const box = bboxOf(quadOf(this.gs.ctm, 0, 0, 1, 1));
    if (!this.hitsOf(box).length) return;
    if (!this.apply) { this.residue++; return; }
    this.job.report.inlineImages++;
    this.removedHere();
    this.edit(o.start, o.end, '');
  }

  async xobject(o, name) {
    const xo = this.category('XObject');
    const s = lookup(this.ctx, xo?.get(N(name)));
    if (!(s instanceof PDFStream)) return;
    const sub = nameOf(this.ctx, s.dict.get(N('Subtype')));
    if (sub === 'Image') await this.image(o, s);
    else if (sub === 'Form') await this.form(o, s);
  }

  async image(o, s) {
    const c = this.gs.ctm;
    const box = bboxOf(quadOf(c, 0, 0, 1, 1));
    const hits = this.hitsOf(box);
    if (!hits.length || !this.apply) return;
    const report = this.job.report;
    this.removedHere();
    if (quadCovered(c, hits)) { this.edit(o.start, o.end, ''); report.imagesRemoved++; return; }
    try {
      const ctx = this.ctx;
      if (lookup(ctx, s.dict.get(N('Mask'))) instanceof PDFStream) throw new Error('masked');
      const img = await decodeImage(ctx, s, this.job.codec);
      const back = inv(c);
      const clear = (target, values) => {
        for (const r of hits) {
          const uv = [at(back, r[0], r[1]), at(back, r[2], r[1]), at(back, r[2], r[3]), at(back, r[0], r[3])];
          const u0 = Math.min(...uv.map((p) => p[0])); const u1 = Math.max(...uv.map((p) => p[0]));
          const v0 = Math.min(...uv.map((p) => p[1])); const v1 = Math.max(...uv.map((p) => p[1]));
          fillPixels(target, Math.floor(u0 * target.width), Math.floor((1 - v1) * target.height), Math.ceil(u1 * target.width), Math.ceil((1 - v0) * target.height), values);
        }
      };
      const fill = this.job.fillFor(hits);
      let values;
      if (img.mask) { const d = numsOf(ctx, s.dict.get(N('Decode'))); values = [d && d[0] === 1 ? 0 : 1]; }
      else if (img.jpeg || (img.comps === 3 && nameOf(ctx, s.dict.get(N('ColorSpace'))) !== 'Indexed')) values = fill.map((v) => Math.round(v * (2 ** img.bpc - 1)));
      else if (img.comps === 1 && !/Indexed/.test(String(lookup(ctx, s.dict.get(N('ColorSpace')))))) values = [Math.round(((fill[0] + fill[1] + fill[2]) / 3) * (2 ** img.bpc - 1))];
      else if (img.comps === 4) values = [0, 0, 0, Math.round((1 - (fill[0] + fill[1] + fill[2]) / 3) * (2 ** img.bpc - 1))];
      else values = [0];
      clear(img, values);
      const copy = await encodeImage(ctx, s, img, this.job.codec);
      // A soft mask holds the shapes too: its covered part becomes transparent.
      const smask = lookup(ctx, s.dict.get(N('SMask')));
      if (smask instanceof PDFStream) {
        const m = await decodeImage(ctx, smask, this.job.codec);
        clear(m, [0]);
        copy.dict.set(N('SMask'), ctx.register(await encodeImage(ctx, smask, m, this.job.codec)));
      }
      const name = this.uniqueName('XObject', 'DPRedactIm');
      this.category('XObject', true).set(N(name), ctx.register(copy));
      this.edit(o.start, o.end, `/${name} Do`);
      report.imagesCleared++;
    } catch {
      this.edit(o.start, o.end, '');
      report.imagesRemoved++;
    }
  }

  async form(o, s) {
    const ctx = this.ctx;
    const m = numsOf(ctx, s.dict.get(N('Matrix'))) || [1, 0, 0, 1, 0, 0];
    const c = mul(m.length === 6 ? m : [1, 0, 0, 1, 0, 0], this.gs.ctm);
    const bb = numsOf(ctx, s.dict.get(N('BBox'))) || [0, 0, 0, 0];
    const box = bboxOf(quadOf(c, bb[0], bb[1], bb[2], bb[3]));
    if (!this.hitsOf(box).length) return;
    let bytes;
    try { bytes = streamBytes(s); } catch { bytes = null; }
    if (!bytes || this.depth >= MAX_DEPTH) {
      if (this.apply) { this.edit(o.start, o.end, ''); this.job.report.forms++; this.removedHere(); } else this.residue++;
      return;
    }
    const own = dictOf(ctx, s.dict.get(N('Resources')));
    const res = own && this.apply ? ownResources(ctx, own, this.job.owned) : own || this.res;
    const sub = await new Scope(this.job, { bytes, resources: res, ctm: c, gs: { ...this.gs }, depth: this.depth + 1 }).run();
    if (!this.apply) { this.residue += sub.residue; return; }
    if (!sub.edits.length) return;
    const dict = s.dict.clone(ctx);
    for (const k of ['Filter', 'DecodeParms', 'Length']) dict.delete(N(k));
    dict.set(N('Filter'), N('FlateDecode'));
    if (own) dict.set(N('Resources'), res);
    const name = this.uniqueName('XObject', 'DPRedactFm');
    this.category('XObject', true).set(N(name), ctx.register(PDFRawStream.of(dict, deflate(ctx, applyEdits(bytes, sub.edits)))));
    this.edit(o.start, o.end, `/${name} Do`);
    this.job.report.forms++;
    this.removedHere();
  }
}

/** A copy of a resource dictionary with its own XObject dictionary, which redaction may change. */
function ownResources(ctx, res, owned) {
  const copy = res.clone(ctx);
  const xo = dictOf(ctx, copy.get(N('XObject')));
  if (xo) { const c = xo.clone(ctx); copy.set(N('XObject'), c); owned.add(c); }
  return copy;
}

/** The XObject names drawn with each XObject dictionary, through the forms the content draws. */
function collectDrawn(ctx, bytes, res, map, seen, depth = 0) {
  const xo = dictOf(ctx, res?.get(N('XObject')));
  const names = (xo && map.get(xo)) || new Set();
  if (xo) map.set(xo, names);
  let ops;
  try { ops = tokenize(bytes); } catch { return; }
  for (const o of ops) {
    if (o.op !== 'Do' || o.args[0]?.t !== 'name') continue;
    const name = o.args[0].v;
    names.add(name);
    const ref = xo?.get(N(name)); const s = lookup(ctx, ref);
    if (!(s instanceof PDFStream) || nameOf(ctx, s.dict.get(N('Subtype'))) !== 'Form' || depth >= MAX_DEPTH) continue;
    const key = ref instanceof PDFRef ? ref.tag : s;
    if (seen.has(key)) continue;
    seen.add(key);
    let b; try { b = streamBytes(s); } catch { continue; }
    collectDrawn(ctx, b, dictOf(ctx, s.dict.get(N('Resources'))) || res, map, seen, depth + 1);
  }
}

/** Unlinks images and forms that the redacted content no longer draws, so their data leaves the file. */
function unlinkUndrawn(ctx, bytes, res, owned) {
  const map = new Map();
  collectDrawn(ctx, bytes, res, map, new Set());
  for (const xo of owned) {
    const drawn = map.get(xo) || new Set();
    for (const [k] of xo.entries()) if (!drawn.has(k.decodeText())) xo.delete(k);
  }
}

/** Removes the annotations of a page whose rectangle overlaps a mark (form fields left without widgets go too). */
function removeAnnotations(doc, page, regions, report) {
  const ctx = doc.context;
  const annots = lookup(ctx, page.node.get(N('Annots')));
  if (!(annots instanceof PDFArray)) return;
  const gone = new Set();
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i); const a = dictOf(ctx, ref);
    if (!a) continue;
    const r = numsOf(ctx, a.get(N('Rect')));
    if (!r || r.length !== 4) continue;
    if (!regions.some((m) => overlaps([Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])], m))) continue;
    annots.remove(i);
    if (ref instanceof PDFRef) gone.add(ref.tag);
    report.annotations++;
    if (nameOf(ctx, a.get(N('Subtype'))) === 'Widget') removeWidget(doc, ref, a, report);
  }
  // Pop-up notes of removed comments.
  for (let i = annots.size() - 1; i >= 0; i--) { const p = dictOf(ctx, annots.get(i))?.get(N('Parent')); if (p instanceof PDFRef && gone.has(p.tag) && nameOf(ctx, dictOf(ctx, annots.get(i)).get(N('Subtype'))) === 'Popup') annots.remove(i); }
}

function removeWidget(doc, ref, w, report) {
  const ctx = doc.context;
  const form = dictOf(ctx, doc.catalog.get(N('AcroForm')));
  const fields = form && lookup(ctx, form.get(N('Fields')));
  const drop = (list, r) => { if (list instanceof PDFArray) for (let i = list.size() - 1; i >= 0; i--) { const x = list.get(i); if (x instanceof PDFRef && x.tag === r.tag) list.remove(i); } };
  let child = ref; let parent = w.get(N('Parent'));
  if (!(parent instanceof PDFRef)) { if (ref instanceof PDFRef) { drop(fields, ref); report.fields++; } return; }
  // Up the field tree: a field without kids left goes too.
  for (let depth = 0; parent instanceof PDFRef && depth < 32; depth++) {
    const p = dictOf(ctx, parent);
    const kids = p && lookup(ctx, p.get(N('Kids')));
    drop(kids, child);
    if (kids instanceof PDFArray && kids.size()) return;
    const up = p?.get(N('Parent'));
    if (!(up instanceof PDFRef)) { drop(fields, parent); report.fields++; return; }
    child = parent; parent = up;
  }
}

/** Removes document information, XMP metadata and tag texts that repeat the removed text. Returns what was removed. */
function cleanMetadata(doc, words) {
  const out = [];
  const list = [...new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3))];
  if (!list.length) return out;
  const has = (s) => { const t = String(s || '').toLowerCase(); return list.some((w) => t.includes(w)); };
  const ctx = doc.context;
  const info = dictOf(ctx, ctx.trailerInfo.Info);
  if (info) for (const [k, v] of info.entries()) { const o = lookup(ctx, v); if ((o instanceof PDFString || o instanceof PDFHexString) && has(o.decodeText())) { info.delete(k); out.push(k.decodeText()); } }
  const xmp = lookup(ctx, doc.catalog.get(N('Metadata')));
  if (xmp instanceof PDFStream) {
    let text = '';
    try { text = new TextDecoder().decode(streamBytes(xmp)); } catch { text = ''; }
    if (has(text)) { doc.catalog.delete(N('Metadata')); out.push('XMP metadata'); }
  }
  // Tags: alternate descriptions and actual texts that hold the removed text.
  const root = dictOf(ctx, doc.catalog.get(N('StructTreeRoot')));
  if (root) {
    const seen = new Set(); const stack = [root.get(N('K'))]; let n = 0;
    while (stack.length && seen.size < 200000) {
      const v = stack.pop();
      if (v instanceof PDFRef) { if (seen.has(v.tag)) continue; seen.add(v.tag); }
      const o = lookup(ctx, v);
      if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) stack.push(o.get(i)); continue; }
      if (!(o instanceof PDFDict)) continue;
      for (const k of ['Alt', 'ActualText', 'E', 'T']) { const s = lookup(ctx, o.get(N(k))); if ((s instanceof PDFString || s instanceof PDFHexString) && has(s.decodeText())) { o.delete(N(k)); n++; } }
      stack.push(o.get(N('K')));
    }
    if (n) out.push(`${n} tag text(s)`);
  }
  return out;
}

/** Where the removed text still appears without being removed: bookmark titles and attachment names. */
function stillHolding(doc, words) {
  const list = [...new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3))];
  const out = { bookmarks: 0 };
  if (!list.length) return out;
  const ctx = doc.context;
  const outlines = dictOf(ctx, doc.catalog.get(N('Outlines')));
  const seen = new Set(); const stack = outlines ? [outlines.get(N('First'))] : [];
  while (stack.length && seen.size < 100000) {
    const r = stack.pop();
    if (!(r instanceof PDFRef) || seen.has(r.tag)) continue;
    seen.add(r.tag);
    const d = dictOf(ctx, r); if (!d) continue;
    const t = lookup(ctx, d.get(N('Title')));
    if ((t instanceof PDFString || t instanceof PDFHexString) && list.some((w) => t.decodeText().toLowerCase().includes(w))) out.bookmarks++;
    stack.push(d.get(N('Next')), d.get(N('First')));
  }
  return out;
}

const DEFAULT_LOOK = { fill: [0, 0, 0], text: '', textColor: [1, 1, 1], size: 0, align: 1, repeat: false };

/**
 * Applies redaction marks. marks: Map(page index -> [{rect: [x0, y0, x1, y1] in PDF coordinates, look?}]) with
 * look {fill: [r, g, b] | null, text, textColor, size (0 = fit), align (0 left, 1 centre, 2 right), repeat}.
 * o: {codec (for JPEG images), removedText: words that lie under the marks, look: default look}.
 * Returns {bytes, report}. Throws, leaving nothing changed, when the result cannot be verified.
 */
export async function applyRedactions(bytes, marks, o = {}) {
  const doc = await loadForEdit(bytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  const report = { pages: 0, glyphs: 0, paths: 0, imagesCleared: 0, imagesRemoved: 0, inlineImages: 0, forms: 0, annotations: 0, fields: 0, metadata: [], stillHolding: null };
  const lookOf = (m) => ({ ...DEFAULT_LOOK, ...(o.look || {}), ...(m.look || {}) });
  for (const [i, list] of marks) {
    const page = pages[i];
    if (!page || !list.length) continue;
    const regions = list.map((m) => [Math.min(m.rect[0], m.rect[2]), Math.min(m.rect[1], m.rect[3]), Math.max(m.rect[0], m.rect[2]), Math.max(m.rect[1], m.rect[3])]);
    const mb = page.getMediaBox();
    const job = {
      ctx, regions, mode: 'apply', codec: o.codec, report, around: [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height], owned: new Set(),
      fillFor: (hits) => { const k = regions.indexOf(hits[0]); return lookOf(list[Math.max(0, k)]).fill || [1, 1, 1]; },
    };
    // The page's resources become its own, so new entries do not change other pages sharing them.
    let res = page.node.Resources();
    if (!res) { res = ctx.obj({}); }
    res = ownResources(ctx, res, job.owned);
    page.node.set(N('Resources'), res);
    const content = pageContentBytes(page);
    const scope = await new Scope(job, { bytes: content, resources: res, ctm: [1, 0, 0, 1, 0, 0] }).run();
    if (scope.edits.length) {
      const out = applyEdits(content, scope.edits);
      page.node.set(N('Contents'), ctx.register(PDFRawStream.of(ctx.obj({ Filter: 'FlateDecode' }), deflate(ctx, out))));
      unlinkUndrawn(ctx, out, res, job.owned);
    }
    removeAnnotations(doc, page, regions, report);
    report.pages++;
    // Verification: nothing under the marks may remain.
    const check = await new Scope({ ...job, mode: 'verify' }, { bytes: pageContentBytes(page), resources: res, ctm: [1, 0, 0, 1, 0, 0] }).run();
    if (check.residue) throw new Error(`The redaction could not be verified: ${check.residue} item(s) were still found under the marks on page ${i + 1}, so nothing was changed.`);
    // The marks become boxes with their overlay text.
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    list.forEach((m, k) => {
      const look = lookOf(m); const r = regions[k];
      const w = r[2] - r[0]; const h = r[3] - r[1];
      if (look.fill) page.drawRectangle({ x: r[0], y: r[1], width: w, height: h, color: rgb(...look.fill) });
      const text = sanitizeFor(font, look.text || '');
      if (!text.trim() || w < 2 || h < 2) return;
      const fit = Math.min(h * 0.8, (w * 0.95 * 1000) / Math.max(1, font.widthOfTextAtSize(text, 1000)));
      const size = look.size > 0 ? Math.min(look.size, h) : Math.max(2, Math.min(fit, 24));
      const tw = font.widthOfTextAtSize(text, size);
      const draw = (x, y) => page.drawText(text, { x, y, size, font, color: rgb(...(look.textColor || [1, 1, 1])) });
      if (look.repeat && tw > 0) {
        for (let y = r[3] - size; y >= r[1] - 0.01; y -= size * 1.2) for (let x = r[0] + 1; x + tw <= r[2] + 0.01; x += tw + size * 0.5) draw(x, y);
      } else {
        const x = look.align === 0 ? r[0] + 2 : look.align === 2 ? r[2] - tw - 2 : r[0] + (w - tw) / 2;
        draw(x, r[1] + (h - size * 0.72) / 2);
      }
    });
  }
  report.metadata = cleanMetadata(doc, o.removedText || []);
  report.stillHolding = stillHolding(doc, o.removedText || []);
  collectGarbage(doc);
  return { bytes: await saveDoc(doc), report };
}

/** Text items of PDF.js text content (with transform, width, height) that lie under a rectangle. */
export function wordsUnder(items, rects) {
  const out = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform; const x = t[4]; const y = t[5]; const w = it.width; const hgt = it.height || Math.hypot(t[2], t[3]);
    const box = [x, y - hgt * 0.2, x + w, y + hgt * 0.9];
    if (rects.some((r) => overlaps(box, r))) out.push(it);
  }
  return out;
}

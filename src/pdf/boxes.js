// Page boxes (ISO 32000-2, 14.11.2) and reversing the page order.
//
// The crop, bleed, trim and art boxes default to their "parent" box (crop -> media; the others -> crop) and are
// clipped to the media box. Margins are measured inward from the media box in default user space (the unrotated
// page). Setting a box validates every page first, so a failure changes nothing; removing the crop box pins the
// media box when an ancestor in the page tree would otherwise supply its crop box again.
// Reversing turns the order of the chosen pages around among the positions they occupy; every other page stays.
//
// Ported from PdfCraft's organize crate (boxes, reverse_pages) (Copyright (c) 2026 ArtCraft Team and the PdfCraft
// contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFArray, PDFNumber } from '@cantoo/pdf-lib';

export const BOXES = [['MediaBox', 'Media box'], ['CropBox', 'Crop box'], ['BleedBox', 'Bleed box'], ['TrimBox', 'Trim box'], ['ArtBox', 'Art box']];

/** A normalized rectangle [xmin, ymin, xmax, ymax] from a PDF array, or null when it is not a valid box. */
function rectOf(ctx, o) {
  const a = o ? ctx.lookup(o) : null;
  if (!(a instanceof PDFArray) || a.size() !== 4) return null;
  const v = a.asArray().map((x) => { const n = ctx.lookup(x); return n instanceof PDFNumber ? n.asNumber() : NaN; });
  if (!v.every(Number.isFinite)) return null;
  const r = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  return r[2] - r[0] > 0 && r[3] - r[1] > 0 ? r : null;
}
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const clip = (a, b) => { const r = intersect(a, b); return r[2] > r[0] && r[3] > r[1] ? r : null; };

/** A page attribute, looked up through the page tree (MediaBox and CropBox are inheritable). */
function inherited(node, key) {
  for (let n = node, depth = 0; n && depth < 64; depth++) {
    const v = n.get(PDFName.of(key));
    if (v) return v;
    const parent = n.get(PDFName.of('Parent'));
    n = parent ? n.context.lookup(parent) : null;
  }
  return undefined;
}

/** The effective boxes of a page: {MediaBox, CropBox, BleedBox, TrimBox, ArtBox} as [xmin, ymin, xmax, ymax]. */
export function pageBoxes(page) {
  const n = page.node; const ctx = n.context;
  const media = rectOf(ctx, inherited(n, 'MediaBox')) || [0, 0, 612, 792];
  const crop = clip(rectOf(ctx, inherited(n, 'CropBox')) || media, media) || media;
  const child = (k) => { const r = rectOf(ctx, n.get(PDFName.of(k))); return (r && clip(r, media)) || crop; };
  return { MediaBox: media, CropBox: crop, BleedBox: child('BleedBox'), TrimBox: child('TrimBox'), ArtBox: child('ArtBox') };
}

/** Whether a page sets a box itself (bleed, trim and art boxes are not inherited). */
export const hasOwnBox = (page, key) => !!rectOf(page.node.context, key === 'MediaBox' || key === 'CropBox' ? inherited(page.node, key) : page.node.get(PDFName.of(key)));

/**
 * Sets a box on the pages (0-based) of a loaded document. spec: {remove: true} (back to its parent box),
 * {rect: [x0, y0, x1, y1]} or {margins: [left, bottom, right, top]} in points inward from each page's media box.
 */
export function setPageBox(doc, pages, key, spec) {
  if (!BOXES.some(([k]) => k === key)) throw new Error(`Unknown page box: ${key}`);
  if (key === 'MediaBox' && spec.remove) throw new Error('The media box cannot be removed.');
  const all = doc.getPages();
  const plan = pages.map((i) => {
    if (!all[i]) throw new Error(`Page ${i + 1} does not exist.`);
    const media = pageBoxes(all[i]).MediaBox;
    let r = null;
    if (spec.rect) {
      if (!spec.rect.every(Number.isFinite)) throw new Error('The rectangle is not a number.');
      const s = spec.rect;
      r = [Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3])];
      if (key !== 'MediaBox') r = intersect(r, media);
    } else if (spec.margins) {
      const m = spec.margins;
      if (!m.every((x) => Number.isFinite(x) && x >= 0)) throw new Error('Margins must be zero or more.');
      r = [media[0] + m[0], media[1] + m[1], media[2] - m[2], media[3] - m[3]];
    }
    if (r && (r[2] - r[0] < 1 || r[3] - r[1] < 1)) throw new Error(`Page ${i + 1} would be smaller than a point.`);
    return { page: all[i], r, media };
  });
  for (const { page, r, media } of plan) {
    const n = page.node;
    if (r) n.set(PDFName.of(key), n.context.obj(r));
    else {
      n.delete(PDFName.of(key));
      // An ancestor's crop box would come back: pin the media box instead.
      if (key === 'CropBox' && rectOf(n.context, inherited(n, 'CropBox'))) n.set(PDFName.of('CropBox'), n.context.obj(media));
    }
  }
}

/** The new page order (old indices) that reverses the chosen pages among the positions they occupy. */
export function reversedOrder(n, indices) {
  const slots = [...new Set(indices)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  if (slots.length < 2) throw new Error('Reversing needs at least two pages.');
  const order = Array.from({ length: n }, (_, i) => i);
  slots.forEach((slot, k) => { order[slot] = slots[slots.length - 1 - k]; });
  return order;
}

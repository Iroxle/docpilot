// Enhance scans and photographed pages (pure pixel functions on RGBA or gray images).
//
// - Clean up: the paper's lighting is evened out (estimated per channel on a coarse grid of blocks from each block's
//   bright end, smoothed and divided out), so the paper turns white and shadows and darker edges go; the contrast is
//   raised; isolated specks are removed (3x3 median for salt-and-pepper noise).
// - Black and white: Sauvola thresholding (window 8, k 0.34) through an integral image, then a one-pixel dilation of
//   the ink, so strokes stay whole.
// - Perspective of phone photos: the sheet's corners are found as the four strongest straight lines (a Hough
//   transform voting along each edge's gradient) that enclose a large convex area with an edge along most of each
//   side; the area inside the corners is warped to an upright rectangle (homography, bilinear sampling).
//
// Ported from PdfCraft's engine and ocr crates (camera, camera_edges, camera_clean, scan_clean, preprocess) (Copyright (c) 2026
// ArtCraft Team and the PdfCraft contributors, MIT license, see THIRD_PARTY_NOTICES.md).
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { interpret } from './content.js';
import { decodeImage, filtersOf, componentsOf, deflate } from './imagedata.js';

/** Gray values (0-255) of an RGBA image {width, height, data}. */
export function toGray(img) {
  const n = img.width * img.height; const g = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) g[i] = Math.round(0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]);
  return g;
}

/** 3x3 median of a gray image (edges clamped). */
export function median3(g, w, h) {
  const out = new Uint8ClampedArray(g.length); const win = new Array(9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[k++] = g[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
    win.sort((a, b) => a - b);
    out[y * w + x] = win[4];
  }
  return out;
}

/** Sauvola ink mask (window 8, k 0.34) through integral images; true where a pixel is ink. */
export function sauvolaMask(g, w, h, k = 0.34, half = 4) {
  const stride = w + 1;
  const sums = new Float64Array(stride * (h + 1)); const sq = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0; let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x]; rs += v; rq += v * v;
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + rs;
      sq[(y + 1) * stride + x + 1] = sq[y * stride + x + 1] + rq;
    }
  }
  const rect = (a, x0, y0, x1, y1) => a[y1 * stride + x1] - a[y0 * stride + x1] - a[y1 * stride + x0] + a[y0 * stride + x0];
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - half); const y0 = Math.max(0, y - half); const x1 = Math.min(w, x + half); const y1 = Math.min(h, y + half);
    const n = (x1 - x0) * (y1 - y0);
    const mean = rect(sums, x0, y0, x1, y1) / n;
    const v = Math.max(0, rect(sq, x0, y0, x1, y1) / n - mean * mean);
    const t = mean * (1 + k * (Math.sqrt(v) / 128 - 1));
    ink[y * w + x] = g[y * w + x] <= t ? 1 : 0;
  }
  return ink;
}
function dilate1(ink, w, h) {
  const out = ink.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (ink[y * w + x]) continue;
    let hit = 0;
    for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1 && !hit; dx++) { const xx = x + dx; const yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && ink[yy * w + xx]) hit = 1; }
    out[y * w + x] = hit;
  }
  return out;
}
/** Black and white (0 ink, 255 paper) from a gray image. */
export function binarize(g, w, h) {
  // Uniform areas (paper) have no local contrast; only keep ink that is darker than the paper around it.
  const ink = dilate1(sauvolaMask(g, w, h), w, h);
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = ink[i] && g[i] < 200 ? 0 : 255;
  return out;
}

/**
 * Evens out the lighting of an RGB(A) image in place: per channel, the paper level of each block (the bright end of
 * its values) is smoothed into a map and divided out, so the paper becomes white. strength 0-1 raises the contrast.
 */
export function evenOut(img, strength = 0.6) {
  const { width: w, height: h, data } = img;
  const B = Math.max(16, Math.round(Math.max(w, h) / 24));
  const bw = Math.ceil(w / B); const bh = Math.ceil(h / B);
  for (let c = 0; c < 3; c++) {
    const level = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const hist = new Uint32Array(256); let n = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++) for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) { hist[data[(y * w + x) * 4 + c]]++; n++; }
      // The 90th percentile: the paper, not the ink.
      let acc = 0; let v = 255;
      for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.1) { v = i; break; } }
      level[by * bw + bx] = Math.max(40, v);
    }
    // Smooth the map (3x3 box, twice) and divide it out with bilinear interpolation between block centres.
    let m = level;
    for (let pass = 0; pass < 2; pass++) {
      const s = new Float32Array(m.length);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        let sum = 0; let k = 0;
        // Mirrored at the edges, so a lighting gradient is not bent towards the middle there.
        const rf = (v, n) => (n === 1 ? 0 : v < 0 ? -v : v >= n ? 2 * (n - 1) - v : v);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { sum += m[rf(y + dy, bh) * bw + rf(x + dx, bw)]; k++; }
        s[y * bw + x] = sum / k;
      }
      m = s;
    }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)); const y0 = Math.floor(fy); const y1 = Math.min(bh - 1, y0 + 1); const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)); const x0 = Math.floor(fx); const x1 = Math.min(bw - 1, x0 + 1); const tx = fx - x0;
        const p = (m[y0 * bw + x0] * (1 - tx) + m[y0 * bw + x1] * tx) * (1 - ty) + (m[y1 * bw + x0] * (1 - tx) + m[y1 * bw + x1] * tx) * ty;
        const i = (y * w + x) * 4 + c;
        // The white point lies a little under the paper level, so all of the paper becomes white.
        let v = Math.min(255, (data[i] / (p * 0.92)) * 255);
        // Contrast: stretch so the paper is white and dark ink darker.
        v = 255 - (255 - v) * (1 + strength);
        data[i] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return img;
}

/** Removes isolated dark specks (at most 2x2 pixels with no dark neighbours) from a gray image in place. */
export function despeckle(g, w, h, dark = 128) {
  let n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (g[y * w + x] >= dark) continue;
    let ring = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      const xx = x + dx; const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && g[yy * w + xx] < dark) ring++;
    }
    if (!ring) { g[y * w + x] = 255; n++; }
  }
  return n;
}

/**
 * Cleans a scan image {width, height, data (RGBA)}: o.mode 'clean' (paper white, contrast, specks removed; colour
 * stays) or 'bw' (black and white), o.denoise (median). Returns a new RGBA image.
 */
export function enhanceImage(img, o = {}) {
  const w = img.width; const h = img.height;
  const out = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  evenOut(out, o.strength ?? 0.5);
  const g0 = toGray(out);
  let g = g0;
  if (o.denoise !== false) g = median3(g0, w, h);
  if (o.mode === 'bw') {
    const b = binarize(g, w, h);
    despeckle(b, w, h);
    for (let i = 0; i < w * h; i++) { out.data[i * 4] = b[i]; out.data[i * 4 + 1] = b[i]; out.data[i * 4 + 2] = b[i]; out.data[i * 4 + 3] = 255; }
    return out;
  }
  // Colour: keep the cleaned colours, but take out the dark specks where the median says paper.
  for (let i = 0; i < w * h; i++) if (g0[i] < 128 && g[i] > 200) { out.data[i * 4] = 255; out.data[i * 4 + 1] = 255; out.data[i * 4 + 2] = 255; }
  return out;
}

// --- Perspective ----------------------------------------------------------------------------------------------
/** Orders four points as top-left, top-right, bottom-right, bottom-left (image coordinates, y down); null if not convex. */
export function orderQuad(q) {
  if (q.length !== 4 || q.some((p) => !p.every(Number.isFinite))) return null;
  const cx = q.reduce((s, p) => s + p[0], 0) / 4; const cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const pts = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Start at the corner nearest the top left (smallest x + y).
  let k = 0; for (let i = 1; i < 4; i++) if (pts[i][0] + pts[i][1] < pts[k][0] + pts[k][1]) k = i;
  const o = [0, 1, 2, 3].map((i) => pts[(k + i) % 4]);
  // Convex: all cross products of consecutive edges have the same sign.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = o[i]; const b = o[(i + 1) % 4]; const c = o[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) return null;
    if (sign && Math.sign(cr) !== sign) return null;
    sign = Math.sign(cr);
  }
  return o;
}

/** The homography mapping four source points to four destination points, as 9 numbers (h33 = 1), or null. */
export function homography(src, dst) {
  const A = []; const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]; const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}
export const applyH = (H, [x, y]) => { const d = H[6] * x + H[7] * y + H[8]; return Math.abs(d) < 1e-12 ? null : [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };

/**
 * Warps the quadrilateral quad (image pixels) of an RGBA image to an upright rectangle as large as its longer sides
 * (at most maxPixels). Outside the image is white. Returns {width, height, data}.
 */
export function warp(img, quad, maxPixels = 40e6) {
  const q = orderQuad(quad);
  if (!q) throw new Error('The four corners must enclose an area.');
  const [tl, tr, br, bl] = q;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = Math.max(dist(tl, tr), dist(bl, br)); let oh = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, Math.sqrt(maxPixels / Math.max(1, ow * oh)));
  ow = Math.max(1, Math.floor(ow * k)); oh = Math.max(1, Math.floor(oh * k));
  const H = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], [tl, tr, br, bl]);
  if (!H) throw new Error('The four corners must not be in a line.');
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const s = applyH(H, [x + 0.5, y + 0.5]);
    const o = (y * ow + x) * 4;
    out[o + 3] = 255;
    if (!s) { out[o] = out[o + 1] = out[o + 2] = 255; continue; }
    const fx = s[0] - 0.5; const fy = s[1] - 0.5;
    if (!(fx > -1 && fy > -1 && fx < w && fy < h)) { out[o] = out[o + 1] = out[o + 2] = 255; continue; }
    const x0 = Math.floor(fx); const y0 = Math.floor(fy); const ax = fx - x0; const ay = fy - y0;
    const cl = (v, n) => Math.min(n - 1, Math.max(0, v));
    const xa = cl(x0, w); const xb = cl(x0 + 1, w); const ya = cl(y0, h); const yb = cl(y0 + 1, h);
    for (let c = 0; c < 3; c++) {
      const p = (xx, yy) => data[(yy * w + xx) * 4 + c];
      const top = p(xa, ya) * (1 - ax) + p(xb, ya) * ax; const bot = p(xa, yb) * (1 - ax) + p(xb, yb) * ax;
      out[o + c] = Math.round(top * (1 - ay) + bot * ay);
    }
  }
  return { width: ow, height: oh, data: out };
}

// Finding the sheet in a photo.
const WORK = 400; const MAX_LINES = 24; const MIN_SUPPORT = 0.55; const MIN_AREA = 0.12; const MARGIN = 0.02;
function shrinkGray(img) {
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.ceil(Math.max(w, h) / WORK));
  const sw = Math.ceil(w / step); const sh = Math.ceil(h / step);
  const v = new Float32Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
    let sum = 0; let n = 0;
    for (let y = sy * step; y < Math.min(h, (sy + 1) * step); y++) for (let x = sx * step; x < Math.min(w, (sx + 1) * step); x++) { const i = (y * w + x) * 4; sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++; }
    v[sy * sw + sx] = n ? sum / n : 255;
  }
  return { w: sw, h: sh, v, step };
}
const at = (g, x, y) => g.v[Math.min(g.h - 1, Math.max(0, y)) * g.w + Math.min(g.w - 1, Math.max(0, x))];
function blur(g) {
  const v = new Float32Array(g.v.length);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    let s = 0;
    for (const [dy, wy] of [[-1, 1], [0, 2], [1, 1]]) for (const [dx, wx] of [[-1, 1], [0, 2], [1, 1]]) s += wy * wx * at(g, x + dx, y + dy);
    v[y * g.w + x] = s / 16;
  }
  return { ...g, v };
}
function edgeMap(g) {
  const n = g.w * g.h; const mag = new Float32Array(n); const dir = new Float32Array(n);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const p = (dx, dy) => at(g, x + dx, y + dy);
    const gx = (p(1, -1) + 2 * p(1, 0) + p(1, 1)) - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1));
    const gy = (p(-1, 1) + 2 * p(0, 1) + p(1, 1)) - (p(-1, -1) + 2 * p(0, -1) + p(1, -1));
    mag[y * g.w + x] = Math.hypot(gx, gy); dir[y * g.w + x] = Math.atan2(gy, gx);
  }
  const sorted = Float32Array.from(mag).sort();
  const threshold = Math.max(0.25 * (sorted[Math.floor(n * 0.98)] || 0), 24);
  const m = (x, y) => (x < 0 || y < 0 || x >= g.w || y >= g.h ? 0 : mag[y * g.w + x]);
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % g.w; const y = Math.floor(i / g.w);
    if (!(x > 1 && y > 1 && x < g.w - 2 && y < g.h - 2) || mag[i] < threshold) continue;
    const dx = Math.round(Math.cos(dir[i])); const dy = Math.round(Math.sin(dir[i]));
    if (mag[i] >= m(x + dx, y + dy) && mag[i] >= m(x - dx, y - dy)) keep[i] = 1;
  }
  return { w: g.w, h: g.h, mag, dir, keep };
}
function hough(E) {
  const STEPS = 180; const { w, h } = E;
  const diag = Math.ceil(Math.hypot(w, h)); const rows = 2 * diag + 1;
  const acc = new Float32Array(STEPS * rows);
  const trig = Array.from({ length: STEPS }, (_, t) => [Math.cos((t * Math.PI) / 180), Math.sin((t * Math.PI) / 180)]);
  for (let i = 0; i < w * h; i++) {
    if (!E.keep[i]) continue;
    const x = i % w; const y = Math.floor(i / w);
    const normal = Math.round((((E.dir[i] * 180) / Math.PI) % 180 + 180) % 180);
    for (let t = normal - 6; t <= normal + 6; t++) {
      const tt = ((t % STEPS) + STEPS) % STEPS;
      const r = Math.round(x * trig[tt][0] + y * trig[tt][1]) + diag;
      if (r >= 0 && r < rows) acc[tt * rows + r] += E.mag[i];
    }
  }
  const lines = []; let first = 0;
  for (const v of acc) first = Math.max(first, v);
  while (lines.length < MAX_LINES) {
    let best = -1; let bv = 0;
    for (let i = 0; i < acc.length; i++) if (acc[i] > bv) { bv = acc[i]; best = i; }
    if (best < 0 || bv < 0.08 * first) break;
    const t = Math.floor(best / rows); const r = best % rows;
    lines.push({ theta: (t * Math.PI) / 180, rho: r - diag });
    for (let dt = -6; dt <= 6; dt++) {
      let tt = t + dt; let flip = false;
      if (tt < 0) { tt += STEPS; flip = true; } else if (tt >= STEPS) { tt -= STEPS; flip = true; }
      const rr = flip ? 2 * diag - r : r;
      for (let dr = -6; dr <= 6; dr++) { const q = rr + dr; if (q >= 0 && q < rows) acc[tt * rows + q] = 0; }
    }
  }
  return lines;
}
function intersectLines(a, b) {
  const c1 = Math.cos(a.theta); const s1 = Math.sin(a.theta); const c2 = Math.cos(b.theta); const s2 = Math.sin(b.theta);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-6) return null;
  return [(a.rho * s2 - b.rho * s1) / det, (c1 * b.rho - c2 * a.rho) / det];
}
function support(a, b, E) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1) return 0;
  const ux = (b[0] - a[0]) / len; const uy = (b[1] - a[1]) / len;
  const normal = Math.atan2(ux, -uy);
  const n = Math.max(8, Math.min(200, Math.floor(len / 2)));
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const t = 0.05 + (0.9 * (i + 0.5)) / n;
    const px = a[0] + (b[0] - a[0]) * t; const py = a[1] + (b[1] - a[1]) * t;
    let hit = false;
    for (let o = -2; o <= 2 && !hit; o++) {
      const x = Math.round(px - uy * o); const y = Math.round(py + ux * o);
      if (x < 0 || y < 0 || x >= E.w || y >= E.h) continue;
      const k = y * E.w + x;
      if (!E.keep[k]) continue;
      const d = (((E.dir[k] - normal) % Math.PI) + Math.PI) % Math.PI;
      if (!(d >= 0.35 && d <= Math.PI - 0.35)) hit = true;
    }
    if (hit) hits++;
  }
  return hits / n;
}
function quadScore(q, E) {
  const { w, h } = E;
  if (q.some((p) => p[0] < -MARGIN * w || p[1] < -MARGIN * h || p[0] > w * (1 + MARGIN) || p[1] > h * (1 + MARGIN))) return null;
  let area = 0; for (let k = 0; k < 4; k++) { const p = q[k]; const nx = q[(k + 1) % 4]; area += p[0] * nx[1] - nx[0] * p[1]; }
  area = Math.abs(area) / 2;
  if (area < MIN_AREA * w * h) return null;
  const sides = [0, 1, 2, 3].map((k) => support(q[k], q[(k + 1) % 4], E));
  if (sides.some((s) => s < MIN_SUPPORT)) return null;
  const mean = sides.reduce((s, v) => s + v, 0) / 4;
  return area * mean * mean;
}
/**
 * The corners of a photographed sheet in an RGBA image (pixels, top-left, top-right, bottom-right, bottom-left),
 * or null when its edges cannot be found with confidence.
 */
export function detectDocument(img) {
  if (img.width < 16 || img.height < 16) return null;
  const g = shrinkGray(img);
  const E = edgeMap(blur(blur(g)));
  const lines = hough(E);
  const flat = (l) => Math.abs((l.theta * 180) / Math.PI - 90) <= 45;
  const hor = lines.filter(flat); const ver = lines.filter((l) => !flat(l));
  let best = null;
  for (let i = 0; i < hor.length; i++) for (let i2 = i + 1; i2 < hor.length; i2++) for (let j = 0; j < ver.length; j++) for (let j2 = j + 1; j2 < ver.length; j2++) {
    const c = [intersectLines(hor[i], ver[j]), intersectLines(hor[i], ver[j2]), intersectLines(hor[i2], ver[j2]), intersectLines(hor[i2], ver[j])];
    if (c.some((p) => !p)) continue;
    const q = orderQuad(c);
    if (!q) continue;
    const s = quadScore(q, E);
    if (s !== null && (!best || s > best[0])) best = [s, q];
  }
  if (!best) return null;
  const k = Math.max(img.width, img.height) / Math.max(g.w, g.h);
  return best[1].map(([x, y]) => [(x + 0.5) * k, (y + 0.5) * k]);
}

// --- Scanned pages in the PDF ---------------------------------------------------------------------------------
/**
 * Enhance scanned pages: each scan image is decoded, cleaned and written back into the same image object, so the
 * recognized text, comments, links and form fields stay. A page is a scan when its images cover at least half of it;
 * the images covering a tenth of it or more are its scan. o: {mode: 'clean'|'bw', denoise, codec}. A JPEG stays a JPEG
 * in "clean" (through the codec); black and white is stored as 1-bit Flate. Returns {pages, images, left, notScans}.
 */
export async function enhanceScans(doc, pages = doc.getPageIndices(), o = {}) {
  const ctx = doc.context;
  const out = { pages: 0, images: 0, left: 0, notScans: [] };
  const done = new Set();
  for (const i of pages) {
    const page = doc.getPage(i);
    const { x, y, width, height } = page.getCropBox();
    const area = Math.max(1, width * height);
    let items = [];
    try { items = interpret(page).items.filter((it) => it.kind === 'image'); } catch { items = []; }
    const clip = (b) => Math.max(0, Math.min(b[2], x + width) - Math.max(b[0], x)) * Math.max(0, Math.min(b[3], y + height) - Math.max(b[1], y));
    const cover = items.reduce((s, it) => s + clip(it.bbox), 0);
    if (cover < area * 0.5) { out.notScans.push(i); continue; }
    const xo = page.node.Resources()?.lookup(PDFName.of('XObject'));
    let changed = false;
    for (const it of items.filter((t) => clip(t.bbox) >= area * 0.1)) {
      const ref = xo instanceof PDFDict ? xo.get(PDFName.of(it.name)) : null;
      if (!(ref instanceof PDFRef) || done.has(ref.toString())) continue;
      done.add(ref.toString());
      const s = ctx.lookup(ref);
      try {
        const rgba = await imageToRgba(ctx, s, o.codec);
        const img = enhanceImage(rgba, { mode: o.mode, denoise: o.denoise });
        ctx.assign(ref, await storeImage(ctx, s, img, o));
        out.images++; changed = true;
      } catch { out.left++; }
    }
    if (changed) out.pages++;
  }
  return out;
}

/** An image XObject as RGBA pixels (8-bit gray, RGB, or JPEG through the codec). */
async function imageToRgba(ctx, s, codec) {
  if (!(s instanceof PDFRawStream)) throw new Error('not an image');
  const cs = s.dict.lookup(PDFName.of('ColorSpace'));
  const family = cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray ? cs.lookup(0)?.decodeText?.() : null;
  if (['Indexed', 'I', 'Separation', 'DeviceN', 'Lab'].includes(family) || s.dict.get(PDFName.of('ImageMask'))) throw new Error('not supported');
  const im = await decodeImage(ctx, s, codec);
  if (im.bpc !== 8 || !(im.comps === 1 || im.comps === 3)) throw new Error('not supported');
  const n = im.width * im.height; const data = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const r = im.data[p * im.comps]; const g = im.comps === 3 ? im.data[p * 3 + 1] : r; const b = im.comps === 3 ? im.data[p * 3 + 2] : r;
    data[p * 4] = r; data[p * 4 + 1] = g; data[p * 4 + 2] = b; data[p * 4 + 3] = 255;
  }
  return { width: im.width, height: im.height, data, jpeg: im.jpeg, comps: im.comps };
}

/** The cleaned image as a new stream with the entries of the old one (soft mask, interpolation and so on). */
async function storeImage(ctx, old, img, o) {
  const dict = old.dict.clone(ctx);
  for (const k of ['Filter', 'DecodeParms', 'DP', 'Length', 'Decode']) dict.delete(PDFName.of(k));
  dict.set(PDFName.of('Width'), PDFNumber.of(img.width)); dict.set(PDFName.of('Height'), PDFNumber.of(img.height));
  const n = img.width * img.height;
  if (o.mode === 'bw') {
    const row = Math.ceil(img.width / 8); const bits = new Uint8Array(row * img.height);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4] >= 128) bits[y * row + (x >> 3)] |= 0x80 >> (x & 7);
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray')); dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(1));
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    return PDFRawStream.of(dict, deflate(ctx, bits));
  }
  const wasJpeg = !!filtersOf(ctx, old.dict).find((f) => f.name === 'DCTDecode');
  if (wasJpeg && o.codec?.encodeJpeg) {
    const bytes = await o.codec.encodeJpeg(new Uint8ClampedArray(img.data), img.width, img.height, 0.9);
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB')); dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8)); dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    return PDFRawStream.of(dict, bytes);
  }
  const gray = componentsOf(ctx, old.dict.get(PDFName.of('ColorSpace'))) === 1;
  const px = new Uint8Array(n * (gray ? 1 : 3));
  for (let p = 0; p < n; p++) { if (gray) px[p] = img.data[p * 4]; else { px[p * 3] = img.data[p * 4]; px[p * 3 + 1] = img.data[p * 4 + 1]; px[p * 3 + 2] = img.data[p * 4 + 2]; } }
  dict.set(PDFName.of('ColorSpace'), PDFName.of(gray ? 'DeviceGray' : 'DeviceRGB')); dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8)); dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  return PDFRawStream.of(dict, deflate(ctx, px));
}

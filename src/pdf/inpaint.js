// Removes letters from pixels (e.g. of a scanned page) and fills the spots with the background.
// Pure calculation functions without DOM, so they can also be tested without an interface.
//
// img: { data: RGBA (Uint8ClampedArray), width, height }, Rechtecke in Bildpunkten [x0, y0, x1, y1].

const lum = (d, k) => d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114;

const clipRect = (img, r) => [Math.max(0, Math.floor(r[0])), Math.max(0, Math.floor(r[1])), Math.min(img.width, Math.ceil(r[2])), Math.min(img.height, Math.ceil(r[3]))];

/**
 * Separates text and background in a rectangle. Returns the mask (1 = text), text and background color.
 * Text is the smaller group (dark text on a light background or vice versa).
 */
export function classify(img, rect) {
  const [x0, y0, x1, y1] = clipRect(img, rect);
  const w = x1 - x0; const h = y1 - y0;
  if (w < 2 || h < 2) return null;
  const L = new Float32Array(w * h);
  let min = 255; let max = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = lum(img.data, ((y0 + y) * img.width + x0 + x) * 4);
    L[y * w + x] = v; if (v < min) min = v; if (v > max) max = v;
  }
  // Too little contrast: there is no text here.
  if (max - min < 48) return null;
  // The background is the most common value (median). Text is everything that deviates clearly from it,
  // even if there are darker lines next to it.
  const sorted = Float32Array.from(L).sort();
  const bgL = sorted[Math.floor(sorted.length / 2)];
  const textIsDark = bgL - min >= max - bgL;
  const t = Math.max(28, Math.abs(bgL - (textIsDark ? min : max)) * 0.35);
  const mask = new Uint8Array(w * h);
  for (let k = 0; k < L.length; k++) mask[k] = (textIsDark ? bgL - L[k] > t : L[k] - bgL > t) ? 1 : 0;
  // Lines that cross the whole rectangle (tables, underlines) do not belong to the text: value 2.
  for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) n += mask[y * w + x] ? 1 : 0; if (n >= w * 0.95) for (let x = 0; x < w; x++) mask[y * w + x] = 2; }
  for (let x = 0; x < w; x++) { let n = 0; for (let y = 0; y < h; y++) n += mask[y * w + x] ? 1 : 0; if (n >= h * 0.95) for (let y = 0; y < h; y++) mask[y * w + x] = 2; }
  const avg = (want) => {
    const c = [0, 0, 0]; let n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (mask[k] !== want) continue;
      // For the text color only the core of the letters, not the anti-aliased edges.
      if (want === 1 && Math.abs(L[k] - bgL) < t * 2) continue;
      const p = ((y0 + y) * img.width + x0 + x) * 4;
      c[0] += img.data[p]; c[1] += img.data[p + 1]; c[2] += img.data[p + 2]; n++;
    }
    return n ? c.map((v) => v / n) : null;
  };
  // Background as the median per color channel: this way noise and JPEG artifacts at the edge of the text do not distort it.
  const median = () => {
    const ch = [[], [], []];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 0) continue;
      const p = ((y0 + y) * img.width + x0 + x) * 4;
      ch[0].push(img.data[p]); ch[1].push(img.data[p + 1]); ch[2].push(img.data[p + 2]);
    }
    if (!ch[0].length) return null;
    return ch.map((a) => { a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; });
  };
  return { x0, y0, w, h, mask, text: avg(1), bg: median(), textIsDark };
}

/**
 * Removes the text in the rectangles (e.g. word boxes from text recognition).
 * Long horizontal or vertical lines (tables, underlines) are kept.
 * Returns { erased: number of pixels, color: text color 0..1, bg: background color 0..1 }.
 */
export function eraseText(img, rects) {
  let erased = 0; const colors = []; const bgs = [];
  for (const r of rects) {
    const hgt = r[3] - r[1];
    const pad = Math.max(2, Math.round(hgt * 0.08));
    const c = classify(img, [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]);
    if (!c) continue;
    const { x0, y0, w, h, mask } = c;
    // Include the anti-aliased edges and JPEG artifacts around the letters, otherwise a light shadow remains:
    // first a fixed margin, then all adjacent pixels that still deviate slightly from the background.
    const rad = Math.max(2, Math.round(hgt * 0.08));
    const fill = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue;
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const yy = y + dy; const xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx] !== 2) fill[yy * w + xx] = 1;
      }
    }
    {
      const bgL0 = c.bg ? c.bg[0] * 0.299 + c.bg[1] * 0.587 + c.bg[2] * 0.114 : 255;
      const stack = [];
      for (let k = 0; k < fill.length; k++) if (fill[k]) stack.push(k);
      while (stack.length) {
        const k = stack.pop(); const x = k % w; const y = (k - x) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx; const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (fill[q] || mask[q] === 2) continue;
          if (Math.abs(lum(img.data, ((y0 + yy) * img.width + x0 + xx) * 4) - bgL0) > 10) { fill[q] = 1; stack.push(q); }
        }
      }
    }
    if (c.text) colors.push(c.text);
    const bg = c.bg || [255, 255, 255];
    bgs.push(bg);
    const bgL = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114;
    const d = img.data; const W = img.width;
    const px = (x, y) => ((y0 + y) * W + x0 + x) * 4;
    const okEnd = (p) => Math.abs(lum(d, p) - bgL) < 40;
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!fill[y * w + x]) continue;
      // Interpolate horizontally and vertically between the nearest background pixels.
      const cands = [];
      let a = x - 1; while (a >= 0 && fill[y * w + a]) a--;
      let b = x + 1; while (b < w && fill[y * w + b]) b++;
      let u = y - 1; while (u >= 0 && fill[u * w + x]) u--;
      let v = y + 1; while (v < h && fill[v * w + x]) v++;
      const lerp = (p, q, t) => [0, 1, 2].map((ch) => src[p + ch] + (src[q + ch] - src[p + ch]) * t);
      const pair = (p, q, t) => { if (p !== null && q !== null && okEnd(p) && okEnd(q)) return lerp(p, q, t); if (p !== null && okEnd(p)) return [src[p], src[p + 1], src[p + 2]]; if (q !== null && okEnd(q)) return [src[q], src[q + 1], src[q + 2]]; return null; };
      const hz = pair(a >= 0 ? px(a, y) : null, b < w ? px(b, y) : null, (x - a) / Math.max(1, b - a));
      const vt = pair(u >= 0 ? px(x, u) : null, v < h ? px(x, v) : null, (y - u) / Math.max(1, v - u));
      if (hz) cands.push(hz); if (vt) cands.push(vt);
      let out = cands.length ? [0, 1, 2].map((ch) => cands.reduce((s, cc) => s + cc[ch], 0) / cands.length) : bg;
      // Uniform background: take its color directly, otherwise noise and JPEG artifacts form fine stripes.
      if (Math.abs(out[0] * 0.299 + out[1] * 0.587 + out[2] * 0.114 - bgL) < 16) out = bg;
      const p = px(x, y);
      d[p] = out[0]; d[p + 1] = out[1]; d[p + 2] = out[2]; d[p + 3] = 255;
      erased++;
    }
  }
  const mean = (list) => (list.length ? [0, 1, 2].map((ch) => list.reduce((s, c) => s + c[ch], 0) / list.length / 255) : null);
  return { erased, color: mean(colors), bg: mean(bgs) };
}

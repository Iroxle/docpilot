// Skewed scans: determine the rotation angle of a page, rotate a grayscale image and convert points between the skewed
// and the straightened image. Logic without interface.
// Angles in degrees. Positive means clockwise in the image (y downwards): the lines slope down to the right.

/**
 * Rotates a point around (cx, cy) by deg degrees clockwise (image coordinates, y downwards).
 */
export function rotatePoint(x, y, deg, cx, cy) {
  const r = (deg * Math.PI) / 180; const c = Math.cos(r); const s = Math.sin(r);
  const dx = x - cx; const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/**
 * Rotation angle of a page. G: { g, width, height } in grayscale, dark text on a light background.
 * Method: for each angle, the dark pixels are summed up along the imagined line direction.
 * At the right angle, text lines (and rules) and the gaps between them separate sharply; the sum of the
 * squares of the row sums is then largest.
 * o: { max (largest angle searched, default 12), dark (threshold for "dark", default 128) }.
 * Returns { angle, confidence }. confidence: how clearly the best angle stands out (0 = not at all). Pages
 * without lines (photo, empty page, noise) have a small confidence; angle is then not reliable.
 */
export function skewAngle(G, o = {}) {
  const { g, width: W, height: H } = G;
  const max = o.max || 12; const T = o.dark || 128;
  // Collect dark pixels on a coarse grid (at most about 600,000 samples).
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 600000)));
  const xs = []; const ys = [];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) if (g[y * W + x] < T) { xs.push(x); ys.push(y); }
  const n = xs.length;
  if (n < 200) return { angle: 0, confidence: 0 };
  const bins = new Float64Array(Math.ceil((H + W) / step) + 4);
  const score = (deg) => {
    const r = (deg * Math.PI) / 180; const c = Math.cos(r); const s = Math.sin(r);
    bins.fill(0);
    const off = W * Math.abs(s) + step;
    for (let k = 0; k < n; k++) bins[Math.round((ys[k] * c - xs[k] * s + off) / step)]++;
    let sum = 0;
    for (let k = 0; k < bins.length; k++) sum += bins[k] * bins[k];
    return sum;
  };
  // Coarse in steps of 0.5 degrees, then refine twice.
  const coarse = [];
  for (let a = -max; a <= max + 1e-9; a += 0.5) coarse.push([a, score(a)]);
  let best = coarse.reduce((p, q) => (q[1] > p[1] ? q : p));
  for (const d of [0.1, 0.02]) {
    const from = best[0] - d * 5;
    for (let k = 0; k <= 10; k++) { const a = from + k * d; const v = score(a); if (v > best[1]) best = [a, v]; }
  }
  const sorted = coarse.map((x) => x[1]).sort((p, q) => p - q);
  const median = sorted[Math.floor(sorted.length / 2)];
  // If the best angle lies at the edge of the search range, the page is rotated more strongly or has no clear lines.
  const atEdge = Math.abs(best[0]) > max - 0.26;
  return { angle: Math.round(best[0] * 100) / 100, confidence: atEdge || median <= 0 ? 0 : best[1] / median - 1 };
}

/**
 * Rotates a grayscale image around its center by deg degrees clockwise (same size, corners filled with fill).
 * Intermediate values are averaged from the four neighboring pixels.
 */
export function rotateGray(G, deg, fill = 255) {
  const { g, width: W, height: H } = G;
  const out = new Uint8Array(W * H);
  const r = (-deg * Math.PI) / 180; const c = Math.cos(r); const s = Math.sin(r);
  const cx = (W - 1) / 2; const cy = (H - 1) / 2;
  for (let y = 0; y < H; y++) {
    const dy = y - cy;
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const sx = cx + dx * c - dy * s; const sy = cy + dx * s + dy * c;
      const x0 = Math.floor(sx); const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) { out[y * W + x] = fill; continue; }
      const fx = sx - x0; const fy = sy - y0; const i = y0 * W + x0;
      out[y * W + x] = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + W] * (1 - fx) + g[i + W + 1] * fx) * fy + 0.5;
    }
  }
  return { g: out, width: W, height: H };
}

// From this angle on a page counts as skewed, and this is how clearly the angle must at least stand out.
export const MIN_SKEW = 0.3;
export const MIN_CONFIDENCE = 0.25;
/** Angle by which a page has to be straightened, or 0 (straight, too uncertain or out of range). */
export function usableSkew(r) {
  return r && r.confidence >= MIN_CONFIDENCE && Math.abs(r.angle) >= MIN_SKEW ? r.angle : 0;
}

// Preparation for text recognition and evaluation of the pixels: normalize the image, detect bullets,
// punctuation and bold text by their shape, combine lines into paragraphs.
// Pure calculation functions without DOM, so they can also be tested without an interface.
//
// Grayscale image G: { g: Uint8Array (0 = text ... 255 = background), width, height }.

const lum = (d, k) => d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114;

/**
 * Turns a color image into a grayscale image with dark text on a white background, also where light
 * text is on a dark background (dark-mode screenshots) or there are colored areas (table headers).
 * The background is determined per tile (most common brightness in the tile and its neighbors, so that
 * large, bold text that almost fills a tile does not count as background); text is what deviates from it.
 * Text recognition itself only separates text and background with one threshold for the whole page.
 */
export function normalizeForOcr(img, tile = 24, gain = 1.6, reach = 1, scanGain = 1.9) {
  const { data, width: W, height: H } = img;
  const tw = Math.ceil(W / tile); const th = Math.ceil(H / tile);
  const BINS = 32; const STEP = 256 / BINS;
  // Histogram per tile (coarse levels so JPEG noise does not spread the background over many levels) and
  // sum of brightness per level, to hit the background exactly afterwards.
  const hist = new Uint32Array(tw * th * BINS); const sum = new Float64Array(tw * th * BINS);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / tile) * tw;
    for (let x = 0; x < W; x++) {
      const v = lum(data, (y * W + x) * 4); const b = Math.min(BINS - 1, Math.floor(v / STEP));
      const k = (row + Math.floor(x / tile)) * BINS + b;
      hist[k]++; sum[k] += v;
    }
  }
  const bg = new Uint8Array(tw * th);
  const h = new Float64Array(BINS); const s = new Float64Array(BINS);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    h.fill(0); s.fill(0);
    for (let ny = Math.max(0, ty - reach); ny <= Math.min(th - 1, ty + reach); ny++) {
      for (let nx = Math.max(0, tx - reach); nx <= Math.min(tw - 1, tx + reach); nx++) {
        // The tile itself counts double: small areas (table header, code block) keep their background.
        const wgt = ny === ty && nx === tx ? 2 : 1;
        const o = (ny * tw + nx) * BINS;
        for (let b = 0; b < BINS; b++) { h[b] += hist[o + b] * wgt; s[b] += sum[o + b] * wgt; }
      }
    }
    let best = 0; for (let b = 1; b < BINS; b++) if (h[b] > h[best]) best = b;
    // Average of the neighboring levels so a background at the boundary of two levels is hit exactly.
    let n = 0; let t = 0;
    for (let b = Math.max(0, best - 1); b <= Math.min(BINS - 1, best + 1); b++) { n += h[b]; t += s[b]; }
    bg[ty * tw + tx] = Math.round(t / Math.max(1, n));
  }
  // A background of its own (e.g. a dark table header, a code block) is an area: several neighboring tiles have
  // the same one (at its corner still three of eight). A tile that stands almost alone, however, is the inside
  // of a thick letter stroke (large bold text, logos) and gets the background of its surroundings; otherwise
  // the letter would be inverted there.
  // Two passes: tiles that only supported each other drop out in the second one.
  for (let round = 0; round < 2; round++) {
    const src = bg.slice();
    const near = [];
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      near.length = 0;
      for (let ny = Math.max(0, ty - 1); ny <= Math.min(th - 1, ty + 1); ny++) for (let nx = Math.max(0, tx - 1); nx <= Math.min(tw - 1, tx + 1); nx++) if (ny !== ty || nx !== tx) near.push(src[ny * tw + nx]);
      const own = src[ty * tw + tx];
      const same = near.filter((v) => Math.abs(v - own) <= 48).length;
      if (near.length && same <= near.length * 0.3) { near.sort((a, b) => a - b); bg[ty * tw + tx] = near[Math.floor(near.length / 2)]; }
    }
  }
  const g = new Uint8Array(W * H);
  const dist = new Uint32Array(256);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / tile) * tw;
    for (let x = 0; x < W; x++) {
      const b = bg[row + Math.floor(x / tile)];
      const d = Math.min(255, Math.round(Math.abs(lum(data, (y * W + x) * 4) - b)));
      g[y * W + x] = d; dist[d]++;
    }
  }
  // Noise (scanner, JPEG): most pixels are background; how much they usually deviate from the background
  // is the noise. Deviations of this size do not count as text, otherwise the
  // amplification turns them into a grain pattern. Clean images (screenshots) have no noise and stay unchanged.
  let acc = 0; let med = 0;
  while (med < 255 && (acc += dist[med]) < (W * H) / 2) med++;
  const floor = Math.min(40, Math.round(med * 3));
  // Whatever lies above keeps its full contrast. Scans are also blurry: small marks such as umlaut dots
  // are only gray there and would get lost on the cleaned background. That is why noise gets stronger amplification.
  const k2 = floor > 0 ? Math.max(gain, scanGain) : gain;
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / tile) * tw;
    for (let x = 0; x < W; x++) {
      const d = Math.abs(lum(data, (y * W + x) * 4) - bg[row + Math.floor(x / tile)]);
      g[y * W + x] = d <= floor ? 255 : 255 - Math.min(255, Math.round(d * k2));
    }
  }
  return { g, width: W, height: H };
}

/** Grayscale image as RGBA (for a canvas). */
export function grayToRgba(G) {
  const out = new Uint8ClampedArray(G.width * G.height * 4);
  for (let k = 0; k < G.g.length; k++) { const v = G.g[k]; out[k * 4] = v; out[k * 4 + 1] = v; out[k * 4 + 2] = v; out[k * 4 + 3] = 255; }
  return out;
}

const INK = 150;

/**
 * Removes long, thin lines from the grayscale image (table lines, separators: solid, dashed
 * or dotted, horizontal and vertical). Otherwise text recognition pulls such lines into the text line
 * next to them: it misreads characters ("2031" instead of "2.31"), returns rows of dots as text and the line is measured
 * too tall. A line is a long run of thin pixels with free space above and below it; text
 * does not meet that (the letters stand directly above the baseline).
 * o: { minLen, minLenV, maxThick, gap } in pixels. Returns the number of removed runs.
 */
export function removeRules(G, o) {
  const { g, width: W, height: H } = G;
  // Faint lines count too (dotted lines are often only light gray in a scan): everything that is visibly darker
  // than the background.
  const T = o.ink || 225;
  let removed = 0;
  // along: direction of the line, across: perpendicular to it. Index = a * sa + b * sb.
  const pass = (na, nb, sa, sb, minLen) => {
    // Thin: the stroke across the line through this point is at most maxThick long.
    const thin = new Uint8Array(W * H);
    for (let a = 0; a < na; a++) {
      let b = 0;
      while (b < nb) {
        if (g[a * sa + b * sb] >= T) { b++; continue; }
        let e = b; while (e < nb && g[a * sa + e * sb] < T) e++;
        if (e - b <= o.maxThick) for (let k = b; k < e; k++) thin[a * sa + k * sb] = 1;
        b = e;
      }
    }
    const far = o.maxThick + 3;
    const inkShare = (b, a0, a1) => { if (b < 0 || b >= nb) return 0; let c = 0; for (let a = a0; a < a1; a++) if (g[a * sa + b * sb] < T) c++; return c / (a1 - a0); };
    // The band around the run: the rows across the line in which something lies along the run. A line is
    // a narrow band that becomes free on both sides within far and consists only of thin points.
    // Text does not meet that: above the baseline and below the top edge are the letters (higher than far for normal
    // text), and for small text the band contains the stems of the letters (not thin).
    const isRule = (b, a0, a1) => {
      let lo = b; let hi = b;
      for (let d = 1; ; d++) { if (inkShare(b - d, a0, a1) < 0.1) break; if (d > far) return null; lo = b - d; }
      for (let d = 1; ; d++) { if (inkShare(b + d, a0, a1) < 0.1) break; if (d > far) return null; hi = b + d; }
      let ink = 0; let thick = 0;
      for (let q = lo; q <= hi; q++) for (let a = a0; a < a1; a++) { const i = a * sa + q * sb; if (g[i] < T) { ink++; if (!thin[i]) thick++; } }
      return thick <= ink * 0.1 ? [lo, hi] : null;
    };
    const runs = [];
    for (let b = 0; b < nb; b++) {
      let a = 0;
      while (a < na) {
        if (!thin[a * sa + b * sb]) { a++; continue; }
        const a0 = a; let last = a; let n = 0;
        while (a < na && a - last <= o.gap) { if (thin[a * sa + b * sb]) { last = a; n++; } a++; }
        const a1 = last + 1;
        if (a1 - a0 >= minLen && n >= (a1 - a0) * 0.25) { const band = isRule(b, a0, a1); if (band) runs.push([a0, a1, band[0], band[1]]); }
        a = a1;
      }
    }
    // Clear the whole band along the run: this also removes the short ends of a slightly slanted line
    // (in its last row it is shorter than minLen) and its gray fringe.
    for (const [a0, a1, lo, hi] of runs) {
      for (let q = Math.max(0, lo - 2); q <= Math.min(nb - 1, hi + 2); q++) {
        const inBand = q >= lo && q <= hi;
        for (let a = a0; a < a1; a++) { const i = a * sa + q * sb; if ((inBand && thin[i]) || g[i] >= T) g[i] = 255; }
      }
    }
    removed += runs.length;
  };
  pass(W, H, 1, W, o.minLen);
  pass(H, W, W, 1, o.minLenV || o.minLen * 3);
  return removed;
}

const clip =(G, r) => [Math.max(0, Math.floor(r[0])), Math.max(0, Math.floor(r[1])), Math.min(G.width, Math.ceil(r[2])), Math.min(G.height, Math.ceil(r[3]))];

/** Connected text areas in a rectangle: [{ x0, y0, x1, y1 (exclusive), area }]. */
export function components(G, rect) {
  const [x0, y0, x1, y1] = clip(G, rect);
  const w = x1 - x0; const h = y1 - y0;
  if (w < 1 || h < 1) return [];
  const seen = new Uint8Array(w * h); const out = [];
  const ink = (x, y) => G.g[(y0 + y) * G.width + x0 + x] < INK;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (seen[y * w + x] || !ink(x, y)) continue;
    const c = { x0: x, y0: y, x1: x + 1, y1: y + 1, area: 0 };
    const stack = [y * w + x]; seen[y * w + x] = 1;
    while (stack.length) {
      const k = stack.pop(); const px = k % w; const py = (k - px) / w;
      c.area++;
      if (px < c.x0) c.x0 = px; if (px + 1 > c.x1) c.x1 = px + 1; if (py < c.y0) c.y0 = py; if (py + 1 > c.y1) c.y1 = py + 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx; const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        if (!seen[q] && ink(qx, qy)) { seen[q] = 1; stack.push(q); }
      }
    }
    out.push({ x0: c.x0 + x0, y0: c.y0 + y0, x1: c.x1 + x0, y1: c.y1 + y0, area: c.area });
  }
  return out;
}

/**
 * Is a text area a bullet? Returns '•' (dot), '◦' (circle), '▪' (square) or null.
 * Bullets are small, roughly round and float above the baseline; a letter "o" sits on it.
 * base: baseline (pixel row), s: font size in pixels.
 */
export function bulletKind(G, c, base, s) {
  const bw = c.x1 - c.x0; const bh = c.y1 - c.y0;
  if (bw < 0.1 * s || bh < 0.1 * s || bw > 0.6 * s || bh > 0.6 * s) return null;
  const ar = bw / bh;
  if (ar < 0.7 || ar > 1.45) return null;
  if (c.y1 > base - 0.05 * s || c.y0 < base - 0.9 * s) return null;
  // Actual text pixels in the box (the area c.area can be incomplete for circles).
  let n = 0; let mid = 0; let midN = 0; let cor = 0; let corN = 0;
  for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) {
    const ink = G.g[y * G.width + x] < INK;
    if (ink) n++;
    const fx = (x - c.x0 + 0.5) / bw; const fy = (y - c.y0 + 0.5) / bh;
    if (fx > 0.35 && fx < 0.65 && fy > 0.35 && fy < 0.65) { midN++; if (ink) mid++; }
    // Corners: filled for a square, empty for a dot.
    if ((fx < 0.2 || fx > 0.8) && (fy < 0.2 || fy > 0.8)) { corN++; if (ink) cor++; }
  }
  const fill = n / (bw * bh);
  const center = midN ? mid / midN : 1;
  const corners = corN ? cor / corN : 0;
  if (center < 0.3 && fill > 0.2 && fill < 0.75) return '◦';
  if (center < 0.5) return null;
  if (corners >= 0.7 && fill >= 0.85) return '▪';
  if (fill >= 0.55) return '•';
  return null;
}

/** Bullet in an area (exactly one matching area), otherwise null. */
export function findBullet(G, rect, base, s) {
  const cs = components(G, rect).filter((c) => c.area > 2);
  if (cs.length !== 1) return null;
  const kind = bulletKind(G, cs[0], base, s);
  return kind ? { kind, box: [cs[0].x0, cs[0].y0, cs[0].x1, cs[0].y1] } : null;
}

/** Tight box around the text in a rectangle (text recognition boxes are often too large), otherwise null. */
export function inkBox(G, rect) {
  const [x0, y0, x1, y1] = clip(G, rect);
  let a = x1; let b = y1; let c = -1; let d = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (G.g[y * G.width + x] >= INK) continue;
    if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y;
  }
  return c < 0 ? null : [a, b, c + 1, d + 1];
}

/**
 * Is the recognized "+" actually a "±"? Then there are two horizontal strokes (crossbar of the plus and the
 * stroke on the baseline), for a plus only one. Counts groups of wide rows; this also works when the
 * gap between the plus and the stroke blurs at screen resolution.
 */
export function isPlusMinus(G, box, base, s) {
  const [x0, y0, x1, y1] = clip(G, [box[0], box[1] - 0.05 * s, box[2], Math.max(box[3], base + 0.12 * s)]);
  const w = x1 - x0;
  if (w < 3 || y1 - y0 < 4) return false;
  const rows = [];
  for (let y = y0; y < y1; y++) { let n = 0; for (let x = x0; x < x1; x++) if (G.g[y * G.width + x] < INK) n++; rows.push(n); }
  const max = Math.max(...rows);
  if (max < 0.5 * w) return false;
  const groups = [];
  rows.forEach((n, k) => {
    if (n < 0.6 * max) return;
    const g = groups[groups.length - 1];
    if (g && g.end === k - 1) g.end = k; else groups.push({ start: k, end: k });
  });
  if (groups.length !== 2) return false;
  const [top, bar] = groups;
  // The lower stroke lies on the baseline (not below it like an underline) and is thin.
  if (y0 + bar.end + 1 > base + 0.08 * s || bar.end - bar.start + 1 > 0.16 * s) return false;
  // Between the strokes only the vertical stroke of the plus (narrow).
  const between = rows.slice(top.end + 1, bar.start);
  return between.length > 0 && Math.max(...between) <= 0.45 * max;
}

/**
 * Period or comma (colon or semicolon)? The comma reaches below the baseline.
 * Returns the correct character or null if it cannot be decided.
 */
export function stopKind(G, box, base, s, ch) {
  const cs = components(G, [box[0] - 1, base - 0.6 * s, box[2] + 1, base + 0.45 * s])
    .filter((c) => c.area > 1 && (c.x0 + c.x1) / 2 >= box[0] - 1 && (c.x0 + c.x1) / 2 <= box[2] + 1 && c.y1 > base - 0.3 * s);
  if (!cs.length) return null;
  const low = cs.reduce((m, c) => (c.y1 > m.y1 ? c : m));
  if (low.x1 - low.x0 > 0.35 * s) return null;
  const below = low.y1 - base;
  // Only switch for a clear shape: a comma is taller than wide and reaches clearly below the baseline.
  const tallish = low.y1 - low.y0 >= 1.3 * (low.x1 - low.x0);
  const comma = below >= 0.1 * s && tallish; const stop = below <= 0.03 * s && !tallish;
  if (ch === ',' && stop) return '.';
  if (ch === '.' && comma) return ',';
  if (ch === ';' && stop) return ':';
  if (ch === ':' && comma) return ';';
  return null;
}

const small = (c, s) => c.x1 - c.x0 <= 0.24 * s && c.y1 - c.y0 <= 0.24 * s && c.area > 1;

/** Is there a separate dot above the character (i or j instead of 1 or l)? */
// Search for areas in a larger neighborhood so parts of neighboring letters (e.g. the bar of a T above
// the following a) do not appear as small dots.
const around = (G, box, base, s) => components(G, [box[0] - 0.35 * s, box[1] - 0.4 * s, box[2] + 0.35 * s, base + 0.05 * s]);
const centerIn = (c, box, tol) => (c.x0 + c.x1) / 2 >= box[0] - tol && (c.x0 + c.x1) / 2 <= box[2] + tol;

/** Is there a separate dot above the character (i instead of 1 or l)? */
export function hasDot(G, box, base, s) {
  const cs = around(G, box, base, s).filter((c) => centerIn(c, box, 1) && c.y1 > box[1] - 0.3 * s);
  if (cs.length !== 2) return false;
  const [top, stem] = cs[0].y0 < cs[1].y0 ? cs : [cs[1], cs[0]];
  return small(top, s) && top.y1 < stem.y0 && stem.y1 - stem.y0 > 0.3 * s && stem.y1 > base - 0.1 * s;
}

/** Two dots above an a, o or u (an umlaut that text recognition missed)? */
export function hasUmlaut(G, box, base, s) {
  // The dots lie above the letter, often already inside the text recognition box. We are looking for a
  // letter above which exactly two dots sit side by side (with "ii" each i has only one).
  const cs = around(G, box, base, s).filter((c) => centerIn(c, box, 0.04 * s));
  const bodies = cs.filter((c) => !small(c, s) && c.y1 > base - 0.15 * s);
  return bodies.some((body) => {
    const dots = cs.filter((c) => small(c, s) && c.y1 <= body.y0 + 1 && c.y0 >= body.y0 - 0.35 * s && centerIn(c, [body.x0, 0, body.x1, 0], 1));
    if (dots.length !== 2) return false;
    const [a, b] = dots[0].x0 < dots[1].x0 ? dots : [dots[1], dots[0]];
    return b.x0 >= a.x1 && Math.abs((a.y0 + a.y1) - (b.y0 + b.y1)) / 2 <= 0.08 * s;
  });
}

/** Stroke width of the text in a rectangle (median of the horizontal runs), in pixels. */
export function strokeWidth(G, rect) {
  const [x0, y0, x1, y1] = clip(G, rect);
  const runs = [];
  for (let y = y0; y < y1; y++) {
    let run = 0;
    for (let x = x0; x <= x1; x++) {
      const ink = x < x1 && G.g[y * G.width + x] < INK;
      if (ink) run++; else if (run) { runs.push(run); run = 0; }
    }
  }
  if (runs.length < 5) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

const MARKER = /^(\d{1,2}[.)]|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)]|[-–—•◦▪])$/;
/** Is the first word of a line a bullet or a number ("1.", "a)", "-")? */
export const isMarker = (text) => MARKER.test(text);

/**
 * Combines lines into paragraphs the way one would read them. Bullet points and numbers form their
 * own paragraph so they stay unchanged when editing and wrapped lines stay aligned.
 * lines: [{ x0, x1, base, size (pixels), bold, marker (the character only), list (text after a marker),
 *           n (number of words), first (width of the first word), lower (starts with a lowercase letter) }].
 * Returns groups of line indices.
 *
 * Lines that merely sit below each other are not yet a paragraph: table rows, number columns and addresses
 * stay one line each (otherwise they would run together into running text when edited). Only wrapped
 * running text is joined, i.e. when the first word of the lower line would no longer have fit on the line above:
 * 1. The lower line starts with a lowercase letter (a new entry starts with a capital or a number), and its
 *    first word would not have fit on the upper line within the width of the group.
 * 2. It starts with a capital, but the column has a text width confirmed by 1., and the upper line reaches
 *    up to it.
 * The upper line needs at least three words for this. Without the details n/first/lower, only the position counts.
 */
export function groupParagraphs(lines) {
  const order = lines.map((l, k) => k).sort((a, b) => lines[a].base - lines[b].base || lines[a].x0 - lines[b].x0);
  const pars = [];
  const prev = new Array(lines.length).fill(-1); const parOf = new Array(lines.length).fill(-1);
  for (const k of order) {
    const L = lines[k];
    let join = null;
    // A bullet point always starts a new paragraph.
    if (!L.marker && !L.list) {
      // Nearest line above that overlaps horizontally with this one.
      let best = null;
      for (const p of pars) {
        if (p.marker) continue;
        const q = lines[p.lines[p.lines.length - 1]];
        if (q.base >= L.base - 0.3 * L.size) continue;
        if (Math.min(q.x1, L.x1) - Math.max(q.x0, L.x0) <= 0) continue;
        if (!best || q.base > lines[best.lines[best.lines.length - 1]].base) best = p;
      }
      // Another line lying in between separates the paragraphs.
      if (best) {
        const q = lines[best.lines[best.lines.length - 1]];
        const between = order.some((j) => j !== k && lines[j].base > q.base + 0.3 * L.size && lines[j].base < L.base - 0.3 * L.size && Math.min(lines[j].x1, L.x1) - Math.max(lines[j].x0, L.x0) > 0);
        const gap = L.base - q.base;
        const pitchOk = best.lines.length > 1 ? Math.abs(gap - best.pitch) <= 0.22 * best.pitch : gap >= 0.85 * L.size && gap <= 1.75 * L.size;
        const sizeOk = Math.abs(L.size - best.size) <= 0.15 * best.size;
        // Aligned with the text above; for lists also aligned with the bullet (without indent).
        // A first line with an indent is allowed.
        const leftOk = Math.abs(L.x0 - best.left) <= 0.9 * L.size || (best.markerX !== undefined && Math.abs(L.x0 - best.markerX) <= 0.6 * L.size)
          || (best.lines.length === 1 && !best.list && L.x0 < best.left && best.left - L.x0 <= 3 * L.size);
        if (!between && pitchOk && sizeOk && leftOk && !!L.bold === !!best.bold) join = best;
      }
    }
    if (join) {
      const q = lines[join.lines[join.lines.length - 1]];
      if (join.lines.length === 1) { join.pitch = L.base - q.base; join.left = Math.min(join.left, L.x0); }
      prev[k] = join.lines[join.lines.length - 1]; parOf[k] = pars.indexOf(join);
      join.lines.push(k);
    } else { parOf[k] = pars.length; pars.push({ lines: [k], size: L.size, left: L.x0, bold: L.bold, list: !!L.list || !!L.marker, marker: !!L.marker, markerX: L.markerX, pitch: 0 }); }
  }

  // From the groups by position, keep only the transitions that are a line break in running text.
  const link = new Array(lines.length).fill(false);
  const widest = pars.map((p) => Math.max(...p.lines.map((i) => lines[i].x1)));
  const noRoom = (q, L, M) => q.x1 + 0.28 * L.size + L.first > M;
  const samples = [];
  for (const k of order) {
    if (prev[k] < 0) continue;
    const q = lines[prev[k]]; const L = lines[k];
    if (L.first === undefined || q.n === undefined) { link[k] = true; continue; }
    if (q.n >= 3 && L.lower && noRoom(q, L, widest[parOf[k]])) { link[k] = true; samples.push({ left: pars[parOf[k]].left, x1: q.x1, base: q.base }); }
  }
  for (const k of order) {
    if (prev[k] < 0 || link[k]) continue;
    const q = lines[prev[k]]; const L = lines[k];
    if (q.n < 3) continue;
    // Text width of the column: the nearest confirmed lines with the same left edge.
    const near = samples.filter((s) => Math.abs(s.left - pars[parOf[k]].left) <= 3 * L.size).sort((a, b) => Math.abs(a.base - q.base) - Math.abs(b.base - q.base)).slice(0, 4);
    if (near.length && noRoom(q, L, Math.max(...near.map((s) => s.x1)))) link[k] = true;
  }
  const groups = []; const groupOf = new Array(lines.length).fill(-1);
  for (const k of order) {
    if (link[k] && groupOf[prev[k]] >= 0) { groupOf[k] = groupOf[prev[k]]; groups[groupOf[k]].push(k); }
    else { groupOf[k] = groups.length; groups.push([k]); }
  }
  return groups;
}

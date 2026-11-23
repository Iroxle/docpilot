// Word-level geometry from the text content of a page.
let measureCtx = null;
/** Fraction of the width up to character i. Takes letters of different widths into account. */
export function prefixRatio(str, i) {
  if (i <= 0) return 0;
  if (i >= str.length) return 1;
  if (typeof OffscreenCanvas === 'undefined') return i / str.length;
  if (!measureCtx) { measureCtx = new OffscreenCanvas(4, 4).getContext('2d'); measureCtx.font = '100px Arial, Helvetica, sans-serif'; }
  const whole = measureCtx.measureText(str).width;
  return whole > 0 ? measureCtx.measureText(str.slice(0, i)).width / whole : i / str.length;
}
export function wordBoxes(content) {
  const out = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const fontH = Math.hypot(c, d) || it.height || 10;
    const dirX = Math.hypot(a, b) > 0 ? a / Math.hypot(a, b) : 1; const dirY = Math.hypot(a, b) > 0 ? b / Math.hypot(a, b) : 0;
    const re = /\S+/gu;
    let m;
    while ((m = re.exec(it.str))) {
      const s0 = prefixRatio(it.str, m.index) * it.width; const s1 = prefixRatio(it.str, m.index + m[0].length) * it.width;
      const x = e + dirX * s0; const y = f + dirY * s0; const x2 = e + dirX * s1; const y2 = f + dirY * s1;
      const nx = -dirY * fontH; const ny = dirX * fontH;
      const xs = [x, x2, x + nx, x2 + nx]; const ys = [y, y2, y + ny, y2 + ny];
      const descent = fontH * 0.22;
      out.push({ text: m[0], x, y, width: Math.hypot(x2 - x, y2 - y), height: fontH, angle: Math.atan2(dirY, dirX), rect: [Math.min(...xs), Math.min(...ys) - descent, Math.max(...xs), Math.max(...ys)] });
    }
  }
  return out;
}
export const rectsOverlap = (a, b, m = 0) => a[0] < b[2] + m && a[2] > b[0] - m && a[1] < b[3] + m && a[3] > b[1] - m;
export const quadFromRect = ([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0];
export const rectFromQuad = (q) => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];

/** Word-by-word comparison. Returns operations on the two lists. */
export function diffWords(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA); const B = b.slice(start, endB);
  const removed = []; const added = [];
  if (A.length * B.length > 25e6) {
    for (let i = 0; i < A.length; i++) removed.push(start + i);
    for (let i = 0; i < B.length; i++) added.push(start + i);
    return { removed, added };
  }
  const w = B.length + 1;
  const t = new Uint16Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  let i = 0; let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { i++; j++; } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { removed.push(start + i); i++; } else { added.push(start + j); j++; }
  }
  while (i < A.length) removed.push(start + i++);
  while (j < B.length) added.push(start + j++);
  return { removed, added };
}

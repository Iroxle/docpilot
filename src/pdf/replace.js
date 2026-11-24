// Find and replace: logic without interface. Maps search results to the editor's text blocks, replaces
// within the text of a block and rewraps a paragraph when a line becomes too long as a result.

const norm = (s) => s.normalize('NFC');

/** Search pattern as in the search: whitespace in the search term matches any whitespace, including a line break. */
export function searchRegex(q, opts = {}) {
  const esc = norm(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc, `gu${opts.caseSensitive ? '' : 'i'}`);
}

/**
 * Text of a block as it is edited in the editor, together with the start of each line in it. Between the lines there
 * is a line break; a recognized running-text paragraph brings its own separators (block.seps: ' ', '' or '\n').
 */
export function blockLines(block) {
  const seps = block.seps || [];
  let text = ''; const starts = [];
  block.lines.forEach((l, k) => { if (k) text += seps[k - 1] ?? '\n'; starts.push(text.length); text += l.text; });
  return { text, starts };
}

const squash = (s, cs) => { const t = norm(s).replace(/\s+/g, ''); return cs ? t : t.toLowerCase(); };

/**
 * Returns a function that maps a search result to a text block.
 * blocks: text blocks with lines[].parts[{ item, at }] (item: number of the text item on the page, at: start in the line).
 * Called with the page text, the mapping character -> { item, off } and the range of the result. Result:
 * { block, a, b } (number of the block, range in its text from blockLines) or { reason }:
 *   'no-text'   The text is not in any editable block (e.g. rotated text).
 *   'multiple'  The result spans several paragraphs or table cells.
 *   'different' The block does not contain the text the way the search found it.
 */
export function locator(blocks, opts = {}) {
  const byItem = new Map();
  const texts = blocks.map((b) => (b.kind === 'text' && b.lines ? blockLines(b) : null));
  blocks.forEach((b, bi) => {
    if (!texts[bi]) return;
    b.lines.forEach((l, k) => { for (const p of l.parts || []) if (!byItem.has(p.item)) byItem.set(p.item, { bi, k, at: p.at }); });
  });
  return (pageText, map, start, end, re) => {
    const real = (c) => map[c] && map[c].off >= 0 && /\S/.test(pageText[c]);
    let s = start; let e = end;
    while (s < e && !real(s)) s++;
    while (e > s && !real(e - 1)) e--;
    if (s >= e) return { reason: 'no-text' };
    const p0 = byItem.get(map[s].item); const p1 = byItem.get(map[e - 1].item);
    if (!p0 || !p1) return { reason: 'no-text' };
    if (p0.bi !== p1.bi) return { reason: 'multiple' };
    const { text, starts } = texts[p0.bi];
    let a = starts[p0.k] + p0.at + map[s].off;
    let b = starts[p1.k] + p1.at + map[e - 1].off + 1;
    // Whitespace at the edge of the result (search term starts or ends with a space) belongs to it.
    if (s > start && a > 0 && /\s/.test(text[a - 1])) a--;
    if (e < end && b < text.length && /\s/.test(text[b])) b++;
    const want = squash(pageText.slice(start, end), opts.caseSensitive);
    if (a >= 0 && b <= text.length && a < b && squash(text.slice(a, b), opts.caseSensitive) === want) return { block: p0.bi, a, b };
    // The characters are slightly different in the block (e.g. composed umlauts): take the nearest occurrence.
    if (re) {
      const r = new RegExp(re.source, re.flags);
      let m; let best = null;
      while ((m = r.exec(text))) {
        if (!m[0].length) { r.lastIndex++; continue; }
        if (!best || Math.abs(m.index - a) < Math.abs(best.a - a)) best = { a: m.index, b: m.index + m[0].length };
      }
      if (best && Math.abs(best.a - a) <= 3) return { block: p0.bi, ...best };
    }
    return { reason: 'different' };
  };
}

/**
 * Replaces ranges in the text of a block. hits: [{ a, b }] in the text from blockLines, soft[k]: line k continues in
 * line k+1 (wrap in running text). Returns the new lines, their separators and soft for them. If a
 * range spans a line break, the two lines grow together.
 */
export function replaceInBlock(block, hits, replacement, soft = []) {
  const { starts } = blockLines(block);
  const lines = block.lines.map((l) => l.text);
  const seps = lines.slice(1).map((_, k) => (block.seps || [])[k] ?? '\n');
  const flow = lines.slice(1).map((_, k) => !!soft[k]);
  const lineOf = (pos) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= pos) k++;
    return k;
  };
  let first = lines.length;
  // From back to front so the positions of the earlier ranges stay valid.
  for (const h of [...hits].sort((p, q) => q.a - p.a)) {
    const k0 = lineOf(h.a); const k1 = lineOf(Math.max(h.a, h.b - 1));
    const p0 = Math.min(lines[k0].length, h.a - starts[k0]); const p1 = Math.max(0, Math.min(lines[k1].length, h.b - starts[k1]));
    lines.splice(k0, k1 - k0 + 1, lines[k0].slice(0, p0) + replacement + lines[k1].slice(p1));
    if (k1 > k0) { seps.splice(k0, k1 - k0); flow.splice(k0, k1 - k0); }
    first = Math.min(first, k0);
  }
  return { lines, seps, soft: flow, first };
}

function wrapWords(text, width, measure) {
  const out = []; let cur = '';
  for (const w of text.split(/ +/)) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && measure(t) > width) { out.push(cur); cur = w; } else cur = t;
  }
  out.push(cur);
  return out;
}

/**
 * Rewraps a paragraph after lines have become longer. lines: lines after replacing, soft[k]: line k
 * continues in line k+1, width: text width, measure(text): width of a line.
 * Lines that fit stay unchanged. What no longer fits on a line moves to the start of the
 * next line of the same running text; if the running text ends there, a new line is created.
 */
export function reflow(lines, soft, width, measure) {
  const out = []; let carry = '';
  for (let k = 0; k < lines.length; k++) {
    const cur = carry ? `${carry} ${lines[k]}`.trim() : lines[k];
    carry = '';
    if (measure(cur) <= width) { out.push(cur); continue; }
    const parts = wrapWords(cur, width, measure);
    if (soft[k] && k + 1 < lines.length && parts.length > 1) carry = parts.pop();
    out.push(...parts);
  }
  return out;
}

/**
 * New text of a block after replacing.
 * block: { lines[{ text, x0, x1 }], seps?, fixedWidth? }, hits: [{ a, b }], flow: { soft[], width } from the
 * paragraph detection (which lines are running text and how wide the text is), measure(text): width in the new font.
 * A block with a fixed width wraps by itself when set; otherwise it is wrapped here, but only if the block
 * really is running text. Single lines (table, address, heading) stay single lines.
 */
export function replacedText(block, hits, replacement, flow, measure) {
  const r = replaceInBlock(block, hits, replacement, flow?.soft || []);
  if (block.fixedWidth) return r.lines.reduce((t, l, k) => (k ? t + r.seps[k - 1] + l : l), '');
  if (!measure || !flow || !r.soft.some(Boolean)) return r.lines.join('\n');
  // Text width in the new font: at least as wide as the widest previous line, so unchanged
  // lines never count as too long.
  const width = Math.max(flow.width, ...block.lines.map((l) => measure(l.text)));
  const head = r.lines.slice(0, r.first);
  return [...head, ...reflow(r.lines.slice(r.first), r.soft.slice(r.first), width, measure)].join('\n');
}

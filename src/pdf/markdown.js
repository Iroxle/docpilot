// Export as Markdown (CommonMark with pipe tables): the paragraphs in reading order, headings from the font size,
// bold and italic text, and tables. The body text size is the size most of the document's characters are set in;
// a short paragraph at 1.6 times that size or more is a level 1 heading, at 1.25 times (or a short bold line that
// does not end with a full stop) a level 2 heading. Lines that a paragraph wraps are joined; a hyphen at the end of a
// line before a lowercase letter goes. Images are left out.
//
// Ported from PdfCraft's export crate (as_markdown, layout) (Copyright (c) 2026 ArtCraft Team and the PdfCraft
// contributors, MIT license, see THIRD_PARTY_NOTICES.md).

/** The body text size of the pages (blocks with {text, size}). */
export function bodySize(pages) {
  const by = new Map();
  for (const p of pages) for (const b of p.blocks) {
    if (b.kind !== 'text') continue;
    const k = Math.round((b.size || 0) * 2);
    by.set(k, (by.get(k) || 0) + (b.text || '').length);
  }
  let best = null;
  for (const [k, n] of by) if (!best || n > best[1]) best = [k, n];
  return best ? best[0] / 2 : 11;
}

/** Heading level of a text block: 1, 2 or 0 (body text). */
export function headingLevel(b, body) {
  const t = (b.text || '').trim();
  const short = t.length < 200;
  if (short && b.size >= body * 1.6) return 1;
  if (short && (b.size >= body * 1.25 || (b.bold && b.size >= body - 0.01 && t.length < 80 && !t.endsWith('.') && !t.includes('\n')))) return 2;
  return 0;
}

/** Escapes the characters Markdown would read as formatting. */
export function escapeMd(s) {
  return s.replace(/([\\`*_{}[\]<>#|])/g, '\\$1')
    .replace(/^(\s*)([-+])(\s)/, '$1\\$2$3')
    .replace(/^(\s*\d+)([.)])(\s)/, '$1\\$2$3');
}

/** The lines of a paragraph as one line: wrapped lines joined, hyphens at line ends removed before lowercase. */
export function joinLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reduce((acc, l) => {
    if (!acc) return l;
    if (/[A-Za-zÀ-ÿ]-$/.test(acc) && /^[a-zà-ÿ]/.test(l)) return acc.slice(0, -1) + l;
    return `${acc} ${l}`;
  }, '');
}

const emph = (s, b) => {
  if (!s) return s;
  if (b.bold && b.italic) return `***${s}***`;
  if (b.bold) return `**${s}**`;
  if (b.italic) return `*${s}*`;
  return s;
};

/** A pipe table from a table block {rows, cols, cells: [{r, c, colSpan, text}]}; the first row is the header. */
export function mdTable(t) {
  const grid = Array.from({ length: t.rows }, () => Array(t.cols).fill(''));
  for (const c of t.cells) {
    if (!grid[c.r]) continue;
    grid[c.r][c.c] = escapeMd(joinLines(c.text || ''));
  }
  const line = (cells) => `| ${cells.map((x) => x || ' ').join(' | ')} |`;
  const out = [line(grid[0]), `| ${grid[0].map(() => '---').join(' | ')} |`];
  for (let r = 1; r < grid.length; r++) out.push(line(grid[r]));
  return out.join('\n');
}

/**
 * Markdown from page models: [{blocks: [{kind: 'text', text, size, bold, italic} | {kind: 'table', ...}]}] in
 * reading order.
 */
export function markdownFrom(pages) {
  const body = bodySize(pages);
  const parts = [];
  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.kind === 'table') { if (b.rows && b.cols) parts.push(mdTable(b)); continue; }
      if (b.kind !== 'text') continue;
      const text = joinLines(b.text || '');
      if (!text) continue;
      const level = headingLevel(b, body);
      if (level) parts.push(`${'#'.repeat(level)} ${escapeMd(text)}`);
      else if (/^[•●▪◦‣\-–]\s+/.test(text)) parts.push(`- ${emph(escapeMd(text.replace(/^[•●▪◦‣\-–]\s+/, '')), b)}`);
      else parts.push(emph(escapeMd(text), b));
    }
  }
  return `${parts.join('\n\n')}\n`;
}

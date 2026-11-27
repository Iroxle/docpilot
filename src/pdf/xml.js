// A small XML reader for XFA packets (works in the app and in Node, which has no DOMParser): elements with their
// attributes, text and children. Comments, processing instructions and the doctype are skipped, CDATA is text,
// character and the five predefined entity references are decoded. Namespace prefixes are kept in the name and also
// given without them (local).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
export const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENT[e] ?? m;
});

/** Parses XML text into {name, local, attrs, children, text} (the document element), or null. */
export function parseXml(src) {
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0; const n = src.length;
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) { const t = decodeEntities(src.slice(i, textEnd)); top().text += t; if (t.trim()) top().children.push({ name: '#text', local: '#text', text: t }); }
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); const t = src.slice(lt + 9, e < 0 ? n : e); top().text += t; top().children.push({ name: '#text', local: '#text', text: t }); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) {
      // Doctype, possibly with an internal subset in brackets.
      let depth = 0; let k = lt + 2;
      for (; k < n; k++) { if (src[k] === '[') depth++; else if (src[k] === ']') depth--; else if (src[k] === '>' && depth <= 0) break; }
      i = k + 1; continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      // Close up to the matching element (tolerant of unclosed elements).
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      i = e < 0 ? n : e + 1; continue;
    }
    // Start tag: name, then attributes up to '>' or '/>' (quotes may contain '>').
    let k = lt + 1;
    while (k < n && !/[\s/>]/.test(src[k])) k++;
    const name = src.slice(lt + 1, k);
    const attrs = {};
    for (;;) {
      while (k < n && /\s/.test(src[k])) k++;
      if (k >= n || src[k] === '>' || src[k] === '/') break;
      const a0 = k; while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const an = src.slice(a0, k);
      while (k < n && /\s/.test(src[k])) k++;
      let av = '';
      if (src[k] === '=') {
        k++; while (k < n && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q === '"' || q === '\'') { const e = src.indexOf(q, k + 1); av = src.slice(k + 1, e < 0 ? n : e); k = e < 0 ? n : e + 1; } else { const a1 = k; while (k < n && !/[\s>]/.test(src[k])) k++; av = src.slice(a1, k); }
      }
      if (an) { attrs[an] = decodeEntities(av); const loc = an.includes(':') ? an.split(':').pop() : an; if (!(loc in attrs)) attrs[loc] = attrs[an]; }
    }
    const self = src[k] === '/';
    const e = src.indexOf('>', k);
    const el = { name, local: name.includes(':') ? name.split(':').pop() : name, attrs, children: [], text: '' };
    top().children.push(el);
    if (!self) stack.push(el);
    i = e < 0 ? n : e + 1;
  }
  return root.children.find((c) => c.name !== '#text') || null;
}

/** The element children of an element, optionally with the local name. */
export const kids = (el, local) => (el?.children || []).filter((c) => c.name !== '#text' && (!local || c.local === local));
/** The first element child with the local name. */
export const kid = (el, local) => (el?.children || []).find((c) => c.local === local) || null;
/** The text of an element and its descendants. */
export const textContent = (el) => (!el ? '' : el.name === '#text' ? el.text : el.children.map(textContent).join(''));
/** Finds descendants (depth first) with the local name. */
export function findAll(el, local, out = []) { for (const c of kids(el)) { if (c.local === local) out.push(c); findAll(c, local, out); } return out; }

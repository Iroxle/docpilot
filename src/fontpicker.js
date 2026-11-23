// Font picker like in Word: field for typing, list with theme fonts, recently used and all
// fonts, each shown in its own typeface.
import { h, icon, toast } from './util.js';
import { allFamilies, familyInfo, themeFonts, recentFonts, rememberFont, previewFamily } from './fonts.js';

const NO_EMBED = 'This font\'s license does not allow embedding in PDF files.';

export function fontPicker(value, onPick) {
  const input = h('input', { type: 'text', class: 'fp-input', value: value || '', title: 'Font', spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-label': 'Font', 'aria-expanded': 'false' });
  const arrow = h('button', { type: 'button', class: 'fp-arrow', tabindex: '-1', title: 'Show fonts' }, icon('chevD'));
  const wrap = h('div', { class: 'fontpick' }, input, arrow);
  let pop = null; let items = []; let active = -1; let observer = null;
  const previews = new Map();

  const close = () => {
    if (!pop) return;
    observer?.disconnect(); observer = null;
    pop.remove(); pop = null; items = []; active = -1; previews.clear();
    input.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => { if (!wrap.contains(e.target)) { close(); input.value = value || ''; } };
  const pick = (name) => {
    const f = familyInfo(name);
    if (!f || !f.embeddable) { toast(f ? NO_EMBED : `The font "${name}" is not installed on this PC.`); input.value = value || ''; close(); return; }
    value = f.name; input.value = f.name; close();
    rememberFont(f.name);
    onPick(f.name);
  };
  const setActive = (k) => {
    items[active]?.el.classList.remove('active');
    active = Math.max(-1, Math.min(items.length - 1, k));
    const it = items[active];
    if (it) { it.el.classList.add('active'); it.el.scrollIntoView({ block: 'nearest' }); }
  };
  const row = (name, label) => {
    const f = familyInfo(name);
    const ok = !!f && f.embeddable;
    const span = h('span', { class: 'fp-name' }, label || name);
    const el = h('div', { class: `fp-item${ok ? '' : ' disabled'}${name === value ? ' current' : ''}`, role: 'option', title: ok ? name : NO_EMBED, data: { font: name } }, span);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); });
    el.addEventListener('click', () => { if (ok) pick(name); });
    // The preview in its own typeface is only loaded when the entry becomes visible.
    if (ok) previews.set(el, () => { const face = previewFamily(f); if (face) span.style.fontFamily = `"${face}", "Segoe UI", sans-serif`; });
    const it = { el, name, ok };
    items.push(it);
    return el;
  };
  const render = (filter) => {
    if (!pop) return;
    observer?.disconnect();
    items = []; active = -1; previews.clear();
    const q = (filter || '').trim().toLowerCase();
    const all = allFamilies();
    const kids = [];
    if (!q) {
      const theme = themeFonts();
      if (theme.length) kids.push(h('div', { class: 'fp-head' }, 'Theme Fonts'), ...theme.map((t) => row(t.name, t.label)));
      const rec = recentFonts();
      if (rec.length) kids.push(h('div', { class: 'fp-head' }, 'Recently Used Fonts'), ...rec.map((n) => row(n)));
      kids.push(h('div', { class: 'fp-head' }, 'All Fonts'), ...all.map((f) => row(f.name)));
    } else {
      // First fonts that start with what was typed, then those that contain it.
      const starts = all.filter((f) => f.name.toLowerCase().startsWith(q));
      const has = all.filter((f) => !f.name.toLowerCase().startsWith(q) && f.name.toLowerCase().includes(q));
      kids.push(...[...starts, ...has].map((f) => row(f.name)));
      if (!kids.length) kids.push(h('div', { class: 'fp-empty' }, 'No matching font'));
    }
    pop.replaceChildren(...kids);
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { previews.get(en.target)?.(); previews.delete(en.target); observer.unobserve(en.target); }
    }, { root: pop, rootMargin: '120px 0px' });
    for (const el of previews.keys()) observer.observe(el);
    if (q) setActive(items.findIndex((it) => it.ok));
    else {
      // Like in Word: the list starts at the top (theme fonts), the current font is marked.
      pop.scrollTop = 0;
      setActive(items.findIndex((it) => it.name === value));
    }
  };
  const open = (filter) => {
    if (!pop) {
      pop = h('div', { class: 'fp-pop', role: 'listbox' });
      wrap.append(pop);
      input.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
    }
    render(filter);
  };

  input.addEventListener('focus', () => input.select());
  input.addEventListener('click', () => { if (!pop) open(''); });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!pop) open(''); else setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (pop) setActive(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const typed = input.value.trim();
      const exact = familyInfo(typed);
      if (exact) pick(exact.name);
      else if (pop && items[active]?.ok) pick(items[active].name);
      else if (typed) pick(typed);
    } else if (e.key === 'Escape') { e.preventDefault(); input.value = value || ''; close(); }
    else if (e.key === 'Tab') close();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (pop && !wrap.contains(document.activeElement)) { close(); input.value = value || ''; } }, 150));
  arrow.addEventListener('pointerdown', (e) => e.preventDefault());
  arrow.addEventListener('click', () => { if (pop) close(); else { input.focus(); open(''); } });
  return wrap;
}

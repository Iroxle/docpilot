// Fonts like in Word: catalog of all installed fonts, Word's default font, fonts for display.
import { setFontCatalog, resolveFamily } from './pdf/ops.js';

const state = { families: [], byName: new Map(), word: null, ready: null };
const cssLoaded = new Map();

/** Loads the catalog once (in the background at startup). */
export function loadFonts() {
  if (!state.ready) {
    state.ready = (async () => {
      try {
        const r = await window.dp.fonts();
        state.families = r.families || [];
        state.word = r.word || null;
      } catch { state.families = []; }
      state.byName = new Map(state.families.map((f) => [f.name.toLowerCase(), f]));
      setFontCatalog(state.families);
      return state;
    })();
  }
  return state.ready;
}

export const allFamilies = () => state.families;
export const familyInfo = (name) => state.byName.get(String(name || '').toLowerCase()) || null;
const usable = (name) => { const f = familyInfo(name); return f && f.embeddable ? f.name : null; };

/**
 * Default font like in Word: font and size from Word's Normal.dotm template. Without the template, Word's
 * built-in default applies (Aptos 11, Calibri 11 for older Office). If the font is missing on the PC: Calibri, then Arial.
 */
export function wordDefault() {
  const w = state.word || {};
  const family = usable(w.body) || usable('Aptos') || usable('Calibri') || resolveFamily('Arial') || 'Arial';
  const size = Number(w.size) > 0 && Number(w.size) <= 200 ? Number(w.size) : 11;
  return { family, size };
}
/** Theme fonts like in Word: headings and body. */
export function themeFonts() {
  const w = state.word || {};
  const body = usable(w.body) || wordDefault().family;
  const heading = usable(w.heading);
  return [heading && { name: heading, label: `${heading} (Headings)` }, body && { name: body, label: `${body} (Body)` }].filter(Boolean);
}

const STYLE_WORDS = /(bold|italic|oblique|regular|roman|book|light|medium|semibold|demibold|black|heavy|condensed|narrow|mt|ps|psmt|std|pro)$/;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FAMILY_RULES = [[/arial|helvet/i, 'Arial'], [/times/i, 'Times New Roman'], [/courier/i, 'Courier New'], [/calibri|carlito/i, 'Calibri'], [/verdana/i, 'Verdana'], [/tahoma/i, 'Tahoma'], [/georgia/i, 'Georgia'], [/segoe/i, 'Segoe UI']];
/**
 * Maps the font name from the PDF (e.g. "ABCDEF+Aptos-Bold", "TimesNewRomanPSMT", "Calibri,Bold")
 * to an installed font. Otherwise a similar standard font.
 */
export function mapFamily(baseFont) {
  const base = String(baseFont || '').replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0];
  let n = norm(base);
  if (n && state.families.length) {
    for (let i = 0; i < 4 && n; i++) {
      const exact = state.families.find((f) => f.embeddable && norm(f.name) === n);
      if (exact) return exact.name;
      const next = n.replace(STYLE_WORDS, '');
      if (next === n) break;
      n = next;
    }
    // Longest installed name that the PDF name starts with (e.g. "arialnarrow..." before "arial").
    let best = null;
    for (const f of state.families) {
      const k = norm(f.name);
      if (f.embeddable && k.length >= 4 && norm(base).startsWith(k) && (!best || k.length > norm(best.name).length)) best = f;
    }
    if (best) return best.name;
  }
  const rule = (FAMILY_RULES.find(([r]) => r.test(baseFont || '')) || [0, 'Arial'])[1];
  return resolveFamily(rule) || rule;
}

/**
 * CSS name of a font for the input field and preview. The faces are loaded directly from the files
 * that also go into the PDF; so the input field looks like the result, even for Office cloud fonts.
 */
export function cssFamily(name) {
  const f = familyInfo(name);
  if (!f) return `"${String(name).replace(/"/g, '')}", sans-serif`;
  const alias = `bmf-${state.families.indexOf(f)}`;
  if (!cssLoaded.has(alias)) {
    const faces = [];
    f.faces.forEach((id, k) => {
      if (id === null || id === undefined) return;
      const face = new FontFace(alias, `url(/__font/${id})`, { weight: k & 1 ? '700' : '400', style: k & 2 ? 'italic' : 'normal' });
      document.fonts.add(face);
      faces.push(face.load().catch(() => null));
    });
    cssLoaded.set(alias, Promise.all(faces));
  }
  return `"${alias}", "${f.name.replace(/"/g, '')}", sans-serif`;
}
/** Waits until the faces of a font are loaded. */
export async function cssFamilyReady(name) {
  cssFamily(name);
  const f = familyInfo(name);
  if (f) await cssLoaded.get(`bmf-${state.families.indexOf(f)}`);
}

/** Regular face only, for the preview in the picker list. */
const previewLoaded = new Map();
export function previewFamily(f) {
  if (f.symbol || f.preview === null || f.preview === undefined || f.size > 6e6) return null;
  const alias = `bmp-${f.preview}`;
  if (!previewLoaded.has(alias)) {
    const face = new FontFace(alias, `url(/__font/${f.preview})`);
    document.fonts.add(face);
    previewLoaded.set(alias, face.load().catch(() => null));
  }
  return alias;
}

// Recently used fonts (shown at the top of the list like in Word).
const RECENT_KEY = 'dp-recent-fonts';
export function recentFonts() {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).filter((n) => usable(n)).slice(0, 6); } catch { return []; }
}
export function rememberFont(name) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...recentFonts().filter((n) => n !== name)].slice(0, 6))); } catch { /* convenience only */ }
}

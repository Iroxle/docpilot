// Preferences (Ctrl+K): categories on the left, settings on the right.
import { h } from './util.js';

export const DEFAULTS = {
  appearance: 'light', restoreDocs: false, recentCount: 10,
  warnSigned: true,
  formHighlight: false,
  userName: '', org: '', email: '',
  jsEnabled: false,
  commentFontSize: 12, openCommentsPanel: true, printComments: true,
  defaultZoom: 'width', defaultLayout: 'continuous', openPanel: 'auto',
  links: 'ask', attachmentsSave: true,
  officeMacros: false,
  units: 'mm', gridSize: 10,
  speechRate: 1, speechVoice: '',
  searchCase: false, searchWhole: false,
  autosaveMinutes: 2, thumbSize: 150, measureSnap: true,
  ocrOnOpen: 'ask', ocrOnCreate: true, ocrLang: 'deu+eng', ocrDeskew: false,
};
export const withDefaults = (s) => ({ ...DEFAULTS, ...(s || {}) });

const voices = () => {
  const v = (window.speechSynthesis?.getVoices() || []).filter((x) => /^(de|fr|it|en)/i.test(x.lang));
  return [['', 'Default voice'], ...v.map((x) => [x.name, `${x.name} (${x.lang})`])];
};

/** Categories in alphabetical order. */
const CATEGORIES = () => [
  { id: 'general', label: 'General', fields: [
    { k: 'appearance', type: 'select', label: 'Appearance', options: [['light', 'Light'], ['dark', 'Dark'], ['system', 'Same as Windows']], help: 'Default: Light. In the dark appearance, the title bar with the tabs, the tools pane, sidebars, dialogs and the home page are dark. The PDF pages stay white like paper; only the background around the pages becomes dark. "Same as Windows" follows the Windows setting (Colors > Mode). The change takes effect immediately.' },
    { k: 'restoreDocs', type: 'checkbox', label: 'Reopen the last open documents at startup' },
    { k: 'recentCount', type: 'select', label: 'Number of recent files', options: [[5, '5'], [10, '10'], [20, '20'], [30, '30']] },
  ] },
  { id: 'documents', label: 'Documents', fields: [
    { k: 'warnSigned', type: 'checkbox', label: 'Warn before changing a digitally signed document' },
    { k: 'autosaveMinutes', type: 'select', label: 'Keep a copy of unsaved changes for recovery', options: [[0, 'Off'], [1, 'Every minute'], [2, 'Every 2 minutes'], [5, 'Every 5 minutes'], [10, 'Every 10 minutes']], help: 'If DocPilot is not closed properly (for example after a crash or a power cut), the documents with unsaved changes are offered for recovery at the next start. Password-protected documents are not copied.' },
  ] },
  { id: 'units', label: 'Units & Guides', fields: [
    { k: 'units', type: 'select', label: 'Unit (rulers and measuring)', options: [['mm', 'Millimeters'], ['cm', 'Centimeters'], ['in', 'Inches'], ['pt', 'Points']] },
    { k: 'gridSize', type: 'number', label: 'Grid spacing in mm', min: 1, max: 100 },
  ] },
  { id: 'forms', label: 'Forms', fields: [
    { k: 'formHighlight', type: 'checkbox', label: 'Highlight form fields' },
  ] },
  { id: 'identity', label: 'Identity', fields: [
    { k: 'userName', type: 'text', label: 'Name', help: 'Appears as the author of comments, stamps and digital IDs.' },
    { k: 'org', type: 'text', label: 'Organization' },
    { k: 'email', type: 'text', label: 'Email' },
  ] },
  { id: 'convert', label: 'Convert to PDF', fields: [
    { k: 'officeMacros', type: 'checkbox', lock: 'allowOfficeMacros', label: 'Allow macros in Word, Excel and PowerPoint files during conversion', help: 'Default: off. When creating a PDF from an Office file, all macros are blocked. When turned on, the macro settings of Microsoft Office apply.' },
  ] },
  { id: 'js', label: 'JavaScript', fields: [
    { k: 'jsEnabled', type: 'checkbox', lock: 'allowJavaScript', label: 'Enable JavaScript in PDF documents', help: 'Default: off. When turned on, scripts in forms (e.g. calculations, validations, formatting) run in an isolated environment without access to files or the internet. The change takes effect immediately, including for the open document.' },
  ] },
  { id: 'comments', label: 'Comment', fields: [
    { k: 'commentFontSize', type: 'select', label: 'Font size for new text boxes', options: [8, 9, 10, 11, 12, 14, 16, 18, 20, 24].map((v) => [v, `${v} pt`]) },
    { k: 'openCommentsPanel', type: 'checkbox', label: 'Open the comment list automatically when commenting' },
    { k: 'printComments', type: 'checkbox', label: 'Print comments by default' },
  ] },
  { id: 'ocr', label: 'Scan & OCR', fields: [
    { k: 'ocrOnOpen', type: 'select', label: 'Scanned documents when opening', options: [['ask', 'Offer to recognize text'], ['auto', 'Recognize text automatically'], ['never', 'Do nothing']] },
    { k: 'ocrOnCreate', type: 'checkbox', label: 'Recognize text when a PDF is created from an image, the scanner or the clipboard, or when an image is pasted with Ctrl+V' },
    { k: 'ocrDeskew', type: 'checkbox', label: 'Straighten skewed scans automatically when recognizing text', help: 'Default: off. A skewed page is always straightened for reading; the recognized text still lies over the skewed image afterwards. When turned on, the image of the page itself is also rotated straight (as with "Straighten page" under "Scan & OCR"). Pages that are already straight and pages with normal text stay unchanged.' },
    { k: 'ocrLang', type: 'select', label: 'Text recognition language', options: [['deu+eng', 'German + English'], ['deu', 'German'], ['fra', 'French'], ['ita', 'Italian'], ['eng', 'English'], ['deu+fra+ita+eng', 'All four languages (slower)']], help: 'Text recognition runs entirely on this PC, without the internet. Recognized text can be searched, copied and changed under "Edit PDF".' },
  ] },
  { id: 'page', label: 'Page Display', fields: [
    { k: 'defaultZoom', type: 'select', label: 'Zoom', options: [['width', 'Fit width'], ['page', 'Fit page'], ['height', 'Fit visible height'], ['actual', 'Actual size']] },
    { k: 'defaultLayout', type: 'select', label: 'Page layout', options: [['continuous', 'Continuous'], ['single', 'Single page'], ['double', 'Two pages'], ['double-continuous', 'Two pages continuous']] },
    { k: 'openPanel', type: 'select', label: 'Sidebar when opening', options: [['auto', 'As set in the document'], ['none', 'Closed'], ['thumbs', 'Page thumbnails'], ['bookmarks', 'Bookmarks'], ['comments', 'Comments']] },
  ] },
  { id: 'speech', label: 'Read Out Loud', fields: [
    { k: 'speechVoice', type: 'select', label: 'Voice', options: voices() },
    { k: 'speechRate', type: 'select', label: 'Speed', options: [[0.75, 'Slow'], [1, 'Normal'], [1.25, 'Faster'], [1.5, 'Fast']] },
  ] },
  { id: 'search', label: 'Find', fields: [
    { k: 'searchCase', type: 'checkbox', label: 'Match case by default' },
    { k: 'searchWhole', type: 'checkbox', label: 'Search whole words only by default' },
  ] },
  { id: 'trust', label: 'Trust Manager', fields: [
    { k: 'links', type: 'select', label: 'Links to web pages in documents', options: [['ask', 'Always ask'], ['allow', 'Always allow'], ['block', 'Block']] },
    { k: 'attachmentsSave', type: 'checkbox', label: 'Allow saving file attachments from PDF documents', help: 'File attachments are never run directly, only saved.' },
  ] },
];

/**
 * Opens Preferences. Returns the new values or null if cancelled.
 * policy: IT policy. Blocked options are grayed out and stay off.
 */
export function openPreferences(current, startAt, policy = {}) {
  return new Promise((resolve) => {
    const work = withDefaults(current);
    const cats = CATEGORIES();
    for (const c of cats) for (const f of c.fields) if (f.lock && !policy[f.lock]) work[f.k] = false;
    let active = cats.find((c) => c.id === startAt) || cats[0];
    const nav = h('div', { class: 'pref-nav', role: 'tablist' });
    const pane = h('div', { class: 'pref-pane' });
    const field = (f) => {
      const v = work[f.k];
      let input;
      if (f.type === 'checkbox') {
        const locked = !!f.lock && !policy[f.lock];
        input = h('input', { type: 'checkbox', checked: !locked && !!v, disabled: locked, onchange: (e) => { if (!locked) work[f.k] = e.target.checked; } });
        input.dataset.pref = f.k;
        const help = locked
          ? 'Blocked. This feature stays off for security reasons.'
          : f.help;
        return h('div', { class: `pref-row ${locked ? 'locked' : ''}` },
          h('label', { class: 'pref-chk' }, input, h('span', {}, f.label), locked ? h('span', { class: 'pref-lock' }, 'Blocked') : null),
          help ? h('div', { class: 'pref-help' }, help) : null);
      }
      if (f.type === 'select') {
        input = h('select', { onchange: (e) => { const o = f.options.find(([x]) => String(x) === e.target.value); work[f.k] = o ? o[0] : e.target.value; } },
          f.options.map(([val, label]) => h('option', { value: val, selected: String(val) === String(v) }, label)));
      } else if (f.type === 'number') {
        input = h('input', { type: 'number', min: f.min, max: f.max, value: v, onchange: (e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) work[f.k] = Math.min(f.max ?? n, Math.max(f.min ?? n, n)); } });
      } else {
        input = h('input', { type: 'text', value: v || '', spellcheck: 'false', oninput: (e) => { work[f.k] = e.target.value; } });
      }
      input.dataset.pref = f.k;
      return h('div', { class: 'pref-row' }, h('label', { class: 'pref-lbl' }, h('span', {}, f.label), input), f.help ? h('div', { class: 'pref-help' }, f.help) : null);
    };
    const render = () => {
      nav.replaceChildren(...cats.map((c) => h('button', { class: `pref-cat ${c === active ? 'active' : ''}`, type: 'button', role: 'tab', data: { cat: c.id }, onclick: () => { active = c; render(); } }, c.label)));
      pane.replaceChildren(h('h4', {}, active.label), ...active.fields.map(field));
    };
    render();
    const close = (val) => { scrim.remove(); resolve(val); };
    const dlg = h('div', { class: 'dlg pref', role: 'dialog', 'aria-label': 'Preferences' },
      h('h3', {}, 'Preferences'),
      h('div', { class: 'pref-body' }, nav, pane),
      h('div', { class: 'f' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', 'data-ok': '1', onclick: () => close(work) }, 'OK')));
    const scrim = h('div', { class: 'scrim' }, dlg);
    scrim.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(null); });
    document.body.append(scrim);
    setTimeout(() => nav.querySelector('.active')?.focus(), 10);
  });
}

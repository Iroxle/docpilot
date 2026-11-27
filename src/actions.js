// Action wizard: named sequences of steps (recognize text, reduce file size, watermark, ...) run over several files.
// Every file is opened, the steps run in their order exactly as the tools do, and the result is saved under the same
// name in the chosen folder ("_processed" is added when it is the folder the file comes from). A step that fails
// fails the file: nothing is saved for it, and the report says which step and why. Actions of one's own are kept in
// the preferences.
//
// Ported from PdfCraft's engine crate (actions) (Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors, MIT
// license, see THIRD_PARTY_NOTICES.md).
import { h, ibtn, toast, busy, formDialog, messageBox, fileBase, inFolder, imageCodec } from './util.js';
import * as ops from './pdf/ops.js';
import * as optimize from './pdf/optimize.js';
import * as pdfa from './pdf/pdfa.js';
import { flattenAnnotationsInDoc } from './pdf/annots.js';
import { readFont } from './document.js';
import * as conv from './convert.js';

/** The steps: id -> {label, arg (label of its text argument, if it takes one), default argument}. */
export const STEPS = {
  recognize_text: { label: 'Recognize text' },
  enhance_scans: { label: 'Enhance scanned pages' },
  reduce_file_size: { label: 'Reduce file size' },
  remove_hidden: { label: 'Remove hidden information' },
  flatten_comments: { label: 'Flatten comments' },
  flatten_fields: { label: 'Flatten form fields' },
  add_watermark: { label: 'Add watermark', arg: 'Text', def: 'CONFIDENTIAL' },
  add_header: { label: 'Add header', arg: 'Text', def: '{file}' },
  add_footer: { label: 'Add footer', arg: 'Text', def: 'Page {page} of {pages}' },
  set_title: { label: 'Set document title', arg: 'Title', def: '' },
  grayscale: { label: 'Convert to grayscale' },
  fix_hairlines: { label: 'Fix hairlines' },
  auto_tag: { label: 'Automatically tag document' },
  pdfa: { label: 'Convert to PDF/A-2b' },
};

/** The built-in actions. */
export const BUILTIN = [
  { name: 'Prepare for distribution', description: 'Remove hidden information and flatten comments and form fields, so recipients see only the pages.', steps: [{ step: 'remove_hidden' }, { step: 'flatten_comments' }, { step: 'flatten_fields' }] },
  { name: 'Optimize scanned documents', description: 'Clean up the scans, make them searchable, then make them smaller.', steps: [{ step: 'enhance_scans' }, { step: 'recognize_text' }, { step: 'reduce_file_size' }] },
  { name: 'Add page numbers', description: 'Number every page in the footer.', steps: [{ step: 'add_footer', arg: 'Page {page} of {pages}' }] },
  { name: 'Mark as confidential', description: 'A diagonal CONFIDENTIAL watermark on every page.', steps: [{ step: 'add_watermark', arg: 'CONFIDENTIAL' }] },
  { name: 'Make accessible', description: 'Recognize text in scans, tag the document and show its title.', steps: [{ step: 'recognize_text' }, { step: 'auto_tag' }] },
  { name: 'Archive as PDF/A', description: 'Make scans searchable and convert to PDF/A-2b for long-term archiving.', steps: [{ step: 'recognize_text' }, { step: 'pdfa' }] },
];
export const stepLabel = (s) => `${STEPS[s.step]?.label || s.step}${STEPS[s.step]?.arg && s.arg ? `: "${s.arg}"` : ''}`;

/** Runs one step on the open document d (the active document). Returns a line for the log. */
async function runStep(app, d, s) {
  const T = app.tools; const all = [...Array(d.numPages).keys()];
  const m = (fn) => d.mutate(fn, { skipCheck: true });
  switch (s.step) {
    case 'recognize_text': { const n = await T.recognizeText(all, { quiet: true, silent: true, skipCheck: true }); return `Recognize text: ${n} page(s) with new text`; }
    case 'enhance_scans': { let r; await m(async (b) => { r = await ops.enhanceScans(b, all, { mode: 'clean', codec: imageCodec }); return r; }); return `Enhance scanned pages: ${r.pages} page(s)`; }
    case 'reduce_file_size': { const before = d.bytes.length; await m(async (b) => (await optimize.optimizePdf(b, optimize.PRESETS.standard, { codec: imageCodec })).bytes); d.fullSave = true; return `Reduce file size: ${before} to ${d.bytes.length} bytes`; }
    case 'remove_hidden': await m((b) => ops.sanitizeDocument(b, { metadata: true, attachments: true, javascript: true, thumbs: true })); d.fullSave = true; return 'Remove hidden information';
    case 'flatten_comments': {
      const bytes = await d.buildOutput({ noEncrypt: true });
      const doc = await ops.loadForEdit(bytes); flattenAnnotationsInDoc(doc);
      const out = await ops.saveDoc(doc);
      d.annots = new Map();
      await m(() => out);
      return 'Flatten comments';
    }
    case 'flatten_fields': await m((b) => ops.flattenForms(b)); return 'Flatten form fields';
    case 'add_watermark': await m((b) => ops.addWatermark(b, { text: s.arg || 'CONFIDENTIAL', size: 64, color: '#808080', opacity: 0.3, rotation: 45, settings: { kind: 'text', text: s.arg, size: 64, color: '#808080', opacity: 30, rotation: 45 } }, readFont)); return stepLabel(s);
    case 'add_header': case 'add_footer': {
      const key = s.step === 'add_header' ? 'center' : 'footCenter';
      await m((b) => ops.addHeaderFooter(b, { [key]: s.arg || '', fileName: d.name, settings: { [key]: s.arg || '' } }, readFont));
      return stepLabel(s);
    }
    case 'set_title': await m((b) => ops.setMetadata(b, { title: s.arg || fileBase(d.name) })); return stepLabel(s);
    case 'grayscale': await m((b) => ops.convertToGray(b, all, { codec: imageCodec })); return 'Convert to grayscale';
    case 'fix_hairlines': { let r; await m(async (b) => { r = await ops.fixHairlines(b, all); return r; }); return `Fix hairlines: ${r.lines} line(s)`; }
    case 'auto_tag': {
      if ((await ops.readTags(d.bytes)).length) return 'Automatically tag document: already tagged';
      await m(async (b) => ops.fixAccessibility((await ops.autoTag(b)).bytes));
      return 'Automatically tag document';
    }
    case 'pdfa': {
      const res = await pdfa.convertPdfA(await d.buildOutput({ noEncrypt: true }), '2b', await window.dp.srgbIcc(), fileBase(d.name));
      d.annots = new Map();
      await m(() => res.bytes);
      d.fullSave = true;
      return `Convert to PDF/A-2b${res.remaining.length ? `: ${res.remaining.length} problem(s) remain` : ''}`;
    }
    default: throw new Error(`Unknown step: ${s.step}`);
  }
}

/**
 * Runs the steps on files and saves the results in dir. Returns [{file, out, log, error}]. progress(k, n, text).
 */
export async function runAction(app, steps, files, dir, progress) {
  const results = [];
  for (let k = 0; k < files.length; k++) {
    const p = files[k];
    const name = p.split(/[\\/]/).pop();
    const base = /\.pdf$/i.test(name) ? name : `${fileBase(name)}.pdf`;
    const log = []; let out = null; let error = null; let d = null; let opened = false;
    progress?.(k, files.length, name);
    try {
      const already = app.docs.find((x) => x.path && x.path.toLowerCase() === p.toLowerCase());
      if (already && already.dirty) throw new Error('The file is open with unsaved changes. Save or close it first.');
      d = already || (/\.pdf$/i.test(p) ? await app.openPath(p) : await app.openBytes(await conv.fileToPdf(p), base, { unsaved: true }));
      if (!d) throw new Error('The file could not be opened.');
      opened = !already;
      app.activate(d);
      await d.scanCheck?.catch(() => {});
      for (const s of steps) {
        try { log.push(await runStep(app, d, s)); } catch (e) { throw new Error(`${STEPS[s.step]?.label || s.step}: ${e.message}`); }
      }
      const src = p.replace(/[\\/][^\\/]+$/, '');
      out = inFolder(dir, src.toLowerCase() === dir.toLowerCase() ? `${fileBase(base)}_processed.pdf` : base);
      await window.dp.writeFile(out, await d.buildOutput({ noEncrypt: true }));
    } catch (e) { error = e.message; out = null; }
    if (d && opened) await app.closeDoc(d, true);
    else if (d && !error) { d.dirty = false; await app.closeDoc(d, true); await app.openPath(p); }
    results.push({ file: p, out, log, error });
  }
  progress?.(files.length, files.length, '');
  return results;
}

/** The action wizard: choose or edit an action, then run it over files. */
export async function actionWizard(app, preset) {
  const saved = () => app.settings.actions || [];
  let steps = (preset?.steps || BUILTIN[0].steps).map((s) => ({ ...s }));
  let name = preset?.name || BUILTIN[0].name;
  const list = h('div', { class: 'aw-steps' });
  const all = () => [...BUILTIN.map((a) => ({ ...a, builtin: true })), ...saved()];
  const pick = h('select', { class: 'fld', data: { awAction: '1' } });
  const fillPick = () => pick.replaceChildren(...all().map((a, k) => h('option', { value: String(k), selected: a.name === name }, `${a.name}${a.builtin ? '' : ' (own)'}`)));
  const desc = h('p', { class: 'aw-desc' });
  const draw = () => {
    const a = all().find((x) => x.name === name);
    desc.textContent = a?.description || 'Your own action.';
    list.replaceChildren(...steps.map((s, k) => h('div', { class: 'aw-step', data: { step: s.step } },
      h('span', { class: 'n' }, `${k + 1}.`), h('span', { class: 'l' }, STEPS[s.step].label),
      STEPS[s.step].arg ? (() => { const inp = h('input', { type: 'text', value: s.arg ?? STEPS[s.step].def, placeholder: STEPS[s.step].arg, data: { stepArg: String(k) } }); inp.addEventListener('input', () => { s.arg = inp.value; }); s.arg = s.arg ?? STEPS[s.step].def; return inp; })() : h('span', {}),
      ibtn('chevU', 'Move up', () => { if (k) { [steps[k - 1], steps[k]] = [steps[k], steps[k - 1]]; draw(); } }),
      ibtn('chevD', 'Move down', () => { if (k < steps.length - 1) { [steps[k + 1], steps[k]] = [steps[k], steps[k + 1]]; draw(); } }),
      ibtn('trash', 'Remove step', () => { steps.splice(k, 1); draw(); }))));
    if (!steps.length) list.append(h('div', { class: 'empty' }, 'No steps yet. Add a step below.'));
  };
  pick.addEventListener('change', () => { const a = all()[+pick.value]; name = a.name; steps = a.steps.map((s) => ({ ...s })); draw(); });
  const add = h('select', { class: 'fld', data: { awAdd: '1' } }, h('option', { value: '' }, 'Add a step...'), Object.entries(STEPS).map(([id, s]) => h('option', { value: id }, s.label)));
  add.addEventListener('change', () => { if (add.value) { steps.push({ step: add.value, arg: STEPS[add.value].def }); add.value = ''; draw(); } });
  fillPick(); draw();
  const body = h('div', { class: 'aw' }, h('label', { class: 'fr' }, h('span', {}, 'Action'), pick), desc, h('div', { class: 'aw-title' }, 'Steps (run in this order)'), list, add);
  const c = await messageBox('Action wizard', body, ['Choose files and run...', 'Save as my action...', 'Cancel'], { primary: 0, wide: true, cancel: 2 });
  if (c === 2 || !steps.length) { if (c !== 2) toast('Please add at least one step.'); return null; }
  if (c === 1) {
    const r = await formDialog('Save action', [{ k: 'name', label: 'Name', value: BUILTIN.some((b) => b.name === name) ? '' : name, required: true }, { k: 'description', label: 'Description', value: '' }], { validate: (v) => (BUILTIN.some((b) => b.name.toLowerCase() === v.name.trim().toLowerCase()) ? 'A built-in action already has this name.' : null) });
    if (!r) return null;
    app.settings.actions = [...saved().filter((a) => a.name !== r.name.trim()), { name: r.name.trim(), description: r.description, steps }];
    await app.saveSettings();
    toast('Action saved', 'ok');
    return actionWizard(app, { name: r.name.trim(), steps });
  }
  const files = await window.dp.openDialog({ title: 'Choose the files for the action', multi: true, filters: [{ name: 'PDF and images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'gif', 'webp'] }] });
  if (!files.length) return null;
  const dir = await window.dp.folderDialog('Choose the folder for the results');
  if (!dir) return null;
  return runAndReport(app, steps, files, dir);
}

export async function runAndReport(app, steps, files, dir) {
  const res = await busy('Running action', (progress) => runAction(app, steps, files, dir, (k, n, t) => progress(k / n, t ? `${t} (${k + 1} of ${n})` : '')));
  const ok = res.filter((r) => !r.error);
  const body = h('div', {}, h('p', {}, `${ok.length} of ${res.length} file${res.length === 1 ? '' : 's'} processed.`),
    h('ul', { class: 'aw-report' }, res.map((r) => h('li', { class: r.error ? 'bad' : 'ok' }, h('b', {}, r.file.split(/[\\/]/).pop()), r.error ? ` - ${r.error}` : ` - ${r.log.join('; ')}`))));
  await messageBox('Action wizard', body, ['Close'], { wide: true });
  if (ok.length) window.dp.openPath(dir);
  return res;
}

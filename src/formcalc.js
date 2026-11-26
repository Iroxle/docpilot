// Filling in forms with formats, validation and calculations while JavaScript stays blocked: the standard
// AF scripts of the fields (number, percent, date, time and special formats, value ranges, sums, products,
// averages, minimum, maximum, simplified field notation) run natively (see pdf/afcalc.js). Image fields take a
// picture when clicked. Other scripts only run when JavaScript is allowed in Preferences.
import * as af from './pdf/afcalc.js';
import { isImageScript, setButtonImage } from './pdf/formauthor.js';
import { messageBox, normalizeImage, errToast } from './util.js';

const entries = (actions) => (actions instanceof Map ? Object.fromEntries(actions) : actions || {});

export class FormCalc {
  constructor(app) { this.app = app; this.models = new WeakMap(); }

  /** The fields of a document with what runs natively: {byName, byId, order}, or null without any. */
  async model(doc) {
    const cached = this.models.get(doc);
    if (cached && cached.pdf === doc.pdf) return cached.model;
    let model = null;
    try {
      const objs = await doc.fieldObjects();
      const list = objs instanceof Map ? [...objs] : Object.entries(objs || {});
      const byName = new Map(); const byId = new Map(); const idToName = new Map();
      for (const [name, items] of list) {
        const withActions = items.find((x) => x.actions && (x.actions.size || Object.keys(x.actions).length));
        const acts = entries(withActions?.actions);
        const a = af.readActions(acts);
        const widgets = items.filter((x) => x.page >= 0 || x.type);
        const image = items.some((x) => x.type === 'button' && isImageScript([].concat(entries(x.actions).Action || []).join('\n')));
        const field = { name, ...a, image, type: widgets[0]?.type || '', ids: widgets.map((x) => x.id), initial: widgets[0]?.value ?? '' };
        for (const x of items) idToName.set(x.id, name);
        if (a.format || a.validate || a.calculate || image) for (const id of field.ids) byId.set(id, field);
        byName.set(name, field);
      }
      if (byId.size) {
        const co = (await doc.pdf.getCalculationOrderIds().catch(() => null)) || [];
        const order = [...new Set(co.map((id) => idToName.get(id)).filter((n) => byName.get(n)?.calculate))];
        for (const f of byName.values()) if (f.calculate && !order.includes(f.name)) order.push(f.name);
        model = { byName, byId, order };
      }
    } catch (e) { console.warn('Form calculations', e); }
    this.models.set(doc, { pdf: doc.pdf, model });
    return model;
  }

  raw(doc, f) {
    const id = f.ids[0];
    const v = id ? doc.pdf.annotationStorage.getValue(id, { value: f.initial }).value : f.initial;
    return Array.isArray(v) ? v.join(',') : v === true ? 'Yes' : v === false ? 'Off' : String(v ?? '');
  }

  /** The values of the field named name and of the fields below it (for a group name). */
  values(doc, model, name) {
    const out = [];
    for (const [n, f] of model.byName) if (n === name || n.startsWith(`${name}.`)) { const v = this.raw(doc, f); if (v !== '' && v !== 'Off') out.push(v); }
    return out;
  }

  store(doc, f, value) {
    const formattedValue = f.format ? af.formatValue(f.format, value) : null;
    for (const id of f.ids) doc.pdf.annotationStorage.setValue(id, formattedValue !== null && formattedValue !== value ? { value, formattedValue } : { value, formattedValue: null });
  }

  /** Recalculates every calculated field in the calculation order. Returns the names that changed. */
  recalc(doc, model) {
    const changed = [];
    for (const name of model.order) {
      const f = model.byName.get(name);
      const v = af.calculate(f.calculate, (n) => this.values(doc, model, n));
      if (v === null || v === this.raw(doc, f)) continue;
      this.store(doc, f, v);
      changed.push(name);
    }
    return changed;
  }

  /** Shows the values of the rendered fields again (formatted unless the field is being edited). */
  refresh(doc, model, names) {
    for (const el of document.querySelectorAll('.annotationLayer section[data-annotation-id] input, .annotationLayer section[data-annotation-id] textarea')) {
      const f = model.byId.get(el.closest('section').dataset.annotationId);
      if (!f || (names && !names.includes(f.name)) || el === document.activeElement) continue;
      const raw = this.raw(doc, f);
      el.value = f.format ? af.formatValue(f.format, raw) : raw;
    }
  }

  /** After a form layer was drawn: formats, commit checks, calculations and image fields for its fields. */
  async decorate(div, doc) {
    const model = await this.model(doc);
    if (!model) return;
    for (const section of div.querySelectorAll('section[data-annotation-id]')) {
      const f = model.byId.get(section.dataset.annotationId);
      if (!f) continue;
      if (f.image) {
        section.style.cursor = 'pointer';
        section.title = 'Click to choose a picture';
        section.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.pickImage(doc, f).catch(errToast); }, true);
        continue;
      }
      const el = section.querySelector('input, textarea');
      if (!el) continue;
      if (f.format && el !== document.activeElement) el.value = af.formatValue(f.format, this.raw(doc, f));
      // The value before typing (PDF.js stores every keystroke): a refused entry goes back to it.
      el.addEventListener('focus', () => { f.committed = this.raw(doc, f); if (f.format) el.value = f.committed; });
      el.addEventListener('blur', () => this.commit(doc, model, f, el).catch(errToast));
    }
  }

  async commit(doc, model, f, el) {
    const typed = el.value;
    const before = f.committed ?? this.raw(doc, f);
    f.committed = undefined;
    const show = () => { el.value = f.format ? af.formatValue(f.format, this.raw(doc, f)) : this.raw(doc, f); };
    const k = af.keystroke(f.format, f.name, typed);
    if (k.error) { this.store(doc, f, before); show(); await messageBox('Form', k.error); return; }
    const bad = af.validate(f.validate, k.value);
    if (bad) { this.store(doc, f, before); show(); await messageBox('Form', bad); return; }
    this.store(doc, f, k.value);
    show();
    const changed = this.recalc(doc, model);
    if (changed.length || k.value !== before) doc.markDirty();
    if (changed.length) this.refresh(doc, model, changed);
  }

  async pickImage(doc, f) {
    const [p] = await window.dp.openDialog({ title: 'Choose a picture', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }] });
    if (!p) return;
    const img = await normalizeImage(await window.dp.readFile(p), p);
    await doc.mutate((b) => setButtonImage(b, f.name, img.bytes, img.mime), {});
  }
}

// Autosave and recovery after a crash: documents with unsaved changes are written to the app's data folder every
// few minutes (Preferences > Documents). Saving, closing or quitting normally removes the copy. When DocPilot
// starts and copies are still there, it was not closed properly: the documents are offered for recovery.
// Password-protected documents are not written there (the copy would not be protected).
import { messageBox, toast, fmtDate, h } from './util.js';
import { loadForEdit, saveDoc } from './pdf/ops.js';
import { writeAnnotations } from './pdf/annots.js';
import { readFont } from './document.js';

const dp = window.dp;
const session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class Autosave {
  constructor(app) {
    this.app = app;
    this.written = new Map(); // doc -> undo depth and bytes of the last copy
    this.timer = setInterval(() => this.tick().catch((e) => console.warn('Autosave', e)), 20000);
  }
  idOf(d) { return `${session}-${d.id}`; }
  minutes() { return Number(this.app.settings.autosaveMinutes ?? 2); }
  /** Writes copies of the dirty documents whose last copy is older than the interval. */
  async tick(force = false) {
    const min = this.minutes();
    if (!force && !(min > 0)) return 0;
    let n = 0;
    for (const d of this.app.docs) {
      if (!d.dirty || d.security || d.encrypted) continue;
      const last = this.written.get(d);
      const annots = JSON.stringify([...d.annots.entries()]);
      if (last && last.bytes === d.bytes && last.annots === annots) continue;
      if (!force && last && Date.now() - last.at < min * 60000) continue;
      const bytes = await this.snapshot(d);
      await dp.autosaveWrite(this.idOf(d), bytes, { name: d.name, path: d.path || '', time: Date.now() });
      this.written.set(d, { bytes: d.bytes, annots, at: Date.now() });
      n++;
    }
    return n;
  }
  /**
   * The document as it is now, with comments and typed form values, without changing the open document (unlike
   * saving, which takes the form values over into it).
   */
  async snapshot(d) {
    let bytes = d.pdf?.annotationStorage?.size ? await d.pdf.saveDocument() : d.bytes;
    if (d.allAnnots().length) { const doc = await loadForEdit(bytes); await writeAnnotations(doc, d.annots, readFont); bytes = await saveDoc(doc); }
    return bytes;
  }
  /** The document was saved or closed: its copy is not needed any more. */
  async drop(d) {
    if (!this.written.has(d)) return;
    this.written.delete(d);
    await dp.autosaveRemove(this.idOf(d));
  }
  async dropAll() { for (const d of [...this.written.keys()]) await this.drop(d); }
  /** At startup: copies left by an earlier session that did not end normally are offered for recovery. */
  async offerRecovery() {
    const list = (await dp.autosaveList()).filter((x) => !x.id.startsWith(session));
    if (!list.length) return 0;
    const body = h('div', {}, h('p', {}, 'DocPilot was not closed properly. These documents have changes that were not saved:'),
      h('ul', { class: 'recover-list' }, list.map((x) => h('li', {}, h('b', {}, x.name), x.path ? ` (${x.path})` : '', h('br'), h('small', {}, `Last copy: ${fmtDate(new Date(x.time).toISOString())}`)))));
    const c = await messageBox('Recover documents', body, ['Recover', 'Discard'], { primary: 0, cancel: 1 });
    let opened = 0;
    for (const x of list) {
      if (c === 0) {
        const bytes = await dp.autosaveRead(x.id);
        if (bytes) {
          const d = await this.app.openBytes(bytes, x.name, { unsaved: true });
          if (d) { if (x.path) d.path = x.path; d.markDirty(); opened++; }
        }
      }
      await dp.autosaveRemove(x.id);
    }
    if (opened) toast(`${opened} document${opened === 1 ? '' : 's'} recovered. Save to keep the changes.`, 'ok');
    return opened;
  }
}

// Open document: bytes, PDF.js proxy, comments, undo history, saving.
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { PDFDocument } from '@cantoo/pdf-lib';
import { loadDoc, loadForEdit, saveDoc, cryptoRandom, gcObjects } from './pdf/ops.js';
import { stripAndImport, writeAnnotations } from './pdf/annots.js';
import { formDialog, messageBox, fileBase } from './util.js';

pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.mjs';
export const RENDER_OPTS = { cMapUrl:'pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'pdfjs/standard_fonts/', wasmUrl: 'pdfjs/wasm/', iccUrl: 'pdfjs/iccs/', isEvalSupported: false, enableXfa: false, verbosity: 0 };
const UNDO_LIMIT = 30;
const MAX_ANNOT_IMPORT = 150 * 1048576;
// Number: face from the font catalog. Text: file in the Windows fonts folder.
export const readFont = (f) => (typeof f === 'number' ? window.dp.fontFace(f) : window.dp.font(f));
export { pdfjs };

const clone = (m) => new Map([...m].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
function contains(bytes, needle) {
  const n = [...needle].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - n.length; i++) {
    if (bytes[i] !== n[0]) continue;
    for (let k = 1; k < n.length; k++) if (bytes[i + k] !== n[k]) continue outer;
    return true;
  }
  return false;
}

function permissionOptions(p) {
  const F = pdfjs.PermissionFlag;
  return { printing: p.includes(F.PRINT_HIGH_QUALITY) ? 'highResolution' : p.includes(F.PRINT) ? 'lowResolution' : false, modifying: p.includes(F.MODIFY_CONTENTS), copying: p.includes(F.COPY), annotating: p.includes(F.MODIFY_ANNOTATIONS), fillingForms: p.includes(F.FILL_INTERACTIVE_FORMS), contentAccessibility: p.includes(F.COPY_FOR_ACCESSIBILITY), documentAssembly: p.includes(F.ASSEMBLE) };
}

async function askPassword(name, wrong) {
  const r = await formDialog('Password required', [
    { type: 'info', label: wrong ? 'The password was incorrect. Please try again.' : `"${name}" is protected. Please enter the password to open it.` },
    { k: 'pw', label: 'Password', type: 'password' },
  ], { ok: 'Open' });
  return r ? r.pw : null;
}

export class Doc {
  constructor({ name, path, bytes, unsaved }) {
    this.id = `d${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    this.name = name; this.path = path || null; this.bytes = bytes; this.saved = bytes;
    this.dirty = !!unsaved; this.annots = new Map(); this.undoStack = []; this.redoStack = [];
    this.security = null; this.restricted = false; this.signed = false; this.signWarned = false;
    this.listeners = new Set(); this.view = {};
    this.user = 'User';
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const l of this.listeners) l(type, data); }

  async openPdf(bytes, password) {
    const task = pdfjs.getDocument({ data: bytes.slice(), password, ...RENDER_OPTS });
    let lastPw = password;
    task.onPassword = async (update, reason) => {
      const pw = await askPassword(this.name, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
      if (pw === null) { task.destroy(); return; }
      lastPw = pw; update(pw);
    };
    const pdf = await task.promise;
    return { pdf, password: lastPw };
  }

  async load() {
    let { pdf, password } = await this.openPdf(this.bytes);
    this.signed = contains(this.bytes, '/ByteRange');
    this.encrypted = contains(this.bytes, '/Encrypt') && (await PDFDocument.load(this.bytes, { ignoreEncryption: true, updateMetadata: false })).isEncrypted;
    const rawPerms = this.encrypted ? await pdf.getPermissions() : null;
    const perms = rawPerms ? [...rawPerms] : null;
    this.permissions = perms;
    if (this.encrypted) {
      const d = await loadDoc(this.bytes, password ?? '');
      // Old cross-reference objects still carry the reference to the encryption and must go.
      gcObjects(d);
      const plain = await saveDoc(d);
      this.security = { userPassword: password ?? '', ownerPassword: null, permissions: perms ? permissionOptions(perms) : undefined };
      this.restricted = !!perms && !perms.includes(pdfjs.PermissionFlag.MODIFY_CONTENTS);
      this.noCopy = !!perms && !perms.includes(pdfjs.PermissionFlag.COPY);
      this.originalEncrypted = this.bytes;
      this.bytes = plain;
      await pdf.loadingTask.destroy();
      ({ pdf } = await this.openPdf(this.bytes));
    }
    this.pdf = pdf;
    if (this.bytes.length < MAX_ANNOT_IMPORT && !this.signed) {
      try {
        const r = await stripAndImport(this.bytes);
        this.annots = r.annots;
        if (r.bytes !== this.bytes) {
          this.bytes = r.bytes;
          await this.swapPdf();
        }
      } catch (e) { console.warn('Comments could not be loaded', e); this.annotImportFailed = true; }
    }
    await this.readInfo();
    return this;
  }

  async swapPdf() {
    const { pdf } = await this.openPdf(this.bytes);
    const old = this.pdf;
    this.pdf = pdf;
    if (old) old.loadingTask.destroy();
    await this.readInfo();
  }

  async readInfo() {
    const pdf = this.pdf;
    this.numPages = pdf.numPages;
    this.pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      this.pages.push({ view: p.view, rotate: p.rotate, proxy: p });
    }
    this.pageLabels = await pdf.getPageLabels();
    this.textCache = new Map();
    this.ocConfig = await pdf.getOptionalContentConfig();
    this.pageMode = await pdf.getPageMode().catch(() => null);
    // Does the document contain JavaScript (document actions or scripts in form fields)?
    this.hasJS = await (typeof pdf.hasJSActions === 'function' ? pdf.hasJSActions() : pdf.getJSActions().then((a) => !!a)).catch(() => false);
    this._fieldObjects = null;
  }

  async fieldObjects() {
    if (!this._fieldObjects) this._fieldObjects = this.pdf.getFieldObjects();
    return this._fieldObjects;
  }

  page(i) { return this.pages[i].proxy; }
  label(i) { return this.pageLabels?.[i] || String(i + 1); }

  async pageText(i) {
    if (!this.textCache.has(i)) this.textCache.set(i, await this.page(i).getTextContent());
    return this.textCache.get(i);
  }

  list(page) { if (!this.annots.has(page)) this.annots.set(page, []); return this.annots.get(page); }
  allAnnots() { return [...this.annots.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, l]) => l); }
  find(id) { return this.allAnnots().find((a) => a.id === id); }

  state() { return { bytes: this.bytes, annots: clone(this.annots) }; }
  pushUndo() {
    this.undoStack.push(this.state());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }
  markDirty() { this.dirty = true; this.emit('dirty'); }

  /** Call before a change. Protects permissions and warns for signed documents. */
  async allowEdit() {
    if (this.restricted) {
      const r = await formDialog('Document is protected', [
        { type: 'info', label: 'Changes to this document are restricted. Enter the permissions password to edit it.' },
        { k: 'pw', label: 'Permissions password', type: 'password' },
      ], { ok: 'Unlock' });
      if (!r) return false;
      let ok = false;
      if (r.pw && r.pw !== this.security.userPassword) { try { await loadDoc(this.originalEncrypted, r.pw); ok = true; } catch { ok = false; } }
      if (!ok) { await messageBox('Password', 'The permissions password is incorrect.'); return false; }
      this.security.ownerPassword = r.pw;
      this.restricted = false;
      this.emit('security');
    }
    if (this.signed && !this.signWarned && Doc.settings?.warnSigned !== false) {
      const c = await messageBox('Signed document', 'This document is digitally signed. Any change will invalidate the existing signature. Edit anyway?', ['Edit', 'Cancel'], { primary: 1 });
      if (c !== 0) return false;
      this.signWarned = true;
    }
    return true;
  }

  /** Copies form values from PDF.js into the bytes. */
  async commitForms() {
    if (this.pdf.annotationStorage.size === 0) return false;
    this.bytes = await this.pdf.saveDocument();
    await this.swapPdf();
    return true;
  }

  /** Structural change: fn(bytes) returns new bytes or {bytes,pageMap}. */
  async mutate(fn, o = {}) {
    if (!o.skipCheck && !(await this.allowEdit())) return false;
    await this.commitForms();
    const before = this.state();
    const r = await fn(this.bytes);
    const next = r instanceof Uint8Array ? r : r.bytes;
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.bytes = next;
    if (r.pageMap) this.remapAnnots(r.pageMap);
    await this.swapPdf();
    this.markDirty();
    this.emit('reload', { pages: o.pages, structural: !!r.pageMap || !o.pages });
    return true;
  }

  remapAnnots(map) {
    const next = new Map();
    map.forEach((old, i) => {
      if (old < 0 || !this.annots.has(old)) return;
      const copy = JSON.parse(JSON.stringify(this.annots.get(old)));
      copy.forEach((a) => { a.page = i; });
      next.set(i, copy);
    });
    // Beim Duplizieren brauchen Kopien eigene Kennungen.
    const seen = new Set();
    for (const list of next.values()) for (const a of list) { if (seen.has(a.id)) a.id = `${a.id}-${cryptoRandom().slice(0, 6)}`; seen.add(a.id); }
    this.annots = next;
  }

  async restore(state) {
    const same = state.bytes === this.bytes;
    this.bytes = state.bytes; this.annots = state.annots;
    if (!same) await this.swapPdf();
    this.markDirty();
    this.emit('reload', { structural: !same, annotOnly: same });
  }
  async undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.state());
    await this.restore(this.undoStack.pop());
    return true;
  }
  async redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.state());
    await this.restore(this.redoStack.pop());
    return true;
  }

  /** Creates the final PDF file with all comments. */
  async buildOutput(o = {}) {
    await this.commitForms();
    const hasAnnots = this.allAnnots().length > 0;
    if (!hasAnnots && !this.security) return this.bytes;
    const d = await loadForEdit(this.bytes);
    if (hasAnnots) await writeAnnotations(d, this.annots, readFont);
    if (this.security && !o.noEncrypt) {
      const perms = this.security.permissions;
      d.encrypt({ userPassword: this.security.userPassword || '', ownerPassword: this.security.ownerPassword || this.security.userPassword || cryptoRandom(), ...(perms ? { permissions: perms } : {}) });
    }
    return saveDoc(d);
  }

  async saveTo(path) {
    const out = await this.buildOutput();
    await window.dp.writeFile(path, out);
    this.saved = out; this.path = path;
    this.name = path.split(/[\\/]/).pop();
    this.dirty = false;
    this.emit('dirty');
    await window.dp.recentAdd(path);
  }

  suggestedPath(suffix = '') {
    const base = fileBase(this.name) + suffix;
    return this.path ? this.path.replace(/[^\\/]+$/, `${base}.pdf`) : `${base}.pdf`;
  }

  async revert() {
    this.undoStack = []; this.redoStack = [];
    this.bytes = this.saved; this.annots = new Map();
    await this.swapPdf();
    if (!this.signed && this.bytes.length < MAX_ANNOT_IMPORT && !this.security) {
      const r = await stripAndImport(this.bytes);
      this.annots = r.annots;
      if (r.bytes !== this.bytes) { this.bytes = r.bytes; await this.swapPdf(); }
    }
    this.dirty = false;
    this.emit('dirty'); this.emit('reload', { structural: true });
  }

  destroy() { if (this.pdf) this.pdf.loadingTask.destroy(); this.listeners.clear(); }
}

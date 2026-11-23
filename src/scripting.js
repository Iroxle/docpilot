// PDF JavaScript (form calculations etc.). Only runs when it is turned on in Preferences,
// and then in the isolated QuickJS environment of PDF.js without access to files or the network.
import './pdfjs-global.js';
import { EventBus, PDFScriptingManager } from 'pdfjs-dist/web/pdf_viewer.mjs';

export class Scripting {
  constructor(app) {
    this.app = app;
    this.eventBus = new EventBus();
    this.manager = null;
    this.doc = null;
  }
  // Double safeguard: the IT policy and the preference must both allow JavaScript.
  get enabled() { return !!this.app.policy?.allowJavaScript && !!this.app.settings.jsEnabled; }

  /** View as expected by the PDF.js scripts. */
  viewerShim() {
    const v = () => this.app.viewer;
    return {
      get currentPageNumber() { return v().current + 1; }, set currentPageNumber(n) { v().goto(n - 1); },
      get pagesCount() { return v().doc?.numPages || 0; },
      nextPage: () => v().next(), previousPage: () => v().prev(),
      increaseScale: () => v().zoomStep(1), decreaseScale: () => v().zoomStep(-1),
      get currentScaleValue() { return String(v().zoom); }, set currentScaleValue(z) { const m = { 'page-width': 'width', 'page-fit': 'page', auto: 'width' }; v().setZoom(m[z] || (Number.isFinite(+z) ? +z : 'width')); },
      set spreadMode(_m) { /* layout stays with the user */ },
      // Page view for page actions (PageOpen/PageClose). 3 = finished rendering.
      getPageView: (i) => { const n = v().node(i); return n ? { renderingState: n.layers ? 3 : 0, pdfPage: v().doc.page(i) } : null; },
      isInPresentationMode: false, isChangingPresentationMode: false,
      get pagesPromise() { return Promise.resolve(); },
    };
  }

  /** Set up for the active document if turned on and the document contains scripts. */
  async attach(doc) {
    if (this.doc === doc) return;
    await this.detach();
    this.doc = doc;
    if (!doc || !this.enabled || !doc.hasJS) return;
    this.manager = new PDFScriptingManager({ eventBus: this.eventBus, sandboxBundleSrc: new URL('pdfjs/pdf.sandbox.min.mjs', location.href).href, wasmUrl: 'pdfjs/wasm/' });
    this.manager.setViewer(this.viewerShim());
    await this.manager.setDocument(doc.pdf);
  }
  async detach() {
    const m = this.manager;
    this.manager = null; this.doc = null;
    if (m) { try { await m.setDocument(null); } catch { /* bereits beendet */ } }
  }
  /** Reconnect after a document is reloaded (e.g. after a change). */
  async refresh(doc) { if (this.doc === doc) { this.doc = null; await this.attach(doc); } }
  /** Is the document rendered with scripts? */
  active(doc) { return !!this.manager && this.doc === doc; }
  pageChanged(prev, next) { if (this.manager) this.eventBus.dispatch('pagechanging', { source: this, pageNumber: next + 1, previous: prev + 1 }); }
  pageRendered(i) { if (this.manager) this.eventBus.dispatch('pagerendered', { source: this, pageNumber: i + 1 }); }
}

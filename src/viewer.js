// Seitendarstellung: Virtualisierung, Zoom, Layouts, Textebene, Formularebene, Suchmarkierung.
import { pdfjs } from './document.js';
import { h, debounce } from './util.js';

const { TextLayer, AnnotationLayer, AnnotationMode, RenderingCancelledException } = pdfjs;
const MAX_PIXELS = 24e6;
const GAP = 12;

export class Viewer {
  constructor(app, el) {
    this.app = app; this.el = el; this.doc = null;
    this.zoom = 'width'; this.layout = 'continuous'; this.viewRot = 0; this.scale = 1; this.current = 0;
    this.nodes = []; this.history = []; this.histPos = -1; this.renderSeq = 0; this.active = new Set();
    this.queue = []; this.pageListeners = new Set();
    this.onScroll = this.onScroll.bind(this);
    el.addEventListener('scroll', this.onScroll, { passive: true });
    document.addEventListener('mouseup', () => el.querySelectorAll('.textLayer.selecting').forEach((t) => t.classList.remove('selecting')));
    new ResizeObserver(debounce(() => { if (this.doc && typeof this.zoom === 'string') this.applyZoom(true); }, 120)).observe(el);
    el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !this.doc) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.setZoom(Math.min(64, Math.max(0.08, this.scale * factor)), { x: e.clientX, y: e.clientY });
    }, { passive: false });
  }

  attach(doc) {
    this.saveState();
    this.doc = doc;
    if (!doc) { this.clear(); return; }
    const v = doc.view;
    this.zoom = v.zoom ?? this.app.settings.defaultZoom ?? 'width';
    this.layout = v.layout ?? this.app.settings.defaultLayout ?? 'continuous';
    this.viewRot = v.viewRot ?? 0;
    this.current = v.current ?? 0;
    this.build();
    this.goto(this.current, { top: v.scrollTopRatio, noHistory: true });
  }
  saveState() {
    if (!this.doc) return;
    const v = this.doc.view;
    v.zoom = this.zoom; v.layout = this.layout; v.viewRot = this.viewRot; v.current = this.current;
    const n = this.nodes[this.current];
    v.scrollTopRatio = n ? (this.el.scrollTop - n.el.offsetTop) / Math.max(1, n.el.offsetHeight) : 0;
  }
  clear() { this.cancelAll(); this.el.replaceChildren(); this.nodes = []; }
  cancelAll() { for (const n of this.nodes) this.dropPage(n); this.queue = []; this.active.clear(); }

  baseSize(i) {
    const p = this.doc.pages[i];
    const rot = (p.rotate + this.viewRot) % 360;
    const w = p.view[2] - p.view[0]; const h2 = p.view[3] - p.view[1];
    return rot % 180 === 0 ? { w, h: h2 } : { w: h2, h: w };
  }
  viewport(i, scale = this.scale) {
    return this.doc.page(i).getViewport({ scale, rotation: (this.doc.pages[i].rotate + this.viewRot) % 360 });
  }

  build() {
    this.clear();
    const wrap = h('div', { class: `pv-pages ${/double/.test(this.layout) ? 'double' : ''}` });
    this.nodes = this.doc.pages.map((_, i) => {
      const el = h('div', { class: 'pv-page', data: { page: i } }, h('div', { class: 'ph' }, String(i + 1)));
      wrap.append(el);
      return { i, el, ver: 0, rendered: 0 };
    });
    this.wrap = wrap;
    this.el.replaceChildren(wrap);
    this.applyZoom(false);
  }

  computeScale() {
    if (typeof this.zoom === 'number') return this.zoom;
    const n = Math.min(this.current, this.doc.numPages - 1);
    const s = this.baseSize(n);
    const double = /double/.test(this.layout);
    const availW = Math.max(100, this.el.clientWidth - 116) / (double ? 2 : 1) - (double ? GAP : 0);
    const availH = Math.max(100, this.el.clientHeight - 118);
    switch (this.zoom) {
      case 'width': return availW / s.w;
      case 'height': return availH / s.h;
      case 'page': return Math.min(availW / s.w, availH / s.h);
      case 'actual': return 1;
      default: return 1;
    }
  }

  applyZoom(keep) {
    if (!this.doc) return;
    const prev = this.scale;
    this.scale = Math.round(this.computeScale() * 1000) / 1000;
    if (keep && Math.abs(prev - this.scale) < 0.001) return;
    this.layoutPages();
    this.invalidate();
    this.app.onZoom?.();
  }

  layoutPages() {
    for (const n of this.nodes) {
      const { w, h: ht } = this.baseSize(n.i);
      n.el.style.width = `${Math.round(w * this.scale)}px`;
      n.el.style.height = `${Math.round(ht * this.scale)}px`;
      n.el.style.setProperty('--scale-factor', this.scale);
      n.el.style.setProperty('--total-scale-factor', this.scale);
      n.el.style.setProperty('--user-unit', 1);
      n.el.style.setProperty('--scale-round-x', '1px');
      n.el.style.setProperty('--scale-round-y', '1px');
    }
    this.applyLayoutVisibility();
  }
  applyLayoutVisibility() {
    const single = this.layout === 'single'; const dbl = this.layout === 'double';
    const spreadStart = this.current - (this.current % 2);
    for (const n of this.nodes) {
      n.el.classList.toggle('gone', (single && n.i !== this.current) || (dbl && n.i !== spreadStart && n.i !== spreadStart + 1));
    }
  }

  /** Redraw all pages (after zoom, rotation or a change). */
  invalidate(pages) {
    for (const n of this.nodes) if (!pages || pages.includes(n.i)) { n.ver++; n.stale = true; }
    this.scheduleRender();
  }

  scheduleRender = debounce(() => this.renderVisible(), 40);

  visiblePages() {
    const top = this.el.scrollTop; const bottom = top + this.el.clientHeight;
    const out = [];
    for (const n of this.nodes) {
      if (n.el.classList.contains('gone')) continue;
      const a = n.el.offsetTop; const b = a + n.el.offsetHeight;
      if (b >= top - 500 && a <= bottom + 500) out.push(n);
    }
    return out;
  }

  renderVisible() {
    if (!this.doc) return;
    const vis = this.visiblePages();
    const keep = new Set(vis.map((n) => n.i));
    for (const n of this.nodes) {
      if (keep.has(n.i)) continue;
      if (n.task || n.canvas) this.dropPage(n);
    }
    for (const n of vis) if (n.stale !== false || !n.canvas) this.renderPage(n);
  }

  dropPage(n) {
    if (n.task) { n.task.cancel(); n.task = null; }
    if (n.textLayer) { n.textLayer.cancel(); n.textLayer = null; }
    if (n.canvas) { n.canvas.width = 0; n.canvas.height = 0; n.canvas = null; }
    n.el.replaceChildren(h('div', { class: 'ph' }, String(n.i + 1)));
    n.stale = true; n.layers = null;
  }

  async renderPage(n) {
    const seq = ++n.ver;
    n.stale = false;
    if (n.task) { n.task.cancel(); n.task = null; }
    const doc = this.doc;
    const proxy = doc.page(n.i);
    const vpCss = this.viewport(n.i);
    let dpr = window.devicePixelRatio || 1;
    const pixels = vpCss.width * vpCss.height * dpr * dpr;
    if (pixels > MAX_PIXELS) dpr *= Math.sqrt(MAX_PIXELS / pixels);
    const canvas = h('canvas', { class: 'main' });
    canvas.width = Math.floor(vpCss.width * dpr); canvas.height = Math.floor(vpCss.height * dpr);
    const task = proxy.render({
      canvas, canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport: vpCss, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      annotationStorage: doc.pdf.annotationStorage,
      optionalContentConfigPromise: Promise.resolve(doc.ocConfig),
    });
    n.task = task;
    try { await task.promise; }
    catch (e) { if (!(e instanceof RenderingCancelledException)) console.error(e); return; }
    if (n.task === task) n.task = null;
    if (seq !== n.ver || doc !== this.doc) return;
    if (n.canvas) { n.canvas.width = 0; n.canvas.height = 0; }
    n.canvas = canvas;

    const text = h('div', { class: 'textLayer' });
    const annotDiv = h('div', { class: 'annotationLayer' });
    const hl = h('div', { class: 'hl' });
    const markup = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    markup.setAttribute('class', 'markup');
    const ov = h('div', { class: 'ov' });
    const keepers = [...n.el.children].filter((c) => c.classList.contains('tool') || c.classList.contains('edit'));
    n.el.replaceChildren(canvas, text, annotDiv, hl, markup, ov, ...keepers);
    n.layers = { text, annotDiv, hl, markup, ov };
    this.app.overlay.renderPage(n.i);
    this.app.editor?.renderPage(n.i);
    this.app.fieldDetect?.paintPage(n.i);

    try {
      const content = await doc.pageText(n.i);
      if (seq !== n.ver) return;
      const tl = new TextLayer({ textContentSource: content, container: text, viewport: vpCss });
      n.textLayer = tl;
      await tl.render();
      if (seq !== n.ver) return;
      text.append(h('div', { class: 'endOfContent' }));
      text.addEventListener('mousedown', () => text.classList.add('selecting'));
      this.app.find?.paintPage(n.i);
    } catch (e) { if (!(e instanceof RenderingCancelledException)) console.warn(e); }

    try {
      const annotations = await proxy.getAnnotations({ intent: 'display' });
      if (seq !== n.ver || !annotations.length) return;
      // JavaScript only if it is turned on in Preferences and active for this document.
      const js = this.app.scripting?.active(doc);
      const fieldObjects = js ? await doc.fieldObjects() : null;
      if (seq !== n.ver) return;
      const layer = new AnnotationLayer({ div: annotDiv, page: proxy, viewport: vpCss.clone({ dontFlip: true }), accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, structTreeLayer: null, commentManager: null, linkService: this.linkService(), annotationStorage: doc.pdf.annotationStorage });
      await layer.render({ annotations, div: annotDiv, page: proxy, viewport: vpCss.clone({ dontFlip: true }), linkService: this.linkService(), annotationStorage: doc.pdf.annotationStorage, renderForms: true, enableScripting: !!js, hasJSActions: !!js, fieldObjects, imageResourcesPath: '', downloadManager: null });
      if (js) this.app.scripting.pageRendered(n.i);
      this.app.applyFormHighlight?.(annotDiv);
      annotDiv.addEventListener('input', () => doc.markDirty(), { once: false });
      annotDiv.addEventListener('change', () => doc.markDirty(), { once: false });
    } catch (e) { console.warn('Form layer', e); }
  }

  linkService() {
    if (this._link) return this._link;
    const self = this;
    this._link = {
      externalLinkTarget: 0, externalLinkRel: 'noopener', externalLinkEnabled: true,
      get eventBus() { return self.app.scripting?.active(self.doc) ? self.app.scripting.eventBus : null; },
      get pagesCount() { return self.doc.numPages; },
      get page() { return self.current + 1; }, set page(v) { self.goto(v - 1); },
      get rotation() { return self.viewRot; }, set rotation(v) { self.setViewRot(v); },
      isInPresentationMode: false,
      goToDestination: (d) => self.gotoDest(d), goToPage: (v) => self.goto(+v - 1),
      goToXY: (p, x, y) => self.goto(p - 1, { pdfY: y }),
      addLinkAttributes(link, url) { link.href = '#'; link.title = url; link.onclick = (e) => { e.preventDefault(); window.dp.openExternal(url); return false; }; },
      getDestinationHash: () => '#', getAnchorUrl: () => '#', setHash() {},
      executeNamedAction: (a) => self.namedAction(a), executeSetOCGState() {}, cachePageRef() {},
      getAttachmentContent: () => null,
    };
    return this._link;
  }
  namedAction(a) {
    const m = { NextPage: () => this.next(), PrevPage: () => this.prev(), FirstPage: () => this.goto(0), LastPage: () => this.goto(this.doc.numPages - 1), GoBack: () => this.back(), GoForward: () => this.forward(), Print: () => this.app.run('print') };
    m[a]?.();
  }
  async gotoDest(dest) {
    const doc = this.doc;
    let d = dest;
    if (typeof d === 'string') d = await doc.pdf.getDestination(d);
    if (!Array.isArray(d)) return;
    const ref = d[0];
    const idx = typeof ref === 'object' && ref ? await doc.pdf.getPageIndex(ref) : Number(ref);
    const mode = d[1]?.name;
    const y = mode === 'XYZ' ? d[3] : (mode === 'FitH' || mode === 'FitBH') ? d[2] : (mode === 'FitR') ? d[5] : null;
    this.goto(idx, { pdfY: y ?? undefined });
  }

  onScroll() {
    this.scheduleRender();
    if (this.layout === 'single' || this.layout === 'double') return;
    const mid = this.el.scrollTop + this.el.clientHeight * 0.35;
    let best = this.current;
    for (const n of this.nodes) {
      const a = n.el.offsetTop;
      if (a <= mid && a + n.el.offsetHeight + GAP > mid) { best = n.i; break; }
    }
    if (best !== this.current) { this.current = best; this.emitPage(); }
  }
  emitPage() { this.app.onPage?.(this.current); }

  pushHistory() {
    const hist = this.history.slice(0, this.histPos + 1);
    if (hist[hist.length - 1] !== this.current) hist.push(this.current);
    this.history = hist.slice(-200); this.histPos = this.history.length - 1;
  }

  goto(i, o = {}) {
    if (!this.doc) return;
    const idx = Math.max(0, Math.min(this.doc.numPages - 1, i));
    if (!o.noHistory && idx !== this.current) { this.pushHistory(); }
    this.current = idx;
    this.applyLayoutVisibility();
    const n = this.nodes[idx];
    let y = n.el.offsetTop - 54;
    if (o.pdfY !== undefined) {
      const vp = this.viewport(idx);
      y = n.el.offsetTop + Math.max(0, vp.convertToViewportPoint(0, o.pdfY)[1] - 50);
    } else if (o.top) y = n.el.offsetTop + o.top * n.el.offsetHeight;
    if (o.y !== undefined) y = n.el.offsetTop + o.y;
    this.el.scrollTop = /single|^double$/.test(this.layout) ? 0 : y;
    this.emitPage();
    this.scheduleRender();
    if (!o.noHistory) this.pushHistory();
  }
  step() { return /double/.test(this.layout) ? 2 : 1; }
  next() { this.goto(this.current + this.step()); }
  prev() { this.goto(this.current - this.step()); }
  back() { if (this.histPos > 0) { this.histPos--; this.goto(this.history[this.histPos], { noHistory: true }); } }
  forward() { if (this.histPos < this.history.length - 1) { this.histPos++; this.goto(this.history[this.histPos], { noHistory: true }); } }

  setZoom(z, anchor) {
    const n = this.nodes[this.current];
    let ax; let ay; let fx; let fy;
    if (anchor && n) {
      const r = this.el.getBoundingClientRect();
      ax = anchor.x - r.left + this.el.scrollLeft; ay = anchor.y - r.top + this.el.scrollTop;
      fx = ax / Math.max(1, this.wrap.scrollWidth); fy = ay / Math.max(1, this.wrap.scrollHeight);
    }
    const ratio = n ? (this.el.scrollTop - n.el.offsetTop) / Math.max(1, n.el.offsetHeight) : 0;
    this.zoom = z;
    this.scale = -1;
    this.applyZoom(false);
    if (anchor && n) {
      const r = this.el.getBoundingClientRect();
      this.el.scrollLeft = fx * this.wrap.scrollWidth - (anchor.x - r.left);
      this.el.scrollTop = fy * this.wrap.scrollHeight - (anchor.y - r.top);
    } else if (n) this.el.scrollTop = n.el.offsetTop + ratio * n.el.offsetHeight;
  }
  zoomStep(dir) {
    const steps = [0.08, 0.12, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64];
    const cur = this.scale;
    const next = dir > 0 ? steps.find((s) => s > cur + 0.001) : [...steps].reverse().find((s) => s < cur - 0.001);
    if (next) this.setZoom(next);
  }
  setViewRot(deg) { this.viewRot = ((deg % 360) + 360) % 360; this.layoutPages(); this.applyZoomForce(); }
  applyZoomForce() { this.scale = -1; this.applyZoom(false); this.goto(this.current, { noHistory: true }); }
  rotateView(d) { this.setViewRot(this.viewRot + d); }
  setLayout(l) {
    this.layout = l;
    if (this.wrap) this.wrap.className = `pv-pages ${/double/.test(l) ? 'double' : ''}`;
    this.applyZoomForce();
  }

  /** After a change to the document. */
  reload(info = {}) {
    if (info.structural || this.nodes.length !== this.doc.numPages) {
      this.current = Math.min(this.current, this.doc.numPages - 1);
      const top = this.el.scrollTop;
      this.build();
      this.el.scrollTop = top;
      this.scheduleRender();
      this.emitPage();
      return;
    }
    if (info.annotOnly) { for (const n of this.nodes) if (n.layers) this.app.overlay.renderPage(n.i); return; }
    this.layoutPages();
    this.invalidate(info.pages);
  }

  pageAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY)?.closest?.('.pv-page');
    return el ? +el.dataset.page : -1;
  }
  layersOf(i) { return this.nodes[i]?.layers; }
  node(i) { return this.nodes[i]; }
  /** Wandelt Bildschirm-Koordinaten in Seitenkoordinaten um. */
  toPdf(i, clientX, clientY) {
    const r = this.nodes[i].el.getBoundingClientRect();
    return this.viewport(i).convertToPdfPoint(clientX - r.left, clientY - r.top);
  }
  rectToCss(i, rect) {
    const vp = this.viewport(i);
    const [a, b] = [vp.convertToViewportPoint(rect[0], rect[1]), vp.convertToViewportPoint(rect[2], rect[3])];
    return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
  }

  /** Renders a page into a canvas, e.g. for printing, image export or OCR. */
  async renderToCanvas(i, dpi, o = {}) {
    const proxy = this.doc?.page(i) || o.proxy;
    const scale = dpi / 72;
    const viewport = proxy.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await proxy.render({
      canvas, canvasContext: canvas.getContext('2d', { alpha: false }), viewport, intent: o.intent || 'print',
      annotationMode: o.noAnnots ? AnnotationMode.DISABLE : AnnotationMode.ENABLE_FORMS,
      annotationStorage: this.doc?.pdf.annotationStorage,
    }).promise;
    return { canvas, viewport };
  }
  async thumbnail(i, width) {
    const proxy = this.doc.page(i);
    const base = proxy.getViewport({ scale: 1 });
    const scale = (width * (window.devicePixelRatio || 1)) / base.width;
    const viewport = proxy.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(viewport.width); c.height = Math.ceil(viewport.height);
    c.style.width = `${width}px`;
    await proxy.render({ canvas: c, canvasContext: c.getContext('2d', { alpha: false }), viewport, annotationMode: AnnotationMode.ENABLE_FORMS, annotationStorage: this.doc.pdf.annotationStorage }).promise;
    return c;
  }
}

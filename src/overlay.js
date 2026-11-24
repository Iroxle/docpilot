// Comment layer: display and handling of all comments and drawing tools.
import { h, icon, ibtn, cssColor, debounce, toast, errToast, contextMenu, $ } from './util.js';
import { cloudSegments, arrowHead, newId, SUBJECT } from './pdf/annots.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v); return e; };
export const PALETTE = [[0.176, 0.482, 0.784], [0.094, 0.071, 0.063], [0.569, 0.561, 0.565], [1, 0.82, 0], [0.95, 0.3, 0.2], [0.2, 0.7, 0.3], [1, 0.45, 0.75], [1, 1, 1]];
const MARKUP = new Set(['highlight', 'underline', 'strikeout', 'squiggly', 'redact']);
const TEXT_TOOLS = new Set(['highlight', 'underline', 'strikeout', 'squiggly', 'replace', 'caret', 'redact-text']);
const DRAG_SHAPES = new Set(['rect', 'ellipse', 'line', 'arrow']);
const CLICK_POLY = new Set(['polygon', 'polyline', 'cloud', 'measure-perimeter', 'measure-area']);
const DEFAULTS = {
  highlight: { color: [1, 0.82, 0], opacity: 1 }, underline: { color: [0.2, 0.7, 0.3], opacity: 1 }, strikeout: { color: [0.9, 0.1, 0.1], opacity: 1 }, squiggly: { color: [1, 0.45, 0.75], opacity: 1 },
  note: { color: [1, 0.82, 0], opacity: 1 }, freetext: { textColor: [0, 0, 0], fontSize: 12, fill: null, opacity: 1 }, callout: { textColor: [0, 0, 0], fontSize: 12, borderColor: [0.176, 0.482, 0.784], fill: [1, 1, 1], width: 1, opacity: 1 },
  rect: { color: [0.95, 0.3, 0.2], width: 2, fill: null, opacity: 1 }, ellipse: { color: [0.95, 0.3, 0.2], width: 2, fill: null, opacity: 1 }, line: { color: [0.176, 0.482, 0.784], width: 2, opacity: 1 }, arrow: { color: [0.95, 0.3, 0.2], width: 2, opacity: 1 },
  polygon: { color: [0.95, 0.3, 0.2], width: 2, fill: null, opacity: 1 }, polyline: { color: [0.176, 0.482, 0.784], width: 2, opacity: 1 }, cloud: { color: [0.95, 0.3, 0.2], width: 2, fill: null, opacity: 1 }, ink: { color: [0.176, 0.482, 0.784], width: 2, opacity: 1 },
};

export function startDrag(e, onMove, onEnd, stable) {
  e.preventDefault(); e.stopPropagation();
  // If the clicked element is rebuilt while dragging, a stable element must receive the input.
  const target = stable || e.currentTarget || e.target;
  try { target.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  const move = (m) => onMove(m);
  const up = (u) => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
    onEnd?.(u);
  };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
}

const bboxOfPoints = (pts) => { const x = pts.map((p) => p[0]); const y = pts.map((p) => p[1]); return [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)]; };
export function boundsOf(a) {
  if (a.quads) return bboxOfPoints(a.quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]));
  if (a.type === 'ink') return bboxOfPoints(a.strokes.flat());
  if (a.points && a.type !== 'callout') return bboxOfPoints(a.points);
  if (a.type === 'note') return [a.rect[0], a.rect[1], a.rect[0] + 20, a.rect[1] + 20];
  return a.rect;
}
function translate(a, dx, dy) {
  const mv = (p) => [p[0] + dx, p[1] + dy];
  a.rect = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
  if (a.points) a.points = a.points.map((p, i) => (a.type === 'callout' && i === 0 ? p : mv(p)));
  if (a.strokes) a.strokes = a.strokes.map((st) => st.map(mv));
  if (a.quads) a.quads = a.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)));
}
function resizeTo(a, r) {
  const b = boundsOf(a);
  if (a.type === 'ink') {
    const sx = (r[2] - r[0]) / Math.max(0.1, b[2] - b[0]); const sy = (r[3] - r[1]) / Math.max(0.1, b[3] - b[1]);
    a.strokes = a.strokes.map((st) => st.map((p) => [r[0] + (p[0] - b[0]) * sx, r[1] + (p[1] - b[1]) * sy]));
  }
  a.rect = r;
}

export class Overlay {
  constructor(app) {
    this.app = app; this.tool = 'select'; this.selected = null; this.props = JSON.parse(JSON.stringify(DEFAULTS));
    this.rectTools = new Map(); this.clickTools = new Map(); this.poly = null;
    // Text markups lie above the text. They take no mouse input so the text below stays selectable.
    const v = $('#viewer');
    v.addEventListener('click', (e) => { if (this.tool === 'select' && window.getSelection().isCollapsed) { const a = this.hitMarkup(e); if (a) this.select(a.id); } });
    v.addEventListener('dblclick', (e) => { if (this.tool === 'select') { const a = this.hitMarkup(e); if (a) { window.getSelection().removeAllRanges(); this.openEditor(a, e); } } });
    v.addEventListener('contextmenu', (e) => { if (this.tool === 'select' && !e.defaultPrevented) { const a = this.hitMarkup(e); if (a) { e.preventDefault(); this.annMenu(e, a); } } });
    document.addEventListener('pointerup', (e) => this.onSelectionEnd(e));
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.mini')) this.hideMini(); if (e.target.closest?.('#viewer') && !e.target.closest('.ann,.ann-html,.handle')) { if (this.selected && this.tool === 'select') this.select(null); } });
  }
  get doc() { return this.app.doc; }
  get viewer() { return this.app.viewer; }
  registerRect(name, fn, o = {}) { this.rectTools.set(name, { fn, ...o }); }
  registerClick(name, fn, o = {}) { this.clickTools.set(name, { fn, ...o }); }

  setTool(name, opts = {}) {
    this.finishPoly();
    this.tool = name; this.toolOpts = opts;
    this.select(null);
    document.body.classList.toggle('cursor-hand', name === 'hand');
    window.getSelection()?.removeAllRanges();
    for (const n of this.viewer.nodes) this.ensureToolLayer(n.i);
    this.app.onToolChanged?.();
    this.renderPropbar();
  }
  needsLayer() {
    const t = this.tool;
    return t !== 'select' && t !== 'hand' && !TEXT_TOOLS.has(t) && t !== 'edit';
  }
  ensureToolLayer(i) {
    const n = this.viewer.node(i);
    if (!n) return;
    let layer = [...n.el.children].find((c) => c.classList.contains('tool'));
    if (!this.needsLayer()) { layer?.remove(); return; }
    if (!layer) {
      layer = h('div', { class: 'tool', onpointerdown: (e) => this.toolDown(e, i), ondblclick: () => this.finishPoly(), onpointermove: (e) => this.polyHover(e, i) });
      n.el.append(layer);
    }
    layer.style.cursor = this.tool === 'zoom' ? 'zoom-in' : 'crosshair';
  }

  hitMarkup(e) {
    const el = e.target.closest?.('.pv-page');
    if (!el || !this.doc || e.target.closest('.ann,.ann-html,.handle')) return null;
    const i = +el.dataset.page;
    const [x, y] = this.viewer.toPdf(i, e.clientX, e.clientY);
    return [...(this.doc.annots.get(i) || [])].reverse().find((a) => MARKUP.has(a.type) && a.quads.some((q) => {
      const xs = [q[0], q[2], q[4], q[6]]; const ys = [q[1], q[3], q[5], q[7]];
      return x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys);
    })) || null;
  }

  // --- Rendering ---------------------------------------------------------------------
  renderPage(i) {
    const n = this.viewer.node(i);
    if (!n?.layers) { this.ensureToolLayer(i); return; }
    const ov = n.layers.ov;
    ov.replaceChildren();
    n.layers.markup.replaceChildren();
    const svg = s('svg', {});
    ov.append(svg);
    const vp = this.viewer.viewport(i);
    const P = (p) => vp.convertToViewportPoint(p[0], p[1]);
    const zoom = vp.scale;
    for (const a of this.doc.annots.get(i) || []) this.renderAnnot(a, ov, svg, P, zoom, i);
    if (this.selected) { const a = this.doc.find(this.selected); if (a && a.page === i) this.renderSelection(a, ov, P, i); }
    this.ensureToolLayer(i);
  }

  bindAnn(el, a, i) {
    el.dataset.id = a.id;
    el.addEventListener('pointerdown', (e) => this.annDown(e, a, i));
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); this.openEditor(a, e); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.annMenu(e, a); });
  }

  renderAnnot(a, ov, svg, P, zoom, i) {
    const col = cssColor(a.color); const fill = a.fill ? cssColor(a.fill) : 'none';
    const sw = (a.width ?? 1) * zoom; const dash = a.dash ? a.dash.map((v) => v * zoom).join(' ') : null;
    const op = a.opacity ?? 1;
    const addShape = (d, close) => {
      const g = s('g', { class: 'ann', opacity: op });
      g.append(s('path', { d, fill, stroke: col, 'stroke-width': sw, 'stroke-dasharray': dash, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      g.append(s('path', { d, fill: close && a.fill ? 'transparent' : 'none', stroke: 'transparent', 'stroke-width': Math.max(10, sw + 8), 'pointer-events': 'all' }));
      svg.append(g); this.bindAnn(g, a, i);
    };
    const pathOf = (pts, close) => pts.map((p, k) => { const [x, y] = P(p); return `${k ? 'L' : 'M'}${x} ${y}`; }).join(' ') + (close ? ' Z' : '');
    switch (a.type) {
      case 'highlight': case 'underline': case 'strikeout': case 'squiggly': case 'redact': {
        const g = s('g', { class: 'ann-mark', opacity: op });
        for (const q of a.quads) {
          const [tl, tr, bl, br] = [P([q[0], q[1]]), P([q[2], q[3]]), P([q[4], q[5]]), P([q[6], q[7]])];
          const area = `M${tl[0]} ${tl[1]} L${tr[0]} ${tr[1]} L${br[0]} ${br[1]} L${bl[0]} ${bl[1]} Z`;
          if (a.type === 'highlight') g.append(s('path', { d: area, fill: col }));
          else if (a.type === 'redact') g.append(s('path', { d: area, fill: 'rgb(0 0 0 / .35)', stroke: '#d00', 'stroke-width': 1 }));
          else {
            g.append(s('path', { d: area, fill: 'transparent' }));
            const ly = a.type === 'strikeout' ? [(tl[0] + bl[0]) / 2, (tl[1] + bl[1]) / 2, (tr[0] + br[0]) / 2, (tr[1] + br[1]) / 2] : [bl[0], bl[1] - zoom, br[0], br[1] - zoom];
            if (a.type === 'squiggly') {
              let d = `M${ly[0]} ${ly[1]}`; let x = ly[0]; let up = true;
              while (x < ly[2]) { x = Math.min(x + 2 * zoom, ly[2]); d += ` L${x} ${ly[1] + (up ? -2 : 0) * zoom}`; up = !up; }
              g.append(s('path', { d, fill: 'none', stroke: col, 'stroke-width': zoom }));
            } else g.append(s('line', { x1: ly[0], y1: ly[1], x2: ly[2], y2: ly[3], stroke: col, 'stroke-width': zoom * 1.2 }));
          }
        }
        (a.type === 'highlight' ? ov.parentElement.querySelector('svg.markup') : svg).append(g);
        break;
      }
      case 'rect': { const pts = [[a.rect[0], a.rect[1]], [a.rect[2], a.rect[1]], [a.rect[2], a.rect[3]], [a.rect[0], a.rect[3]]]; addShape(pathOf(pts, true), true); break; }
      case 'ellipse': {
        const css = this.viewer.rectToCss(i, a.rect); const rx = css.width / 2; const ry = css.height / 2; const cx = css.left + rx; const cy = css.top + ry;
        addShape(`M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`, true); break;
      }
      case 'line': addShape(pathOf(a.points)); break;
      case 'arrow': addShape(`${pathOf(a.points)} ${pathOf(arrowHead(a.points[0], a.points[1], a.width ?? 1))}`); break;
      case 'polyline': addShape(pathOf(a.points)); break;
      case 'polygon': addShape(pathOf(a.points, true), true); break;
      case 'cloud': {
        const segs = cloudSegments(a.points);
        const m = P(segs[0].from);
        const d = `M${m[0]} ${m[1]} ${segs.map((g) => { const [c1, c2, to] = [P(g.c1), P(g.c2), P(g.to)]; return `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to[0]} ${to[1]}`; }).join(' ')} Z`;
        addShape(d, true); break;
      }
      case 'ink': addShape(a.strokes.map((st) => pathOf(st.length === 1 ? [st[0], [st[0][0] + 0.2, st[0][1]]] : st)).join(' ')); break;
      case 'caret': { const css = this.viewer.rectToCss(i, a.rect); addShape(`M${css.left} ${css.top + css.height} L${css.left + css.width} ${css.top + css.height} L${css.left + css.width / 2} ${css.top} Z`, true); break; }
      case 'note': {
        const [x, y] = P([a.rect[0], a.rect[3]]);
        const el = h('div', { class: 'ann-html', style: { left: `${x}px`, top: `${y}px`, width: '24px', height: '24px', padding: '2px', borderRadius: '4px', background: cssColor(a.color), border: '1px solid rgb(0 0 0 / .45)', display: 'flex', opacity: op, color: '#222' } }, icon('comment'));
        ov.append(el); this.bindAnn(el, a, i);
        break;
      }
      case 'freetext': case 'callout': {
        const css = this.viewer.rectToCss(i, a.rect);
        if (a.type === 'callout' && a.points) {
          const g = s('path', { d: pathOf(a.points), fill: 'none', stroke: cssColor(a.borderColor || [0, 0, 0]), 'stroke-width': zoom });
          svg.append(g);
        }
        const el = h('div', { class: 'ann-html', style: {
          left: `${css.left}px`, top: `${css.top}px`, width: `${css.width}px`, height: `${css.height}px`,
          fontFamily: a.fontFamily || 'Helvetica, Arial, sans-serif', fontSize: `${(a.fontSize || 12) * zoom}px`, color: cssColor(a.textColor || [0, 0, 0]),
          background: a.fill ? cssColor(a.fill) : 'transparent', border: a.borderColor ? `${(a.width ?? 1) * zoom}px solid ${cssColor(a.borderColor)}` : '1px dashed transparent',
          padding: `${3 * zoom}px`, opacity: op, fontWeight: a.bold ? '700' : '', fontStyle: a.italic ? 'italic' : '',
        } }, a.contents || '');
        ov.append(el); this.bindAnn(el, a, i);
        break;
      }
      case 'stamp': this.renderStamp(a, ov, i, zoom); break;
      default: break;
    }
  }
  renderStamp(a, ov, i, zoom) {
    const css = this.viewer.rectToCss(i, a.rect);
    const st = a.stamp || {};
    const box = { left: `${css.left}px`, top: `${css.top}px`, width: `${css.width}px`, height: `${css.height}px`, opacity: a.opacity ?? 1, padding: 0 };
    let el;
    if (st.image) {
      el = h('div', { class: 'ann-html', style: box }, h('img', { src: `data:${st.mime};base64,${st.image}`, draggable: 'false', style: { width: '100%', height: '100%', display: 'block', pointerEvents: 'none' } }));
    } else {
      const c = cssColor(st.color || [0.8, 0, 0]);
      const fs = Math.min(css.height * (st.sub ? 0.46 : 0.6), (css.width - 12) / Math.max(1, (st.text || '').length * 0.68));
      el = h('div', { class: 'ann-html', style: { ...box, border: `${Math.max(1, css.height * 0.04)}px solid ${c}`, borderRadius: `${Math.min(6 * zoom, css.height / 5)}px`, color: c, fontFamily: 'Helvetica, Arial, sans-serif', fontWeight: 700, textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center', lineHeight: 1.05 } },
        h('div', { style: { fontSize: `${fs}px` } }, st.text || ''), st.sub ? h('div', { style: { fontSize: `${css.height * 0.18}px`, fontWeight: 400 } }, st.sub) : null);
    }
    ov.append(el); this.bindAnn(el, a, i);
  }

  renderSelection(a, ov, P, i) {
    const b = boundsOf(a);
    const css = this.viewer.rectToCss(i, b);
    ov.append(h('div', { class: 'sel-frame', style: { left: `${css.left - 2}px`, top: `${css.top - 2}px`, width: `${css.width + 4}px`, height: `${css.height + 4}px` } }));
    if (a.locked || MARKUP.has(a.type) || a.type === 'note' || a.type === 'caret') return;
    const handle = (x, y, onDrag, cursor = 'nwse-resize') => {
      const el = h('div', { class: 'handle', style: { left: `${x}px`, top: `${y}px`, cursor } });
      el.addEventListener('pointerdown', (e) => {
        let pushed = false;
        startDrag(e, (m) => {
          if (!pushed) { this.doc.pushUndo(); pushed = true; }
          onDrag(this.viewer.toPdf(i, m.clientX, m.clientY));
          this.touch(a);
        }, () => { if (pushed) this.afterEdit(i); }, this.viewer.node(i).el);
      });
      ov.append(el);
    };
    if (a.points && a.type !== 'callout') {
      a.points.forEach((p, k) => { const [x, y] = P(p); handle(x, y, (q) => { a.points[k] = q; this.renderPage(i); }, 'move'); });
    } else {
      const corners = [[0, 1], [2, 1], [0, 3], [2, 3]];
      corners.forEach(([ix, iy]) => {
        const [x, y] = P([b[ix], b[iy]]);
        handle(x, y, (q) => {
          const r = boundsOf(a).slice();
          r[ix] = q[0]; r[iy] = q[1];
          const n = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
          if (n[2] - n[0] > 4 && n[3] - n[1] > 4) resizeTo(a, n);
          this.renderPage(i);
        });
      });
      if (a.type === 'callout' && a.points) { const [x, y] = P(a.points[0]); handle(x, y, (q) => { a.points[0] = q; this.renderPage(i); }, 'move'); }
    }
  }

  touch(a) { a.modified = new Date().toISOString(); }
  afterEdit(i) { this.doc.markDirty(); this.renderPage(i); this.app.panels.commentsChanged(); }

  select(id) {
    const prev = this.selected;
    this.selected = id;
    const pages = new Set();
    for (const v of [prev, id]) { if (v) { const a = this.doc?.find(v); if (a) pages.add(a.page); } }
    for (const p of pages) this.renderPage(p);
    this.renderPropbar();
    this.app.panels.highlightComment(id);
  }

  annDown(e, a, i) {
    if (e.button !== 0) return;
    if (this.tool === 'edit' || this.needsLayer()) return;
    this.select(a.id);
    if (MARKUP.has(a.type) || a.locked) return;
    const start = this.viewer.toPdf(i, e.clientX, e.clientY);
    let last = start; let pushed = false;
    startDrag(e, (m) => {
      const q = this.viewer.toPdf(i, m.clientX, m.clientY);
      if (!pushed && Math.hypot(q[0] - start[0], q[1] - start[1]) < 2) return;
      if (!pushed) { this.doc.pushUndo(); pushed = true; }
      translate(a, q[0] - last[0], q[1] - last[1]);
      last = q; this.touch(a); this.renderPage(i);
    }, () => { if (pushed) this.afterEdit(i); }, this.viewer.node(i).el);
  }
  annMenu(e, a) {
    this.select(a.id);
    contextMenu(e.clientX, e.clientY, [
      { label: 'Edit comment...', run: () => this.openEditor(a, e) },
      { label: 'Show in comments pane', run: () => this.app.panels.show('comments') },
      '-',
      { label: 'Delete', run: () => this.remove(a.id) },
    ]);
  }

  async add(a) {
    if (!(await this.doc.allowEdit())) return null;
    const now = new Date().toISOString();
    Object.assign(a, { id: a.id || newId(), author: a.author ?? this.app.userName(), created: now, modified: now, replies: a.replies || [], status: null, subject: a.subject || SUBJECT[a.type] });
    this.doc.pushUndo();
    this.doc.list(a.page).push(a);
    this.doc.markDirty();
    this.renderPage(a.page);
    this.app.panels.commentsChanged();
    return a;
  }
  remove(id) {
    const a = this.doc.find(id);
    if (!a) return;
    this.doc.pushUndo();
    const l = this.doc.list(a.page);
    l.splice(l.indexOf(a), 1);
    this.selected = null;
    this.doc.markDirty(); this.renderPage(a.page); this.app.panels.commentsChanged(); this.renderPropbar();
  }

  openEditor(a, e) {
    if (a.type === 'freetext' || a.type === 'callout') { this.editFreeText(a); return; }
    if (a.type === 'stamp') return;
    this.notePopup(a, e?.clientX ?? 400, e?.clientY ?? 300);
  }
  editFreeText(a) {
    const n = this.viewer.node(a.page);
    if (!n?.layers) return;
    const el = [...n.layers.ov.querySelectorAll('.ann-html')].find((x) => x.dataset.id === a.id);
    if (!el) return;
    el.classList.add('editing');
    const old = a.contents || '';
    const ta = h('textarea', { spellcheck: 'true' });
    ta.value = old;
    el.replaceChildren(ta);
    const done = () => {
      if (ta.value !== old) { this.doc.pushUndo(); const live = this.doc.find(a.id); if (live) { live.contents = ta.value; this.touch(live); } this.doc.markDirty(); this.app.panels.commentsChanged(); }
      this.renderPage(a.page);
    };
    ta.addEventListener('blur', done, { once: true });
    ta.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') ta.blur(); });
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  notePopup(a, x, y) {
    document.querySelector('.note-pop')?.remove();
    const ta = h('textarea', { placeholder: 'Enter a comment', spellcheck: 'true' });
    ta.value = a.contents || '';
    let pushed = false;
    const save = debounce(() => {
      if (!pushed) { this.doc.pushUndo(); pushed = true; }
      const live = this.doc.find(a.id);
      if (live) { live.contents = ta.value; this.touch(live); }
      this.doc.markDirty(); this.app.panels.commentsChanged();
    }, 200);
    ta.addEventListener('input', save);
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') pop.remove(); });
    const pop = h('div', { class: 'note-pop', style: { left: `${Math.min(x, innerWidth - 280)}px`, top: `${Math.min(y, innerHeight - 180)}px` } },
      h('header', {}, h('span', { style: { flex: 1 } }, a.author || ''), ibtn('trash', 'Delete', () => { pop.remove(); this.remove(a.id); }), ibtn('x', 'Close', () => pop.remove())), ta);
    document.body.append(pop);
    ta.focus();
  }

  // --- Tools -------------------------------------------------------------------------
  toolDown(e, i) {
    if (e.button !== 0) return;
    const t = this.tool;
    const p0 = this.viewer.toPdf(i, e.clientX, e.clientY);
    if (CLICK_POLY.has(t)) { this.polyClick(e, i, p0); return; }
    if (t === 'ink') { this.inkDraw(e, i, p0); return; }
    if (t === 'eraser') { this.erase(e, i, p0); return; }
    if (t === 'note') { this.createNote(i, p0, e); return; }
    if (this.clickTools.has(t)) { const c = this.clickTools.get(t); Promise.resolve(c.fn(i, p0, e)).catch(errToast).finally(() => { if (!c.keep) this.setTool('select'); }); return; }
    this.dragRect(e, i, p0);
  }

  async createNote(i, p, e) {
    const a = await this.add({ type: 'note', page: i, rect: [p[0], p[1] - 20, p[0] + 20, p[1]], icon: 'Comment', contents: '', ...this.props.note });
    this.setTool('select');
    if (a) { this.select(a.id); this.notePopup(a, e.clientX + 20, e.clientY); }
  }

  dragRect(e, i, p0) {
    const t = this.tool;
    const n = this.viewer.node(i);
    const layer = e.currentTarget;
    const lineMode = t === 'line' || t === 'arrow' || t.startsWith('measure-dist');
    const pv = lineMode ? s('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible' }) : h('div', { class: 'sel-frame' });
    const ln = lineMode ? s('line', { stroke: '#0e7c86', 'stroke-width': 2 }) : null;
    if (ln) pv.append(ln);
    layer.append(pv);
    const r0 = n.el.getBoundingClientRect();
    const x0 = e.clientX - r0.left; const y0 = e.clientY - r0.top;
    let p1 = p0;
    startDrag(e, (m) => {
      p1 = this.viewer.toPdf(i, m.clientX, m.clientY);
      let x = m.clientX - r0.left; let y = m.clientY - r0.top;
      if (m.shiftKey && lineMode) { const dx = x - x0; const dy = y - y0; if (Math.abs(dx) > Math.abs(dy)) y = y0; else x = x0; p1 = this.viewer.viewport(i).convertToPdfPoint(x, y); }
      if (lineMode) { ln.setAttribute('x1', x0); ln.setAttribute('y1', y0); ln.setAttribute('x2', x); ln.setAttribute('y2', y); }
      else Object.assign(pv.style, { left: `${Math.min(x0, x)}px`, top: `${Math.min(y0, y)}px`, width: `${Math.abs(x - x0)}px`, height: `${Math.abs(y - y0)}px` });
    }, async (up) => {
      pv.remove();
      const moved = Math.hypot(up.clientX - e.clientX, up.clientY - e.clientY) > 4;
      const rect = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
      try { await this.finishRect(t, i, rect, moved, p0, p1, e); } catch (err) { errToast(err); }
    });
  }

  async finishRect(t, i, rect, moved, p0, p1, e) {
    const P = this.props;
    if (DRAG_SHAPES.has(t)) {
      if (!moved) return;
      if (t === 'line' || t === 'arrow') await this.add({ type: t, page: i, rect, points: [p0, p1], ...P[t] });
      else await this.add({ type: t, page: i, rect, ...P[t] });
      this.setTool('select');
      return;
    }
    if (t === 'freetext' || t === 'callout') {
      const r = moved ? rect : [p0[0], p0[1] - 40, p0[0] + 180, p0[1]];
      const a = await this.add({ type: t, page: i, rect: r, contents: '', color: null, ...(t === 'callout' ? { points: [[r[0] - 40, r[1] - 30], [r[0], (r[1] + r[3]) / 2]] } : {}), ...P[t] });
      this.setTool('select');
      if (a) { this.select(a.id); setTimeout(() => this.editFreeText(a), 20); }
      return;
    }
    if (t === 'zoom') {
      const v = this.viewer;
      this.setTool('select');
      if (moved) {
        const css = v.rectToCss(i, rect);
        const f = Math.min(v.el.clientWidth / css.width, v.el.clientHeight / css.height) * 0.9;
        const z = v.scale * f; const cx = (css.left + css.width / 2) * f; const cy = (css.top + css.height / 2) * f;
        v.setZoom(z);
        const n = v.node(i);
        v.el.scrollLeft = n.el.offsetLeft + cx - v.el.clientWidth / 2; v.el.scrollTop = n.el.offsetTop + cy - v.el.clientHeight / 2;
      } else v.zoomStep(1);
      return;
    }
    const custom = this.rectTools.get(t);
    if (custom) {
      if (custom.needsDrag && !moved) { toast('Please drag out an area.'); return; }
      await custom.fn(i, moved ? rect : null, p0, e, p1);
      if (!custom.keep) this.setTool('select');
    }
  }

  inkDraw(e, i, p0) {
    const layer = e.currentTarget;
    const svg = s('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible' });
    const c = this.props.ink;
    const path = s('path', { fill: 'none', stroke: cssColor(c.color), 'stroke-width': c.width * this.viewer.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    svg.append(path); layer.append(svg);
    const r0 = layer.getBoundingClientRect();
    let d = `M${e.clientX - r0.left} ${e.clientY - r0.top}`;
    const pts = [p0];
    startDrag(e, (m) => {
      for (const ev of m.getCoalescedEvents?.() || [m]) { pts.push(this.viewer.toPdf(i, ev.clientX, ev.clientY)); d += ` L${ev.clientX - r0.left} ${ev.clientY - r0.top}`; }
      path.setAttribute('d', d);
    }, async () => {
      svg.remove();
      const now = Date.now();
      const last = this.lastInk && this.doc.find(this.lastInk.id);
      if (last && last.page === i && now - this.lastInk.at < 1500) {
        this.doc.pushUndo(); last.strokes.push(pts); this.touch(last);
        this.lastInk.at = now; this.afterEdit(i);
      } else {
        const a = await this.add({ type: 'ink', page: i, rect: [0, 0, 1, 1], strokes: [pts], ...c });
        if (a) this.lastInk = { id: a.id, at: now };
      }
    });
  }

  erase(e, i) {
    let pushed = false;
    const radius = 6 / this.viewer.scale;
    const check = (m) => {
      const q = this.viewer.toPdf(i, m.clientX, m.clientY);
      const list = this.doc.list(i);
      let changed = false;
      for (let k = list.length - 1; k >= 0; k--) {
        const a = list[k];
        if (a.type !== 'ink') continue;
        const out = [];
        for (const st of a.strokes) {
          let cur = [];
          let cut = false;
          for (const p of st) {
            if (Math.hypot(p[0] - q[0], p[1] - q[1]) < radius) { cut = true; if (cur.length > 1) out.push(cur); cur = []; } else cur.push(p);
          }
          if (cur.length > 1) out.push(cur);
          if (cut) changed = true;
        }
        if (changed) {
          if (!pushed) { this.doc.pushUndo(); pushed = true; }
          a.strokes = out;
          if (!out.length) list.splice(k, 1);
        }
      }
      if (changed) this.renderPage(i);
    };
    check(e);
    startDrag(e, check, () => { if (pushed) this.afterEdit(i); });
  }

  polyClick(e, i, p) {
    if (!this.poly || this.poly.page !== i) {
      this.finishPoly();
      const svg = s('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible' });
      const line = s('polyline', { fill: 'none', stroke: '#0e7c86', 'stroke-width': 2 });
      svg.append(line); e.currentTarget.append(svg);
      this.poly = { page: i, pts: [p], svg, line };
    } else {
      const first = this.poly.pts[0];
      const closeEnough = this.poly.pts.length > 2 && Math.hypot(p[0] - first[0], p[1] - first[1]) * this.viewer.scale < 8;
      if (closeEnough) { this.finishPoly(); return; }
      this.poly.pts.push(p);
    }
    this.drawPoly();
  }
  drawPoly(extra) {
    const vp = this.viewer.viewport(this.poly.page);
    this.poly.line.setAttribute('points', [...this.poly.pts, ...(extra ? [extra] : [])].map((q) => vp.convertToViewportPoint(q[0], q[1]).join(',')).join(' '));
  }
  polyHover(e, i) { if (this.poly && this.poly.page === i) this.drawPoly(this.viewer.toPdf(i, e.clientX, e.clientY)); }
  finishPoly() {
    if (!this.poly) return;
    const { page, pts, svg } = this.poly;
    this.poly = null;
    svg.remove();
    const t = this.tool;
    // On a double-click the browser delivers two clicks at the same position.
    const clean = pts.filter((p, k) => !k || Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) > 0.5);
    if (clean.length < 2) return;
    if (t.startsWith('measure-')) { this.app.tools.finishMeasure(t, page, clean); return; }
    if (clean.length < 3 && t !== 'polyline') return;
    this.add({ type: t, page, rect: [0, 0, 1, 1], points: clean, ...this.props[t] });
    setTimeout(() => this.setTool('select'), 0);
  }

  // --- Markups from the text selection -----------------------------------------------------
  selectionQuads() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const out = new Map();
    const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    if (range.commonAncestorContainer.nodeType === 3) texts.push(range.commonAncestorContainer);
    else while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) texts.push(walker.currentNode);
    for (const t of texts) {
      const span = t.parentElement;
      if (!span?.closest?.('.textLayer')) continue;
      const pageEl = span.closest('.pv-page');
      const i = +pageEl.dataset.page;
      const r = document.createRange();
      r.setStart(t, t === range.startContainer ? range.startOffset : 0);
      r.setEnd(t, t === range.endContainer ? range.endOffset : t.length);
      if (r.collapsed) continue;
      for (const c of r.getClientRects()) { if (c.width < 0.5) continue; if (!out.has(i)) out.set(i, []); out.get(i).push({ left: c.left, right: c.right, top: c.top, bottom: c.bottom }); }
    }
    if (!out.size) return null;
    const quads = new Map();
    for (const [i, rects] of out) {
      rects.sort((a, b) => a.top - b.top || a.left - b.left);
      const merged = [];
      for (const c of rects) {
        const m = merged[merged.length - 1];
        const overlap = m ? Math.min(m.bottom, c.bottom) - Math.max(m.top, c.top) : 0;
        if (m && overlap > 0.5 * Math.min(m.bottom - m.top, c.bottom - c.top) && c.left - m.right < 12) { m.right = Math.max(m.right, c.right); m.top = Math.min(m.top, c.top); m.bottom = Math.max(m.bottom, c.bottom); } else merged.push({ ...c });
      }
      quads.set(i, merged.map((c) => {
        const tl = this.viewer.toPdf(i, c.left, c.top); const tr = this.viewer.toPdf(i, c.right, c.top);
        const bl = this.viewer.toPdf(i, c.left, c.bottom); const br = this.viewer.toPdf(i, c.right, c.bottom);
        return [...tl, ...tr, ...bl, ...br];
      }));
    }
    return { quads, text: sel.toString() };
  }

  async markSelection(type) {
    const r = this.selectionQuads();
    if (!r) return false;
    const real = type === 'redact-text' ? 'redact' : type === 'replace' ? 'strikeout' : type;
    window.getSelection().removeAllRanges();
    for (const [i, quads] of r.quads) {
      const b = bboxOfPoints(quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]));
      if (type === 'caret') { const q = quads[quads.length - 1]; await this.add({ type: 'caret', page: i, rect: [q[6] - 4, q[7] - 3, q[6] + 4, q[7] + 5], color: [0.1, 0.3, 0.8], contents: '' }); continue; }
      const a = await this.add({ type: real, page: i, rect: b, quads, contents: '', ...(type === 'replace' ? { subject: 'Replace text', ...this.props.strikeout } : real === 'redact' ? { color: [0.85, 0, 0], opacity: 1 } : this.props[real]) });
      if (a && type === 'replace') { const c = window.innerWidth / 2; this.notePopup(a, c, 200); }
    }
    return true;
  }

  onSelectionEnd(e) {
    if (!this.doc || !e.target.closest?.('#viewer')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      if (TEXT_TOOLS.has(this.tool)) {
        const t = this.tool;
        this.markSelection(t).catch(errToast);
        return;
      }
      if (this.tool === 'select') this.showMini(e.clientX, e.clientY);
    }, 0);
  }
  showMini(x, y) {
    this.hideMini();
    const act = (type) => () => { this.hideMini(); this.markSelection(type).catch(errToast); };
    const m = h('div', { class: 'mini', style: { left: `${Math.min(x, innerWidth - 240)}px`, top: `${Math.max(46, y - 46)}px` } },
      ibtn('highlight', 'Highlight', act('highlight')), ibtn('text', 'Underline', act('underline')), ibtn('replace', 'Strikethrough', act('strikeout')),
      ibtn('comment', 'Add comment', async () => {
        this.hideMini();
        const r = this.selectionQuads();
        await this.markSelection('highlight');
        if (r) { const list = this.doc.list([...r.quads.keys()].pop()); const a = list[list.length - 1]; this.notePopup(a, x, y); }
      }),
      ibtn('redact', 'Mark for redaction', act('redact-text')),
      ibtn('dup', 'Copy', () => { document.execCommand('copy'); this.hideMini(); toast('Copied'); }));
    m.addEventListener('pointerdown', (e) => e.preventDefault());
    document.body.append(m);
    this.mini = m;
  }
  hideMini() { this.mini?.remove(); this.mini = null; }

  // --- Properties bar ---------------------------------------------------------------
  renderPropbar() {
    const bar = $('#propbar');
    const a = this.selected ? this.doc?.find(this.selected) : null;
    const key = a ? a.type : this.tool;
    const p = a || this.props[key];
    if (!p || this.tool === 'edit') { if (this.tool !== 'edit') { bar.hidden = true; bar.replaceChildren(); } return; }
    const set = (k, v) => {
      if (a) { this.doc.pushUndo(); a[k] = v; this.touch(a); this.afterEdit(a.page); }
      else this.props[key][k] = v;
      this.renderPropbar();
    };
    const same = (x, y) => (x === null || x === undefined ? y === null || y === undefined : !!y && x.every((v, i) => Math.abs(v - y[i]) < 0.01));
    const swatches = (label, k, allowNone) => h('label', {}, label, h('div', { class: 'swatches' },
      allowNone ? h('button', { class: `swatch none ${same(p[k], null) ? 'on' : ''}`, type: 'button', title: 'None', onclick: () => set(k, null) }) : null,
      PALETTE.map((c) => h('button', { class: `swatch ${same(p[k], c) ? 'on' : ''}`, type: 'button', style: { background: cssColor(c) }, onclick: () => set(k, c) }))));
    const sel = (label, k, opts, fmt = (v) => v) => h('label', {}, label, h('select', { onchange: (e) => set(k, parseFloat(e.target.value)) }, opts.map((o) => h('option', { value: o, selected: Math.abs((p[k] ?? 1) - o) < 0.001 }, fmt(o)))));
    const items = [];
    const isText = key === 'freetext' || key === 'callout';
    if (isText) { items.push(swatches('Text color', 'textColor')); items.push(swatches('Fill', 'fill', true)); items.push(sel('Size', 'fontSize', [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48])); if (key === 'callout') items.push(swatches('Border', 'borderColor')); }
    else if (key !== 'stamp' && key !== 'redact' && key !== 'caret') items.push(swatches('Color', 'color'));
    if (['rect', 'ellipse', 'polygon', 'cloud'].includes(key)) items.push(swatches('Fill', 'fill', true));
    if (['rect', 'ellipse', 'polygon', 'cloud', 'line', 'arrow', 'polyline', 'ink'].includes(key)) items.push(sel('Line', 'width', [0.5, 1, 2, 3, 4, 6, 8, 12], (v) => `${v} pt`));
    if (key !== 'redact' && key !== 'caret') items.push(sel('Opacity', 'opacity', [1, 0.8, 0.6, 0.5, 0.4, 0.2], (v) => `${Math.round(v * 100)} %`));
    if (a) items.push(h('span', { class: 'spacer' }), ibtn('trash', 'Delete comment', () => this.remove(a.id)));
    bar.replaceChildren(...items);
    bar.hidden = items.length === 0;
  }
}

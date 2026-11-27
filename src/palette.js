// Search all commands (Ctrl+Shift+P): every tool of every group and the commands of the menus in one list, filtered
// while typing (every word must match the name or the group). Arrow keys choose, Enter runs, Esc closes.
import { h, icon, emptyState } from './util.js';

/** The menu commands: [label, command, argument, shortcut]. */
const COMMANDS = [
  ['Open', 'open', null, 'Ctrl+O'], ['Save', 'save', null, 'Ctrl+S'], ['Save as', 'save-as', null, 'Ctrl+Shift+S'], ['Print', 'print', null, 'Ctrl+P'],
  ['Document properties', 'properties', null, 'Ctrl+D'], ['Close tab', 'close-tab', null, 'Ctrl+W'], ['Reopen closed tab', 'reopen-closed', null, 'Ctrl+Shift+T'],
  ['Show in Explorer', 'reveal', null, ''], ['Revert (last save)', 'revert', null, ''], ['Find', 'find', null, 'Ctrl+F'], ['Find and replace', 'replace', null, 'Ctrl+Shift+H'],
  ['Advanced search', 'find-advanced', null, 'Ctrl+Shift+F'], ['Undo', 'undo', null, 'Ctrl+Z'], ['Redo', 'redo', null, 'Ctrl+Y'], ['Preferences', 'preferences', null, 'Ctrl+K'],
  ['Rotate view clockwise', 'view-rotate', 90, ''], ['Go to page', 'goto-page', null, 'Ctrl+Shift+G'], ['Zoom in', 'zoom-in', null, ''], ['Zoom out', 'zoom-out', null, ''],
  ['Fit page', 'zoom', 'page', 'Ctrl+0'], ['Actual size', 'zoom', 'actual', 'Ctrl+1'], ['Fit width', 'zoom', 'width', 'Ctrl+2'], ['Single page', 'layout', 'single', ''],
  ['Two pages', 'layout', 'double', ''], ['Rulers', 'toggle-rulers', null, 'Ctrl+R'], ['Grid', 'toggle-grid', null, 'Ctrl+U'], ['Sidebar', 'toggle-right', null, 'F4'],
  ['Page thumbnails', 'panel', 'thumbs', ''], ['Bookmarks', 'panel', 'bookmarks', ''], ['Comment list', 'panel', 'comments', ''], ['Attachments', 'panel', 'attachments', ''],
  ['Reading mode', 'reading-mode', null, 'Ctrl+H'], ['Full screen mode', 'fullscreen', null, 'Ctrl+L'], ['Read page aloud', 'speak', 'page', ''],
  ['Next tab', 'tab-next', null, 'Ctrl+Tab'], ['Previous tab', 'tab-prev', null, 'Ctrl+Shift+Tab'], ['Close all tabs', 'close-all', null, ''],
  ['Combine files', 'tool-combine', null, ''], ['Action wizard', 'action-wizard', null, ''], ['Create PDF from file', 'create-from-file', null, ''], ['Blank page', 'create-blank', null, 'Ctrl+Shift+N'],
  ['Keyboard shortcuts', 'shortcuts', null, 'F1'], ['About DocPilot', 'about', null, ''],
];

/** All entries: {label, group, keys, run}. */
export function paletteEntries(app) {
  const out = [];
  for (const [label, cmd, arg, keys] of COMMANDS) out.push({ label, group: 'Command', keys, run: () => app.run(cmd, arg) });
  for (const g of app.tools.groups) {
    if (!g.hidden) out.push({ label: g.label, group: 'Tool', keys: '', run: () => app.tools.openGroup(g.id) });
    for (const it of g.items || []) {
      if (it.sub) continue;
      const label = it.label.replace(/\.\.\.$/, '');
      out.push({ label, group: g.label, keys: '', run: () => { if (it.tool) { app.tools.openGroup(g.id); app.tools.selectTool(it.tool); } else it.run(); } });
    }
  }
  const seen = new Set();
  return out.filter((e) => { const k = `${e.group}|${e.label}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The entries matching a query: every word in the name or the group; names that start with the query come first. */
export function filterEntries(list, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const hits = list.filter((e) => { const t = `${e.label} ${e.group}`.toLowerCase(); return words.every((w) => t.includes(w)); });
  const ql = q.trim().toLowerCase();
  return hits.sort((a, b) => (b.label.toLowerCase().startsWith(ql) - a.label.toLowerCase().startsWith(ql)) || (b.label.toLowerCase().includes(ql) - a.label.toLowerCase().includes(ql)));
}

/** Opens the command search, below the search field of the title bar; initial: text already typed. */
export function openPalette(app, initial = '') {
  if (document.querySelector('.palette')) return;
  const all = paletteEntries(app);
  let shown = initial ? filterEntries(all, initial) : all; let sel = 0;
  const input = h('input', { type: 'search', placeholder: 'Search tools and commands', spellcheck: 'false', 'aria-label': 'Search tools and commands', value: initial, data: { paletteInput: '1' } });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  // Esc closes the search wherever the focus is (also before the input has it, e.g. right after a click).
  const onKey = (e) => { if (e.key === 'Escape' && scrim.isConnected) { e.preventDefault(); e.stopPropagation(); close(); } };
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey, true); };
  const runAt = (k) => { const e = shown[k]; if (!e) return; close(); setTimeout(() => Promise.resolve(e.run()).catch((err) => console.warn(err)), 0); };
  const render = () => {
    list.replaceChildren(...shown.slice(0, 60).map((e, k) => h('button', { class: `pal-item ${k === sel ? 'sel' : ''}`, type: 'button', role: 'option', data: { label: e.label, group: e.group }, onclick: () => runAt(k) },
      h('span', { class: 'l' }, e.label), h('span', { class: 'g' }, e.group), e.keys ? h('kbd', {}, e.keys) : null)));
    if (!shown.length) list.append(emptyState('search', 'No matching command', 'Try another word, for example "rotate" or "watermark".'));
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { shown = filterEntries(all, input.value); sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Search commands' }, h('div', { class: 'pal-in' }, icon('search'), input), list);
  const scrim = h('div', { class: 'scrim pal-scrim', onmousedown: (e) => { if (e.target === scrim) close(); } }, box);
  // Below the search field of the title bar, centered on it (in full screen the list is in the middle).
  const field = document.getElementById('cmd-search')?.getBoundingClientRect();
  if (field?.width) {
    const w = Math.min(560, innerWidth - 40);
    scrim.classList.add('anchored');
    box.style.marginLeft = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, field.left + field.width / 2 - w / 2)))}px`;
  }
  document.getElementById('float-root').append(scrim);
  document.addEventListener('keydown', onKey, true);
  render();
  const focus = () => { if (!scrim.isConnected) return; input.focus(); input.setSelectionRange(input.value.length, input.value.length); };
  focus(); setTimeout(focus, 0);
}

'use strict';
const { Menu } = require('electron');

/** Menu bar: File, Edit, View, E-Sign, Window, Help. */
function buildMenu({ recent, send, openRecent, devtools }) {
  const c = (label, cmd, accelerator, arg) => ({ label, accelerator, click: () => send(cmd, arg) });
  const sep = { type: 'separator' };
  const template = [
    {
      label: 'File',
      submenu: [
        c('Open...', 'open', 'CmdOrCtrl+O'),
        { label: 'Recent files', submenu: recent.length ? [...recent.slice(0, 12).map((r) => ({ label: r.name, click: () => openRecent(r.path) })), sep, c('Clear list', 'recent-clear')] : [{ label: '(none)', enabled: false }] },
        { label: 'Create', submenu: [c('PDF from file...', 'create-from-file'), c('PDF from scanner...', 'create-scan'), c('PDF from clipboard', 'create-clipboard', 'CmdOrCtrl+Alt+V'), c('Blank page', 'create-blank', 'CmdOrCtrl+Shift+N'), sep, c('Combine files into a single PDF...', 'tool-combine')] },
        sep,
        c('Save', 'save', 'CmdOrCtrl+S'),
        c('Save as...', 'save-as', 'CmdOrCtrl+Shift+S'),
        c('Save as optimized PDF...', 'tool-compress'),
        c('Revert (last save)', 'revert'),
        sep,
        { label: 'Export to', submenu: [c('Microsoft Word (.docx)...', 'export', undefined, 'docx'), c('Microsoft Excel (.xlsx)...', 'export', undefined, 'xlsx'), c('Microsoft PowerPoint (.pptx)...', 'export', undefined, 'pptx'), sep, c('Image (PNG)...', 'export', undefined, 'png'), c('Image (JPEG)...', 'export', undefined, 'jpeg'), sep, c('HTML web page...', 'export', undefined, 'html'), c('Rich Text (.rtf)...', 'export', undefined, 'rtf'), c('Plain text (.txt)...', 'export', undefined, 'txt'), c('PDF/A...', 'tool-pdfa')] },
        c('Password protection...', 'tool-encrypt'),
        sep,
        c('Close', 'close-tab', 'CmdOrCtrl+W'),
        c('Properties...', 'properties', 'CmdOrCtrl+D'),
        c('Print...', 'print', 'CmdOrCtrl+P'),
        sep,
        c('Exit', 'quit', 'CmdOrCtrl+Q'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        c('Undo', 'undo', 'CmdOrCtrl+Z'),
        c('Redo', 'redo', 'CmdOrCtrl+Y'),
        sep,
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Insert' },
        c('Delete', 'delete'),
        c('Select all', 'select-all', 'CmdOrCtrl+A'),
        c('Deselect all', 'deselect', 'CmdOrCtrl+Shift+A'),
        sep,
        c('Edit text and images', 'tool-edit'),
        c('Snapshot', 'tool', undefined, 'snapshot'),
        sep,
        c('Find', 'find', 'CmdOrCtrl+F'),
        c('Find and replace...', 'replace', 'CmdOrCtrl+Shift+H'),
        c('Advanced search', 'find-advanced', 'CmdOrCtrl+Shift+F'),
        sep,
        c('Preferences...', 'preferences', 'CmdOrCtrl+K'),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Rotate view', submenu: [c('Clockwise', 'view-rotate', 'CmdOrCtrl+Shift+Plus', 90), c('Counterclockwise', 'view-rotate', 'CmdOrCtrl+Shift+-', -90)] },
        { label: 'Page navigation', submenu: [c('First page', 'first-page'), c('Previous page', 'prev-page'), c('Next page', 'next-page'), c('Last page', 'last-page'), c('Go to page...', 'goto-page', 'CmdOrCtrl+Shift+G'), sep, c('Previous view', 'nav-back', 'Alt+Left'), c('Next view', 'nav-forward', 'Alt+Right')] },
        { label: 'Page Display', submenu: [c('Single page', 'layout', 'CmdOrCtrl+Alt+1', 'single'), c('Continuous', 'layout', 'CmdOrCtrl+Alt+2', 'continuous'), c('Two pages', 'layout', 'CmdOrCtrl+Alt+3', 'double'), c('Two pages continuous', 'layout', 'CmdOrCtrl+Alt+4', 'double-continuous')] },
        { label: 'Zoom', submenu: [c('Zoom in', 'zoom-in', 'CmdOrCtrl+='), c('Zoom out', 'zoom-out', 'CmdOrCtrl+-'), sep, c('Fit page', 'zoom', 'CmdOrCtrl+0', 'page'), c('Actual size', 'zoom', 'CmdOrCtrl+1', 'actual'), c('Fit width', 'zoom', 'CmdOrCtrl+2', 'width'), c('Fit visible height', 'zoom', 'CmdOrCtrl+3', 'height'), sep, c('Marquee zoom', 'tool', undefined, 'zoom')] },
        { label: 'Einblenden/Ausblenden', submenu: [c('Rulers', 'toggle-rulers', 'CmdOrCtrl+R'), c('Grid', 'toggle-grid', 'CmdOrCtrl+U'), c('Sidebar', 'toggle-right', 'F4'), c('Tools pane', 'toggle-left', 'Shift+F4')] },
        sep,
        c('All tools', 'show-tools'),
        c('Reading mode', 'reading-mode', 'CmdOrCtrl+H'),
        c('Full screen mode', 'fullscreen', 'CmdOrCtrl+L'),
        { label: 'Read Out Loud', submenu: [c('Read page aloud', 'speak', 'CmdOrCtrl+Shift+V', 'page'), c('Read document aloud', 'speak', 'CmdOrCtrl+Shift+B', 'doc'), c('Pause/Fortsetzen', 'speak', 'CmdOrCtrl+Shift+C', 'pause'), c('Exit', 'speak', 'CmdOrCtrl+Shift+E', 'stop')] },
      ],
    },
    {
      label: 'E-Sign',
      submenu: [
        c('Fill and sign', 'tool-group', undefined, 'fillsign'),
        c('Set up signature or initials...', 'sign-setup'),
        sep,
        c('Sign digitally with certificate...', 'tool-digital-sign'),
        c('Create digital ID...', 'tool-create-id'),
        c('Validate signatures', 'panel', undefined, 'signatures'),
      ],
    },
    {
      label: 'Window',
      submenu: [
        c('Next tab', 'tab-next', 'CmdOrCtrl+Tab'),
        c('Previous tab', 'tab-prev', 'CmdOrCtrl+Shift+Tab'),
        c('Close all tabs', 'close-all'),
        sep,
        { role: 'minimize', label: 'Minimize' },
        { role: 'togglefullscreen', label: 'Full-screen window', accelerator: 'F11' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        c('Keyboard shortcuts', 'shortcuts', 'F1'),
        { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+F12', click: devtools },
        sep,
        c('About DocPilot', 'about'),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
module.exports = { buildMenu };

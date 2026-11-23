'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = (c) => (...a) => ipcRenderer.invoke(`dp:${c}`, ...a);
const listen = (c) => (cb) => ipcRenderer.on(`dp:${c}`, (_e, ...a) => cb(...a));

contextBridge.exposeInMainWorld('dp', {
  ready: inv('ready'), closeOk: inv('close-ok'), setTitle: inv('set-title'), fullscreen: inv('fullscreen'), version: inv('version'), policy: inv('policy'),
  openDialog: inv('open-dialog'), saveDialog: inv('save-dialog'), folderDialog: inv('folder-dialog'),
  readFile: inv('read-file'), writeFile: inv('write-file'), fileStat: inv('file-stat'),
  reveal: inv('reveal'), openExternal: inv('open-external'), openPath: inv('open-path'),
  recentGet: inv('recent-get'), recentAdd: inv('recent-add'), recentRemove: inv('recent-remove'),
  settingsGet: inv('settings-get'), settingsSet: inv('settings-set'),
  font: inv('font'), fonts: inv('fonts'), fontFace: inv('font-face'), srgbIcc: inv('srgb-icc'), clipboardImage: inv('clipboard-image'), clipboardWriteImage: inv('clipboard-write-image'),
  officeAvailable: inv('office-available'), officeToPdf: inv('office-to-pdf'), scan: inv('scan'),
  htmlToPdf: inv('html-to-pdf'), printers: inv('printers'), print: inv('print'),
  pathForFile: (f) => webUtils.getPathForFile(f),
  onCommand: listen('command'), onOpenPaths: listen('open-paths'), onRequestClose: listen('request-close'),
});

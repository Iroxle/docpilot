'use strict';
/**
 * Adds a lock to the electron-builder MSI project: if DocPilot is still running, the installation
 * (including an update or uninstall) stops with a message before anything is changed.
 *
 * Reason: while the program is open, Windows cannot replace its files and only swaps them on the next
 * restart. In November 2026 this lost the program file app.asar, and the editor no longer
 * started. The check runs before the old version is removed (RemoveExistingProducts).
 */
const fs = require('fs');

const EXE = 'DocPilot.exe';
// ASCII characters only: WiX writes this text into a table with code page 1252 and rejects umlauts there.
const MESSAGE = 'DocPilot is still open. Please close all DocPilot windows and then start the installation again.';

module.exports = async function msiProjectCreated(projectFile) {
  let wxs = fs.readFileSync(projectFile, 'utf8');
  const UTIL_NS = 'http://wixtoolset.org/schemas/v4/wxs/util';
  if (!wxs.includes(UTIL_NS)) wxs = wxs.replace('<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"', `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:util="${UTIL_NS}"`);
  if (wxs.includes('<InstallExecuteSequence>')) throw new Error('msi-hook: unexpected InstallExecuteSequence in the MSI project; the lock needs to be adjusted.');
  const guard = `
    <!-- Lock: install only while the editor is closed (see scripts/msi-hook.js). -->
    <util:CloseApplication Id="DpEditorRunning" Target="${EXE}" Property="DPEDITORRUNNING" CloseMessage="no" RebootPrompt="no"/>
    <!-- Own early check using the WixUtil function: only sets the property, closes nothing. -->
    <CustomAction Id="DpDetectEditor" BinaryKey="WixCA" DllEntry="WixCloseApplications" Execute="immediate" Return="check"/>
    <CustomAction Id="DpEditorRunningError" Error="${MESSAGE}"/>
    <InstallExecuteSequence>
      <Custom Action="DpDetectEditor" Before="InstallValidate">VersionNT &gt; 400</Custom>
      <Custom Action="DpEditorRunningError" After="DpDetectEditor">DPEDITORRUNNING</Custom>
    </InstallExecuteSequence>
  </Product>`;
  const n = wxs.split('</Product>').length - 1;
  if (n !== 1) throw new Error(`msi-hook: </Product> found ${n} times.`);
  wxs = wxs.replace('</Product>', guard);
  fs.writeFileSync(projectFile, wxs, 'utf8');
};

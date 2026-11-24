'use strict';
/**
 * macOS counterparts of the Windows-specific parts of the main process: IT policy, Office conversion,
 * scanner, fonts and the sRGB color profile. electron/main.js and electron/fonts.js use them on a Mac.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const HOME = os.homedir();

/**
 * IT policy from a configuration profile (MDM) for the domain com.docpilot.app, the counterpart of
 * HKLM\SOFTWARE\Policies\DocPilot. Managed preferences can only be written by the system, not by users.
 * Keys: AllowJavaScript, AllowOfficeMacros (true or 1).
 */
const POLICY_DOMAIN = 'com.docpilot.app';
const POLICY_FILES = [
  path.join('/Library/Managed Preferences', os.userInfo().username, `${POLICY_DOMAIN}.plist`),
  path.join('/Library/Managed Preferences', `${POLICY_DOMAIN}.plist`),
];
function policy() {
  const p = { allowJavaScript: false, allowOfficeMacros: false, key: POLICY_DOMAIN };
  for (const f of POLICY_FILES) {
    try {
      const j = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const on = (v) => v === true || v === 1;
      p.allowJavaScript = on(j.AllowJavaScript);
      p.allowOfficeMacros = on(j.AllowOfficeMacros);
      break;
    } catch { /* no profile: everything stays blocked */ }
  }
  return p;
}

// --- Fonts ---------------------------------------------------------------------------------

/**
 * Font folders on a Mac: system, all users, this user, and the fonts that come with Microsoft Office
 * (Calibri, Cambria and others are inside the app bundles there, not in the system fonts).
 */
const OFFICE_APPS = { 'Word.Application': 'Microsoft Word', 'Excel.Application': 'Microsoft Excel', 'PowerPoint.Application': 'Microsoft PowerPoint' };
const appPath = (name) => [path.join('/Applications', `${name}.app`), path.join(HOME, 'Applications', `${name}.app`)].find((p) => fs.existsSync(p));
const FONT_DIRS = [
  { dir: '/System/Library/Fonts', deep: true, cloud: false },
  { dir: '/Library/Fonts', deep: false, cloud: false },
  { dir: path.join(HOME, 'Library', 'Fonts'), deep: false, cloud: false },
  ...Object.values(OFFICE_APPS).map((n) => appPath(n)).filter(Boolean).map((p) => ({ dir: path.join(p, 'Contents', 'Resources', 'DFonts'), deep: false, cloud: false })),
];

/** Windows file names of the standard fonts (see SYSTEM_FONTS in src/pdf/ops.js) and their names on a Mac. */
const MAC_FONT_FILES = {
  'arial.ttf': 'Arial.ttf', 'arialbd.ttf': 'Arial Bold.ttf', 'ariali.ttf': 'Arial Italic.ttf', 'arialbi.ttf': 'Arial Bold Italic.ttf',
  'times.ttf': 'Times New Roman.ttf', 'timesbd.ttf': 'Times New Roman Bold.ttf', 'timesi.ttf': 'Times New Roman Italic.ttf', 'timesbi.ttf': 'Times New Roman Bold Italic.ttf',
  'cour.ttf': 'Courier New.ttf', 'courbd.ttf': 'Courier New Bold.ttf', 'couri.ttf': 'Courier New Italic.ttf', 'courbi.ttf': 'Courier New Bold Italic.ttf',
  'verdana.ttf': 'Verdana.ttf', 'verdanab.ttf': 'Verdana Bold.ttf', 'verdanai.ttf': 'Verdana Italic.ttf', 'verdanaz.ttf': 'Verdana Bold Italic.ttf',
  'tahoma.ttf': 'Tahoma.ttf', 'tahomabd.ttf': 'Tahoma Bold.ttf',
  'georgia.ttf': 'Georgia.ttf', 'georgiab.ttf': 'Georgia Bold.ttf', 'georgiai.ttf': 'Georgia Italic.ttf', 'georgiaz.ttf': 'Georgia Bold Italic.ttf',
  'calibri.ttf': 'Calibri.ttf', 'calibrib.ttf': 'Calibri Bold.ttf', 'calibrii.ttf': 'Calibri Italic.ttf', 'calibriz.ttf': 'Calibri Bold Italic.ttf',
};
/** Path of a standard font requested by its Windows file name, or null. Only font folders are searched. */
function fontFile(file) {
  const base = path.basename(String(file)).toLowerCase();
  const names = [MAC_FONT_FILES[base], path.basename(String(file))].filter(Boolean);
  const dirs = ['/System/Library/Fonts/Supplemental', ...FONT_DIRS.map((d) => d.dir)];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p)) return p; }
  return null;
}

/**
 * Word's Normal.dotm on a Mac. It lies in Office's group container; reading it there makes macOS ask
 * "DocPilot would like to access data from other apps" on every start. So it is not read: the built-in
 * default font applies (Aptos 11, or Calibri 11 if Aptos is not installed).
 */
const NORMAL_DOTM = null;

const SRGB_ICC = '/System/Library/ColorSync/Profiles/sRGB Profile.icc';

// --- Office --------------------------------------------------------------------------------

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

/** Installed Office apps, with the same names as on Windows ("Word.Application", ...). */
function officeAvailable() {
  return Object.entries(OFFICE_APPS).filter(([, n]) => appPath(n)).map(([k]) => k);
}

/**
 * AppleScript per Office app. Paths come in as arguments, so file names are never interpreted as commands.
 * Office for Mac runs in a sandbox: it can only read and write freely inside its own container. That is why
 * the file is copied there first and the PDF is written there (see officeToPdf).
 */
const OFFICE_SCRIPTS = {
  word: ['com.microsoft.Word', `on run argv
	set inFile to POSIX file (item 1 of argv)
	set outFile to (POSIX file (item 2 of argv)) as text
	tell application "Microsoft Word"
		open inFile
		set d to active document
		try
			save as d file name outFile file format format PDF
		end try
		close d saving no
	end tell
end run`],
  excel: ['com.microsoft.Excel', `on run argv
	set inFile to POSIX file (item 1 of argv)
	set outFile to (POSIX file (item 2 of argv)) as text
	tell application "Microsoft Excel"
		set oldAlerts to display alerts
		set display alerts to false
		try
			open inFile
			set wb to active workbook
			save workbook as wb filename outFile file format PDF file format
			close wb saving no
		end try
		set display alerts to oldAlerts
	end tell
end run`],
  powerpoint: ['com.microsoft.Powerpoint', `on run argv
	set inFile to POSIX file (item 1 of argv)
	set outFile to (POSIX file (item 2 of argv)) as text
	tell application "Microsoft PowerPoint"
		open inFile
		set p to active presentation
		try
			save p in outFile as save as PDF
		end try
		close p
	end tell
end run`],
};

/**
 * File types that can contain macros. With macros blocked, they are not opened in Office on a Mac:
 * unlike on Windows (AutomationSecurity), Office for Mac cannot be told by a script to open a file with
 * all macros switched off, and its macro warning would also stop the conversion.
 */
const MACRO_TYPES = /\.(doc|dot|docm|dotm|xls|xlsm|xlsb|xlt|xltm|ppt|pptm|pot|potm|pps|ppsm)$/i;

/**
 * Converts an Office file to a PDF at `out` with the installed Office for Mac.
 * macrosAllowed: only when IT and the user have allowed macros (same rule as on Windows).
 */
async function officeToPdf(kind, input, out, macrosAllowed) {
  if (MACRO_TYPES.test(input) && !macrosAllowed) throw new Error('This file type can contain macros and is not opened in Office while macros are blocked.');
  const [bundleId, script] = OFFICE_SCRIPTS[kind];
  // The container only exists once the Office app has been started. Never create it ourselves; without it,
  // the normal temporary folder is used and Office asks once for access to it.
  const data = path.join(HOME, 'Library', 'Containers', bundleId, 'Data');
  const base = fs.existsSync(data) ? path.join(data, 'tmp') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'docpilot-'));
  try {
    const src = path.join(dir, `in${path.extname(input).toLowerCase()}`);
    const pdf = path.join(dir, 'out.pdf');
    fs.copyFileSync(input, src);
    await run('/usr/bin/osascript', ['-e', script, src, pdf], 180000);
    // Excel writes one PDF per sheet if the sheets have different page setups: take the first one.
    const made = fs.existsSync(pdf) ? pdf : fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).map((f) => path.join(dir, f))[0];
    if (!made) throw new Error('Office did not create a PDF.');
    fs.copyFileSync(made, out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- Scanner -------------------------------------------------------------------------------

/**
 * Scanner via a small helper program (scripts/mac/scan.swift) that shows the macOS scanner window
 * (ImageKit, like the Image Capture app) and saves the scan as PNG.
 */
function scanHelper() {
  const p = path.join(process.resourcesPath || '', 'docpilot-scan');
  return fs.existsSync(p) ? p : null;
}
async function scan(out) {
  const helper = scanHelper();
  if (!helper) throw new Error('Scanning is not available. Scan with the Image Capture app and open the image in DocPilot.');
  await run(helper, [out, 'Scan'], 600000);
  return fs.existsSync(out);
}

module.exports = { policy, FONT_DIRS, fontFile, NORMAL_DOTM, SRGB_ICC, officeAvailable, officeToPdf, scan };

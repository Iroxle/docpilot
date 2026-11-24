'use strict';
// Builds the scanner helper for macOS (scripts/mac/scan.swift) as a universal binary for Apple silicon
// and Intel into build/mac/docpilot-scan. electron-builder copies it into the app (build.mac.extraResources).
// Usage: node scripts/mac-helper.js (part of npm run dist:mac; needs a Mac with the Xcode command line tools).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.log('The scanner helper can only be built on macOS.');
  process.exit(0);
}
const root = path.join(__dirname, '..');
const out = path.join(root, 'build', 'mac');
const src = path.join(__dirname, 'mac', 'scan.swift');
fs.mkdirSync(out, { recursive: true });
const parts = ['arm64', 'x86_64'].map((arch) => {
  const f = path.join(out, `docpilot-scan-${arch}`);
  execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos11.0`, '-o', f, src], { stdio: 'inherit' });
  return f;
});
execFileSync('lipo', ['-create', '-output', path.join(out, 'docpilot-scan'), ...parts], { stdio: 'inherit' });
for (const f of parts) fs.rmSync(f);
console.log('Scanner helper built:', path.relative(root, path.join(out, 'docpilot-scan')));

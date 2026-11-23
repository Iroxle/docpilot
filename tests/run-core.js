'use strict';
const esbuild = require('esbuild');
const path = require('path');
const { spawnSync } = require('child_process');

const out = path.join(__dirname, '..', 'dist', 'tests', 'core.mjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'core.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error',
  external: ['pdfjs-dist', 'node-forge', '@cantoo/pdf-lib', '@cantoo/fontkit'],
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
});
const r = spawnSync(process.execPath, [out], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(r.status);

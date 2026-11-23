'use strict';
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'renderer');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const copy = (from, to) => fs.cpSync(from, path.join(out, to), { recursive: true });

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const nodeStub = {
  name: 'node-stub',
  setup(b) {
    const re = /^(node:)?(fs|path|crypto|stream|zlib|https|http|url|util|os|buffer|events|assert|string_decoder|net|tls|child_process|timers|tty|vm|constants|readline)(\/.*)?$/;
    b.onResolve({ filter: re }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

async function main() {
  await esbuild.build({
    entryPoints: { app: path.join(root, 'src', 'main.js') },
    bundle: true, format: 'esm', splitting: true, target: 'chrome130', outdir: out, chunkNames: 'chunks/[name]-[hash]',
    minify: !process.env.DP_DEV, sourcemap: process.env.DP_DEV ? 'inline' : false, legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    mainFields: ['browser', 'module', 'main'], conditions: ['browser'], logLevel: 'error', plugins: [nodeStub],
  });
copy(path.join(root, 'src', 'index.html'), 'index.html');
fs.writeFileSync(path.join(out, 'styles.css'),
  fs.readFileSync(nm('pdfjs-dist', 'web', 'pdf_viewer.css'), 'utf8').replace(/url\((['"]?)images\/[^)]*\)/g, 'none') + '\n' +
  fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8'));
copy(path.join(root, 'assets'), 'assets');
copy(nm('pdfjs-dist', 'build', 'pdf.worker.min.mjs'), 'pdfjs/pdf.worker.min.mjs');
copy(nm('pdfjs-dist', 'build', 'pdf.sandbox.min.mjs'), 'pdfjs/pdf.sandbox.min.mjs');
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) copy(nm('pdfjs-dist', d), `pdfjs/${d}`);
copy(nm('tesseract.js', 'dist', 'worker.min.js'), 'tesseract/worker.min.js');
for (const f of fs.readdirSync(nm('tesseract.js-core'))) {
  if (f.startsWith('tesseract-core')) copy(nm('tesseract.js-core', f), `tesseract/core/${f}`);
}
for (const l of ['eng', 'deu', 'fra', 'ita']) {
  copy(nm('@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`), `tesseract/lang/${l}.traineddata.gz`);
}
  console.log('Build complete:', path.relative(root, out));
}
main().catch((e) => { console.error(e); process.exit(1); });

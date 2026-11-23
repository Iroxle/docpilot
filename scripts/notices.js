'use strict';
// Creates THIRD_PARTY_NOTICES.md: license texts of all npm packages that end up in the app.
// Bundled code is found through esbuild's metafile (same entry and options as scripts/build.js);
// files copied as they are (PDF.js worker, Tesseract worker/core/language data) are added explicitly.
// Usage: npm run notices
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');

const nodeStub = {
  name: 'node-stub',
  setup(b) {
    const re = /^(node:)?(fs|path|crypto|stream|zlib|https|http|url|util|os|buffer|events|assert|string_decoder|net|tls|child_process|timers|tty|vm|constants|readline)(\/.*)?$/;
    b.onResolve({ filter: re }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

/** Package directory (node_modules/<name> or node_modules/@scope/<name>) of a file inside node_modules. */
function packageDir(file) {
  const rel = path.relative(nm, path.resolve(root, file)).split(path.sep);
  if (rel[0] === '..' || rel.length < 2) return null;
  // Nested node_modules: take the innermost package.
  const last = rel.lastIndexOf('node_modules');
  const parts = last >= 0 ? rel.slice(last + 1) : rel;
  const base = last >= 0 ? path.join(nm, ...rel.slice(0, last + 1)) : nm;
  return parts[0].startsWith('@') ? path.join(base, parts[0], parts[1]) : path.join(base, parts[0]);
}

function licenseText(dir) {
  const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.|-|$)/i.test(n));
  return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : null;
}

function noticeText(dir) {
  const f = fs.readdirSync(dir).find((n) => /^notice(\.|$)/i.test(n));
  return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : null;
}

const mitText = (pj) => {
  const who = typeof pj.author === 'string' ? pj.author : pj.author?.name || `the ${pj.name} authors`;
  return `MIT License\n\nCopyright (c) ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
};
// The language packages contain trained data from tesseract-ocr/tessdata_best, which is licensed under Apache 2.0.
const TESSDATA_NOTE = 'The trained language data (*.traineddata) comes from https://github.com/tesseract-ocr/tessdata_best and is licensed under the Apache License, Version 2.0. The npm package that distributes it is marked MIT.';

const APACHE_FALLBACK = 'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at\n\n    http://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.';

async function main() {
  const result = await esbuild.build({
    entryPoints: { app: path.join(root, 'src', 'main.js') },
    bundle: true, format: 'esm', splitting: true, target: 'chrome130', outdir: path.join(root, 'dist', 'notices-tmp'),
    write: false, metafile: true, define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    mainFields: ['browser', 'module', 'main'], conditions: ['browser'], logLevel: 'error', plugins: [nodeStub],
  });
  const dirs = new Set();
  for (const f of Object.keys(result.metafile.inputs)) { const d = packageDir(f); if (d) dirs.add(d); }
  // Copied unchanged by scripts/build.js.
  for (const p of ['pdfjs-dist', 'tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng', '@tesseract.js-data/deu', '@tesseract.js-data/fra', '@tesseract.js-data/ita']) dirs.add(path.join(nm, p));

  const pkgs = [...dirs].filter((d) => fs.existsSync(path.join(d, 'package.json'))).map((d) => {
    const pj = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
    const lic = typeof pj.license === 'string' ? pj.license : pj.license?.type || (pj.licenses || []).map((l) => l.type || l).join(' OR ') || 'UNKNOWN';
    const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url || pj.homepage || '';
    const tessdata = pj.name.startsWith('@tesseract.js-data/');
    let text = licenseText(d);
    if (tessdata) text = `${TESSDATA_NOTE}\n\n${APACHE_FALLBACK}`;
    else if (!text && /apache/i.test(lic)) text = APACHE_FALLBACK;
    else if (!text && /^MIT$/i.test(lic)) text = mitText(pj);
    const url = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^(ssh:\/\/)?git@github\.com[:/]/, 'https://github.com/').replace(/^git:/, 'https:');
    return { name: pj.name, version: pj.version, license: tessdata ? 'Apache-2.0 (data), MIT (package)' : lic, repo: url, text, notice: noticeText(d) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const missing = pkgs.filter((p) => !p.text);
  const out = [
    '# Third-party notices',
    '',
    'DocPilot includes the following open-source software. Each component is licensed under the terms shown below.',
    'The Electron runtime (MIT) and the Chromium licenses are shipped with the installed program in `LICENSE.electron.txt` and `LICENSES.chromium.html`.',
    '',
    'This file is generated with `npm run notices`.',
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...pkgs.map((p) => `| ${p.repo ? `[${p.name}](${p.repo})` : p.name} | ${p.version} | ${p.license} |`),
    '',
    ...pkgs.flatMap((p) => [`## ${p.name} ${p.version}`, '', `License: ${p.license}`, '', '```', p.text || '(no license file in the package)', '```', '', ...(p.notice ? ['NOTICE:', '', '```', p.notice, '```', ''] : [])]),
  ].join('\n');
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), out);
  console.log(`THIRD_PARTY_NOTICES.md: ${pkgs.length} packages${missing.length ? `, without license file: ${missing.map((p) => p.name).join(', ')}` : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

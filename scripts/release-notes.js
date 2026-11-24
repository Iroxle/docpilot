'use strict';
// Prints the CHANGELOG.md section of one version (default: the version in package.json), for the release text.
// Usage: npm run --silent release-notes [-- 1.0.2]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = (process.argv[2] || require(path.join(root, 'package.json')).version).replace(/^v/, '');
const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l.trim() === `## ${version}`);
if (start < 0) { console.error(`CHANGELOG.md has no section for version ${version}.`); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
if (end < 0) end = lines.length;
// Relative links do not work in a release text: point them at the repository.
const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}/blob/v${version}/` : '';
// A release text shows every line break, so join the wrapped lines of a list item or paragraph.
const body = [];
for (const l of lines.slice(start + 1, end)) {
  if (/^\s+\S/.test(l) && body.length && body[body.length - 1].trim()) body[body.length - 1] += ` ${l.trim()}`;
  else body.push(l);
}
console.log(body.join('\n').trim().replace(/\]\((?!https?:|#)([^)]+)\)/g, (m, f) => `](${repo}${f})`));

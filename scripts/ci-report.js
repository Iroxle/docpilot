'use strict';
// Shows failed tests as annotations on the GitHub Actions run page (summary and the "Annotations" list),
// so failures can be read without opening the full log.
// Usage: node scripts/ci-report.js <platform name> <log file>...
const fs = require('fs');

const [platform, ...logs] = process.argv.slice(2);
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
let shown = 0;
for (const file of logs) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  const kind = /core/.test(file) ? 'Core test' : 'App test';
  lines.forEach((l, i) => {
    const m = /^\s+FAIL\s+(.*)$/.exec(l);
    if (!m || shown >= 40) return;
    // The first lines after FAIL hold the error message and where it happened.
    const after = lines.slice(i + 1, i + 6);
    const end = after.findIndex((x) => !/^\s{5,}\S/.test(x));
    const detail = (end < 0 ? after : after.slice(0, end)).map((x) => x.trim()).join('\n');
    console.log(`::error title=${esc(`${kind} failed on ${platform}: ${m[1]}`).replace(/[:,]/g, ' ')}::${esc(detail || m[1])}`);
    shown++;
  });
  const summary = lines.reverse().find((l) => /steps (passed|failed)|core tests passed|of \d+ failed/.test(l));
  if (summary) console.log(`::notice title=${kind}s on ${platform}::${esc(summary.trim())}`);
}

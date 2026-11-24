'use strict';
// Shows failed tests as annotations on the GitHub Actions run page (summary and the "Annotations" list),
// so failures can be read without opening the full log.
// Usage: node scripts/ci-report.js <platform name> <error|warning> <log file>...
//        node scripts/ci-report.js <title> tail <log file>   (last lines of a failed build)
const fs = require('fs');

const [platform, level, ...logs] = process.argv.slice(2);
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// "tail" mode: the last lines of a build log, e.g. node scripts/ci-report.js "macOS build" tail build.log
if (level === 'tail') {
  let text = '';
  try { text = require('fs').readFileSync(logs[0], 'utf8'); } catch { /* no log */ }
  const last = text.split(/\r?\n/).filter((l) => l.trim()).slice(-40).join('\n');
  console.log(`::error title=${platform} failed::${esc(last || 'no output')}`);
  process.exit(0);
}
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
    // Following lines up to the next step (indented error text; blank lines inside a message are skipped).
    const after = lines.slice(i + 1, i + 14);
    const end = after.findIndex((x) => /^\s{0,3}\S/.test(x) || /^\s+(OK|FAIL|SKIP)\s/.test(x));
    const detail = (end < 0 ? after : after.slice(0, end)).map((x) => x.trim()).filter(Boolean).slice(0, 10).join('\n');
    console.log(`::${level === 'warning' ? 'warning' : 'error'} title=${esc(`${kind} failed on ${platform}: ${m[1]}`).replace(/[:,]/g, ' ')}::${esc(detail || m[1])}`);
    shown++;
  });
  const skipped = lines.map((l) => /^\s+SKIP\s+(.*)$/.exec(l)).filter(Boolean).map((m) => m[1]);
  if (skipped.length) console.log(`::notice title=${kind}s skipped on ${platform}::${esc(skipped.join('\n'))}`);
  const summary = lines.reverse().find((l) => /steps (passed|failed)|core tests passed|of \d+ failed/.test(l));
  if (summary) console.log(`::notice title=${kind}s on ${platform}::${esc(summary.trim())}`);
}

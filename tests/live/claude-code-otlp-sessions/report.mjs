// Builds evidence/report.md from evidence/{baseline-main,baseline-pr779,branch}.json
// usage: node tests/live/claude-code-otlp-sessions/report.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'evidence');
const runs = [
  ['baseline-main', 'origin/main (no fix)'],
  ['baseline-pr779', '#779 re-applied (what QA tested)'],
  ['branch', 'this branch'],
].filter(([file]) => existsSync(join(dir, `${file}.json`))).map(([file, name]) => ({ name, ...JSON.parse(readFileSync(join(dir, `${file}.json`), 'utf8')) }));

const ids = [...new Set(runs.flatMap((r) => r.results.map((x) => x.id)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const lines = ['# Live validation: continued and reopened Claude Code sessions', '',
  'Real hook process -> real proxy daemon and forwarder (built `dist`) -> fake backend, under a temp `CODEMIE_HOME`.',
  'Nothing touches the real `~/.codemie`, `~/.claude` or the real daemon.', '',
  `Ran: ${runs.map((r) => `${r.name} (${r.ranAt})`).join('; ')}`, '', '## Result per scenario (all checks of the scenario passed = PASS)', '',
  `| Scenario | ${runs.map((r) => r.name).join(' | ')} |`, `|---|${runs.map(() => '---').join('|')}|`];
for (const id of ids) {
  const cells = runs.map((r) => {
    const x = r.results.find((y) => y.id === id);
    if (!x) return 'n/a';
    if (x.error) return 'ERROR';
    return x.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  });
  lines.push(`| ${id} | ${cells.join(' | ')} |`);
}
lines.push('', '## Failed checks and what was observed', '');
for (const id of ids) {
  lines.push(`### ${id}`, '');
  const title = runs.flatMap((r) => r.results).find((x) => x.id === id)?.title;
  if (title) lines.push(`_${title}_`, '');
  for (const r of runs) {
    const x = r.results.find((y) => y.id === id);
    if (!x) continue;
    lines.push(`- **${r.name}**`);
    for (const c of x.checks) lines.push(`  - ${c.ok ? 'ok' : '**FAIL**'}: ${c.message}`);
    if (x.error) lines.push(`  - error: ${x.error.split('\n')[0]}`);
  }
  lines.push('');
}
writeFileSync(join(dir, 'report.md'), lines.join('\n'));
console.log(`wrote ${join(dir, 'report.md')}`);

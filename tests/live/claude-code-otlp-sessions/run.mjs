// Runs every scenario against the build in LIVE_REPO_ROOT (default: this checkout) in a fully isolated
// environment, and writes evidence/<label>.json.
// usage: node tests/live/claude-code-otlp-sessions/run.mjs --label branch [--only S7,S9] [--concurrency 4] [--keep]
//        LIVE_REPO_ROOT=<clean origin/main checkout, built> node ... --label baseline
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SUITE_DIR, REPO_ROOT, createTestEnv } from './lib/env.mjs';
import { createFakeBackend } from './lib/fake-backend.mjs';
import { startDaemon } from './lib/daemon.mjs';
import { scenarios } from './scenarios/index.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const label = arg('label', 'branch');
const only = arg('only', '')?.split(',').filter(Boolean);
const concurrency = Number(arg('concurrency', '4'));
const keep = process.argv.includes('--keep');

const te = createTestEnv({ keep });
const backend = await createFakeBackend();
const daemon = await startDaemon(te, backend);
console.log(`label=${label} repo=${REPO_ROOT}\nisolated root=${te.root}\nfake backend=${backend.url} daemon=${daemon.url}\n`);

const selected = scenarios.filter((s) => !only?.length || only.some((id) => s.id.startsWith(id)));
const results = [];
let next = 0;
async function worker() {
  while (next < selected.length) {
    const scenario = selected[next++];
    const started = Date.now();
    try {
      const { observed, checks } = await scenario.run({ te, backend, daemon });
      results.push({ id: scenario.id, title: scenario.title, observed, checks, ms: Date.now() - started });
    } catch (error) {
      results.push({ id: scenario.id, title: scenario.title, error: String(error?.stack ?? error), checks: [], ms: Date.now() - started });
    }
    const r = results.at(-1);
    console.log(`${r.error ? 'ERROR' : r.checks.every((c) => c.ok) ? 'PASS ' : 'FAIL '} ${r.id}  (${Math.round(r.ms / 1000)}s)`);
    for (const c of r.checks) console.log(`        ${c.ok ? '+' : '-'} ${c.message}`);
    if (r.error) console.log(r.error.split('\n').slice(0, 4).join('\n'));
  }
}
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
} finally {
  const outDir = join(SUITE_DIR, 'evidence');
  mkdirSync(outDir, { recursive: true });
  results.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  // A partial run (--only) never replaces the committed full evidence. The checkout is recorded by its
  // folder name only: an absolute path would put the local user name into the repository.
  const file = only?.length ? `${label}.partial.json` : `${label}.json`;
  writeFileSync(join(outDir, file), JSON.stringify({ label, repo: basename(REPO_ROOT), ranAt: new Date().toISOString(), backendRequests: backend.requests.length, results }, null, 2));
  await daemon.stop();
  await backend.stop();
  te.cleanup();
}
const failed = results.filter((r) => r.error || r.checks.some((c) => !c.ok)).length;
console.log(`\n${label}: ${results.length - failed}/${results.length} scenarios passed all checks`);
// A baseline run documents a build WITHOUT the fix: failures there are the expected result.
process.exit(label.startsWith('baseline') ? 0 : failed ? 1 : 0);

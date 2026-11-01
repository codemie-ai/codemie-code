#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const output = join(root, 'artifacts', 'analytics-weekly', runId);
mkdirSync(output, { recursive: true });
const summary = { runId, sourceVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  sourceSHA: '', releasedVersion: '', localPassingChecks: 0, knownDefectContracts: 0, failures: 0, suites: [] };
let failed = false;

const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 });
if (git.error || git.status !== 0) throw new Error(`Cannot identify source revision: ${git.error?.message ?? git.stderr}`);
summary.sourceSHA = git.stdout.trim();
try {
  const response = await fetch('https://registry.npmjs.org/@codemieai/code/latest', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  summary.releasedVersion = (await response.json()).version;
  if (!summary.releasedVersion) throw new Error('npm registry response has no version');
} catch (error) {
  summary.releaseVerificationError = error.message;
  console.error(`Release verification failed: ${error.message}`);
  failed = true;
}

const suites = [
  ['unit', [
    'src/utils/__tests__/pricing.test.ts',
    'src/cli/commands/analytics/cost/__tests__/cost-calculator.test.ts',
    'src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts',
    'src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts',
    'src/cli/commands/analytics/__tests__/data-loader.test.ts',
    'src/cli/commands/analytics/__tests__/native-loader.test.ts',
    'src/cli/commands/analytics/__tests__/native-loader-pi.test.ts',
    'src/cli/commands/analytics/__tests__/copilot-managed-report.test.ts',
    'src/cli/commands/analytics/__tests__/known-contracts.test.ts',
    'src/cli/commands/analytics/report/__tests__/report-generator.test.ts',
    'src/cli/commands/analytics/report/__tests__/report-views.test.ts',
    'src/cli/commands/analytics/report/__tests__/payload-builder.test.ts',
  ]],
  ['cli', [
    'tests/integration/analytics.test.ts',
    'tests/integration/analytics-cli-contract.test.ts',
    'tests/integration/session/non-claude-processor-gaps.test.ts',
  ]],
  ['browser', ['src/cli/commands/analytics/report/__tests__/client-date-dst.test.ts']],
];

for (const [name, files] of suites) {
  const project = name === 'browser' ? 'unit' : name;
  const reportPath = join(output, `${name}.json`);
  const args = [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--project', project, ...files,
    '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`];
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ANALYTICS_BROWSER_TESTS: name === 'browser' ? 'true' : 'false',
      ANALYTICS_EVIDENCE_DIR: join(output, `${name}-evidence`) },
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  writeFileSync(join(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.signal || result.status !== 0) {
    console.error(`${name} failed: ${result.error?.message ?? result.signal ?? result.status}`);
    failed = true;
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (report.testResults.length !== files.length || report.numTotalTests === 0) {
      throw new Error('Selected files were silently skipped or no tests executed');
    }
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    const known = assertions.filter((test) => test.fullName.includes('KNOWN DEFECT') && test.status === 'passed').length;
    const ordinary = assertions.filter((test) => !test.fullName.includes('KNOWN DEFECT') && test.status === 'passed').length;
    const failures = assertions.filter((test) => test.status === 'failed').length;
    summary.localPassingChecks += ordinary;
    summary.knownDefectContracts += known;
    summary.failures += failures;
    summary.suites.push({ name, passing: ordinary, knownDefectContracts: known, failures });
  } catch (error) {
    console.error(`${name} report invalid: ${error.message}`);
    failed = true;
  }
}
summary.verdict = failed ? 'FAILED' : 'COMPLETE WITH KNOWN DEFECTS';
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.verdict}: ${summary.localPassingChecks} passing protection checks; `
  + `${summary.knownDefectContracts} KNOWN DEFECT contract failures (expected-failure tests, NOT product PASS); `
  + `${summary.failures} unexpected failures.\nEvidence: ${output}`);
process.exitCode = failed ? 1 : 0;

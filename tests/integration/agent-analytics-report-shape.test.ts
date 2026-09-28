/**
 * Agent test T1 — report shape against the golden fixture
 * (unify-analytics-cost-command, spec section C).
 *
 * Runs the BUILT `bin/codemie.js analytics` CLI (spawnSync, no TTY) against an isolated
 * CODEMIE_HOME seeded from the golden Claude fixture (tests/integration/metrics/fixtures/claude/),
 * the same fixture tests/integration/analytics.test.ts uses. Unlike that in-process test, this one
 * drives the real cost-enrichment path: the CodeMie-tracked session's `correlation.agentSessionFile`
 * must resolve to a real native Claude log on disk (findSubagentFiles looks for
 * `{dir}/{agentSessionId}/subagents/agent-*.jsonl`, see src/agents/plugins/claude/claude.session.ts),
 * so the fixture's `-tmp-private/` files are laid out under an isolated HOME's
 * `.claude/projects/-tmp-private/` exactly like the existing
 * tests/integration/session/metrics-processor.test.ts does — not the fixture's flat
 * `expected-session.json`, whose `~/...` path is never tilde-expanded by the real fs calls.
 *
 * Asserts (spec T1):
 * Run 1 (`analytics --export json -o <tmp>/out.json`):
 *   - meta.{generatedAt,agents,totals.*,coverage,unpricedModels,estimatedModels} all exist;
 *   - every session has models/tokens/costUSD/perModelCost;
 *   - totals.totalCostUSD > 0 and unpricedModels is [];
 *   - no session has hadLog && costUSD === 0.
 * Run 2 (`analytics --export both -o <tmp>/nested/dir/`):
 *   - the new directory holds exactly one default-named .html and one default-named .report.json.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportPayload } from '../../src/cli/commands/analytics/report/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'integration', 'metrics', 'fixtures', 'claude');

const CODEMIE_SESSION_ID = '71a17a83-ff99-4d05-964b-0bd56892faec';
const AGENT_SESSION_ID = '4c2ddfdc-b619-4525-8d03-1950fb1b0257';

/** Hard cap per CLI invocation; well under vitest's agent-project 180s testTimeout. */
const RUN_TIMEOUT_MS = 60_000;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Lay out an isolated CODEMIE_HOME so `codemie analytics` prices the golden Claude session for
 * real: a native Claude project dir (with the main transcript + its two sub-agent transcripts
 * under `{sessionId}/subagents/`, exactly as findSubagentFiles expects), a CodeMie-tracked
 * session record whose `correlation.agentSessionFile` points at that real path (so cost-enricher
 * resolves it AND native discovery dedupes it instead of double-counting), the matching
 * `_metrics.jsonl` deltas, and a config with `userEmail` set (so `-o <dir>/` gets an
 * email-slugged default filename and no interactive email prompt is attempted).
 */
function seedHome(home: string): void {
  const projectDir = join(home, '.claude', 'projects', '-tmp-private');
  mkdirSync(projectDir, { recursive: true });
  const agentSessionFile = join(projectDir, `${AGENT_SESSION_ID}.jsonl`);
  copyFileSync(join(FIXTURES_DIR, '-tmp-private', `${AGENT_SESSION_ID}.jsonl`), agentSessionFile);

  const subagentsDir = join(projectDir, AGENT_SESSION_ID, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  for (const agentFile of ['agent-36541525.jsonl', 'agent-50243ee8.jsonl']) {
    copyFileSync(join(FIXTURES_DIR, '-tmp-private', agentFile), join(subagentsDir, agentFile));
  }

  const sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionMeta = {
    sessionId: CODEMIE_SESSION_ID,
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: 1765395456088,
    workingDirectory: '/tmp/private',
    status: 'active',
    correlation: {
      status: 'matched',
      retryCount: 2,
      agentSessionFile,
      agentSessionId: AGENT_SESSION_ID,
      detectedAt: 1765395458136,
    },
  };
  writeFileSync(join(sessionsDir, `${CODEMIE_SESSION_ID}.json`), JSON.stringify(sessionMeta, null, 2), 'utf-8');
  copyFileSync(
    join(FIXTURES_DIR, 'expected-metrics.jsonl'),
    join(sessionsDir, `${CODEMIE_SESSION_ID}_metrics.jsonl`),
  );

  writeFileSync(
    join(home, 'codemie-cli.config.json'),
    JSON.stringify({ version: 2, activeProfile: 'default', profiles: {}, userEmail: 'agent-test@example.com' }, null, 2),
    'utf-8',
  );
}

/** Drive the built `codemie analytics` CLI (no TTY) against the isolated home. */
function runAnalytics(home: string, args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEMIE_')) delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  env.DO_NOT_TRACK = '1';
  env.CI = '1';
  env.CODEMIE_HOME = home;
  env.CODEMIE_SKIP_UPDATE_CHECK = 'true';

  const result = spawnSync(process.execPath, [BIN, 'analytics', ...args], {
    cwd: home,
    env,
    encoding: 'utf-8',
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(
      `codemie analytics failed to run within ${RUN_TIMEOUT_MS}ms` +
      (result.signal ? ` (killed via ${result.signal})` : '') +
      `\nstdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}`,
    );
  }

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('agent-analytics-report-shape (T1): report shape against the golden fixture', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'codemie-analytics-shape-'));
    seedHome(home);
  });

  afterAll(() => {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore cleanup errors */
    }
  });

  describe('Run 1: analytics --export json -o <tmp>/out.json', () => {
    let payload: ReportPayload;

    beforeAll(() => {
      const outPath = join(home, 'out.json');
      const res = runAnalytics(home, ['--export', 'json', '-o', outPath]);
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
      payload = JSON.parse(readFileSync(outPath, 'utf-8')) as ReportPayload;
    });

    it('meta carries generatedAt, agents, totals.*, coverage, unpricedModels and estimatedModels', () => {
      expect(payload.meta.generatedAt).toEqual(expect.any(String));
      expect(Array.isArray(payload.meta.agents)).toBe(true);

      const { totals } = payload.meta;
      expect(totals).toBeDefined();
      expect(typeof totals.sessions).toBe('number');
      expect(typeof totals.durationMs).toBe('number');
      expect(typeof totals.turns).toBe('number');
      expect(typeof totals.files).toBe('number');
      expect(typeof totals.netLines).toBe('number');
      expect(typeof totals.toolCallsTotal).toBe('number');
      expect(typeof totals.toolSuccessRate).toBe('number');
      expect(typeof totals.totalCostUSD).toBe('number');
      expect(typeof totals.cacheReadCostUSD).toBe('number');
      expect(typeof totals.pricedSessions).toBe('number');

      expect(Array.isArray(payload.meta.coverage)).toBe(true);
      expect(Array.isArray(payload.meta.unpricedModels)).toBe(true);
      expect(Array.isArray(payload.meta.estimatedModels)).toBe(true);
    });

    it('every session has models, tokens, costUSD and perModelCost', () => {
      expect(payload.sessions.length).toBeGreaterThan(0);
      for (const session of payload.sessions) {
        expect(Array.isArray(session.models)).toBe(true);
        expect(session.tokens).toBeDefined();
        expect(typeof session.costUSD).toBe('number');
        expect(Array.isArray(session.perModelCost)).toBe(true);
      }
    });

    it('totals.totalCostUSD is greater than 0', () => {
      expect(payload.meta.totals.totalCostUSD).toBeGreaterThan(0);
    });

    it('unpricedModels is empty', () => {
      expect(payload.meta.unpricedModels).toEqual([]);
    });

    it('no session has hadLog true while costUSD is 0', () => {
      const offenders = payload.sessions.filter((s) => s.hadLog && s.costUSD === 0);
      expect(offenders, `sessions with a log but no price: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
    });
  });

  describe('Run 2: analytics --export both -o <tmp>/nested/dir/ (directory does not exist yet)', () => {
    let dirPath: string;

    beforeAll(() => {
      dirPath = join(home, 'nested', 'dir') + '/';
      const res = runAnalytics(home, ['--export', 'both', '-o', dirPath]);
      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    });

    it('creates the directory holding exactly one default-named .html and one default-named .report.json', () => {
      const files = readdirSync(dirPath.replace(/\/$/, ''));
      const htmlFiles = files.filter((f) => f.endsWith('.html'));
      const jsonFiles = files.filter((f) => f.endsWith('.report.json'));

      expect(htmlFiles, `dir contents: ${JSON.stringify(files)}`).toHaveLength(1);
      expect(jsonFiles, `dir contents: ${JSON.stringify(files)}`).toHaveLength(1);
      expect(htmlFiles[0]).toMatch(/^codemie-analytics-.*\.html$/);
      expect(jsonFiles[0]).toMatch(/^codemie-analytics-.*\.report\.json$/);
    });
  });
});

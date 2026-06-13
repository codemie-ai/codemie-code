/**
 * Agent JWT Budget / Project Tests — TC-028
 *
 * Run with: npm run test:integration:agent
 * Requires: INCLUDE_JWT_TESTS=true, CI_CODEMIE_* env vars, CI_CODEMIE_PROJECT_ALL_BUDGETS
 *
 * TC-028: Agent completes `--task 'Say READY'` with exit 0 and writes a session file.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchJwtToken, getTempDir, jwtCleanEnv } from '../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';
const PROJECT = process.env.CI_CODEMIE_PROJECT_ALL_BUDGETS ?? '';
const INCLUDE_BUDGET_TESTS = INCLUDE_JWT_TESTS && !!process.env.CI_CODEMIE_PROJECT_ALL_BUDGETS;

function writeBudgetProfile(codemieHome: string, jwtToken: string): void {
  const config = {
    version: 2,
    activeProfile: 'jwt-budget',
    profiles: {
      'jwt-budget': {
        name: 'jwt-budget',
        provider: 'bearer-auth',
        authMethod: 'jwt',
        codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
        baseUrl: `${(process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '')}/code-assistant-api`,
        model: process.env.CI_CODEMIE_MODEL ?? 'claude-sonnet-4-6',
        jwtToken,
        codeMieProject: PROJECT,
      },
    },
  };
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

describe.runIf(INCLUDE_BUDGET_TESTS)('Budget / Project tests (TC-028)', () => {
  let jwtToken: string;

  beforeAll(async () => {
    jwtToken = await fetchJwtToken();
  }, 30_000);

  // ── TC-028: Agent completes task with all-budget project profile ─────────────
  describe('TC-028 — agent task succeeds with all-budget project', () => {
    let testHome: string;
    let agentResult: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(),'codemie-budget-task-'));
      writeBudgetProfile(testHome, jwtToken);
      agentResult = spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'jwt-budget', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
    }, 180_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('agent exits 0 and writes a session file', () => {
      expect(agentResult.status, (agentResult.stdout ?? '') + (agentResult.stderr ?? '')).toBe(0);
      const files = readdirSync(join(testHome, 'sessions')).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);
    });

    it('session file has bearer-auth provider', () => {
      const sessionsDir = join(testHome, 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      const session = JSON.parse(
        readFileSync(join(sessionsDir, files[0]), 'utf-8')
      ) as Record<string, unknown>;
      expect(String(session.provider ?? session.providerName ?? '')).toMatch(/bearer-auth/i);
    });
  });
});

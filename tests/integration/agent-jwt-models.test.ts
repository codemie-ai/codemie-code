/**
 * Agent JWT Model Selection Tests — TC-020, TC-021
 *
 * Run with: npm run test:integration:agent
 * Requires: INCLUDE_JWT_TESTS=true, CI_CODEMIE_* env vars
 *
 * TC-020: Verify a profile with a specific model causes the agent to record
 *         that model in the _metrics.jsonl `models` array (sonnet and haiku variants).
 * TC-021: Verify the configured model appears in the _metrics.jsonl `models` array
 *         and that it is a non-empty string.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchJwtToken, getTempDir, jwtCleanEnv, getLatestMetricsRecord } from '../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

function writeModelProfile(codemieHome: string, profileName: string, model: string): void {
  const config = {
    version: 2,
    activeProfile: profileName,
    profiles: {
      [profileName]: {
        name: profileName,
        provider: 'bearer-auth',
        authMethod: 'jwt',
        codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
        baseUrl: `${(process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '')}/code-assistant-api`,
        model,
      },
    },
  };
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(
    join(codemieHome, 'codemie-cli.config.json'),
    JSON.stringify(config, null, 2),
    'utf-8'
  );
}


describe.runIf(INCLUDE_JWT_TESTS)('Agent — model selection (TC-020, TC-021)', () => {
  let jwtToken: string;

  beforeAll(async () => {
    jwtToken = await fetchJwtToken();
  }, 30_000);

  // ── TC-020: Session model field matches profile ──────────────────────────────
  describe('TC-020 — session uses model from profile', () => {
    let testHome: string;
    let sonnetMetrics: Record<string, unknown>;
    let haikuMetrics: Record<string, unknown>;

    beforeAll(async () => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-model-match-'));

      // Run sonnet profile task
      writeModelProfile(testHome, 'profile-sonnet', 'claude-sonnet-4-6');
      spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'profile-sonnet', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { cwd: testHome, env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
      sonnetMetrics = getLatestMetricsRecord(join(testHome, 'sessions'));

      // Run haiku profile task (separate testHome so mtime ordering is unambiguous)
      const haikuHome = mkdtempSync(join(getTempDir(), 'codemie-model-haiku-'));
      writeModelProfile(haikuHome, 'profile-haiku', 'claude-haiku-4-5-20251001');
      spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'profile-haiku', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { cwd: haikuHome, env: { ...jwtCleanEnv(), CODEMIE_HOME: haikuHome }, encoding: 'utf-8', timeout: 120_000 }
      );
      haikuMetrics = getLatestMetricsRecord(join(haikuHome, 'sessions'));
    }, 300_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('metrics models array contains sonnet for claude-sonnet-4-6 profile', () => {
      const models = (sonnetMetrics.models as string[]) ?? [];
      expect(
        models.some((m) => /sonnet/i.test(m)),
        `Expected models to contain sonnet, got: ${JSON.stringify(models)}`,
      ).toBe(true);
    });

    it('metrics models array contains haiku for claude-haiku-4-5-20251001 profile', () => {
      const models = (haikuMetrics.models as string[]) ?? [];
      expect(
        models.some((m) => /haiku/i.test(m)),
        `Expected models to contain haiku, got: ${JSON.stringify(models)}`,
      ).toBe(true);
    });
  });

  // ── TC-021: Metrics models array populated ─────────────────────────────────
  describe('TC-021 — metrics records the configured model', () => {
    let testHome: string;
    let metrics: Record<string, unknown>;

    beforeAll(async () => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-tiers-'));
      writeModelProfile(testHome, 'profile-tiers', 'claude-sonnet-4-6');
      spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'profile-tiers', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { cwd: testHome, env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
      metrics = getLatestMetricsRecord(join(testHome, 'sessions'));
    }, 180_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('metrics models array is non-empty and contains the configured model', () => {
      const models = (metrics.models as string[]) ?? [];
      expect(models.length, 'models array must not be empty').toBeGreaterThan(0);
      expect(
        models.some((m) => /sonnet/i.test(m)),
        `Expected models to contain the configured sonnet model, got: ${JSON.stringify(models)}`,
      ).toBe(true);
    });
  });
});

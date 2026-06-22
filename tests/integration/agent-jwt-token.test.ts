/**
 * JWT token — no-profile invocation — TC-027
 *
 * Run with: npm run test:integration:agent
 * Requires: CI_IS_LOCAL_RUN=false (JWT mode) + CI_CODEMIE_* env vars
 *
 * JWT-ONLY: SSO always requires a configured profile; there is no SSO
 * equivalent of the --jwt-token-only invocation path. This suite is skipped
 * when CI_IS_LOCAL_RUN=true.
 *
 * TC-027: --jwt-token passed with no pre-written profile and an empty
 *         CODEMIE_HOME. Verifies the agent authenticates and completes a
 *         --task using only the token supplied on the command line.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchJwtToken,
  getTempDir,
  jwtCleanEnv,
  getTestEnvFlagOrDefault,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

describe.runIf(!CI_IS_LOCAL_RUN)('JWT token — no-profile invocation [JWT-only, skipped when CI_IS_LOCAL_RUN=true]', () => {
  let jwtToken: string;

  beforeAll(async () => {
    jwtToken = await fetchJwtToken();
  }, 30_000);

  // ── TC-027: --jwt-token with no profile ────────────────────────────────────
  // Empty CODEMIE_HOME, no profile written, token supplied only via CLI flag.
  // Every other JWT test pre-writes a bearer-auth profile first; this test
  // exercises the token-only code path that skips profile resolution entirely.
  describe('TC-027 — --jwt-token without profile exits 0 and prints agent response', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-jwt-token-'));
      result = spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--task', 'Say the word READY and nothing else', '--jwt-token', jwtToken],
        {
          env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome },
          encoding: 'utf-8',
          timeout: 120_000,
        },
      );
    }, 180_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits 0', () => {
      expect(
        result.status,
        `stdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}`,
      ).toBe(0);
    });

    it('agent response appears in stdout', () => {
      expect(result.stdout).toMatch(/READY/i);
    });
  });
});

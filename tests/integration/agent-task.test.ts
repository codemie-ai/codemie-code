/**
 * Task output tests — TC-016
 *
 * Run with: npm run test:integration:agent
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode; uses developer's sso-autotest profile in ~/.codemie
 *   false           — JWT mode; isolates to a temp CODEMIE_HOME with bearer-auth profile
 *
 * TC-016: --task run exits 0 and the agent response appears in stdout.
 *         Verifies that non-interactive task output is correctly routed to the
 *         caller's stdout (not swallowed or written only to session files).
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchJwtToken,
  writeJwtProfile,
  writeSsoProfile,
  copySsoCredentials,
  getTempDir,
  jwtCleanEnv,
  ssoCleanEnv,
  setupSsoAutotestProfile,
  teardownSsoAutotestProfile,
  getTestEnvFlagOrDefault,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Task output tests', () => {
  let jwtToken: string;
  let originalActiveProfile: string | undefined;

  beforeAll(async () => {
    if (!CI_IS_LOCAL_RUN) {
      jwtToken = await fetchJwtToken();
    } else {
      originalActiveProfile = setupSsoAutotestProfile();
    }
  }, 30_000);

  afterAll(() => {
    if (CI_IS_LOCAL_RUN) {
      teardownSsoAutotestProfile(originalActiveProfile);
    }
  });

  // ── TC-016: --task exits 0 and response appears in stdout ─────────────────
  // Checks the non-interactive output path specifically. PTY-based tests
  // (TC-024, TC-025) verify interactive session output; this test verifies
  // that --task mode routes the agent response to the caller's stdout.
  describe('TC-016 — --task run exits 0 and prints agent response to stdout', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-task-'));
      if (!CI_IS_LOCAL_RUN) {
        writeJwtProfile(testHome, { jwtToken });
      } else {
        writeSsoProfile(testHome);
        copySsoCredentials(testHome);
      }
      result = spawnSync(
        process.execPath,
        CI_IS_LOCAL_RUN
          ? [CLAUDE_BIN, '--task', 'Say the word READY and nothing else']
          : [CLAUDE_BIN, '--task', 'Say the word READY and nothing else', '--jwt-token', jwtToken],
        {
          cwd: testHome,
          env: { ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()), CODEMIE_HOME: testHome },
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

/**
 * Agent negative cases — TC-018, TC-019
 *
 * Run with: npm run test:integration:agent
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode
 *   false           — JWT mode
 *
 * TC-018: Invalid JWT token — exits non-zero with an auth error.
 *         JWT-only: tests the --jwt-token code path directly; skipped in SSO mode.
 * TC-019: No profile and no token — exits non-zero with a setup/config error.
 *         Dual-mode: an empty CODEMIE_HOME fails the same way in both auth modes.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writeJwtProfile,
  getTempDir,
  jwtCleanEnv,
  ssoCleanEnv,
  getTestEnvFlagOrDefault,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Agent negative cases', () => {
  // ── TC-018: Invalid JWT token ───────────────────────────────────────────────
  // Hardcoded invalid token — no fetchJwtToken() needed. JWT-only because the
  // --jwt-token flag and bearer-auth profile are JWT-specific concepts.
  describe.runIf(!CI_IS_LOCAL_RUN)(
    'TC-018 — invalid JWT token [JWT-only, skipped when CI_IS_LOCAL_RUN=true]',
    () => {
      let testHome: string;
      let result: ReturnType<typeof spawnSync>;

      beforeAll(() => {
        testHome = mkdtempSync(join(getTempDir(), 'codemie-jwt-invalid-'));
        writeJwtProfile(testHome, { jwtToken: 'INVALID_TOKEN_VALUE' });
        result = spawnSync(
          process.execPath,
          [CLAUDE_BIN, '--task', 'Say hello', '--jwt-token', 'INVALID_TOKEN_VALUE'],
          {
            cwd: testHome,
            env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome },
            encoding: 'utf-8',
            timeout: 60_000,
          },
        );
      }, 90_000);

      afterAll(() => rmSync(testHome, { recursive: true, force: true }));

      it('exits non-zero with an invalid JWT token', () => {
        expect(result.status).not.toBe(0);
      });

      it('shows an auth error message', () => {
        expect((result.stdout ?? '') + (result.stderr ?? '')).toMatch(
          /auth|unauthorized|401|invalid|token|malformed|empty.*response|API Error/i,
        );
      });
    },
  );

  // ── TC-019: No profile and no token ────────────────────────────────────────
  // Empty CODEMIE_HOME, no profile written, no token flag. Fails in both SSO
  // and JWT mode because the agent cannot find any auth configuration.
  describe('TC-019 — no profile and no token (negative)', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-no-config-'));
      // Write a config with no profiles so ConfigLoader finds a real file in
      // testHome and does not fall back to ~/.codemie (which has the
      // sso-autotest profile from globalSetup). Without this, the CLI would
      // attempt SSO re-auth via inquirer and crash without a TTY.
      mkdirSync(testHome, { recursive: true });
      writeFileSync(
        join(testHome, 'codemie-cli.config.json'),
        JSON.stringify({ version: 2, profiles: {} }),
        'utf-8',
      );
      result = spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--task', 'Say hello'],
        {
          cwd: testHome,
          env: { ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()), CODEMIE_HOME: testHome },
          encoding: 'utf-8',
          timeout: 30_000,
        },
      );
    }, 60_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits non-zero with empty CODEMIE_HOME and no auth', () => {
      expect(result.status).not.toBe(0);
    });

    it('shows a setup/configuration error message', () => {
      expect((result.stdout ?? '') + (result.stderr ?? '')).toMatch(
        /no profile|not configured|setup|profile/i,
      );
    });
  });
});

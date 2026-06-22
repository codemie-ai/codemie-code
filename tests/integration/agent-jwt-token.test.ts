/**
 * JWT token tests — TC-017, TC-027
 *
 * Run with: npm run test:integration:agent
 * Requires: CI_IS_LOCAL_RUN=false (JWT mode) + CI_CODEMIE_* env vars
 *
 * JWT-ONLY: these tests exercise CLI flag paths that are specific to the
 * --jwt-token mechanism. Skipped when CI_IS_LOCAL_RUN=true (SSO mode).
 *
 * TC-017: Config has two profiles — an SSO profile set as active and a JWT
 *         profile. Running with --profile <jwt-profile> --jwt-token <token>
 *         verifies that --profile overrides the active profile and --jwt-token
 *         overrides the auth, even when the active profile is SSO-configured.
 *
 * TC-027: --jwt-token passed with no pre-written profile and an empty
 *         CODEMIE_HOME. Verifies the agent authenticates and completes a
 *         --task using only the token supplied on the command line.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Write a config with two profiles:
 *   profile-sso-active  — SSO, set as the activeProfile
 *   profile-jwt-override — JWT bearer-auth, not active
 *
 * Used by TC-017 to verify that --profile + --jwt-token override both the
 * active profile selection and the auth method at runtime.
 */
function writeTwoProfileConfig(testHome: string): void {
  const ciCodemieUrl = (process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '');
  const authBase = (process.env.CI_CODEMIE_AUTH_URL ?? '').replace(/\/$/, '');
  const config = {
    version: 2,
    activeProfile: 'profile-sso-active',
    profiles: {
      'profile-sso-active': {
        name: 'profile-sso-active',
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
        baseUrl: `${ciCodemieUrl}/code-assistant-api`,
        apiKey: 'sso-authenticated',
        model: process.env.CI_CODEMIE_MODEL ?? 'claude-sonnet-4-6',
        timeout: 300,
        debug: false,
      },
      'profile-jwt-override': {
        name: 'profile-jwt-override',
        provider: 'bearer-auth',
        authMethod: 'jwt',
        codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
        baseUrl: `${ciCodemieUrl}/code-assistant-api`,
        model: process.env.CI_CODEMIE_MODEL ?? 'claude-sonnet-4-6',
        authServerUrl: authBase,
        authRealm: 'codemie-prod',
      },
    },
  };
  mkdirSync(testHome, { recursive: true });
  writeFileSync(join(testHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function getLatestSessionFile(sessionsDir: string): Record<string, unknown> {
  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(sessionsDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error('No session files found in ' + sessionsDir);
  return JSON.parse(readFileSync(files[0], 'utf-8'));
}

describe.runIf(!CI_IS_LOCAL_RUN)(
  'JWT token tests [JWT-only, skipped when CI_IS_LOCAL_RUN=true]',
  () => {
    let jwtToken: string;

    beforeAll(async () => {
      jwtToken = await fetchJwtToken();
    }, 30_000);

    // ── TC-017: --profile + --jwt-token override active SSO profile ────────────
    // Two profiles are written to the config with an SSO profile set as active.
    // Running with --profile profile-jwt-override --jwt-token <token> must use
    // the JWT profile, not the active SSO one, and authenticate via the token.
    describe('TC-017 — --profile and --jwt-token override active SSO profile', () => {
      let testHome: string;
      let result: ReturnType<typeof spawnSync>;

      beforeAll(() => {
        testHome = mkdtempSync(join(getTempDir(), 'codemie-jwt-override-'));
        writeTwoProfileConfig(testHome);
        result = spawnSync(
          process.execPath,
          [
            CLAUDE_BIN,
            '--profile', 'profile-jwt-override',
            '--jwt-token', jwtToken,
            '--task', 'Say READY',
          ],
          {
            cwd: testHome,
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

      it('session file records bearer-auth provider (not SSO)', () => {
        const session = getLatestSessionFile(join(testHome, 'sessions'));
        expect(String(session.provider ?? session.providerName ?? '')).toMatch(/bearer-auth/i);
      });
    });

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
  },
);

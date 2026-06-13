/**
 * Agent JWT Basic Tests — TC-016..TC-019, TC-031
 *
 * Run with: npm run test:integration:agent
 * Requires: INCLUDE_JWT_TESTS=true, CI_CODEMIE_* env vars
 *
 * TC-023 / TC-034 are covered by agent-task-session.test.ts.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchJwtToken, writeJwtProfile, getTempDir, jwtCleanEnv } from '../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

function getLatestSessionFile(sessionsDir: string): Record<string, unknown> {
  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(sessionsDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error('No session files found in ' + sessionsDir);
  return JSON.parse(readFileSync(files[0], 'utf-8'));
}

describe.runIf(INCLUDE_JWT_TESTS)('Agent — JWT basic (TC-016..TC-019, TC-031)', () => {
  let jwtToken: string;

  beforeAll(async () => {
    jwtToken = await fetchJwtToken();
  }, 30_000);

  // ── TC-016: Agent runs successfully with JWT token ──────────────────────────
  describe('TC-016 — agent runs with JWT token', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(),'codemie-jwt-basic-'));
      writeJwtProfile(testHome, { jwtToken });
      result = spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--task', 'Say the word READY and nothing else', '--jwt-token', jwtToken],
        { cwd: testHome, env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
    }, 180_000);
    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits 0 and prints agent output', () => {
      const agentOutput = (result.stdout ?? '') + (result.stderr ?? '');
      expect(result.status, `agent exited ${result.status}; output:\n${agentOutput}`).toBe(0);
      expect(result.stdout).toMatch(/READY/i);
    });

    it('writes a session file to CODEMIE_HOME/sessions/', () => {
      const sessionsDir = join(testHome, 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);
    });
  });

  // ── TC-017: Agent with profile + JWT override ───────────────────────────────
  describe('TC-017 — agent with profile and JWT token override', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(),'codemie-jwt-profile-'));
      writeJwtProfile(testHome, { profileName: 'jwt-autotest', jwtToken });
      result = spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { cwd: testHome, env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
    }, 180_000);
    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits 0 when using --profile + --jwt-token', () => {
      const agentOutput = (result.stdout ?? '') + (result.stderr ?? '');
      expect(result.status, `agent exited ${result.status}; output:\n${agentOutput}`).toBe(0);
    });

    it('session file shows bearer-auth provider', () => {
      const session = getLatestSessionFile(join(testHome, 'sessions'));
      expect(String(session.provider ?? session.providerName ?? '')).toMatch(/bearer-auth/i);
    });
  });

  // ── TC-018: Invalid JWT token (negative) ────────────────────────────────────
  describe('TC-018 — invalid JWT token (negative)', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(),'codemie-jwt-invalid-'));
      writeJwtProfile(testHome, { jwtToken: 'INVALID_TOKEN_VALUE' });
      result = spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--task', 'Say hello', '--jwt-token', 'INVALID_TOKEN_VALUE'],
        { cwd: testHome, env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 60_000 }
      );
    }, 90_000);
    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits non-zero with an invalid JWT token', () => {
      expect(result.status).not.toBe(0);
    });

    it('shows an error message indicating auth or bad response', () => {
      expect((result.stdout ?? '') + (result.stderr ?? '')).toMatch(/auth|unauthorized|401|invalid|token|malformed|empty.*response|API Error/i);
    });
  });

  // ── TC-019: No profile, no JWT (negative) ───────────────────────────────────
  describe('TC-019 — no profile and no JWT (negative)', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(),'codemie-jwt-none-'));
      result = spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--task', 'Say hello'],
        { env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 30_000 }
      );
    }, 60_000);
    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits non-zero with empty CODEMIE_HOME and no --jwt-token', () => {
      expect(result.status).not.toBe(0);
    });

    it('shows a setup/configuration error message', () => {
      expect((result.stdout ?? '') + (result.stderr ?? '')).toMatch(/no profile|not configured|setup|profile/i);
    });
  });

  // ── TC-031: Agent health check ──────────────────────────────────────────────
  describe('TC-031 — agent health check', () => {
    let testHome: string;
    let result: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(),'codemie-health-'));
      result = spawnSync(
        process.execPath,
        [CLAUDE_BIN, 'health'],
        { env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 15_000 }
      );
    }, 30_000);
    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('codemie-claude health exits 0', () => {
      expect(result.status).toBe(0);
    });

    it('output mentions install, binary, or health', () => {
      expect((result.stdout ?? '') + (result.stderr ?? '')).toMatch(/install|binary|health/i);
    });
  });
});

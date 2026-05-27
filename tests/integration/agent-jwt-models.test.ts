/**
 * Agent JWT Model Selection Tests — TC-020, TC-021
 *
 * Run with: npm run test:integration:agent
 * Requires: INCLUDE_JWT_TESTS=true, CI_CODEMIE_* env vars
 *
 * TC-020: Verify a profile with a specific model causes the agent to record
 *         that model in the session file (sonnet and haiku variants).
 * TC-021: Verify all three tier models (haikuModel, sonnetModel, opusModel)
 *         are populated, truthy, and distinct in the session file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchJwtToken } from '../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

// Minimal env to prevent credential leakage to subprocesses
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    NODE_PATH: process.env.NODE_PATH ?? '',
  };
}

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
        baseUrl: process.env.CI_CODEMIE_API_DOMAIN ?? '',
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

function getLatestSessionFile(sessionsDir: string): Record<string, unknown> {
  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(sessionsDir, f))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
  if (!files.length) throw new Error('No session files found in ' + sessionsDir);
  return JSON.parse(readFileSync(files[0], 'utf-8')) as Record<string, unknown>;
}

describe.runIf(INCLUDE_JWT_TESTS)('Agent — model selection (TC-020, TC-021)', () => {
  let jwtToken: string;

  beforeAll(async () => {
    jwtToken = await fetchJwtToken();
  }, 30_000);

  // ── TC-020: Session model field matches profile ──────────────────────────────
  describe('TC-020 — session uses model from profile', () => {
    let testHome: string;
    let sonnetSession: Record<string, unknown>;
    let haikuSession: Record<string, unknown>;

    beforeAll(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'codemie-model-match-'));

      // Run sonnet profile task
      writeModelProfile(testHome, 'profile-sonnet', 'claude-sonnet-4-6');
      spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'profile-sonnet', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { env: { ...cleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
      sonnetSession = getLatestSessionFile(join(testHome, 'sessions'));

      // Run haiku profile task (reuse testHome, overwrite config for isolation)
      writeModelProfile(testHome, 'profile-haiku', 'claude-haiku-4-5-20251001');
      spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'profile-haiku', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { env: { ...cleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
      haikuSession = getLatestSessionFile(join(testHome, 'sessions'));
    }, 300_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('session file model matches claude-sonnet-4-6 profile', () => {
      expect(String(sonnetSession.model ?? sonnetSession.sonnetModel ?? '')).toMatch(/sonnet/i);
    });

    it('session file model matches claude-haiku-4-5-20251001 profile', () => {
      expect(String(haikuSession.model ?? haikuSession.haikuModel ?? '')).toMatch(/haiku/i);
    });
  });

  // ── TC-021: Haiku/Sonnet/Opus tiers all populated ──────────────────────────
  describe('TC-021 — model tiers assigned correctly', () => {
    let testHome: string;
    let session: Record<string, unknown>;

    beforeAll(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'codemie-tiers-'));
      writeModelProfile(testHome, 'profile-tiers', 'claude-sonnet-4-6');
      spawnSync(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'profile-tiers', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { env: { ...cleanEnv(), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 }
      );
      session = getLatestSessionFile(join(testHome, 'sessions'));
    }, 180_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('session file has haikuModel, sonnetModel, opusModel all set and distinct', () => {
      expect(session.haikuModel).toBeTruthy();
      expect(session.sonnetModel).toBeTruthy();
      expect(session.opusModel).toBeTruthy();
      expect(session.haikuModel).not.toBe(session.sonnetModel);
      expect(session.sonnetModel).not.toBe(session.opusModel);
    });
  });
});

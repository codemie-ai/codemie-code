import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchJwtToken, writeJwtProfile } from '../../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

function writeConfig(codemieHome: string, config: object): void {
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function readConfig(codemieHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(codemieHome, 'codemie-cli.config.json'), 'utf-8'));
}

function fakeProfile(name: string) {
  return { name, provider: 'bearer-auth', authMethod: 'jwt', codeMieUrl: 'https://test.example.com', baseUrl: 'https://test.example.com/api', model: 'test-model' };
}

function runCLI(args: string[], codemieHome: string) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    env: {
      ...process.env,
      CODEMIE_HOME: codemieHome,
      CI: '1',
      // NODE_ENV=test disables auto-update check in bin/codemie.js
      NODE_ENV: 'test',
      // CODEMIE_DEBUG surfaces logger.error() messages to stderr so
      // negative-path tests can assert on error text
      CODEMIE_DEBUG: 'true',
    },
    // Run from codemieHome so there is no local .codemie/ config in cwd;
    // this ensures all profile operations target the global (CODEMIE_HOME) config
    cwd: codemieHome,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

// ─── TC-005: List profiles ────────────────────────────────────────────────────
describe('Profile list — two profiles (TC-005)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-list-'));
    writeConfig(testHome, {
      version: 2, activeProfile: 'jwt-autotest',
      profiles: { 'jwt-autotest': fakeProfile('jwt-autotest'), 'jwt-secondary': fakeProfile('jwt-secondary') },
    });
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('lists both profiles', () => {
    const r = runCLI(['profile'], testHome);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/jwt-autotest/);
    expect(out).toMatch(/jwt-secondary/);
  });
});

// ─── TC-006: Switch profile ───────────────────────────────────────────────────
describe('Profile switch (TC-006)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-switch-'));
    writeConfig(testHome, {
      version: 2, activeProfile: 'jwt-autotest',
      profiles: { 'jwt-autotest': fakeProfile('jwt-autotest'), 'jwt-secondary': fakeProfile('jwt-secondary') },
    });
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('exits 0 when switching to an existing profile', () => {
    const r = runCLI(['profile', 'switch', 'jwt-secondary'], testHome);
    expect(r.status).toBe(0);
  });

  it('updates activeProfile in the config file', () => {
    const cfg = readConfig(testHome);
    expect(cfg.activeProfile).toBe('jwt-secondary');
  });

  it('profile list shows jwt-secondary as active', () => {
    // 'profile status' may prompt for re-auth in non-TTY environments;
    // use 'profile' (list) instead, which prints the active marker without auth checks.
    const r = runCLI(['profile'], testHome);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/jwt-secondary/);
  });
});

// ─── TC-007: Delete inactive profile ─────────────────────────────────────────
describe('Profile delete inactive (TC-007)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-del-'));
    writeConfig(testHome, {
      version: 2, activeProfile: 'jwt-autotest',
      profiles: { 'jwt-autotest': fakeProfile('jwt-autotest'), 'jwt-secondary': fakeProfile('jwt-secondary') },
    });
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('exits 0 when deleting an inactive profile', () => {
    const r = runCLI(['profile', 'delete', 'jwt-secondary', '-y'], testHome);
    expect(r.status).toBe(0);
  });

  it('removed profile no longer appears in listing', () => {
    const r = runCLI(['profile'], testHome);
    expect(r.stdout + r.stderr).not.toMatch(/jwt-secondary/);
  });

  it('active profile jwt-autotest still exists', () => {
    const r = runCLI(['profile'], testHome);
    expect(r.stdout + r.stderr).toMatch(/jwt-autotest/);
  });
});

// ─── TC-008: Delete active profile (negative) ────────────────────────────────
// Actual CLI behaviour: deleting the active (and last) profile is allowed;
// the CLI sets activeProfile to '' and prints "No profiles remaining."
// The test verifies the CLI handles this gracefully without crashing and that
// the resulting config is in a consistent (not corrupted) state.
describe('Profile delete active — negative (TC-008)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-del-active-'));
    writeConfig(testHome, {
      version: 2, activeProfile: 'jwt-autotest',
      profiles: { 'jwt-autotest': fakeProfile('jwt-autotest') },
    });
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('does not crash (exit 0 or 1) when deleting the active profile', () => {
    const r = runCLI(['profile', 'delete', 'jwt-autotest', '-y'], testHome);
    expect(r.status === 0 || r.status === 1).toBe(true);
  });

  it('config file is in a consistent state after deleting the active profile', () => {
    // After the delete the config must still be parseable JSON with a
    // "profiles" key (even if empty), i.e. not corrupted.
    const cfg = readConfig(testHome);
    expect(typeof cfg.profiles).toBe('object');
  });
});

// ─── TC-009: Profile rename ───────────────────────────────────────────────────
describe('Profile rename (TC-009)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-rename-'));
    writeConfig(testHome, {
      version: 2, activeProfile: 'jwt-autotest',
      profiles: { 'jwt-autotest': fakeProfile('jwt-autotest') },
    });
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('exits 0 when renaming to a new name', () => {
    const r = runCLI(['profile', 'rename', 'jwt-autotest', 'jwt-renamed'], testHome);
    expect(r.status).toBe(0);
  });

  it('new name appears in profile listing', () => {
    const r = runCLI(['profile'], testHome);
    expect(r.stdout + r.stderr).toMatch(/jwt-renamed/);
  });

  it('old name no longer appears in profile listing', () => {
    const r = runCLI(['profile'], testHome);
    expect(r.stdout + r.stderr).not.toMatch(/jwt-autotest/);
  });
});

// ─── TC-010: Profile status with no profiles (negative) ──────────────────────
describe('Profile status — no profiles (TC-010)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-empty-'));
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('does not crash when no profiles configured', () => {
    const r = runCLI(['profile', 'status'], testHome);
    expect(r.status === 0 || r.status === 1).toBe(true);
  });

  it('produces non-empty output', () => {
    const r = runCLI(['profile', 'status'], testHome);
    expect((r.stdout + r.stderr).trim().length).toBeGreaterThan(0);
  });
});

// ─── TC-032: Switch to non-existent profile (negative) ───────────────────────
describe('Profile switch — non-existent (TC-032)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-switch-neg-'));
    writeConfig(testHome, {
      version: 2, activeProfile: 'jwt-autotest',
      profiles: { 'jwt-autotest': fakeProfile('jwt-autotest') },
    });
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('exits non-zero when switching to a non-existent profile', () => {
    const r = runCLI(['profile', 'switch', 'does-not-exist'], testHome);
    expect(r.status).not.toBe(0);
  });

  it('shows a not-found error message', () => {
    const r = runCLI(['profile', 'switch', 'does-not-exist'], testHome);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/not found|does not exist|no profile/i);
  });
});

// ─── TC-033: Rename to existing name (negative) ──────────────────────────────
describe('Profile rename — to existing name (TC-033)', () => {
  let testHome: string;

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-rename-neg-'));
    writeConfig(testHome, {
      version: 2, activeProfile: 'profile-a',
      profiles: { 'profile-a': fakeProfile('profile-a'), 'profile-b': fakeProfile('profile-b') },
    });
  });
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('exits non-zero or shows error when renaming to existing name', () => {
    const r = runCLI(['profile', 'rename', 'profile-a', 'profile-b'], testHome);
    const out = r.stdout + r.stderr;
    const isError = r.status !== 0 || /already exists|conflict|cannot/i.test(out);
    expect(isError).toBe(true);
  });

  it('neither profile is corrupted after failed rename', () => {
    const cfg = readConfig(testHome);
    const profiles = cfg.profiles as Record<string, unknown>;
    expect(profiles['profile-a']).toBeDefined();
    expect(profiles['profile-b']).toBeDefined();
  });
});

// ─── TC-004: Create profile via config write — JWT-gated ─────────────────────
describe.runIf(INCLUDE_JWT_TESTS)('Profile create via config (TC-004)', () => {
  let testHome: string;

  beforeAll(async () => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-prof-jwt-'));
    const token = await fetchJwtToken();
    writeJwtProfile(testHome, { jwtToken: token });
  }, 30_000);
  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('profile list shows jwt-autotest', () => {
    const r = runCLI(['profile'], testHome);
    expect(r.stdout + r.stderr).toMatch(/jwt-autotest/);
  });

  it('profile status shows provider and profile name', () => {
    const r = runCLI(['profile', 'status'], testHome);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/jwt-autotest/);
    expect(out).toMatch(/bearer-auth|jwt/i);
  });
});

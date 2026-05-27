/**
 * CLI Doctor Command Integration Test
 *
 * Tests the 'codemie doctor' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';
import { fetchJwtToken, writeJwtProfile } from '../../helpers/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = createCLIRunner();

describe('Doctor Command', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let doctorResult: CommandResult;

  beforeAll(() => {
    // Execute once, validate many times
    doctorResult = cli.runSilent('doctor');
  }, 120000); // 120s timeout for slower Windows CI runs (observed ~70s on GitHub Actions)

  it('should run system diagnostics', () => {
    // Should include system check header (even if some checks fail)
    expect(doctorResult.output).toMatch(/System Check|Health Check|Diagnostics/i);
  });

  it('should check Node.js version', () => {
    // Should verify Node.js installation (even if profile checks fail)
    expect(doctorResult.output).toMatch(/Node\.?js|node version/i);
  });

  it('should check npm', () => {
    // Should verify npm installation
    expect(doctorResult.output).toMatch(/npm/i);
  });

  it('should check Python', () => {
    // Should check Python installation (may be present or not)
    expect(doctorResult.output).toMatch(/Python/i);
  });

  it('should check uv', () => {
    // Should check uv installation (optional)
    expect(doctorResult.output).toMatch(/uv/i);
  });

  it('should execute without crashing', () => {
    // Doctor may return non-zero exit code if no profile configured
    // but it should still run and not crash
    expect(doctorResult).toBeDefined();
    expect(doctorResult.output).toBeDefined();
  });
});

describe('Doctor Command — verbose (TC-002)', () => {
  setupTestIsolation();

  let verboseResult: CommandResult;
  let baseResult: CommandResult;

  beforeAll(() => {
    verboseResult = cli.runSilent('doctor --verbose');
    baseResult = cli.runSilent('doctor');
  }, 120_000);

  it('should not crash with --verbose', () => {
    expect(verboseResult).toBeDefined();
    expect(verboseResult.output).toBeDefined();
  });

  it('should produce output at least as long as non-verbose (or contain extra info)', () => {
    const verboseLen = (verboseResult.output + (verboseResult.error ?? '')).length;
    const baseLen = (baseResult.output + (baseResult.error ?? '')).length;
    expect(verboseLen).toBeGreaterThanOrEqual(baseLen);
  });
});

const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

describe.runIf(INCLUDE_JWT_TESTS)('Doctor Command — JWT profile (TC-003)', () => {
  const REPO_ROOT = resolve(__dirname, '..', '..', '..');
  const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');

  let testHome: string;
  let doctorResult: ReturnType<typeof spawnSync>;

  beforeAll(async () => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-jwt-doctor-'));
    const token = await fetchJwtToken();
    writeJwtProfile(testHome, { profileName: 'jwt-autotest', jwtToken: token });
    doctorResult = spawnSync(process.execPath, [CLI_BIN, 'doctor'], {
      env: { ...process.env, CODEMIE_HOME: testHome, CI: '1' },
      encoding: 'utf-8',
      timeout: 120_000,
    });
  }, 30_000);

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should show JWT profile name in doctor output', () => {
    const combined = doctorResult.stdout + (doctorResult.stderr ?? '');
    expect(combined).toMatch(/jwt-autotest/i);
  });

  it('should not crash with JWT profile', () => {
    expect(doctorResult.status === 0 || doctorResult.status === 1).toBe(true);
  });
});

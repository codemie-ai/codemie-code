import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupAuthJson, cleanupConfigToml, setupAuthJson, setupConfigToml } from '../../src/agents/plugins/codex.plugin.js';

describe('Codex Configuration Merge', () => {
  let testDir: string;
  let authFile: string;
  let configFile: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `codex-test-${Date.now()}`);
    authFile = join(testDir, 'auth.json');
    configFile = join(testDir, 'config.toml');
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  // Test scenarios
  const scenarios = [
    {
      name: 'empty-config-session',
      description: 'empty → session → cleanup → empty'
    },
    {
      name: 'cleanup-after-session',
      description: 'pre-existing → session → cleanup → pre-existing'
    },
    {
      name: 'single-profile-add-ollama',
      description: 'single profile → session → cleanup → single profile'
    },
    {
      name: 'multi-profile-add-ollama',
      description: 'multi profile → session → cleanup → multi profile'
    }
  ];

  scenarios.forEach(({ name, description }) => {
    it(`${name}: ${description}`, async () => {
      // Step 1: Load fixtures
      const fixturesDir = join(import.meta.dirname, 'fixtures', 'codex', name);
      const inputAuth = await readFile(join(fixturesDir, 'input-auth.json'), 'utf-8');
      const inputConfig = await readFile(join(fixturesDir, 'input-config.toml'), 'utf-8');
      const expectedAuth = await readFile(join(fixturesDir, 'expected-auth.json'), 'utf-8');
      const expectedConfig = await readFile(join(fixturesDir, 'expected-config.toml'), 'utf-8');

      // Step 2: Copy input to tmp
      await writeFile(authFile, inputAuth);
      await writeFile(configFile, inputConfig);

      // Step 3: Run codex setup logic
      const sessionEnv = {
        OPENAI_MODEL: 'qwen3-vl:235b-cloud',
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_API_KEY: 'not-required',
        CODEMIE_PROVIDER: 'ollama'
      };

      await setupAuthJson(authFile, sessionEnv);
      await setupConfigToml(configFile, sessionEnv);

      // Step 4: Compare with expected (after session start)
      const afterSetupAuth = await readFile(authFile, 'utf-8');
      const afterSetupConfig = await readFile(configFile, 'utf-8');

      // Compare auth (exact match for JSON structure)
      expect(JSON.parse(afterSetupAuth)).toEqual(JSON.parse(expectedAuth));

      // Compare config (session ID and profile name are dynamic, check structure matches expected pattern)
      expect(afterSetupConfig).toMatch(/# --- CODEMIE SESSION START: ollama-\d+ ---/);
      expect(afterSetupConfig).toMatch(/\[profiles\.ollama-\d+\]/); // Unique profile per session
      expect(afterSetupConfig).toMatch(/profile = "ollama-\d+"/); // Profile reference matches session ID

      // Step 5: Run cleanup logic
      await cleanupAuthJson(authFile, sessionEnv, configFile);
      await cleanupConfigToml(configFile, sessionEnv);

      // Step 6: Compare with original input (exact match)
      const afterCleanupAuth = await readFile(authFile, 'utf-8');
      const afterCleanupConfig = await readFile(configFile, 'utf-8');

      expect(afterCleanupAuth.trim()).toBe(inputAuth.trim());
      expect(afterCleanupConfig.trim()).toBe(inputConfig.trim());
    });
  });

  it('multiple-sessions: concurrent sessions with intermediate cleanup', async () => {
    // Step 1: Load fixtures
    const fixturesDir = join(import.meta.dirname, 'fixtures', 'codex', 'multiple-sessions');
    const inputAuth = await readFile(join(fixturesDir, 'input-auth.json'), 'utf-8');
    const inputConfig = await readFile(join(fixturesDir, 'input-config.toml'), 'utf-8');
    const expectedIntermediateAuth = await readFile(join(fixturesDir, 'expected-intermediate-auth.json'), 'utf-8');
    const expectedIntermediateConfig = await readFile(join(fixturesDir, 'expected-intermediate-config.toml'), 'utf-8');
    const expectedAuth = await readFile(join(fixturesDir, 'expected-auth.json'), 'utf-8');
    const expectedConfig = await readFile(join(fixturesDir, 'expected-config.toml'), 'utf-8');
    const expectedAfterCleanup1Auth = await readFile(join(fixturesDir, 'expected-after-cleanup1-auth.json'), 'utf-8');
    const expectedAfterCleanup1Config = await readFile(join(fixturesDir, 'expected-after-cleanup1-config.toml'), 'utf-8');

    // Step 2: Copy input to tmp
    await writeFile(authFile, inputAuth);
    await writeFile(configFile, inputConfig);

    // Step 3: Start first session (ollama)
    const session1Env = {
      OPENAI_MODEL: 'qwen3-vl:235b-cloud',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_API_KEY: 'not-required',
      CODEMIE_PROVIDER: 'ollama'
    };

    await setupAuthJson(authFile, session1Env);
    await setupConfigToml(configFile, session1Env);

    // Step 4: Verify intermediate state (one session active)
    const afterSession1Auth = await readFile(authFile, 'utf-8');
    const afterSession1Config = await readFile(configFile, 'utf-8');

    expect(JSON.parse(afterSession1Auth)).toEqual(JSON.parse(expectedIntermediateAuth));
    expect(afterSession1Config).toMatch(/# --- CODEMIE SESSION START: ollama-\d+ ---/);

    // Step 5: Start second session (gemini)
    const session2Env = {
      OPENAI_MODEL: 'gemini-2.0-flash-exp',
      OPENAI_BASE_URL: 'http://localhost:8080/v1',
      OPENAI_API_KEY: 'not-required',
      CODEMIE_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'not-required',
      GOOGLE_GEMINI_BASE_URL: 'http://localhost:8080/v1'
    };

    await setupAuthJson(authFile, session2Env);
    await setupConfigToml(configFile, session2Env);

    // Step 6: Verify both sessions active
    const afterSession2Auth = await readFile(authFile, 'utf-8');
    const afterSession2Config = await readFile(configFile, 'utf-8');

    expect(JSON.parse(afterSession2Auth)).toEqual(JSON.parse(expectedAuth));
    expect(afterSession2Config).toMatch(/# --- CODEMIE SESSION START: ollama-\d+ ---/);
    expect(afterSession2Config).toMatch(/# --- CODEMIE SESSION START: gemini-\d+ ---/);

    // Step 7: Stop first session (ollama)
    await cleanupAuthJson(authFile, session1Env, configFile);
    await cleanupConfigToml(configFile, session1Env);

    // Step 8: Verify back to intermediate state (only gemini session active)
    const afterCleanup1Auth = await readFile(authFile, 'utf-8');
    const afterCleanup1Config = await readFile(configFile, 'utf-8');

    expect(JSON.parse(afterCleanup1Auth)).toEqual(JSON.parse(expectedAfterCleanup1Auth));
    expect(afterCleanup1Config).toMatch(/# --- CODEMIE SESSION START: gemini-\d+ ---/);

    // Step 9: Stop second session (gemini)
    await cleanupAuthJson(authFile, session2Env, configFile);
    await cleanupConfigToml(configFile, session2Env);

    // Step 10: Verify back to original input (exact match)
    const afterCleanup2Auth = await readFile(authFile, 'utf-8');
    const afterCleanup2Config = await readFile(configFile, 'utf-8');

    expect(afterCleanup2Auth.trim()).toBe(inputAuth.trim());
    expect(afterCleanup2Config.trim()).toBe(inputConfig.trim());
  });
});

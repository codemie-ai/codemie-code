import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupAuthJson, setupAuthJson } from '../../src/agents/plugins/codex.plugin.js';

/**
 * Test auth.json setup and cleanup (config.toml is now managed via CLI args only)
 */
describe('Codex Auth Configuration', () => {
  let testDir: string;
  let authFile: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `codex-test-${Date.now()}`);
    authFile = join(testDir, 'auth.json');
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should create auth.json with OPENAI_API_BASE', async () => {
    const env = {
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_API_KEY: 'not-required',
      CODEMIE_PROVIDER: 'ollama'
    };

    await setupAuthJson(authFile, env);

    const authContent = await readFile(authFile, 'utf-8');
    const authConfig = JSON.parse(authContent);

    expect(authConfig.OPENAI_API_KEY).toBe('not-required');
    expect(authConfig.OPENAI_API_BASE).toBe('http://localhost:11434/v1');
  });

  it('should cleanup auth.json on session end', async () => {
    // Setup
    const setupEnv = {
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_API_KEY: 'not-required',
      CODEMIE_PROVIDER: 'ollama'
    };
    await setupAuthJson(authFile, setupEnv);

    // Cleanup
    await cleanupAuthJson(authFile, setupEnv);

    const authContent = await readFile(authFile, 'utf-8');
    const authConfig = JSON.parse(authContent);

    // Should remove both keys
    expect(authConfig.OPENAI_API_KEY).toBeUndefined();
    expect(authConfig.OPENAI_API_BASE).toBeUndefined();
  });

  it('should handle Gemini provider', async () => {
    const env = {
      GEMINI_API_KEY: 'test-key',
      GOOGLE_GEMINI_BASE_URL: 'http://localhost:8080/v1',
      OPENAI_API_KEY: 'not-required',
      CODEMIE_PROVIDER: 'gemini'
    };

    await setupAuthJson(authFile, env);

    const authContent = await readFile(authFile, 'utf-8');
    const authConfig = JSON.parse(authContent);

    expect(authConfig.GEMINI_API_KEY).toBe('test-key');
    expect(authConfig.GOOGLE_GEMINI_BASE_URL).toBe('http://localhost:8080/v1');
    expect(authConfig.OPENAI_API_KEY).toBe('not-required');
  });

  it('should cleanup Gemini-specific vars', async () => {
    // Setup
    const setupEnv = {
      GEMINI_API_KEY: 'test-key',
      GOOGLE_GEMINI_BASE_URL: 'http://localhost:8080/v1',
      OPENAI_API_KEY: 'not-required',
      CODEMIE_PROVIDER: 'gemini'
    };
    await setupAuthJson(authFile, setupEnv);

    // Cleanup
    await cleanupAuthJson(authFile, setupEnv);

    const authContent = await readFile(authFile, 'utf-8');
    const authConfig = JSON.parse(authContent);

    // Should remove Gemini vars
    expect(authConfig.GEMINI_API_KEY).toBeUndefined();
    expect(authConfig.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    expect(authConfig.OPENAI_API_KEY).toBeUndefined();
  });
});

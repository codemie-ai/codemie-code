/**
 * VS Code Claude Code extension connector tests
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { ConfigurationError } from '@/utils/errors.js';
import { writeVsCodeClaudeCodeConfigAtPath } from '../vscode-claude-code.js';

describe('writeVsCodeClaudeCodeConfigAtPath', () => {
  let testDir: string;
  let productDir: string;
  let configPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'codemie-vscode-claude-code-'));
    productDir = join(testDir, 'Code');
    configPath = join(productDir, 'User', 'settings.json');
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
  }

  it('creates settings.json (and the User dir) from scratch when neither exists', async () => {
    const result = await writeVsCodeClaudeCodeConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      'gw-key-abc123'
    );

    expect(result).toEqual({ written: true, path: configPath });

    const settings = await readSettings();
    expect(settings['claudeCode.disableLoginPrompt']).toBe(true);
    expect(settings['claudeCode.environmentVariables']).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-abc123' },
    ]);
  });

  it('preserves unrelated existing top-level keys and env var entries', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          'editor.fontSize': 14,
          'claudeCode.environmentVariables': [{ name: 'MY_CUSTOM_VAR', value: 'keep-me' }],
        },
        null,
        2
      )
    );

    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123');

    const settings = await readSettings();
    expect(settings['editor.fontSize']).toBe(14);
    expect(settings['claudeCode.disableLoginPrompt']).toBe(true);
    expect(settings['claudeCode.environmentVariables']).toEqual([
      { name: 'MY_CUSTOM_VAR', value: 'keep-me' },
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-abc123' },
    ]);
  });

  it('upserts the managed env vars in place on a second call, without duplicating entries', async () => {
    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123');
    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:5002', 'gw-key-xyz789');

    const settings = await readSettings();
    const envVars = settings['claudeCode.environmentVariables'] as Array<{
      name: string;
      value: string;
    }>;

    expect(envVars).toHaveLength(2);
    expect(envVars).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:5002' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-xyz789' },
    ]);
  });

  it('rejects invalid existing JSON with ConfigurationError and leaves the file unchanged', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    const invalidContent = '{ not valid json';
    await writeFile(configPath, invalidContent);

    await expect(
      writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123')
    ).rejects.toThrow(ConfigurationError);

    const rawAfter = await readFile(configPath, 'utf-8');
    expect(rawAfter).toBe(invalidContent);
  });

  it('never logs the raw gateway key value', async () => {
    const gatewayKey = 'super-secret-gateway-key-value-0123456789';
    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', gatewayKey);

    const allLoggedArgs = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ].flat();

    for (const arg of allLoggedArgs) {
      const serialized = JSON.stringify(arg);
      expect(serialized ?? '').not.toContain(gatewayKey);
    }
  });
});

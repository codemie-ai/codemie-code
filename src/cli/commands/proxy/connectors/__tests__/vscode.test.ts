/**
 * VS Code language model connector tests
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVsCodeLanguageModelsConfigAtPath } from '../vscode.js';

describe('writeVsCodeLanguageModelsConfigAtPath', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'codemie-vscode-models-'));
    configPath = join(testDir, 'User', 'chatLanguageModels.json');
    await mkdir(join(testDir, 'User'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function readProviders(): Promise<Array<Record<string, unknown>>> {
    return JSON.parse(await readFile(configPath, 'utf-8')) as Array<Record<string, unknown>>;
  }

  it('writes the selected profile model as the model ID', async () => {
    const result = await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      'gpt-profile-model'
    );

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;
    expect(result).toEqual({ configPath, requiresSecretConfiguration: true });
    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-profile-model',
        name: 'CodeMie Profile Model',
        url: 'http://127.0.0.1:4001/v1/chat/completions',
      }),
    ]);
  });

  it('updates the managed model and preserves unrelated configuration', async () => {
    const secretReference = '${input:chat.lm.secret.codemie}';
    await writeFile(configPath, JSON.stringify([
      {
        name: 'Other',
        vendor: 'customendpoint',
        models: [{ id: 'other-model', name: 'Other model' }],
      },
      {
        name: 'CodeMie',
        vendor: 'customendpoint',
        apiType: 'chat-completions',
        apiKey: secretReference,
        customProperty: 'preserved',
        settings: {
          'old-profile-model': { reasoningEffort: 'medium' },
          'custom-setting': { enabled: true },
        },
        models: [
          { id: 'old-profile-model', name: 'CodeMie Profile Model', stale: true },
          { id: 'user-managed-model', name: 'User model', custom: true },
        ],
      },
    ], null, 2), 'utf-8');

    const result = await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4010',
      'claude-profile-model'
    );

    const providers = await readProviders();
    const codemie = providers[1];
    expect(result.requiresSecretConfiguration).toBe(false);
    expect(providers[0]).toMatchObject({ name: 'Other' });
    expect(codemie).toMatchObject({
      name: 'CodeMie',
      apiKey: secretReference,
      customProperty: 'preserved',
      settings: { 'custom-setting': { enabled: true } },
    });
    expect(codemie.models).toEqual([
      expect.objectContaining({ id: 'claude-profile-model', name: 'CodeMie Profile Model' }),
      { id: 'user-managed-model', name: 'User model', custom: true },
    ]);
  });

  it('replaces the previous profile model when the selected profile changes', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      'first-profile-model'
    );
    const firstProviders = await readProviders();
    firstProviders[0].settings = {
      'first-profile-model': { reasoningEffort: 'high' },
      unrelated: { enabled: true },
    };
    await writeFile(configPath, JSON.stringify(firstProviders, null, 2), 'utf-8');

    await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      'second-profile-model'
    );

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('second-profile-model');
    expect(providers[0].settings).toEqual({ unrelated: { enabled: true } });
  });

  it.each([
    ['invalid JSON', '{invalid-json'],
    ['a non-array root', JSON.stringify({ name: 'CodeMie' })],
  ])('rejects %s without overwriting the file', async (_label, original) => {
    await writeFile(configPath, original, 'utf-8');

    await expect(writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      'profile-model'
    )).rejects.toThrow();

    expect(await readFile(configPath, 'utf-8')).toBe(original);
  });

  it('rejects an empty profile model before writing configuration', async () => {
    await expect(writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      '   '
    )).rejects.toThrow('requires a profile model');
  });
});

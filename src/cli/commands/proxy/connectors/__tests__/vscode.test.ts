/**
 * VS Code language model connector tests
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VS_CODE_SUPPORTED_MODELS, type VsCodeApiType } from '../vscode-models.js';
import { writeVsCodeLanguageModelsConfigAtPath } from '../vscode.js';

const EXPECTED_MODEL_IDS = [
  'claude-sonnet-4-5-20250929',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-5-2025-08-07',
  'gpt-5-mini-2025-08-07',
  'gpt-5-nano-2025-08-07',
  'gpt-5-2-2025-12-11',
  'gpt-5.4-2026-03-05',
  'gpt-5.5-2026-04-24',
  'gpt-5.6-luna-2026-07-09',
  'gpt-5.6-sol-2026-07-09',
  'gpt-5.6-terra-2026-07-09',
  'gemini-3-flash',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'claude-4-5-sonnet',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6-20260205',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
  'qwen.qwen3-coder-30b-a3b-v1',
  'qwen.qwen3-coder-480b-a35b-v1',
  'moonshotai.kimi-k2.5',
] as const;

function getApiPath(apiType: VsCodeApiType): string {
  if (apiType === 'responses') return '/v1/responses';
  if (apiType === 'messages') return '/v1/messages';
  return '/v1/chat/completions';
}

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

  it('writes the exact supported model allowlist under the CodeMie provider', async () => {
    const result = await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001'
    );

    const providers = await readProviders();
    const provider = providers[0];
    const models = provider.models as Array<Record<string, unknown>>;

    expect(result).toEqual({ configPath, requiresSecretConfiguration: true });
    expect(provider).toMatchObject({
      name: 'CodeMie',
      vendor: 'customendpoint',
      apiType: 'chat-completions',
    });
    expect(models.map(model => model.id)).toEqual(EXPECTED_MODEL_IDS);
    expect(models.map(model => model.name)).toEqual(EXPECTED_MODEL_IDS);
  });

  it('renders every catalog capability and endpoint without internal metadata', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;

    for (const definition of VS_CODE_SUPPORTED_MODELS) {
      const model = models.find(candidate => candidate.id === definition.id);
      const expected: Record<string, unknown> = {
        id: definition.id,
        name: definition.id,
        url: `http://127.0.0.1:4001${getApiPath(definition.apiType)}`,
        apiType: definition.apiType,
        toolCalling: true,
        vision: definition.vision,
      streaming: true,
      thinking: definition.thinking,
      maxInputTokens: definition.maxInputTokens,
      maxOutputTokens: definition.maxOutputTokens,
    };
      if (definition.zeroDataRetentionEnabled !== undefined) {
        expected.zeroDataRetentionEnabled = definition.zeroDataRetentionEnabled;
      }
      if (definition.adaptiveThinking) expected.adaptiveThinking = true;
      if (definition.modelOptions) expected.modelOptions = definition.modelOptions;
      if (definition.requestHeaders) expected.requestHeaders = definition.requestHeaders;
      if (definition.supportsReasoningEffort) {
        expected.supportsReasoningEffort = definition.supportsReasoningEffort;
      }
      if (definition.reasoningEffortFormat) {
        expected.reasoningEffortFormat = definition.reasoningEffortFormat;
      }

      expect(model).toEqual(expected);
    }
  });

  it('omits top_p for Claude 4.5 models that reject dual sampling parameters', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;
    const affectedIds = [
      'claude-sonnet-4-5-20250929',
      'claude-4-5-sonnet',
      'claude-haiku-4-5-20251001',
    ];

    for (const id of affectedIds) {
      expect(models.find(model => model.id === id)).toMatchObject({
        modelOptions: { top_p: null },
      });
    }
  });

  it('renders stateless Responses reasoning capabilities for GPT-5.5 and GPT-5.6', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;
    const expectedEfforts = new Map([
      ['gpt-5.5-2026-04-24', ['none', 'low', 'medium', 'high', 'xhigh']],
      ['gpt-5.6-luna-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-5.6-sol-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-5.6-terra-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ]);

    for (const [id, efforts] of expectedEfforts) {
      const model = models.find(candidate => candidate.id === id);
      expect(model).toMatchObject({
        apiType: 'responses',
        url: 'http://127.0.0.1:4001/v1/responses',
        zeroDataRetentionEnabled: true,
        thinking: true,
        supportsReasoningEffort: efforts,
        reasoningEffortFormat: 'responses',
      });
    }
  });

  it('requires every Responses catalog entry to enable stateless mode', () => {
    const responsesModels = VS_CODE_SUPPORTED_MODELS.filter(
      definition => definition.apiType === 'responses'
    );

    expect(responsesModels.length).toBeGreaterThan(0);
    for (const definition of responsesModels) {
      expect(definition.zeroDataRetentionEnabled).toBe(true);
    }
  });

  it('requires effort metadata for every thinking-enabled Responses entry', () => {
    const responsesModels = VS_CODE_SUPPORTED_MODELS.filter(
      definition => definition.apiType === 'responses' && definition.thinking
    );

    expect(responsesModels.length).toBeGreaterThan(0);
    for (const definition of responsesModels) {
      expect(definition.supportsReasoningEffort?.length).toBeGreaterThan(0);
      expect(definition.reasoningEffortFormat).toBe('responses');
    }
  });

  it('forces bearer authentication for Messages models only', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;

    for (const definition of VS_CODE_SUPPORTED_MODELS) {
      const model = models.find(candidate => candidate.id === definition.id);
      if (definition.apiType === 'messages') {
        expect(model?.requestHeaders).toEqual({
          Authorization: 'Bearer ${apiKey}',
        });
      } else {
        expect(model).not.toHaveProperty('requestHeaders');
      }
    }
  });

  it('overrides the CodeMie model catalog while preserving the secret and saved settings', async () => {
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
        apiType: 'messages',
        apiKey: secretReference,
        customProperty: 'preserved',
        settings: {
          'gpt-5.4-2026-03-05': { reasoningEffort: 'high' },
          'custom-setting': { enabled: true },
        },
        models: [
          { id: 'stale-catalog-model', name: 'Stale catalog model', stale: true },
          { id: 'user-managed-model', name: 'User model', custom: true },
        ],
      },
    ], null, 2), 'utf-8');

    const result = await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4010'
    );

    const providers = await readProviders();
    const codeMie = providers[1];
    const models = codeMie.models as Array<Record<string, unknown>>;

    expect(result.requiresSecretConfiguration).toBe(false);
    expect(providers[0]).toEqual({
      name: 'Other',
      vendor: 'customendpoint',
      models: [{ id: 'other-model', name: 'Other model' }],
    });
    expect(codeMie).toMatchObject({
      name: 'CodeMie',
      vendor: 'customendpoint',
      apiType: 'chat-completions',
      apiKey: secretReference,
      customProperty: 'preserved',
      settings: {
        'gpt-5.4-2026-03-05': { reasoningEffort: 'high' },
        'custom-setting': { enabled: true },
      },
    });
    expect(models.map(model => model.id)).toEqual(EXPECTED_MODEL_IDS);
    expect(models.some(model => model.id === 'user-managed-model')).toBe(false);
  });

  it('updates every managed endpoint without changing saved model settings', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001');
    const firstProviders = await readProviders();
    firstProviders[0].settings = {
      'claude-opus-4-8': { reasoningEffort: 'xhigh' },
    };
    await writeFile(configPath, JSON.stringify(firstProviders, null, 2), 'utf-8');

    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4010');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;
    expect(models.every(model => String(model.url).startsWith('http://127.0.0.1:4010/'))).toBe(true);
    expect(providers[0].settings).toEqual({
      'claude-opus-4-8': { reasoningEffort: 'xhigh' },
    });
  });

  it.each([
    ['invalid JSON', '{invalid-json'],
    ['a non-array root', JSON.stringify({ name: 'CodeMie' })],
  ])('rejects %s without overwriting the file', async (_label, original) => {
    await writeFile(configPath, original, 'utf-8');

    await expect(writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001'
    )).rejects.toThrow();

    expect(await readFile(configPath, 'utf-8')).toBe(original);
  });
});

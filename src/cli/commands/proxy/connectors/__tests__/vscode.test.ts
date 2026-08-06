/**
 * VS Code language model connector tests
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeVsCodeModelCatalog, type VsCodeCatalogModel } from '../vscode-model-catalog.js';
import { resolveVsCodeModelCatalog } from '../vscode-protocol-resolver.js';
import { writeVsCodeLanguageModelsConfigAtPath } from '../vscode.js';

const RAW_MODELS: VsCodeCatalogModel[] = [
  {
    base_name: 'gpt-4.1',
    deployment_name: 'gpt-4.1',
    label: 'GPT 4.1',
    enabled: true,
    multimodal: true,
    features: {
      streaming: true,
      tools: true,
      temperature: true,
      parallel_tool_calls: true,
      system_prompt: true,
      max_tokens: true,
    },
    max_input_tokens: 1000000,
    max_output_tokens: 30000,
  },
  {
    base_name: 'gpt-5.6-sol',
    deployment_name: 'gpt-5.6-sol-2026-07-09',
    label: 'GPT 5.6 Sol',
    enabled: true,
    multimodal: true,
    features: {
      streaming: true,
      tools: true,
      temperature: false,
      parallel_tool_calls: true,
      system_prompt: true,
      max_tokens: true,
      top_p: false,
    },
  },
  {
    base_name: 'claude-opus-4-8',
    deployment_name: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    enabled: true,
    multimodal: true,
    features: {
      streaming: true,
      tools: true,
      temperature: true,
      parallel_tool_calls: true,
      system_prompt: true,
      max_tokens: true,
    },
    max_output_tokens: 128000,
  },
];

const RESOLVED_MODELS = resolveVsCodeModelCatalog(
  normalizeVsCodeModelCatalog(RAW_MODELS).models
).models;

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

  it('writes resolved backend models with dynamic labels, capabilities, and routes', async () => {
    const result = await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      RESOLVED_MODELS
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
    expect(models).toEqual([
      {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        url: 'http://127.0.0.1:4001/v1/messages',
        apiType: 'messages',
        toolCalling: true,
        vision: true,
        streaming: true,
        thinking: true,
        adaptiveThinking: true,
        modelOptions: { top_p: null },
        requestHeaders: { Authorization: 'Bearer ${apiKey}' },
        supportsReasoningEffort: ['low', 'medium', 'high', 'xhigh', 'max'],
        maxInputTokens: 872000,
        maxOutputTokens: 128000,
      },
      {
        id: 'gpt-4.1',
        name: 'GPT 4.1',
        url: 'http://127.0.0.1:4001/v1/chat/completions',
        apiType: 'chat-completions',
        toolCalling: true,
        vision: true,
        streaming: true,
        thinking: false,
        maxInputTokens: 1000000,
        maxOutputTokens: 30000,
      },
      {
        id: 'gpt-5.6-sol-2026-07-09',
        name: 'GPT 5.6 Sol',
        url: 'http://127.0.0.1:4001/v1/responses',
        apiType: 'responses',
        toolCalling: true,
        vision: true,
        streaming: true,
        thinking: true,
        zeroDataRetentionEnabled: true,
        modelOptions: { temperature: null, top_p: null },
        supportsReasoningEffort: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        reasoningEffortFormat: 'responses',
        maxInputTokens: 922000,
        maxOutputTokens: 128000,
      },
    ]);
  });

  it('replaces only the managed catalog while preserving secrets and unrelated data', async () => {
    const secretReference = '${input:chat.lm.secret.codemie}';
    await writeFile(configPath, JSON.stringify([
      { name: 'Other', vendor: 'customendpoint', models: [{ id: 'other-model' }] },
      {
        name: 'CodeMie',
        vendor: 'customendpoint',
        apiKey: secretReference,
        customProperty: 'preserved',
        settings: { 'saved-model': { reasoningEffort: 'high' } },
        models: [{ id: 'stale-model' }],
      },
    ]), 'utf-8');

    const result = await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4010',
      RESOLVED_MODELS
    );
    const providers = await readProviders();

    expect(result.requiresSecretConfiguration).toBe(false);
    expect(providers[0]).toEqual({
      name: 'Other',
      vendor: 'customendpoint',
      models: [{ id: 'other-model' }],
    });
    expect(providers[1]).toMatchObject({
      apiKey: secretReference,
      customProperty: 'preserved',
      settings: { 'saved-model': { reasoningEffort: 'high' } },
    });
    expect((providers[1].models as Array<{ id: string }>).map(model => model.id)).toEqual([
      'claude-opus-4-8',
      'gpt-4.1',
      'gpt-5.6-sol-2026-07-09',
    ]);
  });

  it('refuses to replace a working configuration with an empty catalog', async () => {
    const original = JSON.stringify([{ name: 'CodeMie', models: [{ id: 'working' }] }]);
    await writeFile(configPath, original, 'utf-8');

    await expect(writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      []
    )).rejects.toThrow('empty model list');
    expect(await readFile(configPath, 'utf-8')).toBe(original);
  });

  it.each([
    ['invalid JSON', '{invalid-json'],
    ['a non-array root', JSON.stringify({ name: 'CodeMie' })],
  ])('rejects %s without overwriting the file', async (_label, original) => {
    await writeFile(configPath, original, 'utf-8');

    await expect(writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      RESOLVED_MODELS
    )).rejects.toThrow();
    expect(await readFile(configPath, 'utf-8')).toBe(original);
  });
});

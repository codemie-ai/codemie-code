/**
 * VS Code language model connector tests
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VS_CODE_CAPABILITY_TABLE, type VsCodeApiType } from '../vscode-models.js';
import { writeVsCodeLanguageModelsConfigAtPath } from '../vscode.js';
import { ConfigurationError } from '@/utils/errors.js';

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
  'claude-opus-5',
  'claude-haiku-4-5-20251001',
  'qwen.qwen3-coder-30b-a3b-v1',
  'qwen.qwen3-coder-480b-a35b-v1',
  'moonshotai.kimi-k2.5',
] as const;

// A sparse, non-EPAM-shaped tenant catalog — vendor-prefixed undated GPT id,
// version-first Claude naming, and github-copilot-* noise — authored fresh
// here, never the root sample file.
const NON_EPAM_TENANT_FIXTURE = [
  'openai.gpt-5.6-luna',
  'claude-4-6-sonnet',
  'github-copilot-gpt-5-mini',
  'github-copilot-claude-sonnet-4-5',
];

function getApiPath(apiType: VsCodeApiType): string {
  if (apiType === 'responses') return '/v1/responses';
  if (apiType === 'messages') return '/v1/messages';
  return '/v1/chat/completions';
}

const mkHeaders = (ct: string) => ({ get: (h: string) => h === 'content-type' ? ct : null });

function mockCatalog(ids: readonly string[]): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: mkHeaders('application/json'),
    json: async () => ids.map((id) => ({ base_name: id })),
  }) as unknown as typeof globalThis.fetch;
}

describe('writeVsCodeLanguageModelsConfigAtPath', () => {
  let testDir: string;
  let configPath: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'codemie-vscode-models-'));
    configPath = join(testDir, 'User', 'chatLanguageModels.json');
    await mkdir(join(testDir, 'User'));
    originalFetch = globalThis.fetch;
    mockCatalog(EXPECTED_MODEL_IDS);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(testDir, { recursive: true, force: true });
  });

  async function readProviders(): Promise<Array<Record<string, unknown>>> {
    return JSON.parse(await readFile(configPath, 'utf-8')) as Array<Record<string, unknown>>;
  }

  it('writes the exact supported model allowlist under the CodeMie provider', async () => {
    const result = await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      'gw-key'
    );

    const providers = await readProviders();
    const provider = providers[0];
    const models = provider.models as Array<Record<string, unknown>>;

    expect(result).toEqual({ configPath, requiresSecretConfiguration: true, modelCount: EXPECTED_MODEL_IDS.length });
    expect(provider).toMatchObject({
      name: 'CodeMie',
      vendor: 'customendpoint',
      apiType: 'chat-completions',
    });
    expect(models.map(model => model.id)).toEqual(EXPECTED_MODEL_IDS);
    expect(models.map(model => model.name)).toEqual(EXPECTED_MODEL_IDS);
  });

  it('renders every catalog capability and endpoint without internal metadata', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;

    VS_CODE_CAPABILITY_TABLE.forEach((entry, index) => {
      const tenantId = EXPECTED_MODEL_IDS[index];
      const model = models.find(candidate => candidate.id === tenantId);
      const expected: Record<string, unknown> = {
        id: tenantId,
        name: tenantId,
        url: `http://127.0.0.1:4001${getApiPath(entry.apiType)}`,
        apiType: entry.apiType,
        toolCalling: true,
        vision: entry.vision,
        streaming: true,
        thinking: entry.thinking,
        maxInputTokens: entry.maxInputTokens,
        maxOutputTokens: entry.maxOutputTokens,
      };
      if (entry.zeroDataRetentionEnabled !== undefined) {
        expected.zeroDataRetentionEnabled = entry.zeroDataRetentionEnabled;
      }
      if (entry.adaptiveThinking) expected.adaptiveThinking = true;
      if (entry.modelOptions) expected.modelOptions = entry.modelOptions;
      if (entry.requestHeaders) expected.requestHeaders = entry.requestHeaders;
      if (entry.supportsReasoningEffort) {
        expected.supportsReasoningEffort = entry.supportsReasoningEffort;
      }
      if (entry.reasoningEffortFormat) {
        expected.reasoningEffortFormat = entry.reasoningEffortFormat;
      }

      expect(model).toEqual(expected);
    });
  });

  it('omits top_p for Claude 4.5 models that reject dual sampling parameters', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

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
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

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
    const responsesModels = VS_CODE_CAPABILITY_TABLE.filter(
      entry => entry.apiType === 'responses'
    );

    expect(responsesModels.length).toBeGreaterThan(0);
    for (const entry of responsesModels) {
      expect(entry.zeroDataRetentionEnabled).toBe(true);
    }
  });

  it('requires effort metadata for every thinking-enabled Responses entry', () => {
    const responsesModels = VS_CODE_CAPABILITY_TABLE.filter(
      entry => entry.apiType === 'responses' && entry.thinking
    );

    expect(responsesModels.length).toBeGreaterThan(0);
    for (const entry of responsesModels) {
      expect(entry.supportsReasoningEffort?.length).toBeGreaterThan(0);
      expect(entry.reasoningEffortFormat).toBe('responses');
    }
  });

  it('forces bearer authentication for Messages models only', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;

    VS_CODE_CAPABILITY_TABLE.forEach((entry, index) => {
      const tenantId = EXPECTED_MODEL_IDS[index];
      const model = models.find(candidate => candidate.id === tenantId);
      if (entry.apiType === 'messages') {
        expect(model?.requestHeaders).toEqual({
          Authorization: 'Bearer ${apiKey}',
        });
      } else {
        expect(model).not.toHaveProperty('requestHeaders');
      }
    });
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
      'http://127.0.0.1:4010',
      'gw-key'
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
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');
    const firstProviders = await readProviders();
    firstProviders[0].settings = {
      'claude-opus-4-8': { reasoningEffort: 'xhigh' },
    };
    await writeFile(configPath, JSON.stringify(firstProviders, null, 2), 'utf-8');

    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4010', 'gw-key');

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
      'http://127.0.0.1:4001',
      'gw-key'
    )).rejects.toThrow();

    expect(await readFile(configPath, 'utf-8')).toBe(original);
  });

  describe('tenant-aware resolution against a non-EPAM-shaped catalog', () => {
    it('AC1: omits a capability-table family with no match in a sparse tenant catalog', async () => {
      mockCatalog(NON_EPAM_TENANT_FIXTURE);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models.some(model => model.id === 'gpt-4.1')).toBe(false);
    });

    it('AC2: writes the tenant id verbatim for a family matched under a different token order', async () => {
      mockCatalog(NON_EPAM_TENANT_FIXTURE);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      const entry = VS_CODE_CAPABILITY_TABLE.find(candidate => candidate.family === 'claude-sonnet-4-6');
      const model = models.find(candidate => candidate.id === 'claude-4-6-sonnet');

      expect(model).toMatchObject({
        id: 'claude-4-6-sonnet',
        name: 'claude-4-6-sonnet',
        apiType: entry?.apiType,
        vision: entry?.vision,
        thinking: entry?.thinking,
      });
    });

    it('AC3: resolves gpt-5.6-luna to the vendor-prefixed tenant id verbatim, not a canonical form', async () => {
      mockCatalog(NON_EPAM_TENANT_FIXTURE);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models.some(model => model.id === 'openai.gpt-5.6-luna')).toBe(true);
      expect(models.some(model => model.id === 'gpt-5.6-luna')).toBe(false);
    });

    it('AC4: never surfaces a github-copilot-* deployment even alongside a matching same-family entry', async () => {
      mockCatalog(NON_EPAM_TENANT_FIXTURE);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models.some(model => model.id === 'github-copilot-gpt-5-mini')).toBe(false);
      expect(models.some(model => model.id === 'github-copilot-claude-sonnet-4-5')).toBe(false);
    });

    it('AC5: rejects and writes no file when the tenant catalog matches nothing in the capability table', async () => {
      mockCatalog(['totally-unknown-model']);

      await expect(writeVsCodeLanguageModelsConfigAtPath(
        configPath,
        'http://127.0.0.1:4001',
        'gw-key'
      )).rejects.toThrow(ConfigurationError);

      expect(existsSync(configPath)).toBe(false);
    });
  });

  describe('profileModel pinning', () => {
    it('narrows to the single tenant model a profile-pinned canonical name resolves to', async () => {
      mockCatalog(NON_EPAM_TENANT_FIXTURE);

      const result = await writeVsCodeLanguageModelsConfigAtPath(
        configPath,
        'http://127.0.0.1:4001',
        'gw-key',
        'gpt-5.6-luna'
      );

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(result.modelCount).toBe(1);
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('openai.gpt-5.6-luna');
    });

    it('narrows correctly when the profile is already pinned to the tenant\'s exact id', async () => {
      mockCatalog(EXPECTED_MODEL_IDS);

      await writeVsCodeLanguageModelsConfigAtPath(
        configPath,
        'http://127.0.0.1:4001',
        'gw-key',
        'gpt-4.1-mini'
      );

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('gpt-4.1-mini');
    });

    it('falls back to the full tenant-resolved list when the pinned model matches no capability family', async () => {
      mockCatalog(EXPECTED_MODEL_IDS);

      const result = await writeVsCodeLanguageModelsConfigAtPath(
        configPath,
        'http://127.0.0.1:4001',
        'gw-key',
        'not-a-real-model'
      );

      expect(result.modelCount).toBe(EXPECTED_MODEL_IDS.length);
    });

    it('falls back to the full tenant-resolved list when no model is pinned', async () => {
      mockCatalog(EXPECTED_MODEL_IDS);

      const result = await writeVsCodeLanguageModelsConfigAtPath(
        configPath,
        'http://127.0.0.1:4001',
        'gw-key',
        undefined
      );

      expect(result.modelCount).toBe(EXPECTED_MODEL_IDS.length);
    });

    it('treats a blank pinned model the same as unset', async () => {
      mockCatalog(EXPECTED_MODEL_IDS);

      const result = await writeVsCodeLanguageModelsConfigAtPath(
        configPath,
        'http://127.0.0.1:4001',
        'gw-key',
        '   '
      );

      expect(result.modelCount).toBe(EXPECTED_MODEL_IDS.length);
    });
  });
});

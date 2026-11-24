/**
 * VS Code language model connector tests
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VS_CODE_CAPABILITY_TABLE, type VsCodeApiType } from '../vscode-models.js';
import {
  getVsCodeLanguageModelsPath,
  getVsCodeProductDir,
  readVsCodeByokGateway,
  removeFileThroughLink,
  writeAtomically,
  writeVsCodeLanguageModelsConfigAtPath,
} from '../vscode.js';
import { ClientNotInstalledError, ConfigurationError } from '@/utils/errors.js';
import { writeFileAtomic } from '@/utils/atomic-write.js';
import { logger } from '@/utils/logger.js';

vi.mock('@/utils/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/atomic-write.js')>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

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
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gemini-3-flash',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'claude-4-5-sonnet',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6-20260205',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-haiku-4-5-20251001',
  'claude-haiku-5-5',
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

/** A bare id string becomes `{ base_name: id }`; an object is served verbatim. */
type CatalogEntry = string | Record<string, unknown>;

function mockCatalog(entries: readonly CatalogEntry[]): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: mkHeaders('application/json'),
    json: async () => entries.map((entry) => typeof entry === 'string' ? { base_name: entry } : entry),
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

  it('renders stateless Responses reasoning capabilities for GPT-5.5, GPT-5.6 and GPT-6', async () => {
    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;
    const expectedEfforts = new Map([
      ['gpt-5.5-2026-04-24', ['none', 'low', 'medium', 'high', 'xhigh']],
      ['gpt-5.6-luna-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-5.6-sol-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-5.6-terra-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-6-astra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['gpt-6.1-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
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

  it('applies catalog token limits to both table and default entries', async () => {
    mockCatalog([
      { base_name: 'claude-4-5-sonnet', max_input_tokens: 200000 },
      { base_name: 'mistral-large-3', max_input_tokens: 922000 },
    ]);

    await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

    const providers = await readProviders();
    const models = providers[0].models as Array<Record<string, unknown>>;
    expect(models.find(m => m.id === 'claude-4-5-sonnet'))
      .toMatchObject({ maxInputTokens: 136000, maxOutputTokens: 64000 });
    expect(models.find(m => m.id === 'mistral-large-3'))
      .toMatchObject({ maxInputTokens: 913808, maxOutputTokens: 8192 });
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

    it('AC5: rejects and writes no file when the catalog has only github-copilot-* or disabled entries', async () => {
      mockCatalog(['github-copilot-gpt-5-mini', { base_name: 'gpt-6-sol', enabled: false }]);

      await expect(writeVsCodeLanguageModelsConfigAtPath(
        configPath,
        'http://127.0.0.1:4001',
        'gw-key'
      )).rejects.toThrow(ConfigurationError);

      expect(existsSync(configPath)).toBe(false);
    });

    it('lists a tenant model that matches no capability-table family', async () => {
      mockCatalog(['totally-unknown-model']);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models.map(model => model.id)).toEqual(['totally-unknown-model']);
    });
  });

  describe('full tenant catalog', () => {
    const GPT_6_SOL = { base_name: 'gpt-6-sol', label: 'GPT-6 Sol' };

    it('writes every enabled tenant model in catalog order, including table-backed GPT-6 models', async () => {
      mockCatalog(EXPECTED_MODEL_IDS);

      const result = await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(result.modelCount).toBe(EXPECTED_MODEL_IDS.length);
      expect(models.map(model => model.id)).toEqual(EXPECTED_MODEL_IDS);
      expect(models.find(model => model.id === 'gpt-6-sol')).toMatchObject({
        name: 'gpt-6-sol',
        apiType: 'responses',
        zeroDataRetentionEnabled: true,
        url: 'http://127.0.0.1:4001/v1/responses',
        maxInputTokens: 922000,
        maxOutputTokens: 128000,
      });
    });

    it('keeps catalog order when a GPT-6 model comes first', async () => {
      mockCatalog([GPT_6_SOL, 'claude-sonnet-5', 'gpt-4.1']);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models.map(model => model.id)).toEqual(['gpt-6-sol', 'claude-sonnet-5', 'gpt-4.1']);
    });

    it('rebuilds the list from the live catalog on every write, picking up new models', async () => {
      mockCatalog(EXPECTED_MODEL_IDS);
      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      mockCatalog([...EXPECTED_MODEL_IDS, 'claude-sonnet-6']);
      const result = await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(result.modelCount).toBe(EXPECTED_MODEL_IDS.length + 1);
      expect(models.map(model => model.id)).toContain('claude-sonnet-6');
    });

    it('omits an enabled: false entry', async () => {
      mockCatalog([...EXPECTED_MODEL_IDS, { base_name: 'gpt-6-luna', enabled: false }]);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models.map(model => model.id)).toEqual(EXPECTED_MODEL_IDS);
    });

    it('writes toolCalling: false for an unknown model the catalog marks without tools', async () => {
      mockCatalog([{ base_name: 'embed-only', features: { tools: false } }]);

      await writeVsCodeLanguageModelsConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

      const providers = await readProviders();
      const models = providers[0].models as Array<Record<string, unknown>>;
      expect(models[0]).toMatchObject({ id: 'embed-only', toolCalling: false, apiType: 'chat-completions' });
    });
  });
});

describe('readVsCodeByokGateway', () => {
  let home: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codemie-vscode-byok-reader-'));
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME']) vi.stubEnv(name, home);
    originalFetch = globalThis.fetch;
    mockCatalog(['gpt-4.1', 'claude-sonnet-5']);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function writeModels(text: string, insiders = false): Promise<void> {
    await mkdir(join(getVsCodeProductDir(insiders), 'User'), { recursive: true });
    await writeFile(join(getVsCodeProductDir(insiders), 'User', 'chatLanguageModels.json'), text);
  }

  const provider = (...urls: string[]) => JSON.stringify([{
    name: 'CodeMie',
    vendor: 'customendpoint',
    models: urls.map((url, index) => ({ id: `m${index}`, url })),
  }]);

  it('a missing product directory throws ClientNotInstalledError, still a ConfigurationError', () => {
    expect(() => getVsCodeLanguageModelsPath(true)).toThrow(ClientNotInstalledError);
    expect(() => getVsCodeLanguageModelsPath(true)).toThrow(ConfigurationError);
  });

  it('reads back the port its writer wrote, with no key', async () => {
    await mkdir(getVsCodeProductDir(false), { recursive: true });
    await writeVsCodeLanguageModelsConfigAtPath(getVsCodeLanguageModelsPath(false), 'http://127.0.0.1:52311', 'codemie-proxy');

    await expect(readVsCodeByokGateway(60122)).resolves.toEqual({ port: 52311 });
  });

  it('returns the first managed model port that differs from the daemon\'s', async () => {
    await writeModels(provider('http://127.0.0.1:60122/v1/chat/completions', 'http://127.0.0.1:4001/v1/responses'));

    await expect(readVsCodeByokGateway(60122)).resolves.toEqual({ port: 4001 });
  });

  it('reads the stable and the Insiders file each on its own', async () => {
    await writeModels(provider('http://127.0.0.1:4002/v1/messages'), true);

    await expect(readVsCodeByokGateway(60122, true)).resolves.toEqual({ port: 4002 });
    await expect(readVsCodeByokGateway(60122, false)).resolves.toBeNull();
  });

  it.each([
    ['a missing product directory', async () => undefined],
    ['an unparsable file', async () => writeModels('[{')],
    ['no managed provider', async () => writeModels(JSON.stringify([{ name: 'Other', vendor: 'customendpoint', models: [] }]))],
    ['a non-loopback URL', async () => writeModels(provider('https://models.example.com:4001/v1/chat/completions'))],
    // The remover keeps a provider with any non-loopback model, so it is not CodeMie's and not connected.
    ['mixed loopback and non-loopback URLs', async () => writeModels(provider('http://127.0.0.1:4001/v1/chat/completions', 'https://models.example.com/v1/chat/completions'))],
  ])('returns null for %s', async (_case, arrange) => {
    await arrange();

    await expect(readVsCodeByokGateway(60122)).resolves.toBeNull();
  });
});


describe('writeAtomically', () => {
  const originalPlatform = process.platform;
  let dir: string;
  let targetDir: string;
  let target: string;
  let link: string;
  const tempFiles = async (directory: string) => (await readdir(directory)).filter((name) => name.endsWith('.tmp'));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codemie-write-atomically-'));
    targetDir = join(dir, 'read-only');
    target = join(targetDir, 'settings.json');
    link = join(dir, 'settings.json');
    await mkdir(targetDir);
    await writeFile(target, 'old');
    vi.mocked(writeFileAtomic).mockClear();
    vi.mocked(rename).mockClear();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
    await chmod(targetDir, 0o755).catch(() => undefined);
    await chmod(target, 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  const readOnlyTarget = async () => {
    await chmod(target, 0o444);
    await chmod(targetDir, 0o555);
  };

  it.skipIf(process.platform === 'win32')('writes through a link and keeps it', async () => {
    await symlink(target, link);

    await writeAtomically(link, 'new');

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('new');
    expect(await tempFiles(dir)).toEqual([]);
    expect(await tempFiles(targetDir)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('replaces a link whose target cannot be written with a file, the target unchanged', async () => {
    if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
    await symlink(target, link);
    await readOnlyTarget();

    await writeAtomically(link, 'new');

    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, 'utf-8')).toBe('new');
    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await tempFiles(dir)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32').each(['EPERM', 'EROFS'])('replaces a link with a file when writing its target fails with %s', async (code) => {
    await symlink(target, link);
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(errnoError(code));

    await writeAtomically(link, 'new');

    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, 'utf-8')).toBe('new');
    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')('rethrows for a regular read-only file in a read-only directory', async () => {
    if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
    await readOnlyTarget();

    await expect(writeAtomically(target, 'new')).rejects.toMatchObject({ code: 'EACCES' });

    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rethrows any other failure on a link, the link kept', async () => {
    await symlink(target, link);
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(errnoError('ENOSPC'));

    await expect(writeAtomically(link, 'new')).rejects.toMatchObject({ code: 'ENOSPC' });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('win32: rethrows EPERM on a link, no fallback', async () => {
    await symlink(target, link);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(errnoError('EPERM'));

    await expect(writeAtomically(link, 'new')).rejects.toMatchObject({ code: 'EPERM' });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('a failed rename of the fallback removes its temp file and rethrows that error', async () => {
    await symlink(target, link);
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(errnoError('EROFS'));
    vi.mocked(rename).mockRejectedValueOnce(errnoError('EXDEV'));

    await expect(writeAtomically(link, 'new')).rejects.toMatchObject({ code: 'EXDEV' });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await tempFiles(dir)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('removeFileThroughLink', () => {
  let dir: string;
  let targetDir: string;
  let target: string;
  let link: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codemie-remove-through-link-'));
    targetDir = join(dir, 'dotfiles');
    target = join(targetDir, 'hooks.json');
    link = join(dir, 'hooks.json');
    await mkdir(targetDir);
    await writeFile(target, 'hooks');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes a regular file', async () => {
    await removeFileThroughLink(target);

    expect(existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('deletes the target of a link and the link', async () => {
    await symlink(target, link);

    await removeFileThroughLink(link);

    expect(existsSync(target)).toBe(false);
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('deletes the final file of a chain of links and the path', async () => {
    const middle = join(dir, 'middle.json');
    await symlink(target, middle);
    await symlink(middle, link);

    await removeFileThroughLink(link);

    expect(existsSync(target)).toBe(false);
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('removes the link with one warning when its target cannot be deleted', async () => {
    if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
    await symlink(target, link);
    await chmod(targetDir, 0o555);
    try {
      await removeFileThroughLink(link);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(target, 'utf-8')).toBe('hooks');
    } finally {
      await chmod(targetDir, 0o755);
    }
  });

  it.skipIf(process.platform === 'win32')('removes the link with one warning and keeps a target that is a FIFO', async () => {
    const fifo = join(targetDir, 'hooks.fifo');
    execFileSync('mkfifo', [fifo]);
    await symlink(fifo, link);

    await removeFileThroughLink(link);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(fifo)).isFIFO()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('removes the link with one warning and keeps a target that is a directory', async () => {
    await symlink(targetDir, link);

    await removeFileThroughLink(link);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf-8')).toBe('hooks');
  });
});

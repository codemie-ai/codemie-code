/**
 * Tests for the OpenCode 2.x config emission shape.
 *
 * The schema is selected by the version probe, so the three v2 branches are
 * unreachable on a 1.x host and nothing else in the suite covers them. Each
 * branch used to fail in a way a user cannot act on: Ollama declared no models
 * and silently resolved to another provider, Bedrock fell through to a v1-shaped
 * block whose `model:` reference had no provider behind it, and no branch pinned
 * `enabled_providers`, so an unresolvable reference was replaced by another
 * provider's default instead of failing.
 *
 * `CODEMIE_OPENCODE_CONFIG_VERSION=2` pins the schema so the assertions do not
 * depend on the binary installed on the machine running them. The live catalogue
 * is stubbed; everything else is real.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OpenCodeModelConfig } from '../opencode-model-configs.js';
import { ConfigurationError } from '../../../../utils/errors.js';

const getHooksPluginFileUrl = vi.fn(() => 'file:///tmp/codemie-hooks/shell-hooks.ts');
const getHooksV2PluginDirUrl = vi.fn(() => 'file:///tmp/codemie-hooks/shell-hooks-v2');
const cleanupHooksPlugin = vi.fn();
const cleanupHooksV2Plugin = vi.fn();

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn() }));
vi.mock('../opencode.incremental-sync.js', () => ({
  startOpenCodeIncrementalSync: vi.fn(),
  stopOpenCodeIncrementalSync: vi.fn(),
}));
vi.mock('../opencode.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode.paths.js')>()),
  getOpenCodeDbPath: () => '/data/opencode/opencode.db',
  resolveOpenCodeDbPath: vi.fn(async () => '/data/opencode/opencode.db'),
}));
vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl,
  cleanupHooksPlugin,
  getHooksV2PluginDirUrl,
  cleanupHooksV2Plugin,
}));
vi.mock('../opencode-dynamic-models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode-dynamic-models.js')>()),
  fetchDynamicModelConfigs: vi.fn(),
}));

const { fetchDynamicModelConfigs } = await import('../opencode-dynamic-models.js');
const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');

const V2_CHAT_PACKAGE = '@opencode/ai/providers/openai-compatible';
const V2_RESPONSES_PACKAGE = '@opencode/ai/providers/openai-compatible/responses';
const V2_PLUGIN_DIR_URL = 'file:///tmp/codemie-hooks/shell-hooks-v2';

const ORIGINAL_OVERRIDE = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;

function modelConfig(id: string, extra: Partial<OpenCodeModelConfig> = {}): OpenCodeModelConfig {
  return {
    id,
    name: id,
    displayName: id,
    family: 'test',
    tool_call: true,
    reasoning: false,
    attachment: false,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    knowledge: '2026-01-01',
    release_date: '2026-01-01',
    last_updated: '2026-01-01',
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 128000, output: 4096 },
    ...extra,
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    CODEMIE_SESSION_ID: 'codemie-uuid-1',
    CODEMIE_AGENT: 'opencode',
    CODEMIE_PROVIDER: 'ai-run-sso',
    CODEMIE_URL: 'https://sso.example.com',
    CODEMIE_CLI_VERSION: '9.9.9',
    CODEMIE_MODEL: 'claude-4-5-sonnet',
    CODEMIE_BASE_URL: 'http://localhost:1234',
  };
}

/** Run beforeRun and return the emitted v2 document. */
async function emitV2(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
}

function providerEntry(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const providers = config.providers as Record<string, Record<string, unknown>>;
  return providers[key];
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '2';
  vi.mocked(fetchDynamicModelConfigs).mockResolvedValue({
    'claude-4-5-sonnet': modelConfig('claude-4-5-sonnet'),
    'gpt-6-luna': modelConfig('gpt-6-luna', {
      limit: { context: 1050000, output: 128000 },
      use_responses_api: true,
    }),
  });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
  } else {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = ORIGINAL_OVERRIDE;
  }
});

describe('OpenCode v2 config emission — SSO/proxy', () => {
  it('emits the plural v2 schema and never the v1 provider key', async () => {
    const config = await emitV2(baseEnv());

    expect(config.providers).toBeDefined();
    // A leftover `provider` key would be normalized into `providers` and clash.
    expect(config.provider).toBeUndefined();
    expect(providerEntry(config, 'codemie-proxy').package).toBe(V2_CHAT_PACKAGE);
  });

  it('disables sharing and registers the v2 hooks payload as a directory', async () => {
    const config = await emitV2(baseEnv());

    expect(config.share).toBe('disabled');
    expect(config.plugins).toEqual([V2_PLUGIN_DIR_URL]);
    // v2 no longer reads OPENCODE_DISABLE_SHARE; the `share` key is the mechanism.
    expect(config.plugin).toBeUndefined();
  });

  it('pins the allowlist to the declared provider', async () => {
    const config = await emitV2(baseEnv());

    expect(config.enabled_providers).toEqual(['codemie-proxy']);
  });

  it('overrides the package only for Responses-API models', async () => {
    const config = await emitV2(baseEnv());
    const models = providerEntry(config, 'codemie-proxy').models as Record<string, Record<string, unknown>>;

    expect(models['gpt-6-luna'].package).toBe(V2_RESPONSES_PACKAGE);
    expect(models['claude-4-5-sonnet'].package).toBeUndefined();
    expect(models['gpt-6-luna'].limit).toEqual({ context: 1050000, output: 128000 });
  });

  it('selects the model as provider/model', async () => {
    const config = await emitV2(baseEnv());

    expect(config.model).toBe('codemie-proxy/claude-4-5-sonnet');
  });

  it.each([
    { tools: false, input: ['text'], output: ['text'] },
    { tools: true, input: ['text', 'image', 'audio'], output: ['text', 'audio'] },
  ])('F5-7 preserves capabilities in both model loops: %j', async capabilities => {
    const metadata = { tool_call: capabilities.tools, modalities: { input: capabilities.input, output: capabilities.output } };
    vi.mocked(fetchDynamicModelConfigs).mockResolvedValue({
      'claude-4-5-sonnet': modelConfig('claude-4-5-sonnet', metadata),
      'gpt-6-luna': modelConfig('gpt-6-luna', { ...metadata, use_responses_api: true }),
    });
    const config = await emitV2(baseEnv());
    const models = providerEntry(config, 'codemie-proxy').models as Record<string, Record<string, unknown>>;
    expect(models['claude-4-5-sonnet'].capabilities).toEqual(capabilities);
    expect(models['gpt-6-luna'].capabilities).toEqual(capabilities);
    expect(models['gpt-6-luna'].package).toBe(V2_RESPONSES_PACKAGE);

    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '1';
    const env = baseEnv();
    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
    const legacyConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
    const legacy = legacyConfig.provider as Record<string, { models: Record<string, Record<string, unknown>> }>;
    for (const model of [legacy['codemie-proxy'].models['claude-4-5-sonnet'], legacy.openai.models['gpt-6-luna']]) {
      expect(model.tool_call).toBe(capabilities.tools);
      expect(model.modalities).toEqual(metadata.modalities);
      expect(model).not.toHaveProperty('capabilities');
    }
  });

  it('preserves capabilities when either loop falls back to a missing model name', async () => {
    vi.mocked(fetchDynamicModelConfigs).mockResolvedValue({
      'claude-4-5-sonnet': modelConfig('claude-4-5-sonnet', { name: undefined, tool_call: false }),
      'gpt-6-luna': modelConfig('gpt-6-luna', { name: undefined, tool_call: false, use_responses_api: true }),
    });
    const config = await emitV2(baseEnv());
    const models = providerEntry(config, 'codemie-proxy').models as Record<string, Record<string, unknown>>;
    for (const id of ['claude-4-5-sonnet', 'gpt-6-luna']) {
      expect(models[id].name).toBe(id);
      expect(models[id].capabilities).toEqual({ tools: false, input: ['text'], output: ['text'] });
    }
  });
});

describe('OpenCode v2 config emission — selected model outside the catalogue', () => {
  // F5-6 replaced the warning-only policy with a strict pre-launch rejection.
  it('rejects a selected model absent from the emitted catalogue without inventing one', async () => {
    const env = { ...baseEnv(), CODEMIE_MODEL: 'claude-9-9-unlisted' };

    await expect(emitV2(env)).rejects.toBeInstanceOf(ConfigurationError);
    expect(env.CODEMIE_MODEL).toBe('claude-9-9-unlisted');
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(getHooksV2PluginDirUrl).not.toHaveBeenCalled();
  });

  it('stays quiet when the selected model is in the catalogue', async () => {
    await emitV2(baseEnv());
    await emitV2({ ...baseEnv(), CODEMIE_MODEL: 'gpt-6-luna' });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('OpenCode v2 config emission — Ollama', () => {
  it('emits an endpoint-only ollama provider without a models map', async () => {
    const env = { ...baseEnv(), CODEMIE_PROVIDER: 'ollama' };

    const config = await emitV2(env);
    const ollama = providerEntry(config, 'ollama');

    expect(ollama.package).toBe(V2_CHAT_PACKAGE);
    // OpenCode 2.x has no built-in ollama provider package and the
    // openai-compatible package cannot list models: inventory comes from the
    // bundled discovery plugin, which reads the baseURL declared below.
    expect(ollama.models).toBeUndefined();
    expect((ollama.settings as Record<string, unknown>).baseURL).toBe('http://localhost:1234/v1/');
    expect(config.enabled_providers).toEqual(['ollama']);
    expect(config.model).toBe('ollama/claude-4-5-sonnet');
  });

  it('pins the allowlist so a model-less provider fails instead of rerouting', async () => {
    const config = await emitV2({ ...baseEnv(), CODEMIE_PROVIDER: 'ollama' });

    // Without this key the unresolvable `ollama/<id>` reference is silently
    // replaced by another provider's default model.
    expect(config.enabled_providers).not.toContain('openai');
  });
});

describe('OpenCode v2 config emission — Bedrock', () => {
  const bedrockEnv = () => ({
    ...baseEnv(),
    CODEMIE_PROVIDER: 'bedrock',
    CODEMIE_MODEL: 'claude-sonnet-4-5',
    AWS_REGION: 'us-east-1',
  });

  it('emits a native v2 bedrock block instead of the v1 shape', async () => {
    const config = await emitV2(bedrockEnv());

    expect(config.provider).toBeUndefined();
    const bedrock = providerEntry(config, 'amazon-bedrock');
    expect(bedrock.package).toBe('@opencode/ai/providers/amazon-bedrock');
  });

  it('declares the region and resolves credentials through the AWS environment', async () => {
    const config = await emitV2(bedrockEnv());
    const settings = providerEntry(config, 'amazon-bedrock').settings as Record<string, unknown>;

    expect(settings.region).toBe('us-east-1');
    // Omitted on purpose: the v2 provider package falls back to the AWS default
    // credential chain, which the Bedrock provider plugin already configures.
    expect(settings.credentials).toBeUndefined();
    expect(settings.apiKey).toBeUndefined();
  });

  it('declares the selected model so the reference resolves', async () => {
    const config = await emitV2(bedrockEnv());
    const bedrock = providerEntry(config, 'amazon-bedrock');

    expect(config.model).toMatch(/^amazon-bedrock\/.+/);
    const modelKey = String(config.model).replace('amazon-bedrock/', '');
    expect(Object.keys(bedrock.models as Record<string, unknown>)).toEqual([modelKey]);
  });

  it('pins the allowlist to bedrock', async () => {
    const config = await emitV2(bedrockEnv());

    expect(config.enabled_providers).toEqual(['amazon-bedrock']);
  });

  it('falls back to CODEMIE_AWS_REGION when AWS_REGION is absent', async () => {
    const env = bedrockEnv();
    delete env.AWS_REGION;
    env.CODEMIE_AWS_REGION = 'eu-west-1';

    const config = await emitV2(env);
    const settings = providerEntry(config, 'amazon-bedrock').settings as Record<string, unknown>;

    expect(settings.region).toBe('eu-west-1');
  });
});

describe('OpenCode hooks payload selection', () => {
  it('creates only the directory payload on a v2 run', async () => {
    await emitV2(baseEnv());

    expect(getHooksV2PluginDirUrl).toHaveBeenCalledTimes(1);
    // v2 rejects single-file plugin targets, so writing the v1 payload here
    // produced a file that could never load.
    expect(getHooksPluginFileUrl).not.toHaveBeenCalled();
  });

  it('creates the v1 payload only on a v1 run', async () => {
    const previous = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '1';
    try {
      const env = baseEnv();
      await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;

      expect(config.plugin).toEqual(['file:///tmp/codemie-hooks/shell-hooks.ts']);
      expect(getHooksPluginFileUrl).toHaveBeenCalledTimes(1);
      expect(getHooksV2PluginDirUrl).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
      else process.env.CODEMIE_OPENCODE_CONFIG_VERSION = previous;
    }
  });
});

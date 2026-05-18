/**
 * Integration tests for the `--merge-providers` flag path in the
 * OpenCode plugin's `beforeRun` lifecycle hook.
 *
 * These tests validate that:
 * - When CODEMIE_MERGE_PROVIDERS is unset, behaviour is identical to today
 *   (CodeMie-only config in OPENCODE_CONFIG_CONTENT).
 * - When CODEMIE_MERGE_PROVIDERS=true and a user opencode config exists,
 *   the final config contains both CodeMie providers and user extras.
 * - A failure to read/parse user config never breaks the launch — the plugin
 *   falls back to the CodeMie-only config.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Mocks -----------------------------------------------------------

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setSessionId: vi.fn(),
    setProfileName: vi.fn(),
  },
}));

vi.mock('../../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    metadata: unknown;
    constructor(metadata: unknown) {
      this.metadata = metadata;
    }
  },
}));

vi.mock('../opencode-model-configs.js', () => ({
  getModelConfig: vi.fn(() => ({
    id: 'gpt-5-2-2025-12-11',
    name: 'gpt-5-2-2025-12-11',
    family: 'gpt-5',
    tool_call: true,
    reasoning: true,
  })),
  getChatCompletionsModelConfigs: vi.fn(() => ({
    'gpt-5-2-2025-12-11': { id: 'gpt-5-2-2025-12-11' },
  })),
  getResponsesApiModelConfigs: vi.fn(() => ({})),
}));

vi.mock('../opencode-dynamic-models.js', () => ({
  fetchDynamicModelConfigs: vi.fn(() =>
    Promise.resolve({
      'gpt-5-2-2025-12-11': {
        id: 'gpt-5-2-2025-12-11',
        name: 'gpt-5-2-2025-12-11',
        family: 'gpt-5',
        tool_call: true,
      },
    }),
  ),
}));

vi.mock('../../../core/session/ensure-session.js', () => ({
  ensureSessionFile: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl: vi.fn(() => 'file:///mock/codemie-hooks.js'),
  cleanupHooksPlugin: vi.fn(),
}));

vi.mock('../opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () {
    return { discoverSessions: vi.fn().mockResolvedValue([]) };
  }),
}));

vi.mock('../../../../providers/plugins/bedrock/bedrock.utils.js', () => ({
  toBedrockModelId: vi.fn((id: string) => id),
}));

// --- Dynamic import after mocks are registered ----------------------
const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');

// --- Helpers ---------------------------------------------------------

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CODEMIE_BASE_URL: 'http://localhost:9999',
    CODEMIE_MODEL: 'gpt-5-2-2025-12-11',
    CODEMIE_PROVIDER: 'ai-run-sso',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function parseGeneratedConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  expect(env.OPENCODE_CONFIG_CONTENT).toBeDefined();
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
}

// --- Tests -----------------------------------------------------------

describe('OpenCode plugin — --merge-providers integration', () => {
  const beforeRun = OpenCodePluginMetadata.lifecycle!.beforeRun!;

  let tmpDir: string;
  let userConfigPath: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'codemie-merge-int-'));
    // Point getOpenCodeConfigDir() at our tmp dir via XDG_CONFIG_HOME
    // NOTE: opencode.paths.ts uses join(XDG_CONFIG_HOME, 'opencode')
    const xdgRoot = join(tmpDir, 'xdg');
    const opencodeDir = join(xdgRoot, 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    userConfigPath = join(opencodeDir, 'config.json');
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgRoot;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('unset CODEMIE_MERGE_PROVIDERS → CodeMie-only config (regression)', async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: { anthropic: { options: { apiKey: 'should-not-appear' } } },
    }));

    const env = baseEnv();
    await beforeRun(env, {} as never);

    const cfg = parseGeneratedConfig(env);
    const providers = cfg.provider as Record<string, unknown>;
    expect(providers['codemie-proxy']).toBeDefined();
    expect(cfg.enabled_providers).toEqual(['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock']);
    // anthropic must NOT leak in when flag is off
    expect(providers.anthropic).toBeUndefined();
  });

  it('CODEMIE_MERGE_PROVIDERS=true + user config with anthropic → merged result', async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: {
        anthropic: { options: { apiKey: 'user-anthropic-key' } },
      },
      enabled_providers: ['anthropic'],
    }));

    const env = baseEnv({ CODEMIE_MERGE_PROVIDERS: 'true' });
    await beforeRun(env, {} as never);

    const cfg = parseGeneratedConfig(env);
    const providers = cfg.provider as Record<string, unknown>;
    expect(providers['codemie-proxy']).toBeDefined();
    expect(providers.anthropic).toEqual({ options: { apiKey: 'user-anthropic-key' } });
    expect('enabled_providers' in cfg).toBe(false);
  });

  it("CODEMIE_MERGE_PROVIDERS=true but no user config file → falls back to CodeMie-only config", async () => {
    // Don't create any user config file
    const env = baseEnv({ CODEMIE_MERGE_PROVIDERS: 'true' });
    await beforeRun(env, {} as never);

    const cfg = parseGeneratedConfig(env);
    const providers = cfg.provider as Record<string, unknown>;
    expect(providers['codemie-proxy']).toBeDefined();
    expect(Object.keys(providers)).toEqual(
      expect.arrayContaining(['codemie-proxy', 'ollama']),
    );
    // No user config means no merge occurred, so the original whitelist remains.
    expect(cfg.enabled_providers).toEqual(['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock']);
  });

  it("CODEMIE_MERGE_PROVIDERS=true with corrupt user config → falls back, does not throw", async () => {
    writeFileSync(userConfigPath, '{ not valid json');
    const env = baseEnv({ CODEMIE_MERGE_PROVIDERS: 'true' });
    await expect(beforeRun(env, {} as never)).resolves.toBeDefined();

    const cfg = parseGeneratedConfig(env);
    expect((cfg.provider as Record<string, unknown>)['codemie-proxy']).toBeDefined();
  });

  it("user's top-level model preserved on merge", async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5',
      provider: { anthropic: {} },
    }));

    const env = baseEnv({ CODEMIE_MERGE_PROVIDERS: 'true' });
    await beforeRun(env, {} as never);

    const cfg = parseGeneratedConfig(env);
    expect(cfg.model).toBe('anthropic/claude-sonnet-4-5');
    expect('enabled_providers' in cfg).toBe(false);
  });

  it("user's stale codemie-proxy models replaced with fresh CodeMie models", async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: {
        'codemie-proxy': {
          options: { baseURL: 'http://stale:1/', apiKey: 'stale' },
          models: { 'stale-model': {} },
        },
      },
    }));

    const env = baseEnv({ CODEMIE_MERGE_PROVIDERS: 'true' });
    await beforeRun(env, {} as never);

    const cfg = parseGeneratedConfig(env);
    const proxy = (cfg.provider as Record<string, { options: { baseURL: string }; models: Record<string, unknown> }>)['codemie-proxy'];
    // Must be the fresh CodeMie proxy (local proxy URL), not the stale user value
    expect(proxy.options.baseURL).toBe('http://localhost:9999/');
    // Must have freshly-fetched models only
    expect(proxy.models).toHaveProperty('gpt-5-2-2025-12-11');
    expect(proxy.models).not.toHaveProperty('stale-model');
    expect('enabled_providers' in cfg).toBe(false);
  });

  it('merge does not break the OPENCODE_CONFIG temp-file fallback for oversized configs', async () => {
    // Write a sizeable user config with many extra providers
    const hugeProviders: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      hugeProviders[`provider-${i}`] = {
        name: `P${i}`,
        options: { apiKey: 'x'.repeat(2000), baseURL: 'http://p/' },
      };
    }
    writeFileSync(userConfigPath, JSON.stringify({ provider: hugeProviders }));

    const env = baseEnv({ CODEMIE_MERGE_PROVIDERS: 'true' });
    await beforeRun(env, {} as never);

    // Either inline config or temp-file path env must be set; never both unset.
    const usedTempFile = !!env.OPENCODE_CONFIG && !env.OPENCODE_CONFIG_CONTENT;
    const usedInline = !!env.OPENCODE_CONFIG_CONTENT;
    expect(usedTempFile || usedInline).toBe(true);
  });
});

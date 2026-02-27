/**
 * Tests for reasoning param sanitization integration in CodeMie Code plugin.
 *
 * Covers beforeRun lifecycle hook: provider mapping, LiteLLM config,
 * plugin injection, and cleanup via onSessionEnd.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock BaseAgentAdapter to avoid dependency tree
vi.mock('../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    metadata: any;
    constructor(metadata: any) {
      this.metadata = metadata;
    }
  },
}));

// Mock binary resolution
vi.mock('../codemie-code-binary.js', () => ({
  resolveCodemieOpenCodeBinary: vi.fn(() => '/mock/bin/codemie'),
  getPlatformPackage: vi.fn(() => '@codemieai/codemie-opencode-darwin-arm64'),
}));

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
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

// Mock installGlobal / uninstallGlobal
vi.mock('../../../utils/processes.js', () => ({
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
}));

// Mock processEvent from hook.js
const { mockProcessEvent } = vi.hoisted(() => ({
  mockProcessEvent: vi.fn(),
}));
vi.mock('../../../cli/commands/hook.js', () => ({
  processEvent: mockProcessEvent,
}));

// Mock getCodemieHome from paths.js
vi.mock('../../../utils/paths.js', () => ({
  getCodemieHome: vi.fn(() => '/mock/.codemie'),
  getCodemiePath: vi.fn((...args: string[]) => `/mock/.codemie/${args.join('/')}`),
}));

// Mock codemie-code-hooks
const { mockGetHooksPluginFileUrl, mockCleanupHooksPlugin } = vi.hoisted(() => ({
  mockGetHooksPluginFileUrl: vi.fn(() => 'file:///mock/hooks-plugin.js'),
  mockCleanupHooksPlugin: vi.fn(),
}));
vi.mock('../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl: mockGetHooksPluginFileUrl,
  cleanupHooksPlugin: mockCleanupHooksPlugin,
}));

// Mock reasoning-sanitizer
const { mockGetReasoningSanitizerPluginUrl, mockCleanupReasoningSanitizer } = vi.hoisted(() => ({
  mockGetReasoningSanitizerPluginUrl: vi.fn(() => 'file:///mock/reasoning-sanitizer.ts'),
  mockCleanupReasoningSanitizer: vi.fn(),
}));
vi.mock('../reasoning-sanitizer/index.js', () => ({
  getReasoningSanitizerPluginUrl: mockGetReasoningSanitizerPluginUrl,
  cleanupReasoningSanitizerPlugin: mockCleanupReasoningSanitizer,
}));

// Mock OpenCodeSessionAdapter
const { mockDiscoverSessions } = vi.hoisted(() => ({
  mockDiscoverSessions: vi.fn(),
}));
vi.mock('../opencode/opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () {
    return { discoverSessions: mockDiscoverSessions };
  }),
}));

// Mock getModelConfig and getAllOpenCodeModelConfigs
vi.mock('../opencode/opencode-model-configs.js', () => ({
  getModelConfig: vi.fn(() => ({
    id: 'gpt-5-2-2025-12-11',
    name: 'gpt-5-2-2025-12-11',
    family: 'gpt-5',
    tool_call: true,
    reasoning: true,
  })),
  getAllOpenCodeModelConfigs: vi.fn(() => ({})),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');

/** Helper: create minimal env for beforeRun */
function createEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CODEMIE_BASE_URL: 'http://localhost:3000',
    CODEMIE_MODEL: 'gpt-5-2-2025-12-11',
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

/** Helper: parse OPENCODE_CONFIG_CONTENT from env into an object */
function parseConfig(env: NodeJS.ProcessEnv): Record<string, any> {
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
}

describe('CodeMie Code Plugin — Reasoning Sanitization Integration', () => {
  const beforeRun = CodeMieCodePluginMetadata.lifecycle!.beforeRun!;
  const onSessionEnd = CodeMieCodePluginMetadata.lifecycle!.onSessionEnd!;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscoverSessions.mockResolvedValue([]);
    mockProcessEvent.mockResolvedValue(undefined);
  });

  describe('Provider Mapping (model prefix in OPENCODE_CONFIG_CONTENT)', () => {
    it('litellm → model prefix litellm/', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'litellm', CODEMIE_API_KEY: 'test-key' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.model).toBe('litellm/gpt-5-2-2025-12-11');
    });

    it('ai-run-sso → model prefix codemie-proxy/', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'ai-run-sso' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.model).toBe('codemie-proxy/gpt-5-2-2025-12-11');
    });

    it('ollama → model prefix ollama/', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'ollama' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.model).toBe('ollama/gpt-5-2-2025-12-11');
    });

    it('bedrock → model prefix amazon-bedrock/', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'bedrock' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.model).toMatch(/^amazon-bedrock\//);
    });

    it('unknown provider → defaults to codemie-proxy/', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'some-unknown' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.model).toBe('codemie-proxy/gpt-5-2-2025-12-11');
    });
  });

  describe('LiteLLM Config', () => {
    it('includes litellm provider when CODEMIE_PROVIDER=litellm', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'litellm', CODEMIE_API_KEY: 'my-key' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.provider.litellm).toBeDefined();
      expect(config.provider.litellm.name).toBe('LiteLLM');
    });

    it('excludes litellm provider when CODEMIE_PROVIDER=ai-run-sso', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'ai-run-sso' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.provider.litellm).toBeUndefined();
    });

    it('passes API key from CODEMIE_API_KEY to litellm provider', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'litellm', CODEMIE_API_KEY: 'sk-secret' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.provider.litellm.options.apiKey).toBe('sk-secret');
    });

    it('uses not-required when CODEMIE_API_KEY is absent', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'litellm' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.provider.litellm.options.apiKey).toBe('not-required');
    });
  });

  describe('Plugin Injection', () => {
    it('injects reasoning-sanitizer plugin URL into config.plugin array', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'ai-run-sso' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.plugin).toContain('file:///mock/reasoning-sanitizer.ts');
    });

    it('calls getReasoningSanitizerPluginUrl during beforeRun', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'ai-run-sso' });
      await beforeRun(env, {} as any);

      expect(mockGetReasoningSanitizerPluginUrl).toHaveBeenCalled();
    });

    it('injects both hooks and reasoning-sanitizer plugins (length=2)', async () => {
      const env = createEnv({ CODEMIE_PROVIDER: 'ai-run-sso' });
      await beforeRun(env, {} as any);

      const config = parseConfig(env);
      expect(config.plugin).toHaveLength(2);
      expect(config.plugin).toContain('file:///mock/hooks-plugin.js');
      expect(config.plugin).toContain('file:///mock/reasoning-sanitizer.ts');
    });
  });

  describe('Cleanup — onSessionEnd', () => {
    it('calls cleanupReasoningSanitizerPlugin during onSessionEnd', async () => {
      const env = createEnv({
        CODEMIE_SESSION_ID: 'session-123',
      });

      await onSessionEnd(0, env);

      expect(mockCleanupReasoningSanitizer).toHaveBeenCalled();
    });

    it('calls cleanup even when processEvent throws', async () => {
      mockProcessEvent.mockRejectedValue(new Error('hook failed'));

      const env = createEnv({
        CODEMIE_SESSION_ID: 'session-123',
      });

      await onSessionEnd(1, env);

      expect(mockCleanupReasoningSanitizer).toHaveBeenCalled();
    });

    it('calls cleanup in finally block alongside hooks cleanup', async () => {
      const env = createEnv({
        CODEMIE_SESSION_ID: 'session-123',
      });

      await onSessionEnd(0, env);

      expect(mockCleanupHooksPlugin).toHaveBeenCalled();
      expect(mockCleanupReasoningSanitizer).toHaveBeenCalled();
    });
  });
});

/**
 * Tests for CodemieOpenCodePluginMetadata lifecycle hooks
 * (beforeRun, enrichArgs, onSessionEnd)
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock BaseAgentAdapter
vi.mock('../../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    metadata: any;
    constructor(metadata: any) {
      this.metadata = metadata;
    }
  },
}));

// Mock binary resolution
vi.mock('../codemie-opencode-binary.js', () => ({
  resolveCodemieOpenCodeBinary: vi.fn(() => '/mock/bin/codemie'),
}));

// Mock logger
vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock installGlobal
vi.mock('../../../../utils/processes.js', () => ({
  installGlobal: vi.fn(),
  detectGitBranch: vi.fn(() => Promise.resolve('main')),
}));

// Mock getModelConfig
vi.mock('../../opencode/opencode-model-configs.js', () => ({
  getModelConfig: vi.fn(() => ({
    id: 'gpt-5-2-2025-12-11',
    name: 'gpt-5-2-2025-12-11',
    displayName: 'GPT-5.2 (Dec 2025)',
    family: 'gpt-5',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    knowledge: '2025-06-01',
    release_date: '2025-12-11',
    last_updated: '2025-12-11',
    open_weights: false,
    cost: { input: 2.5, output: 10 },
    limit: { context: 1048576, output: 65536 },
  })),
}));

// Use vi.hoisted() so mock functions are available in hoisted vi.mock() factories
const { mockDiscoverSessions, mockProcessSession } = vi.hoisted(() => ({
  mockDiscoverSessions: vi.fn().mockResolvedValue([]),
  mockProcessSession: vi.fn().mockResolvedValue({ success: true, totalRecords: 0 }),
}));

// Mock OpenCodeSessionAdapter - must use function (not arrow) to support `new`
vi.mock('../../opencode/opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () {
    return {
      discoverSessions: mockDiscoverSessions,
      processSession: mockProcessSession,
    };
  }),
}));

// Mock SessionStore (dynamic import in ensureSessionFile)
vi.mock('../../../core/session/SessionStore.js', () => ({
  SessionStore: vi.fn(() => ({
    loadSession: vi.fn(() => Promise.resolve(null)),
    saveSession: vi.fn(() => Promise.resolve()),
  })),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { writeFileSync } = await import('fs');
const { logger } = await import('../../../../utils/logger.js');
const { getModelConfig } = await import('../../opencode/opencode-model-configs.js');
const { SessionStore } = await import('../../../core/session/SessionStore.js');
const { CodemieOpenCodePluginMetadata } = await import('../codemie-opencode.plugin.js');

const mockGetModelConfig = vi.mocked(getModelConfig);

const DEFAULT_MODEL_CONFIG = {
  id: 'gpt-5-2-2025-12-11',
  name: 'gpt-5-2-2025-12-11',
  displayName: 'GPT-5.2 (Dec 2025)',
  family: 'gpt-5',
  tool_call: true,
  reasoning: true,
  attachment: true,
  temperature: true,
  modalities: { input: ['text'], output: ['text'] },
  knowledge: '2025-06-01',
  release_date: '2025-12-11',
  last_updated: '2025-12-11',
  open_weights: false,
  cost: { input: 2.5, output: 10 },
  limit: { context: 1048576, output: 65536 },
};

type AgentConfig = { model?: string };

describe('CodemieOpenCodePluginMetadata lifecycle', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Reset mock return value to default (clearAllMocks doesn't reset implementations)
    mockGetModelConfig.mockReturnValue(DEFAULT_MODEL_CONFIG as any);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('beforeRun', () => {
    const beforeRun = CodemieOpenCodePluginMetadata.lifecycle!.beforeRun!;

    it('creates session file when CODEMIE_SESSION_ID present', async () => {
      const env: any = { CODEMIE_SESSION_ID: 'sess-123' };
      const config: AgentConfig = {};

      await beforeRun(env, config as any);

      const SessionStoreCtor = vi.mocked(SessionStore);
      expect(SessionStoreCtor).toHaveBeenCalled();
    });

    it('skips session file when no CODEMIE_SESSION_ID', async () => {
      const env: any = {};
      const config: AgentConfig = {};

      await beforeRun(env, config as any);

      const SessionStoreCtor = vi.mocked(SessionStore);
      expect(SessionStoreCtor).not.toHaveBeenCalled();
    });

    it('logs warning and continues when ensureSessionFile fails', async () => {
      vi.mocked(SessionStore).mockImplementationOnce(() => {
        throw new Error('session store error');
      });

      const env: any = { CODEMIE_SESSION_ID: 'sess-123' };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);

      // ensureSessionFile has its own try/catch that calls logger.warn
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create session file'),
        expect.anything()
      );
      // Should still return env (not throw)
      expect(result).toBeDefined();
    });

    it('returns env unchanged when no CODEMIE_BASE_URL', async () => {
      const env: any = {};
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);

      expect(result).toBe(env);
      expect(result.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('warns and returns env unchanged for invalid CODEMIE_BASE_URL', async () => {
      const env: any = { CODEMIE_BASE_URL: 'ftp://invalid' };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid CODEMIE_BASE_URL'),
        expect.anything()
      );
      expect(result.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('sets OPENCODE_CONFIG_CONTENT for valid http:// URL', async () => {
      const env: any = { CODEMIE_BASE_URL: 'http://localhost:8080' };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);

      expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined();
      const parsed = JSON.parse(result.OPENCODE_CONFIG_CONTENT!);
      expect(parsed.enabled_providers).toEqual(['codemie-proxy']);
      expect(parsed.provider['codemie-proxy']).toBeDefined();
    });

    it('sets OPENCODE_CONFIG_CONTENT for valid https:// URL', async () => {
      const env: any = { CODEMIE_BASE_URL: 'https://proxy.example.com' };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);

      expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined();
      const parsed = JSON.parse(result.OPENCODE_CONFIG_CONTENT!);
      expect(parsed.provider['codemie-proxy'].options.baseURL).toBe('https://proxy.example.com/');
    });

    it('uses CODEMIE_MODEL env var for model selection', async () => {
      const env: any = {
        CODEMIE_BASE_URL: 'http://localhost:8080',
        CODEMIE_MODEL: 'claude-opus-4-20250514',
      };
      const config: AgentConfig = {};

      await beforeRun(env, config as any);

      expect(mockGetModelConfig).toHaveBeenCalledWith('claude-opus-4-20250514');
    });

    it('falls back to config.model when no CODEMIE_MODEL', async () => {
      const env: any = { CODEMIE_BASE_URL: 'http://localhost:8080' };
      const config: AgentConfig = { model: 'custom-model' };

      await beforeRun(env, config as any);

      expect(mockGetModelConfig).toHaveBeenCalledWith('custom-model');
    });

    it('falls back to default gpt-5-2-2025-12-11 when no model specified', async () => {
      const env: any = { CODEMIE_BASE_URL: 'http://localhost:8080' };
      const config: AgentConfig = {};

      await beforeRun(env, config as any);

      expect(mockGetModelConfig).toHaveBeenCalledWith('gpt-5-2-2025-12-11');
    });

    it('generates valid config JSON with required fields', async () => {
      const env: any = { CODEMIE_BASE_URL: 'http://localhost:8080' };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);
      const parsed = JSON.parse(result.OPENCODE_CONFIG_CONTENT!);

      expect(parsed).toHaveProperty('enabled_providers');
      expect(parsed).toHaveProperty('provider.codemie-proxy');
      expect(parsed).toHaveProperty('defaults');
      expect(parsed.defaults.model).toContain('codemie-proxy/');
    });

    it('writes temp file when config exceeds 32KB', async () => {
      // Return config with large headers to exceed MAX_ENV_SIZE
      mockGetModelConfig.mockReturnValue({
        id: 'big-model',
        name: 'big-model',
        displayName: 'Big Model',
        family: 'big',
        tool_call: true,
        reasoning: true,
        attachment: true,
        temperature: true,
        modalities: { input: ['text'], output: ['text'] },
        knowledge: '2025-06-01',
        release_date: '2025-12-11',
        last_updated: '2025-12-11',
        open_weights: false,
        cost: { input: 2.5, output: 10 },
        limit: { context: 1048576, output: 65536 },
        providerOptions: {
          headers: { 'X-Large': 'x'.repeat(40000) },
        },
      } as any);

      const env: any = { CODEMIE_BASE_URL: 'http://localhost:8080' };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);

      expect(result.OPENCODE_CONFIG).toBeDefined();
      expect(result.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(writeFileSync).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeds env var limit'),
        expect.anything()
      );
    });

    it('strips displayName and providerOptions from model config in output', async () => {
      const env: any = { CODEMIE_BASE_URL: 'http://localhost:8080' };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);
      const parsed = JSON.parse(result.OPENCODE_CONFIG_CONTENT!);
      const modelConfig = Object.values(parsed.provider['codemie-proxy'].models)[0] as any;

      expect(modelConfig.displayName).toBeUndefined();
      expect(modelConfig.providerOptions).toBeUndefined();
    });

    it('uses CODEMIE_TIMEOUT when no providerOptions.timeout', async () => {
      const env: any = {
        CODEMIE_BASE_URL: 'http://localhost:8080',
        CODEMIE_TIMEOUT: '300',
      };
      const config: AgentConfig = {};

      const result = await beforeRun(env, config as any);
      const parsed = JSON.parse(result.OPENCODE_CONFIG_CONTENT!);

      expect(parsed.provider['codemie-proxy'].options.timeout).toBe(300000);
    });
  });

  describe('enrichArgs', () => {
    const enrichArgs = CodemieOpenCodePluginMetadata.lifecycle!.enrichArgs!;
    const config: AgentConfig = {};

    it('passes through known subcommands', () => {
      for (const sub of ['run', 'chat', 'config', 'init', 'help', 'version']) {
        const result = enrichArgs([sub, '--flag'], config as any);
        expect(result[0]).toBe(sub);
      }
    });

    it('transforms --task "fix bug" to ["run", "fix bug"]', () => {
      const result = enrichArgs(['--task', 'fix bug'], config as any);
      expect(result).toEqual(['run', 'fix bug']);
    });

    it('strips -m/--message when --task present', () => {
      const result = enrichArgs(['-m', 'hello', '--task', 'fix bug'], config as any);
      expect(result).not.toContain('-m');
      expect(result).not.toContain('hello');
      expect(result).toContain('fix bug');
    });

    it('returns empty array for empty args', () => {
      const result = enrichArgs([], config as any);
      expect(result).toEqual([]);
    });

    it('returns unchanged when --task is last arg (no value)', () => {
      const result = enrichArgs(['--task'], config as any);
      expect(result).toEqual(['--task']);
    });

    it('returns unchanged for unknown args without --task', () => {
      const result = enrichArgs(['--verbose', '--debug'], config as any);
      expect(result).toEqual(['--verbose', '--debug']);
    });

    it('preserves other args alongside --task transformation', () => {
      const result = enrichArgs(['--verbose', '--task', 'fix bug'], config as any);
      expect(result).toContain('run');
      expect(result).toContain('--verbose');
      expect(result).toContain('fix bug');
    });
  });

  describe('onSessionEnd', () => {
    const onSessionEnd = CodemieOpenCodePluginMetadata.lifecycle!.onSessionEnd!;

    it('skips when no CODEMIE_SESSION_ID', async () => {
      const env: any = {};

      await onSessionEnd(0, env);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('skipping')
      );
    });

    it('processes latest session and logs success with record count', async () => {
      mockDiscoverSessions.mockResolvedValue([
        { sessionId: 'oc-session', filePath: '/sessions/file.jsonl' },
      ]);
      mockProcessSession.mockResolvedValue({
        success: true,
        totalRecords: 42,
      });

      const env: any = {
        CODEMIE_SESSION_ID: 'test-sess-id',
        CODEMIE_BASE_URL: 'http://localhost:3000',
      };

      await onSessionEnd(0, env);

      expect(mockDiscoverSessions).toHaveBeenCalledWith({ maxAgeDays: 1 });
      expect(mockProcessSession).toHaveBeenCalledWith(
        '/sessions/file.jsonl',
        'test-sess-id',
        expect.objectContaining({ sessionId: 'test-sess-id' })
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('42 records')
      );
    });

    it('warns when no sessions discovered', async () => {
      mockDiscoverSessions.mockResolvedValue([]);

      const env: any = { CODEMIE_SESSION_ID: 'test-123' };

      await onSessionEnd(0, env);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No recent')
      );
    });

    it('warns on partial failures with failedProcessors list', async () => {
      mockDiscoverSessions.mockResolvedValue([
        { sessionId: 's1', filePath: '/path' },
      ]);
      mockProcessSession.mockResolvedValue({
        success: false,
        failedProcessors: ['tokenizer', 'cost-calculator'],
      });

      const env: any = { CODEMIE_SESSION_ID: 'test-123' };

      await onSessionEnd(0, env);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failures')
      );
    });

    it('logs error but does not throw on processing error', async () => {
      mockDiscoverSessions.mockRejectedValue(new Error('discover failed'));

      const env: any = { CODEMIE_SESSION_ID: 'test-123' };

      // Should not throw
      await onSessionEnd(0, env);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed')
      );
    });

    it('uses clientType codemie-opencode in context', async () => {
      mockDiscoverSessions.mockResolvedValue([
        { sessionId: 's1', filePath: '/path' },
      ]);
      mockProcessSession.mockResolvedValue({ success: true, totalRecords: 1 });

      const env: any = { CODEMIE_SESSION_ID: 'test-123' };

      await onSessionEnd(0, env);

      expect(mockProcessSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ clientType: 'codemie-opencode' })
      );
    });
  });
});

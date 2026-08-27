/**
 * Unit tests for provider core base classes and helpers:
 *  - base/BaseHealthCheck.ts
 *  - base/BaseModelProxy.ts
 *  - decorators.ts
 *  - default-agent-hooks.ts
 *
 * These pin the current on-disk contract. External systems (AgentRegistry,
 * logger, network) are mocked; concrete minimal subclasses exercise the
 * abstract bases without any real HTTP.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { BaseHealthCheck } from '../base/BaseHealthCheck.js';
import { BaseModelProxy } from '../base/BaseModelProxy.js';
import { registerProvider } from '../decorators.js';
import { defaultAgentHooks } from '../default-agent-hooks.js';
import { ProviderRegistry } from '../registry.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { ModelInfo, HealthCheckConfig, ProviderTemplate } from '../types.js';
import type { AgentConfig } from '../../../agents/core/types.js';

// --- Mocks for default-agent-hooks dynamic imports ---
const getAgentMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn()
}));

vi.mock('@/agents/registry.js', () => ({
  AgentRegistry: { getAgent: getAgentMock }
}));

vi.mock('@/utils/logger.js', () => ({
  logger: loggerMock
}));

// ---------------------------------------------------------------------------
// BaseHealthCheck
// ---------------------------------------------------------------------------

class TestHealthCheck extends BaseHealthCheck {
  public pingImpl: () => Promise<void> = async () => {};
  public versionImpl: () => Promise<string | undefined> = async () => '1.2.3';
  public modelsImpl: () => Promise<ModelInfo[]> = async () => [];

  constructor(config: HealthCheckConfig) {
    super(config);
  }

  protected async ping(): Promise<void> {
    return this.pingImpl();
  }
  protected async getVersion(): Promise<string | undefined> {
    return this.versionImpl();
  }
  protected async listModels(): Promise<ModelInfo[]> {
    return this.modelsImpl();
  }
}

function model(id: string): ModelInfo {
  return { id, name: id };
}

describe('BaseHealthCheck', () => {
  const baseConfig: HealthCheckConfig = { provider: 'test-provider', baseUrl: 'http://localhost:9' };

  it('supports() matches only the configured provider', () => {
    const hc = new TestHealthCheck(baseConfig);
    expect(hc.supports('test-provider')).toBe(true);
    expect(hc.supports('other')).toBe(false);
  });

  it('reports healthy with version and models on the happy path', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.modelsImpl = async () => [model('a'), model('b')];

    const result = await hc.check({} as CodeMieConfigOptions);

    expect(result.provider).toBe('test-provider');
    expect(result.status).toBe('healthy');
    expect(result.message).toBe('Provider is healthy with 2 model(s) available');
    expect(result.version).toBe('1.2.3');
    expect(result.models).toHaveLength(2);
    expect(result.details).toEqual([]);
    expect(result.remediation).toBeUndefined();
  });

  it('adds an ok detail when the configured model is available', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.modelsImpl = async () => [model('gpt-x'), model('gpt-y')];

    const result = await hc.check({ model: 'gpt-x' } as CodeMieConfigOptions);

    expect(result.status).toBe('healthy');
    expect(result.details).toEqual([
      { status: 'ok', message: "Model 'gpt-x' available" }
    ]);
  });

  it('adds a warning detail with a hint when the configured model is missing', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.modelsImpl = async () => [model('a'), model('b'), model('c'), model('d')];

    const result = await hc.check({ model: 'zzz' } as CodeMieConfigOptions);

    expect(result.status).toBe('healthy');
    expect(result.details).toHaveLength(1);
    const detail = result.details![0];
    expect(detail.status).toBe('warning');
    expect(detail.message).toBe("Model 'zzz' not found");
    // Only first 3 shown, with trailing ellipsis when more than 3 models
    expect(detail.hint).toBe('Available: a, b, c...');
  });

  it('omits the ellipsis in the hint when 3 or fewer models exist', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.modelsImpl = async () => [model('a'), model('b')];

    const result = await hc.check({ model: 'zzz' } as CodeMieConfigOptions);

    expect(result.details![0].hint).toBe('Available: a, b');
  });

  it('skips model validation details when no model is configured', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.modelsImpl = async () => [model('a')];

    const result = await hc.check({} as CodeMieConfigOptions);
    expect(result.details).toEqual([]);
  });

  it('reports unhealthy with remediation when no models are available', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.modelsImpl = async () => [];

    const result = await hc.check({ model: 'anything' } as CodeMieConfigOptions);

    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('No models available');
    expect(result.remediation).toBe('Install models via provider CLI or CodeMie models command');
    // model validation skipped because models.length === 0
    expect(result.details).toEqual([]);
  });

  it('treats a rejected listModels() as an empty model list (unhealthy)', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.modelsImpl = async () => {
      throw new Error('boom');
    };

    const result = await hc.check({} as CodeMieConfigOptions);
    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('No models available');
  });

  it('returns an unreachable result when ping() throws an Error', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.pingImpl = async () => {
      throw new Error('connection refused');
    };

    const result = await hc.check({} as CodeMieConfigOptions);
    expect(result.status).toBe('unreachable');
    expect(result.message).toBe('Provider is not reachable: connection refused');
    expect(result.remediation).toBe('Check if the provider is running and accessible');
    expect(result.models).toBeUndefined();
  });

  it('stringifies non-Error rejection values in the unreachable message', async () => {
    const hc = new TestHealthCheck(baseConfig);
    hc.pingImpl = async () => {
       
      throw 'plain-string-failure';
    };

    const result = await hc.check({} as CodeMieConfigOptions);
    expect(result.status).toBe('unreachable');
    expect(result.message).toBe('Provider is not reachable: plain-string-failure');
  });
});

// ---------------------------------------------------------------------------
// BaseModelProxy
// ---------------------------------------------------------------------------

class TestModelProxy extends BaseModelProxy {
  public models: ModelInfo[] = [];
  public listSpy = vi.fn(async () => this.models);

  supports(provider: string): boolean {
    return provider === 'test';
  }
  async listModels(): Promise<ModelInfo[]> {
    return this.listSpy();
  }
  async fetchModels(_config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    return this.models;
  }
}

describe('BaseModelProxy', () => {
  it('defaults supportsInstallation() to false', () => {
    const proxy = new TestModelProxy('http://localhost:1');
    expect(proxy.supportsInstallation()).toBe(false);
  });

  it('installModel() rejects as unsupported by default', async () => {
    const proxy = new TestModelProxy('http://localhost:1');
    await expect(proxy.installModel('m')).rejects.toThrow(
      'Model installation not supported by this provider'
    );
  });

  it('removeModel() rejects as unsupported by default', async () => {
    const proxy = new TestModelProxy('http://localhost:1');
    await expect(proxy.removeModel('m')).rejects.toThrow(
      'Model removal not supported by this provider'
    );
  });

  it('getModelInfo() returns the matching model by id via listModels()', async () => {
    const proxy = new TestModelProxy('http://localhost:1');
    proxy.models = [model('alpha'), model('beta')];

    const info = await proxy.getModelInfo('beta');
    expect(info).toEqual({ id: 'beta', name: 'beta' });
    expect(proxy.listSpy).toHaveBeenCalledTimes(1);
  });

  it('getModelInfo() returns null when the model id is absent', async () => {
    const proxy = new TestModelProxy('http://localhost:1');
    proxy.models = [model('alpha')];

    const info = await proxy.getModelInfo('missing');
    expect(info).toBeNull();
  });

  it('getModelInfo() delegates to listModels() on every call (no caching in base)', async () => {
    const proxy = new TestModelProxy('http://localhost:1');
    proxy.models = [model('alpha')];

    await proxy.getModelInfo('alpha');
    await proxy.getModelInfo('alpha');
    expect(proxy.listSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// decorators.registerProvider
// ---------------------------------------------------------------------------

function makeTemplate(name: string): ProviderTemplate {
  return {
    name,
    displayName: name,
    description: 'test template',
    defaultBaseUrl: 'http://localhost:0',
    recommendedModels: [],
    capabilities: [],
    supportsModelInstallation: false
  };
}

describe('registerProvider decorator', () => {
  afterEach(() => {
    ProviderRegistry.clear();
  });

  it('registers the template in the ProviderRegistry and returns it unchanged', () => {
    const template = makeTemplate('deco-provider');
    const returned = registerProvider(template);

    expect(returned).toBe(template);
    expect(ProviderRegistry.hasProvider('deco-provider')).toBe(true);
    expect(ProviderRegistry.getProvider('deco-provider')).toBe(template);
  });

  it('overwrites a prior registration with the same name (last wins)', () => {
    const first = makeTemplate('dup');
    const second = makeTemplate('dup');
    registerProvider(first);
    registerProvider(second);

    expect(ProviderRegistry.getProvider('dup')).toBe(second);
    expect(ProviderRegistry.getProviderNames()).toContain('dup');
  });
});

// ---------------------------------------------------------------------------
// defaultAgentHooks
// ---------------------------------------------------------------------------

describe('defaultAgentHooks', () => {
  beforeEach(() => {
    getAgentMock.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
  });

  const wildcard = defaultAgentHooks!['*'];
  const claudeHooks = defaultAgentHooks!['claude'];

  function runConfig(agent?: string): AgentConfig {
    return { agent } as AgentConfig;
  }

  it('exposes wildcard and claude hook buckets', () => {
    expect(typeof wildcard.beforeRun).toBe('function');
    expect(typeof claudeHooks.enrichArgs).toBe('function');
  });

  it('beforeRun returns env untouched when config.agent is missing', async () => {
    const env = { EXISTING: '1' } as NodeJS.ProcessEnv;
    const result = await wildcard.beforeRun!(env, runConfig(undefined));
    expect(result).toBe(env);
    expect(getAgentMock).not.toHaveBeenCalled();
  });

  it('beforeRun returns env untouched when the agent is not registered', async () => {
    getAgentMock.mockReturnValue(undefined);
    const env = {} as NodeJS.ProcessEnv;
    const result = await wildcard.beforeRun!(env, runConfig('claude'));
    expect(result).toBe(env);
    expect(getAgentMock).toHaveBeenCalledWith('claude');
  });

  it('beforeRun returns env untouched when the agent has no extension installer', async () => {
    getAgentMock.mockReturnValue({});
    const env = {} as NodeJS.ProcessEnv;
    const result = await wildcard.beforeRun!(env, runConfig('claude'));
    expect(result).toBe(env);
    expect(env.CODEMIE_CLAUDE_EXTENSION_DIR).toBeUndefined();
  });

  it('beforeRun sets the extension dir env var on successful install', async () => {
    const install = vi.fn(async () => ({ success: true, targetPath: '/tmp/ext-dir' }));
    getAgentMock.mockReturnValue({ getExtensionInstaller: () => ({ install }) });

    const env = {} as NodeJS.ProcessEnv;
    const result = await wildcard.beforeRun!(env, runConfig('claude'));

    expect(install).toHaveBeenCalledTimes(1);
    expect(result.CODEMIE_CLAUDE_EXTENSION_DIR).toBe('/tmp/ext-dir');
  });

  it('beforeRun logs a warning and leaves env unset when install reports failure', async () => {
    const install = vi.fn(async () => ({ success: false, targetPath: '/tmp/x', error: 'nope' }));
    getAgentMock.mockReturnValue({ getExtensionInstaller: () => ({ install }) });

    const env = {} as NodeJS.ProcessEnv;
    const result = await wildcard.beforeRun!(env, runConfig('gemini'));

    expect(result.CODEMIE_GEMINI_EXTENSION_DIR).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('beforeRun logs an error and continues when install throws', async () => {
    const install = vi.fn(async () => {
      throw new Error('kaboom');
    });
    getAgentMock.mockReturnValue({ getExtensionInstaller: () => ({ install }) });

    const env = { KEEP: 'yes' } as NodeJS.ProcessEnv;
    const result = await wildcard.beforeRun!(env, runConfig('claude'));

    expect(result).toBe(env);
    expect(result.KEEP).toBe('yes');
    expect(result.CODEMIE_CLAUDE_EXTENSION_DIR).toBeUndefined();
    expect(loggerMock.error).toHaveBeenCalled();
  });

  describe('claude.enrichArgs', () => {
    const original = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;

    afterEach(() => {
      if (original === undefined) delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
      else process.env.CODEMIE_CLAUDE_EXTENSION_DIR = original;
    });

    it('returns args unchanged when the extension dir env var is unset', () => {
      delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
      const args = ['chat', '--foo'];
      expect(claudeHooks.enrichArgs!(args, {} as AgentConfig)).toBe(args);
    });

    it('prepends --plugin-dir when the env var is set and not already present', () => {
      process.env.CODEMIE_CLAUDE_EXTENSION_DIR = '/plugins/here';
      const args = ['chat'];
      const result = claudeHooks.enrichArgs!(args, {} as AgentConfig);
      expect(result).toEqual(['--plugin-dir', '/plugins/here', 'chat']);
    });

    it('does not duplicate --plugin-dir when already present', () => {
      process.env.CODEMIE_CLAUDE_EXTENSION_DIR = '/plugins/here';
      const args = ['--plugin-dir', '/other', 'chat'];
      const result = claudeHooks.enrichArgs!(args, {} as AgentConfig);
      expect(result).toBe(args);
    });
  });
});

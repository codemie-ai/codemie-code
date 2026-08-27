import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeMieConfigOptions } from '../../../../env/types.js';

// Mock the HTTPClient used by BaseModelProxy so no real network call is made.
// The mock class exposes a single shared `get` mock we can control/inspect.
const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../core/base/http-client.js', () => {
  class HTTPClient {
    get = getMock;
  }
  return { HTTPClient };
});

// LiteLLMSetupSteps pulls in inquirer at import time; stub it so importing the
// module never touches a real TTY. buildConfig under test never calls prompt.
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { LiteLLMModelProxy } from '../litellm.models.js';
import { LiteLLMTemplate } from '../litellm.template.js';
import { LiteLLMSetupSteps } from '../litellm.setup-steps.js';

function okResponse(ids: string[]): { data: { data: Array<{ id: string }> } } {
  return { data: { data: ids.map(id => ({ id })) } };
}

describe('LiteLLMTemplate', () => {
  it('exposes the expected identity and connectivity fields', () => {
    expect(LiteLLMTemplate.name).toBe('litellm');
    expect(LiteLLMTemplate.displayName).toBe('LiteLLM');
    expect(LiteLLMTemplate.defaultBaseUrl).toBe('http://localhost:4000');
    expect(LiteLLMTemplate.requiresAuth).toBe(false);
    expect(LiteLLMTemplate.authType).toBe('api-key');
    expect(LiteLLMTemplate.priority).toBe(14);
    expect(LiteLLMTemplate.defaultProfileName).toBe('litellm');
  });

  it('declares model + capability configuration', () => {
    expect(LiteLLMTemplate.recommendedModels).toEqual(['claude-sonnet-4-6']);
    expect(LiteLLMTemplate.capabilities).toEqual(['streaming', 'tools', 'function-calling']);
    expect(LiteLLMTemplate.supportsModelInstallation).toBe(false);
    expect(LiteLLMTemplate.supportsStreaming).toBe(true);
    expect(LiteLLMTemplate.setupInstructions).toContain('LiteLLM Setup Instructions');
  });
});

describe('LiteLLMModelProxy.supports', () => {
  it('matches only the litellm provider', () => {
    const proxy = new LiteLLMModelProxy('http://localhost:4000');
    expect(proxy.supports('litellm')).toBe(true);
    expect(proxy.supports('ollama')).toBe(false);
    expect(proxy.supports('')).toBe(false);
  });

  it('does not support local model installation', () => {
    const proxy = new LiteLLMModelProxy('http://localhost:4000');
    expect(proxy.supportsInstallation()).toBe(false);
  });
});

describe('LiteLLMModelProxy.listModels', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('maps the OpenAI /v1/models payload to ModelInfo (id=name, popular=false)', async () => {
    getMock.mockResolvedValueOnce(okResponse(['gpt-4o', 'claude-sonnet-4-6']));
    const proxy = new LiteLLMModelProxy('http://localhost:4000');

    const models = await proxy.listModels();

    expect(models).toEqual([
      { id: 'gpt-4o', name: 'gpt-4o', popular: false },
      { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', popular: false }
    ]);
  });

  it('requests the /v1/models endpoint on the configured base URL', async () => {
    getMock.mockResolvedValueOnce(okResponse(['m1']));
    const proxy = new LiteLLMModelProxy('http://proxy.example.com:4000');

    await proxy.listModels();

    const [url] = getMock.mock.calls[0];
    expect(url).toBe('http://proxy.example.com:4000/v1/models');
  });

  it('returns an empty array when the proxy lists no models', async () => {
    getMock.mockResolvedValueOnce(okResponse([]));
    const proxy = new LiteLLMModelProxy('http://localhost:4000');

    const models = await proxy.listModels();

    expect(models).toEqual([]);
  });

  it('omits the Authorization header when no API key is provided', async () => {
    getMock.mockResolvedValueOnce(okResponse(['m1']));
    const proxy = new LiteLLMModelProxy('http://localhost:4000');

    await proxy.listModels();

    const headers = getMock.mock.calls[0][1] as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('omits the Authorization header for the sentinel "not-required" key', async () => {
    getMock.mockResolvedValueOnce(okResponse(['m1']));
    const proxy = new LiteLLMModelProxy('http://localhost:4000', 'not-required');

    await proxy.listModels();

    const headers = getMock.mock.calls[0][1] as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('adds a Bearer Authorization header when a real API key is provided', async () => {
    getMock.mockResolvedValueOnce(okResponse(['m1']));
    const proxy = new LiteLLMModelProxy('http://localhost:4000', 'sk-secret');

    await proxy.listModels();

    const headers = getMock.mock.calls[0][1] as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-secret');
  });

  it('propagates errors from the HTTP client', async () => {
    getMock.mockRejectedValueOnce(new Error('HTTP 500: boom'));
    const proxy = new LiteLLMModelProxy('http://localhost:4000');

    await expect(proxy.listModels()).rejects.toThrow('HTTP 500: boom');
  });
});

describe('LiteLLMModelProxy.fetchModels', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('uses config.baseUrl and config.apiKey when provided', async () => {
    getMock.mockResolvedValueOnce(okResponse(['runtime-model']));
    const proxy = new LiteLLMModelProxy('http://ctor-url:4000', 'ctor-key');
    const config = { baseUrl: 'http://runtime:9000', apiKey: 'sk-runtime' } as CodeMieConfigOptions;

    const models = await proxy.fetchModels(config);

    expect(models).toEqual([{ id: 'runtime-model', name: 'runtime-model', popular: false }]);
    const [url, headers] = getMock.mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('http://runtime:9000/v1/models');
    expect(headers['Authorization']).toBe('Bearer sk-runtime');
  });

  it('falls back to constructor baseUrl/apiKey when config fields are absent', async () => {
    getMock.mockResolvedValueOnce(okResponse(['m1']));
    const proxy = new LiteLLMModelProxy('http://ctor-url:4000', 'ctor-key');
    const config = {} as CodeMieConfigOptions;

    await proxy.fetchModels(config);

    const [url, headers] = getMock.mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('http://ctor-url:4000/v1/models');
    expect(headers['Authorization']).toBe('Bearer ctor-key');
  });

  it('honours an explicit empty-string apiKey in config over the constructor key', async () => {
    getMock.mockResolvedValueOnce(okResponse(['m1']));
    const proxy = new LiteLLMModelProxy('http://ctor-url:4000', 'ctor-key');
    const config = { apiKey: '' } as CodeMieConfigOptions;

    await proxy.fetchModels(config);

    const [url, headers] = getMock.mock.calls[0] as [string, Record<string, string>];
    // config.apiKey is '' (defined) so it overrides the ctor key -> no auth header
    expect(url).toBe('http://ctor-url:4000/v1/models');
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('LiteLLMSetupSteps.buildConfig (base-url / key wiring)', () => {
  it('wires provider, baseUrl, apiKey and selected model into the config', () => {
    const config = LiteLLMSetupSteps.buildConfig(
      { baseUrl: 'http://proxy:4000', apiKey: 'sk-abc' },
      'claude-sonnet-4-6'
    );

    expect(config).toEqual({
      provider: 'litellm',
      baseUrl: 'http://proxy:4000',
      apiKey: 'sk-abc',
      model: 'claude-sonnet-4-6'
    });
  });

  it('passes through the "not-required" sentinel key verbatim', () => {
    const config = LiteLLMSetupSteps.buildConfig(
      { baseUrl: 'http://localhost:4000', apiKey: 'not-required' },
      'gpt-4o'
    );

    expect(config.apiKey).toBe('not-required');
    expect(config.provider).toBe('litellm');
    expect(config.model).toBe('gpt-4o');
  });

  it('exposes the litellm setup-step identity', () => {
    expect(LiteLLMSetupSteps.name).toBe('litellm');
  });
});

describe('LiteLLMModelProxy.getModelInfo (inherited)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('returns the matching model or null', async () => {
    getMock.mockResolvedValue(okResponse(['a', 'b']));
    const proxy = new LiteLLMModelProxy('http://localhost:4000');

    await expect(proxy.getModelInfo('b')).resolves.toEqual({ id: 'b', name: 'b', popular: false });
    await expect(proxy.getModelInfo('missing')).resolves.toBeNull();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmModel } from '@/providers/plugins/sso/sso.http-client.js';
import codemieModels from '../codemie-models.extension.js';

type Extension = typeof codemieModels;
type ProviderConfig = Parameters<Parameters<Extension>[0]['registerProvider']>[1];

function model(id: string): LlmModel {
  return { base_name: id, deployment_name: id, label: id, enabled: true };
}

describe('codemie-models extension', () => {
  let home: string;
  let extension: Extension;
  let providers: Map<string, ProviderConfig>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codemie-omp-'));

    writeFileSync(join(home, 'proxy-daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:4555', gatewayKey: 'gk-test' }));
    vi.stubEnv('CODEMIE_HOME', home);
    vi.stubEnv('CODEMIE_OMP_BASE_URL', '');
    vi.stubGlobal('fetch', vi.fn());
    extension = codemieModels;
    providers = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });

  function register(): void {
    extension({ registerProvider: (name, config) => { providers.set(name, config); } });
  }

  function response(payload: unknown, status = 200, contentType = 'application/json'): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': contentType } });
  }

  it('registers each wire with its own daemon URL and authentication mode', () => {
    register();
    expect(providers.get('codemie')).toMatchObject({
      baseUrl: 'http://127.0.0.1:4555/v1', api: 'openai-completions', apiKey: 'gk-test',
    });
    expect(providers.get('codemie-claude')).toMatchObject({
      baseUrl: 'http://127.0.0.1:4555', api: 'anthropic-messages', apiKey: 'gk-test', authHeader: true,
    });
  });

  it('uses daemon defaults when the state file is missing', async () => {
    rmSync(join(home, 'proxy-daemon.json'));
    register();
    expect(providers.get('codemie')).toMatchObject({ baseUrl: 'http://127.0.0.1:4001/v1', apiKey: 'codemie-proxy' });
    vi.mocked(fetch).mockResolvedValue(response([]));
    await providers.get('codemie')!.fetchDynamicModels('codemie-proxy');
    expect(fetch).toHaveBeenCalledWith(new URL('http://127.0.0.1:4001/v1/llm_models?include_all=true'), expect.objectContaining({
      headers: { Authorization: 'Bearer codemie-proxy' },
    }));
  });

  it('uses an inference override without changing the daemon catalog request', async () => {
    vi.stubEnv('CODEMIE_OMP_BASE_URL', 'http://127.0.0.1:9999/');
    register();
    expect(providers.get('codemie')).toMatchObject({ baseUrl: 'http://127.0.0.1:9999/v1' });
    expect(providers.get('codemie-claude')).toMatchObject({ baseUrl: 'http://127.0.0.1:9999' });
    vi.mocked(fetch).mockResolvedValue(response([]));
    await providers.get('codemie')!.fetchDynamicModels(undefined);
    expect(fetch).toHaveBeenCalledWith(new URL('http://127.0.0.1:4555/v1/llm_models?include_all=true'), expect.objectContaining({
      headers: { Authorization: 'Bearer gk-test' },
    }));
  });

  it('splits the catalog by provider and reuses one fetch for both wire rosters', async () => {
    register();
    vi.mocked(fetch).mockResolvedValue(response([model('gpt-4.1'), model('claude-sonnet-5')]));
    const openai = providers.get('codemie')!;
    const anthropic = providers.get('codemie-claude')!;
    expect((await openai.fetchDynamicModels(undefined)).map(({ id }) => id)).toEqual(['gpt-4.1']);
    expect((await anthropic.fetchDynamicModels(undefined)).map(({ id }) => id)).toEqual(['claude-sonnet-5']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5001);
    vi.mocked(fetch).mockResolvedValue(response([model('gpt-5.6-luna')]));
    expect((await openai.fetchDynamicModels(undefined)).map(({ id }) => id)).toEqual(['gpt-5.6-luna']);
    expect(fetch).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it.each([401, 403])('reports expired login for HTTP %s', async status => {
    register();
    vi.mocked(fetch).mockResolvedValue(response([], status));
    await expect(providers.get('codemie')!.fetchDynamicModels(undefined)).rejects.toThrow(/codemie profile login/);
  });

  it('reports an HTTP failure for server errors', async () => {
    register();
    vi.mocked(fetch).mockResolvedValue(response([], 500));
    await expect(providers.get('codemie')!.fetchDynamicModels(undefined)).rejects.toThrow(/HTTP 500/);
  });

  it('rejects a non-JSON login page and a non-array payload', async () => {
    register();
    vi.mocked(fetch).mockResolvedValue(response('<html/>', 200, 'text/html'));
    await expect(providers.get('codemie')!.fetchDynamicModels(undefined)).rejects.toThrow(/non-JSON/);
    register();
    vi.mocked(fetch).mockResolvedValue(response({ models: [] }));
    await expect(providers.get('codemie')!.fetchDynamicModels(undefined)).rejects.toThrow(/unexpected payload/);
  });

  it('reports an unreachable daemon with its URL', async () => {
    register();
    vi.mocked(fetch).mockRejectedValue(new Error('connection refused'));
    await expect(providers.get('codemie')!.fetchDynamicModels(undefined)).rejects.toThrow(/not reachable at http:\/\/127\.0\.0\.1:4555/);
  });
});

/**
 * Managed MCP remote-fetch tests
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { fetchManagedMcpServers } from '../managed-mcp-remote.js';

const CREDS = { apiUrl: 'https://api.codemie.test', cookies: { codemie_access_token: 'abc', sid: 'xyz' } };

describe('fetchManagedMcpServers', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(CodeMieSSO.prototype, 'getStoredCredentials').mockResolvedValue(CREDS as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('requests the client-scoped endpoint with a cookie header and returns valid entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'radar', transport: 'http', url: 'https://mcp.epam.com/mcp/radar', auth: 'oauth' },
        { name: 'bad name', transport: 'http', url: 'https://x' },
        { name: 'noturl', transport: 'http' },
      ],
    });
    globalThis.fetch = fetchMock as any;

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');

    expect(result).toEqual([
      { name: 'radar', transport: 'http', url: 'https://mcp.epam.com/mcp/radar', auth: 'oauth' },
    ]);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe('https://api.codemie.test/v1/mcp/managed-servers?client=claude-desktop');
    expect((init.headers as Record<string, string>).cookie).toBe('codemie_access_token=abc;sid=xyz');
  });

  it('returns null when credentials are missing', async () => {
    (CodeMieSSO.prototype.getStoredCredentials as any).mockResolvedValue(null);
    globalThis.fetch = vi.fn() as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns null on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns null when body is not an array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [] }) }) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('drops entries with an invalid auth value', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'ok', transport: 'http', url: 'https://ok', auth: 'oauth' },
        { name: 'bauth', transport: 'http', url: 'https://b', auth: 'ftp' },
      ],
    }) as any;
    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result.map((e) => e.name)).toEqual(['ok']);
  });

  it('drops entries with non-string description or non-string clients', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'ok', transport: 'http', url: 'https://ok' },
        { name: 'baddesc', transport: 'http', url: 'https://b', description: 42 },
        { name: 'badclients', transport: 'http', url: 'https://c', clients: [1, null] },
      ],
    }) as any;
    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result.map((e) => e.name)).toEqual(['ok']);
  });

  it('returns null when response.json() rejects (malformed body)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns an empty array (not null) on a successful empty response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toEqual([]);
  });
});

/**
 * Managed MCP remote-fetch tests
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { HTTPClient } from '@/providers/core/base/http-client.js';
import { fetchManagedMcpServers } from '../managed-mcp-remote.js';

const CREDS = { apiUrl: 'https://api.codemie.test', cookies: { codemie_access_token: 'abc', sid: 'xyz' } };

/** Build a getRaw-style response (statusCode + raw string body) from a JSON value. */
function rawOk(body: unknown, statusCode = 200) {
  return { statusCode, statusMessage: 'OK', headers: {}, data: JSON.stringify(body) };
}

describe('fetchManagedMcpServers', () => {
  let getRawMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(CodeMieSSO.prototype, 'getStoredCredentials').mockResolvedValue(CREDS as any);
    // The fetch goes through the shared HTTPClient (like every other CodeMie
    // request), so mock its getRaw rather than global fetch.
    getRawMock = vi.fn();
    vi.spyOn(HTTPClient.prototype, 'getRaw').mockImplementation(getRawMock as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests the client-scoped endpoint through the shared HTTPClient with CLI auth headers and returns valid entries', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'sample', transport: 'http', url: 'https://mcp.example.com/mcp/sample', auth: 'oauth' },
      { name: 'bad name', transport: 'http', url: 'https://x' },
      { name: 'noturl', transport: 'http' },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');

    expect(result).toEqual([
      { name: 'sample', transport: 'http', url: 'https://mcp.example.com/mcp/sample', auth: 'oauth' },
    ]);
    const [calledUrl, headers] = getRawMock.mock.calls[0];
    expect(String(calledUrl)).toBe('https://api.codemie.test/v1/mcp/managed-servers?client=claude-desktop');
    // buildAuthHeaders attaches the cookie plus the standard CLI-identifying
    // headers that every other CodeMie request sends.
    expect((headers as Record<string, string>).cookie).toBe('codemie_access_token=abc;sid=xyz');
    expect((headers as Record<string, string>)['X-CodeMie-Client']).toBe('codemie-cli');
  });

  it('accepts entries whose optional fields are null (backend serialization)', async () => {
    getRawMock.mockResolvedValue(rawOk([
      {
        name: 'onehub_core',
        transport: 'http',
        url: 'https://mcp.example.com/mcp/onehub_core',
        auth: 'oauth',
        description: null,
        clients: null,
      },
    ]));
    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result).toEqual([
      { name: 'onehub_core', transport: 'http', url: 'https://mcp.example.com/mcp/onehub_core', auth: 'oauth' },
    ]);
  });

  it('preserves a base path on the API URL (e.g. /code-assistant-api)', async () => {
    (CodeMieSSO.prototype.getStoredCredentials as any).mockResolvedValue({
      apiUrl: 'https://codemie.example.com/code-assistant-api',
      cookies: { codemie_access_token: 'abc' },
    });
    getRawMock.mockResolvedValue(rawOk([]));
    await fetchManagedMcpServers('claude-desktop', 'https://codemie.example.com');
    expect(String(getRawMock.mock.calls[0][0])).toBe(
      'https://codemie.example.com/code-assistant-api/v1/mcp/managed-servers?client=claude-desktop',
    );
  });

  it('returns null when credentials are missing', async () => {
    (CodeMieSSO.prototype.getStoredCredentials as any).mockResolvedValue(null);
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
    expect(getRawMock).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx response', async () => {
    getRawMock.mockResolvedValue({ statusCode: 401, statusMessage: 'Unauthorized', headers: {}, data: '' });
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns null when the request throws', async () => {
    getRawMock.mockRejectedValue(new Error('network'));
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns null when body is not an array', async () => {
    getRawMock.mockResolvedValue(rawOk({ servers: [] }));
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('drops entries with an invalid auth value', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok', auth: 'oauth' },
      { name: 'bauth', transport: 'http', url: 'https://b', auth: 'ftp' },
    ]));
    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result.map((e) => e.name)).toEqual(['ok']);
  });

  it('drops entries with non-string description or non-string clients', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok' },
      { name: 'baddesc', transport: 'http', url: 'https://b', description: 42 },
      { name: 'badclients', transport: 'http', url: 'https://c', clients: [1, null] },
    ]));
    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result.map((e) => e.name)).toEqual(['ok']);
  });

  it('returns null when the response body is not valid JSON (malformed body)', async () => {
    getRawMock.mockResolvedValue({ statusCode: 200, statusMessage: 'OK', headers: {}, data: '<<not json>>' });
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns an empty array (not null) on a successful empty response', async () => {
    getRawMock.mockResolvedValue(rawOk([]));
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toEqual([]);
  });
});

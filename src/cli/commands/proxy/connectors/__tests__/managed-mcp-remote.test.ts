/**
 * Managed MCP remote-fetch tests
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { HTTPClient } from '@/providers/core/base/http-client.js';
import { fetchManagedMcpServers, isValidOAuthConfig } from '../managed-mcp-remote.js';

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

  it('returns null when the backend sent entries but none survived validation', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'broken1', transport: 'http', url: 'https://a', oauth: { clientId: 'x' } },
      { name: 'broken2', transport: 'http', url: 'https://b', oauth: { clientId: 'y' } },
    ]));

    // An authoritative "[]" would revoke the tenant's org MCP servers; a backend
    // bug must look like a failure instead.
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns the valid subset when only some entries are invalid', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'good', transport: 'http', url: 'https://good', oauth: true },
      { name: 'broken', transport: 'http', url: 'https://bad', oauth: { clientId: 'x' } },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result).toEqual([{ name: 'good', transport: 'http', url: 'https://good', oauth: true }]);
  });

  const OAUTH = {
    clientId: 'codemie-mcp-proxy',
    scope: 'openid profile email',
    callbackHost: 'localhost',
    callbackPort: 3118,
    authorizationUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/auth?kc_idp_hint=epam-oidc&prompt=login',
    tokenUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/token',
  };

  it('keeps a structured oauth object intact, including unknown keys', async () => {
    getRawMock.mockResolvedValue(rawOk([
      {
        name: 'onehub_core',
        transport: 'http',
        url: 'https://mcp.example.com/mcp/onehub_core',
        oauth: { ...OAUTH, audience: 'onehub', pkce: true },
      },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');

    expect(result).toEqual([
      {
        name: 'onehub_core',
        transport: 'http',
        url: 'https://mcp.example.com/mcp/onehub_core',
        oauth: { ...OAUTH, audience: 'onehub', pkce: true },
      },
    ]);
  });

  it('copies the oauth object rather than aliasing the parsed payload', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'onehub_core', transport: 'http', url: 'https://mcp.example.com/mcp/onehub_core', oauth: OAUTH },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');

    expect(result?.[0].oauth).toEqual(OAUTH);
  });

  it('drops entries whose oauth object is missing a required field', async () => {
    const { clientId: _dropClientId, ...noClientId } = OAUTH;
    const { authorizationUrl: _dropAuthUrl, ...noAuthUrl } = OAUTH;
    const { tokenUrl: _dropTokenUrl, ...noTokenUrl } = OAUTH;
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok', oauth: OAUTH },
      { name: 'noclient', transport: 'http', url: 'https://a', oauth: noClientId },
      { name: 'noauthurl', transport: 'http', url: 'https://b', oauth: noAuthUrl },
      { name: 'notokenurl', transport: 'http', url: 'https://c', oauth: noTokenUrl },
      { name: 'blankclient', transport: 'http', url: 'https://d', oauth: { ...OAUTH, clientId: '   ' } },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result?.map((e) => e.name)).toEqual(['ok']);
  });

  it('drops entries whose optional oauth fields have the wrong type', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok', oauth: OAUTH },
      { name: 'badport', transport: 'http', url: 'https://a', oauth: { ...OAUTH, callbackPort: 3118.5 } },
      { name: 'zeroport', transport: 'http', url: 'https://b', oauth: { ...OAUTH, callbackPort: 0 } },
      { name: 'hugeport', transport: 'http', url: 'https://c', oauth: { ...OAUTH, callbackPort: 70000 } },
      { name: 'strport', transport: 'http', url: 'https://d', oauth: { ...OAUTH, callbackPort: '3118' } },
      { name: 'badscope', transport: 'http', url: 'https://e', oauth: { ...OAUTH, scope: 42 } },
      { name: 'badhost', transport: 'http', url: 'https://f', oauth: { ...OAUTH, callbackHost: [] } },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result?.map((e) => e.name)).toEqual(['ok']);
  });

  it('drops entries whose oauth is an array or a non-object scalar', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok', oauth: OAUTH },
      { name: 'arr', transport: 'http', url: 'https://a', oauth: [OAUTH] },
      { name: 'str', transport: 'http', url: 'https://b', oauth: 'oauth' },
      { name: 'num', transport: 'http', url: 'https://c', oauth: 1 },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result?.map((e) => e.name)).toEqual(['ok']);
  });

  it('accepts the boolean oauth shape and treats oauth: null as absent', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'flagtrue', transport: 'http', url: 'https://a', oauth: true },
      { name: 'flagfalse', transport: 'http', url: 'https://b', oauth: false },
      { name: 'nulled', transport: 'http', url: 'https://c', oauth: null },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result).toEqual([
      { name: 'flagtrue', transport: 'http', url: 'https://a', oauth: true },
      { name: 'flagfalse', transport: 'http', url: 'https://b', oauth: false },
      { name: 'nulled', transport: 'http', url: 'https://c' },
    ]);
  });

  it('still accepts the legacy auth enum alongside the new shape', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'legacy', transport: 'http', url: 'https://a', auth: 'oauth' },
      { name: 'modern', transport: 'http', url: 'https://b', oauth: OAUTH },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result).toEqual([
      { name: 'legacy', transport: 'http', url: 'https://a', auth: 'oauth' },
      { name: 'modern', transport: 'http', url: 'https://b', oauth: OAUTH },
    ]);
  });
});

describe('isValidOAuthConfig', () => {
  const VALID = {
    clientId: 'codemie-mcp-proxy',
    authorizationUrl: 'https://auth.codemie.test/auth',
    tokenUrl: 'https://auth.codemie.test/token',
  };

  it('accepts the minimal required set', () => {
    expect(isValidOAuthConfig(VALID)).toBe(true);
  });

  it('accepts optional fields with correct types and unknown extra keys', () => {
    expect(isValidOAuthConfig({
      ...VALID,
      scope: 'openid profile email',
      callbackHost: 'localhost',
      callbackPort: 3118,
      somethingNew: { nested: true },
    })).toBe(true);
  });

  it('rejects null, arrays, scalars and booleans', () => {
    expect(isValidOAuthConfig(null)).toBe(false);
    expect(isValidOAuthConfig([VALID])).toBe(false);
    expect(isValidOAuthConfig('oauth')).toBe(false);
    expect(isValidOAuthConfig(true)).toBe(false);
    expect(isValidOAuthConfig(undefined)).toBe(false);
  });

  it('rejects a callbackPort outside 1..65535 or non-integer', () => {
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 0 })).toBe(false);
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 65536 })).toBe(false);
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 3118.5 })).toBe(false);
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 3118 })).toBe(true);
  });
});

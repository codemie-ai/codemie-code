/**
 * Silent renewal and refresh-token rotation adoption (McpOAuthProvider.renewSilently).
 *
 * The SDK's discovery and refresh calls are mocked (OAuthError stays real); the token store is real
 * and runs against a temp CODEMIE_HOME, so "another process persisted a newer login" is simulated
 * by persisting from inside the mocked refresh call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { useTempCodemieHome } from './helpers/temp-home.js';

const sdk = vi.hoisted(() => ({
  refreshAuthorization: vi.fn(),
  discoverOAuthServerInfo: vi.fn(),
  selectResourceURL: vi.fn(),
}));

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return { ...actual, ...sdk };
});

import { OAuthError } from '@modelcontextprotocol/client';
import type { OAuthClientInformationMixed } from '@modelcontextprotocol/client';
import { McpOAuthProvider } from '../auth/mcp-oauth-provider.js';
import { peekPersistedLogin, persistLogin, type PersistedLogin } from '../auth/token-store.js';

const home = useTempCodemieHome();
const SERVER = new URL('https://gateway.example/mcp/renewal');

function client(id: string): OAuthClientInformationMixed {
  return { client_id: id, redirect_uris: ['http://127.0.0.1:1234/callback'] } as OAuthClientInformationMixed;
}

function login(name: string, opts: { expired?: boolean } = {}): PersistedLogin {
  return {
    tokens: { access_token: `at-${name}`, token_type: 'Bearer' },
    expiresAt: Date.now() + (opts.expired ? -5_000 : 3_600_000),
    grant: { refreshToken: `rt-${name}`, clientInfo: client(`client-${name}`) },
  };
}

function refreshed(name: string): { access_token: string; token_type: string; expires_in: number; refresh_token: string } {
  return { access_token: `at-${name}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${name}` };
}

function refusal(code: string): OAuthError {
  return new OAuthError(code, `refused: ${code}`);
}

/** Restore `persisted` into a fresh provider, as the bridge does at startup. */
function restoredProvider(persisted: PersistedLogin): McpOAuthProvider {
  persistLogin(SERVER, persisted);
  const provider = new McpOAuthProvider(SERVER);
  provider.restorePersistedLogin();
  return provider;
}

beforeEach(() => {
  sdk.refreshAuthorization.mockReset();
  sdk.discoverOAuthServerInfo.mockReset().mockResolvedValue({
    authorizationServerUrl: 'https://auth.example',
    authorizationServerMetadata: {},
    resourceMetadata: undefined,
  });
  sdk.selectResourceURL.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('restore and plain renewal', () => {
  it('restores an expired persisted login and reports that it needs renewal', () => {
    const provider = restoredProvider(login('a', { expired: true }));

    expect(provider.tokens()?.access_token).toBe('at-a');
    expect(provider.tokenNeedsRenewal()).toBe(true);
  });

  it('renews with the refresh token and persists the new login', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockResolvedValueOnce(refreshed('b'));

    await expect(provider.renewSilently()).resolves.toBe(true);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(sdk.refreshAuthorization.mock.calls[0][1]).toMatchObject({ refreshToken: 'rt-a' });
    expect(provider.tokens()?.access_token).toBe('at-b');
    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-b');
  });
});

describe('refusal without a newer persisted grant', () => {
  it('forgets the file when the persisted refresh token is the refused one', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockRejectedValueOnce(refusal('invalid_grant'));

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(peekPersistedLogin(SERVER)).toBeUndefined();
  });

  it('forgets on any OAuthError code when nothing newer exists', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockRejectedValueOnce(refusal('server_error'));

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(peekPersistedLogin(SERVER)).toBeUndefined();
  });

  it('returns false and keeps today\'s behavior when the persisted file is gone', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockImplementationOnce(async () => {
      const { forgetPersistedLogin } = await import('../auth/token-store.js');
      forgetPersistedLogin(SERVER);
      throw refusal('invalid_grant');
    });

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(peekPersistedLogin(SERVER)).toBeUndefined();
  });

  it('keeps the file after a network error', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-a');
  });
});

describe('adoption of a newer persisted grant', () => {
  it('adopts a newer grant with a valid access token without a second refresh call', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockImplementationOnce(async () => {
      persistLogin(SERVER, login('b'));
      throw refusal('invalid_grant');
    });

    await expect(provider.renewSilently()).resolves.toBe(true);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(provider.tokens()?.access_token).toBe('at-b');
    expect(provider.tokenNeedsRenewal()).toBe(false);
    expect(provider.clientInformation()).toBeUndefined();
    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-b');
  });

  it('renews exactly once with the adopted grant when its access token is expired', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization
      .mockImplementationOnce(async () => {
        persistLogin(SERVER, login('b', { expired: true }));
        throw refusal('invalid_grant');
      })
      .mockResolvedValueOnce(refreshed('c'));

    await expect(provider.renewSilently()).resolves.toBe(true);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(2);
    expect(sdk.refreshAuthorization.mock.calls[1][1]).toMatchObject({
      refreshToken: 'rt-b',
      clientInformation: { client_id: 'client-b' },
    });
    expect(provider.tokens()?.access_token).toBe('at-c');
    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-c');
  });

  it('adopts a newer grant also when the first refusal is not grant-ending', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockImplementationOnce(async () => {
      persistLogin(SERVER, login('b'));
      throw refusal('server_error');
    });

    await expect(provider.renewSilently()).resolves.toBe(true);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(provider.tokens()?.access_token).toBe('at-b');
  });
});

describe('a refused retry with an adopted grant', () => {
  function adoptingExpired(): McpOAuthProvider {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization.mockImplementationOnce(async () => {
      persistLogin(SERVER, login('b', { expired: true }));
      throw refusal('invalid_grant');
    });
    return provider;
  }

  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
    'forgets the file on %s while it still holds the refused token',
    async (code) => {
      const provider = adoptingExpired();
      sdk.refreshAuthorization.mockRejectedValueOnce(refusal(code));

      await expect(provider.renewSilently()).resolves.toBe(false);

      expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(2);
      expect(peekPersistedLogin(SERVER)).toBeUndefined();
    },
  );

  it('does not remove a file that meanwhile holds a still newer refresh token', async () => {
    const provider = adoptingExpired();
    sdk.refreshAuthorization.mockImplementationOnce(async () => {
      persistLogin(SERVER, login('c'));
      throw refusal('invalid_grant');
    });

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(2);
    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-c');
  });

  it('keeps the grant and the file after a network error', async () => {
    const provider = adoptingExpired();
    sdk.refreshAuthorization.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(2);
    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-b');

    // the grant is still held in memory: a later attempt uses it
    sdk.refreshAuthorization.mockResolvedValueOnce(refreshed('d'));
    await expect(provider.renewSilently()).resolves.toBe(true);
    expect(sdk.refreshAuthorization.mock.calls[2][1]).toMatchObject({ refreshToken: 'rt-b' });
  });

  it('keeps the file after a non grant-ending OAuthError (server_error)', async () => {
    const provider = adoptingExpired();
    sdk.refreshAuthorization.mockRejectedValueOnce(refusal('server_error'));

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(2);
    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-b');
  });

  it('never refreshes more than twice, even if the file keeps changing', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    sdk.refreshAuthorization
      .mockImplementationOnce(async () => {
        persistLogin(SERVER, login('b', { expired: true }));
        throw refusal('invalid_grant');
      })
      .mockImplementationOnce(async () => {
        persistLogin(SERVER, login('c', { expired: true }));
        throw refusal('invalid_grant');
      });

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(2);
    expect(peekPersistedLogin(SERVER)?.grant?.refreshToken).toBe('rt-c');
  });
});

describe('persistence switched off', () => {
  it('adopts nothing and writes nothing when MCP_PROXY_PERSIST_TOKENS=off', async () => {
    const provider = restoredProvider(login('a', { expired: true }));
    const authDir = join(home.dir(), 'mcp-auth');
    const before = readdirSync(authDir);

    sdk.refreshAuthorization.mockImplementationOnce(async () => {
      persistLogin(SERVER, login('b')); // written while persistence is still on
      process.env.MCP_PROXY_PERSIST_TOKENS = 'off';
      throw refusal('invalid_grant');
    });

    await expect(provider.renewSilently()).resolves.toBe(false);

    expect(sdk.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(provider.tokens()?.access_token).toBe('at-a');
    expect(readdirSync(authDir).filter((f) => !before.includes(f))).toEqual([]);
  });
});

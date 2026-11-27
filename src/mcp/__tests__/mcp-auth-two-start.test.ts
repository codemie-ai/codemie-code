/**
 * Two-start regression (characterization of already-shipped behaviour, so it is expected to pass
 * on its first run): a login completed by one provider instance is restored by a fresh instance
 * on the same CODEMIE_HOME without opening a browser and without a refresh call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTempCodemieHome } from './helpers/temp-home.js';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      execFileMock(...args);
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as (e: Error | null) => void)(null);
      return undefined;
    },
  };
});

const sdk = vi.hoisted(() => ({
  refreshAuthorization: vi.fn(),
  discoverOAuthServerInfo: vi.fn(),
  selectResourceURL: vi.fn(),
}));

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return { ...actual, ...sdk };
});

import type { OAuthClientInformationMixed } from '@modelcontextprotocol/client';
import { McpOAuthProvider } from '../auth/mcp-oauth-provider.js';

useTempCodemieHome();
const SERVER = new URL('https://gateway.example/mcp/two-start');

beforeEach(() => {
  execFileMock.mockReset();
  sdk.refreshAuthorization.mockReset();
  sdk.discoverOAuthServerInfo.mockReset();
  sdk.selectResourceURL.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('two-start regression (characterization, passes on first run)', () => {
  it('a second provider restores the first one\'s login without a browser or a refresh', () => {
    const first = new McpOAuthProvider(SERVER);
    first.saveClientInformation({
      client_id: 'client-a',
      redirect_uris: ['http://127.0.0.1:1234/callback'],
    } as OAuthClientInformationMixed);
    first.saveTokens({
      access_token: 'at-first',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rt-first',
    });

    const second = new McpOAuthProvider(SERVER);
    second.restorePersistedLogin();

    expect(second.tokens()?.access_token).toBe('at-first');
    expect(second.tokenNeedsRenewal()).toBe(false);
    expect(second.clientInformation()).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(sdk.refreshAuthorization).not.toHaveBeenCalled();
  });
});

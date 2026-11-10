import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const retrieveSSOCredentials = vi.fn();
const clearSSOCredentials = vi.fn();
const openBrowser = vi.fn();

vi.mock('@/utils/security.js', () => ({
  CredentialStore: {
    getInstance: () => ({ retrieveSSOCredentials, clearSSOCredentials }),
  },
}));
vi.mock('open', () => ({ default: openBrowser }));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({
  startDetachedSsoLogin: vi.fn(),
  waitForDetachedSsoLogin: vi.fn(),
  describeLogin: vi.fn(),
  getLastSignInAt: vi.fn(),
  SSO_LOGIN_WAIT_MS: 150_000,
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuthOrWait } from '../sso.auth-gate.js';
import { SSOSessionExpiryPlugin } from '../proxy/plugins/sso-session-expiry.plugin.js';
import type { IncomingMessage } from 'http';
import { startDetachedSsoLogin, waitForDetachedSsoLogin, getLastSignInAt } from '@/providers/plugins/sso/sso.detached-login.js';

const BASE_URL = 'https://codemie.example.com';
const configured = { provider: 'ai-run-sso', ssoUrl: BASE_URL, syncApiUrl: BASE_URL };

describe('ensureCodeMieSsoAuthOrWait with real credential lookup (cookie-only credential)', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'codemie-auth-gate-integration-'));
    process.env.CODEMIE_HOME = home;
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
    vi.mocked(waitForDetachedSsoLogin).mockResolvedValue({ status: 'timeout' } as never);
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('passes without sign-in or deletion for a cookie-only credential stored over 24h ago and no rejection marker', async () => {
    retrieveSSOCredentials.mockResolvedValue({
      cookies: { _oauth2_proxy: 'cookie-value' },
      apiUrl: `${BASE_URL}/code-assistant-api`,
      expiresAt: Date.now() - 60_000, // stored DAY_MS + 1min ago with a 24h client-side expiry
    });

    const result = await ensureCodeMieSsoAuthOrWait(configured);

    expect(result).toEqual({ ok: true });
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(clearSSOCredentials).not.toHaveBeenCalled();
  });

  describe('after the session-expiry plugin records a rejection', () => {
    const cookieCredentials = {
      cookies: { _oauth2_proxy: 'cookie-value' },
      apiUrl: `${BASE_URL}/code-assistant-api`,
    };

    /** Runs the real plugin interceptor against a fake upstream rejection. */
    async function rejectThroughPlugin(response: Partial<IncomingMessage>): Promise<void> {
      const plugin = new SSOSessionExpiryPlugin();
      const interceptor = await plugin.createInterceptor({
        credentials: cookieCredentials,
        config: { targetApiUrl: `${BASE_URL}/code-assistant-api` },
      } as never);
      const tools = {
        readBody: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        retry: vi.fn(),
        fromBuffer: vi.fn().mockImplementation(() => ({ headers: {} })),
      };
      const result = await interceptor.onUpstreamResponse!(
        { headers: { cookie: '_oauth2_proxy=cookie-value' } } as never,
        response as IncomingMessage,
        tools as never
      );
      expect(result.statusCode).toBe(401);
    }

    beforeEach(() => {
      retrieveSSOCredentials.mockResolvedValue({ ...cookieCredentials, expiresAt: Date.now() + 3_600_000 });
      vi.mocked(getLastSignInAt).mockResolvedValue(null);
    });

    const rejections: Array<[string, Partial<IncomingMessage>]> = [
      ['an oauth2 redirect', { statusCode: 302, headers: { location: `${BASE_URL}/oauth2/start?rd=/` } }],
      ['a session-shaped 401', { statusCode: 401, headers: {} }],
    ];

    it.each(rejections)('starts one sign-in for %s and proceeds after sign-in without a second launch', async (_name, response) => {
      await rejectThroughPlugin(response);
      vi.mocked(startDetachedSsoLogin).mockClear();

      vi.mocked(waitForDetachedSsoLogin).mockImplementation(async () => {
        vi.mocked(getLastSignInAt).mockResolvedValue(Date.now() + 5_000);
        return { status: 'succeeded' } as never;
      });

      const result = await ensureCodeMieSsoAuthOrWait(configured, { waitMs: 60_000 });

      expect(result).toEqual({ ok: true });
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
      expect(openBrowser).not.toHaveBeenCalled();
    });
  });
});

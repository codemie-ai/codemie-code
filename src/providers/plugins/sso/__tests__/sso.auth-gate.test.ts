import { describe, it, expect, vi, beforeEach } from 'vitest';

const getStoredCredentials = vi.fn();

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function () {
    return { getStoredCredentials };
  }),
}));
vi.mock('@/utils/analytics-auth-status.js', () => ({ getAnalyticsAuthStatus: vi.fn() }));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({ startDetachedSsoLogin: vi.fn() }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuth } from '../sso.auth-gate.js';
import { getAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { startDetachedSsoLogin } from '@/providers/plugins/sso/sso.detached-login.js';

const configured = { provider: 'ai-run-sso', ssoUrl: 'https://codemie.example.com', syncApiUrl: 'https://api.example.com' };
const PROD = 'https://prod.example.com';
const PREVIEW = 'https://preview.example.com';

describe('ensureCodeMieSsoAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(null);
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
  });

  it('passes with valid credentials and no auth-status marker', async () => {
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });

    expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('passes when analytics is not configured', async () => {
    expect(await ensureCodeMieSsoAuth({})).toEqual({ ok: true });
  });

  it('never starts a sign-in when an api key is set', async () => {
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401' } as never);

    const result = await ensureCodeMieSsoAuth({ ...configured, apiKey: 'key' });

    expect(result.ok).toBe(false);
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('starts a detached sign-in without awaiting authenticate when credentials are missing', async () => {
    getStoredCredentials.mockResolvedValue(null);
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('in-progress');

    const result = await ensureCodeMieSsoAuth(configured);

    expect(result).toEqual({ ok: false, reason: 'no valid CodeMie SSO credentials found', loginOutcome: 'in-progress' });
    expect(startDetachedSsoLogin).toHaveBeenCalledWith(configured.ssoUrl);
  });

  it('reports rejected credentials and starts a sign-in when the marker is present', async () => {
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401' } as never);

    const result = await ensureCodeMieSsoAuth(configured);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('rejected the stored credentials');
    expect(result.loginOutcome).toBe('started');
  });

  it('blocks without starting a sign-in when the provider is SSO but no url is configured', async () => {
    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso' });

    expect(result).toEqual({ ok: false, reason: 'no valid CodeMie SSO credentials found', loginOutcome: undefined });
    expect(getStoredCredentials).not.toHaveBeenCalled();
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('fails closed on an unexpected error', async () => {
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(getAnalyticsAuthStatus).mockRejectedValue(new Error('boom'));

    expect(await ensureCodeMieSsoAuth(configured)).toEqual({
      ok: false,
      reason: 'CodeMie SSO auth gate check failed unexpectedly',
      loginOutcome: undefined,
    });
  });

  describe('profile-first URL resolution', () => {
    it('passes with the profile login even when the workspace environment has no login', async () => {
      getStoredCredentials.mockImplementation(async (url: string) =>
        url === PROD ? { cookies: { a: 'b' }, apiUrl: PROD } : null
      );

      const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', baseUrl: PROD, ssoUrl: PREVIEW });

      expect(result).toEqual({ ok: true });
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('starts the detached sign-in against the profile URL, not the workspace URL', async () => {
      getStoredCredentials.mockResolvedValue(null);

      const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', baseUrl: PROD, ssoUrl: PREVIEW });

      expect(result.ok).toBe(false);
      expect(startDetachedSsoLogin).toHaveBeenCalledWith(PROD);
    });

    it("does not accept another environment's workspace login for the profile", async () => {
      getStoredCredentials.mockImplementation(async (url: string) =>
        url === PREVIEW ? { cookies: { a: 'b' }, apiUrl: `${PREVIEW}/code-assistant-api` } : null
      );

      const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', baseUrl: PROD, ssoUrl: PREVIEW });

      expect(result.ok).toBe(false);
      expect(startDetachedSsoLogin).toHaveBeenCalledWith(PROD);
    });

    it('reads the profile URL from CODEMIE_PROFILE_CONFIG in the supplied env', async () => {
      getStoredCredentials.mockImplementation(async (url: string) =>
        url === PROD ? { cookies: { a: 'b' }, apiUrl: PROD } : null
      );
      const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: PROD }) };

      const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', ssoUrl: PREVIEW, env });

      expect(result).toEqual({ ok: true });
    });

    it('keeps using the workspace URL for non-CodeMie providers', async () => {
      getStoredCredentials.mockImplementation(async (url: string) =>
        url === PREVIEW ? { cookies: { a: 'b' } } : null
      );

      const result = await ensureCodeMieSsoAuth({
        provider: 'anthropic-subscription',
        ssoUrl: PREVIEW,
        syncApiUrl: PREVIEW,
      });

      expect(result).toEqual({ ok: true });
    });
  });
});

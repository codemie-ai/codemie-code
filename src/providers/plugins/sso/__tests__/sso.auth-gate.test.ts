import { describe, it, expect, vi, beforeEach } from 'vitest';

const getStoredCredentials = vi.fn();

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function () {
    return { getStoredCredentials };
  }),
}));
vi.mock('@/utils/analytics-auth-status.js', () => ({
  getAnalyticsAuthStatus: vi.fn(),
  clearAnalyticsAuthStatus: vi.fn(async () => undefined),
}));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({
  startDetachedSsoLogin: vi.fn(),
  waitForDetachedSsoLogin: vi.fn(),
  describeLogin: vi.fn((outcome: string, opts?: { resume?: string }) => `login:${outcome}:${opts?.resume ?? 'manual'}`),
  getLastSignInAt: vi.fn(),
  SSO_LOGIN_WAIT_MS: 150_000,
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuth, ensureCodeMieSsoAuthOrWait } from '../sso.auth-gate.js';
import { clearAnalyticsAuthStatus, getAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { getLastSignInAt, startDetachedSsoLogin, waitForDetachedSsoLogin } from '@/providers/plugins/sso/sso.detached-login.js';

// env: {} keeps CODEMIE_PROFILE_CONFIG / CODEMIE_URL of an enclosing CodeMie session out of the URL resolution.
const configured = {
  provider: 'ai-run-sso',
  ssoUrl: 'https://codemie.example.com',
  syncApiUrl: 'https://api.example.com',
  env: {},
};
const PROD = 'https://prod.example.com';
const PREVIEW = 'https://preview.example.com';

describe('ensureCodeMieSsoAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(null);
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
    vi.mocked(getLastSignInAt).mockResolvedValue(null);
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

  it('ignores a marker written for a different profile (PR #655 review: marker not keyed by environment)', async () => {
    // The marker's own baseUrl (PROD) matches neither this profile's syncApiUrl nor its ssoUrl
    // (PREVIEW) — a redirect in PROD's proxy must not block or re-login a healthy PREVIEW session.
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401', baseUrl: PROD } as never);

    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', ssoUrl: PREVIEW, syncApiUrl: PREVIEW });

    expect(result).toEqual({ ok: true });
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('matches a marker whose targetApiUrl host differs from CODEMIE_URL, via the input.baseUrl candidate (PR #661 review)', async () => {
    // The marker is keyed to the LLM-request proxy's own target URL, which can be on a
    // different host than CODEMIE_URL/CODEMIE_SYNC_API_URL (e.g. a dedicated LLM gateway).
    // hook.ts now passes the preserved CODEMIE_TARGET_API_URL as input.baseUrl for exactly this
    // case — the gate must still match and block even though ssoUrl/syncApiUrl's host differs.
    const TARGET_API_URL = 'https://llm-gateway.example.com';
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401', baseUrl: TARGET_API_URL } as never);

    const result = await ensureCodeMieSsoAuth({
      provider: 'ai-run-sso',
      ssoUrl: 'https://codemie.example.com',
      syncApiUrl: 'https://codemie.example.com',
      baseUrl: TARGET_API_URL,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('rejected the stored credentials');
  });

  it('still applies a marker with no baseUrl of its own (old format, never crashes)', async () => {
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401' } as never); // no baseUrl field at all

    const result = await ensureCodeMieSsoAuth(configured);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('rejected the stored credentials');
  });

  it('blocks without starting a sign-in when the provider is SSO but no url is configured', async () => {
    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', env: {} });

    // 'failed' (not undefined) so describeLogin tells the user to sign in, not to check an API key.
    expect(result).toEqual({ ok: false, reason: 'no valid CodeMie SSO credentials found', loginOutcome: 'failed' });
    expect(getStoredCredentials).not.toHaveBeenCalled();
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('reports a sign-in outcome for an SSO provider with an api key and a rejected-credentials marker', async () => {
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401' } as never);

    const result = await ensureCodeMieSsoAuth({ ...configured, apiKey: 'key' });

    expect(result).toMatchObject({ ok: false, loginOutcome: 'failed' });
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('leaves the outcome undefined for a genuine (non-SSO) api-key failure', async () => {
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401' } as never);

    const result = await ensureCodeMieSsoAuth({ ssoUrl: configured.ssoUrl, syncApiUrl: configured.syncApiUrl, apiKey: 'key' });

    expect(result).toMatchObject({ ok: false, loginOutcome: undefined });
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

  describe('marker older than the last sign-in', () => {
    const SIGNED_IN_AT = 2_000_000;
    const marker = (detectedAt: unknown, baseUrl?: string): never =>
      ({ status: 'invalid', reason: 'HTTP 401', detectedAt, ...(baseUrl ? { baseUrl } : {}) }) as never;

    beforeEach(() => {
      getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
      vi.mocked(getLastSignInAt).mockResolvedValue(SIGNED_IN_AT);
    });

    it('clears a marker detected before the sign-in and lets the prompt through', async () => {
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(SIGNED_IN_AT - 1));

      expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
      expect(clearAnalyticsAuthStatus).toHaveBeenCalledTimes(1);
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it.each([
      ['equal to the sign-in', SIGNED_IN_AT],
      ['after the sign-in', SIGNED_IN_AT + 1],
    ])('keeps a marker detected %s and blocks with a sign-in', async (_name, detectedAt) => {
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(detectedAt));

      const result = await ensureCodeMieSsoAuth(configured);

      expect(result).toMatchObject({ ok: false, loginOutcome: 'started' });
      expect(clearAnalyticsAuthStatus).not.toHaveBeenCalled();
    });

    it('does not clear when the re-read before the clear shows a newer marker', async () => {
      vi.mocked(getAnalyticsAuthStatus)
        .mockResolvedValueOnce(marker(SIGNED_IN_AT - 1))
        .mockResolvedValueOnce(marker(SIGNED_IN_AT + 5));

      const result = await ensureCodeMieSsoAuth(configured);

      expect(result).toMatchObject({ ok: false, loginOutcome: 'started' });
      expect(clearAnalyticsAuthStatus).not.toHaveBeenCalled();
    });

    it('reads the sign-in stamp once, before the marker re-read, and ties the clear to the judged marker', async () => {
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(SIGNED_IN_AT - 1));

      expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });

      expect(getLastSignInAt).toHaveBeenCalledTimes(1);
      const stampRead = vi.mocked(getLastSignInAt).mock.invocationCallOrder[0];
      const markerReads = vi.mocked(getAnalyticsAuthStatus).mock.invocationCallOrder;
      expect(markerReads).toHaveLength(2);
      expect(stampRead).toBeLessThan(markerReads[1]);
      expect(clearAnalyticsAuthStatus).toHaveBeenCalledWith({ ifDetectedAt: SIGNED_IN_AT - 1 });
    });

    it('passes when the marker disappears between the read and the re-read', async () => {
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValueOnce(marker(SIGNED_IN_AT - 1)).mockResolvedValueOnce(null);

      expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('does not clear a marker without a sign-in stamp', async () => {
      vi.mocked(getLastSignInAt).mockResolvedValue(null);
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(1));

      expect(await ensureCodeMieSsoAuth(configured)).toMatchObject({ ok: false });
      expect(clearAnalyticsAuthStatus).not.toHaveBeenCalled();
    });

    it.each([['missing', undefined], ['a string', '5'], ['NaN', NaN]])(
      'does not clear a marker whose detectedAt is %s',
      async (_name, detectedAt) => {
        vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(detectedAt));

        expect(await ensureCodeMieSsoAuth(configured)).toMatchObject({ ok: false });
        expect(clearAnalyticsAuthStatus).not.toHaveBeenCalled();
      }
    );

    it('does not clear a marker written for a different profile', async () => {
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(SIGNED_IN_AT - 1, PROD));

      const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', ssoUrl: PREVIEW, syncApiUrl: PREVIEW });

      expect(result).toEqual({ ok: true });
      expect(clearAnalyticsAuthStatus).not.toHaveBeenCalled();
      expect(getLastSignInAt).not.toHaveBeenCalled();
    });

    it('does not clear when an api key is set', async () => {
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(SIGNED_IN_AT - 1));

      const result = await ensureCodeMieSsoAuth({ ...configured, apiKey: 'key' });

      expect(result.ok).toBe(false);
      expect(clearAnalyticsAuthStatus).not.toHaveBeenCalled();
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
    });

    it('still passes when the clear does nothing', async () => {
      vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(marker(SIGNED_IN_AT - 1));
      vi.mocked(clearAnalyticsAuthStatus).mockResolvedValue(undefined);

      expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
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

describe('ensureCodeMieSsoAuthOrWait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue(null);
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
    vi.mocked(waitForDetachedSsoLogin).mockResolvedValue({ status: 'succeeded' });
  });

  it('allows the prompt after a successful wait and re-check', async () => {
    getStoredCredentials.mockResolvedValueOnce(null).mockResolvedValue({ cookies: { a: 'b' } });
    const onWaitStart = vi.fn();

    expect(await ensureCodeMieSsoAuthOrWait(configured, { onWaitStart })).toEqual({ ok: true });
    expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
    expect(onWaitStart).toHaveBeenCalledTimes(1);
    expect(onWaitStart).toHaveBeenCalledWith('login:started:auto');
    expect(waitForDetachedSsoLogin).toHaveBeenCalledWith({ timeoutMs: 150_000 });
  });

  it('still blocks when the re-check fails after a succeeded wait (another profile signed in)', async () => {
    getStoredCredentials.mockResolvedValue(null);
    vi.mocked(startDetachedSsoLogin).mockResolvedValueOnce('started').mockResolvedValue('signed-in-recently');

    const result = await ensureCodeMieSsoAuthOrWait(configured);

    // waitResult lets describeLogin say the sign-in finished instead of the misleading cooldown text.
    expect(result).toMatchObject({ ok: false, loginOutcome: 'signed-in-recently', waitResult: { status: 'succeeded' } });
    expect(waitForDetachedSsoLogin).toHaveBeenCalledTimes(1);
  });

  it('does not wait or promise auto-continue when the allowed wait is too short', async () => {
    getStoredCredentials.mockResolvedValue(null);
    const onWaitStart = vi.fn();

    const result = await ensureCodeMieSsoAuthOrWait(configured, { waitMs: 15_000, onWaitStart });

    expect(result).toMatchObject({ ok: false, loginOutcome: 'started' });
    expect(result).not.toHaveProperty('waitResult');
    expect(onWaitStart).not.toHaveBeenCalled();
    expect(waitForDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'failed' as const, error: 'Authentication cancelled by user' }],
    [{ status: 'timeout' as const }],
  ])('blocks with the wait result when the wait ends %j', async (waitResult) => {
    getStoredCredentials.mockResolvedValue(null);
    vi.mocked(waitForDetachedSsoLogin).mockResolvedValue(waitResult);

    const result = await ensureCodeMieSsoAuthOrWait(configured);

    expect(result).toMatchObject({ ok: false, loginOutcome: 'started', waitResult });
  });

  it('waits for an in-progress sign-in started by an earlier prompt', async () => {
    getStoredCredentials.mockResolvedValueOnce(null).mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('in-progress');

    expect(await ensureCodeMieSsoAuthOrWait(configured)).toEqual({ ok: true });
    expect(waitForDetachedSsoLogin).toHaveBeenCalledTimes(1);
  });

  it.each([['cooldown' as const], ['signed-in-recently' as const], ['failed' as const]])('does not wait on a %s outcome', async (outcome) => {
    getStoredCredentials.mockResolvedValue(null);
    vi.mocked(startDetachedSsoLogin).mockResolvedValue(outcome);

    const result = await ensureCodeMieSsoAuthOrWait(configured);

    expect(result).toMatchObject({ ok: false, loginOutcome: outcome });
    expect(waitForDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('does not wait when an api key is set', async () => {
    vi.mocked(getAnalyticsAuthStatus).mockResolvedValue({ reason: 'HTTP 401' } as never);

    expect((await ensureCodeMieSsoAuthOrWait({ ...configured, apiKey: 'key' })).ok).toBe(false);
    expect(waitForDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('does not wait when the gate check failed unexpectedly', async () => {
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(getAnalyticsAuthStatus).mockRejectedValue(new Error('boom'));

    const result = await ensureCodeMieSsoAuthOrWait(configured);

    expect(result).toMatchObject({ ok: false, reason: 'CodeMie SSO auth gate check failed unexpectedly' });
    expect(waitForDetachedSsoLogin).not.toHaveBeenCalled();
  });
});

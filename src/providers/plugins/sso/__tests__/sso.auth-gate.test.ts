import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockAuthenticate = vi.fn();
vi.mock('../sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = mockGetStoredCredentials;
    authenticate = mockAuthenticate;
  },
}));

const mockGetAnalyticsAuthStatus = vi.fn();
vi.mock('../../../../utils/analytics-auth-status.js', () => ({
  getAnalyticsAuthStatus: () => mockGetAnalyticsAuthStatus(),
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ensureCodeMieSsoAuth } from '../sso.auth-gate.js';

const PROD = 'https://prod.example.com/code-assistant-api';
const PREVIEW = 'https://preview.example.com';

describe('ensureCodeMieSsoAuth (profile-first)', () => {
  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
    mockAuthenticate.mockReset().mockResolvedValue(undefined);
    mockGetAnalyticsAuthStatus.mockReset().mockResolvedValue(null);
  });

  it('passes with the profile login even when the workspace environment has no login', async () => {
    mockGetStoredCredentials.mockImplementation(async (url: string) =>
      url === PROD ? { cookies: { a: 'b' }, apiUrl: PROD } : null
    );

    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', baseUrl: PROD, ssoUrl: PREVIEW });

    expect(result).toEqual({ ok: true });
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('re-authenticates against the profile URL, not the workspace URL', async () => {
    mockGetStoredCredentials.mockResolvedValue(null);

    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', baseUrl: PROD, ssoUrl: PREVIEW });

    expect(result.ok).toBe(false);
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ codeMieUrl: PROD }));
  });

  it('does not accept another environment\'s workspace login for the profile', async () => {
    mockGetStoredCredentials.mockImplementation(async (url: string) =>
      url === PREVIEW ? { cookies: { a: 'b' }, apiUrl: `${PREVIEW}/code-assistant-api` } : null
    );

    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', baseUrl: PROD, ssoUrl: PREVIEW });

    expect(result.ok).toBe(false);
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ codeMieUrl: PROD }));
  });

  it('reads the profile URL from CODEMIE_PROFILE_CONFIG in the supplied env', async () => {
    mockGetStoredCredentials.mockImplementation(async (url: string) =>
      url === PROD ? { cookies: { a: 'b' }, apiUrl: PROD } : null
    );
    const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: PROD }) };

    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', ssoUrl: PREVIEW, env });

    expect(result).toEqual({ ok: true });
  });

  it('keeps using the workspace URL for non-CodeMie providers', async () => {
    mockGetStoredCredentials.mockImplementation(async (url: string) =>
      url === PREVIEW ? { cookies: { a: 'b' } } : null
    );

    const result = await ensureCodeMieSsoAuth({
      provider: 'anthropic-subscription',
      ssoUrl: PREVIEW,
      syncApiUrl: PREVIEW,
    });

    expect(result).toEqual({ ok: true });
  });

  it('still blocks when the metrics endpoint rejected the stored credentials', async () => {
    mockGetStoredCredentials.mockResolvedValue({ cookies: { a: 'b' }, apiUrl: PROD });
    mockGetAnalyticsAuthStatus.mockResolvedValue({ reason: 'HTTP 401' });

    const result = await ensureCodeMieSsoAuth({ provider: 'ai-run-sso', baseUrl: PROD });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('HTTP 401');
  });
});

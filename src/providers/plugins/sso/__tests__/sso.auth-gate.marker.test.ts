import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getStoredCredentials = vi.fn();

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function () {
    return { getStoredCredentials };
  }),
  // Real implementation mirrored here since this mock factory replaces the whole
  // module — see sso.auth.ts for the canonical definition.
  hasUsableSsoCredential: (cookies?: Record<string, string>, authorization?: string) =>
    Object.keys(cookies ?? {}).length > 0 || Boolean(authorization?.trim()),
}));
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

import { ensureCodeMieSsoAuth } from '../sso.auth-gate.js';
import { getAnalyticsAuthStatus, markAnalyticsAuthInvalid } from '@/utils/analytics-auth-status.js';
import { getLastSignInAt, startDetachedSsoLogin } from '@/providers/plugins/sso/sso.detached-login.js';

const BASE_URL = 'https://codemie.example.com';
const configured = { provider: 'ai-run-sso', ssoUrl: BASE_URL, syncApiUrl: BASE_URL };

describe('ensureCodeMieSsoAuth with real marker files', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'codemie-auth-gate-marker-'));
    process.env.CODEMIE_HOME = home;
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
    vi.mocked(startDetachedSsoLogin).mockResolvedValue('started');
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('removes a marker older than the last sign-in and passes', async () => {
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
    const marker = await getAnalyticsAuthStatus();
    expect(marker).not.toBeNull();
    vi.mocked(getLastSignInAt).mockResolvedValue(marker!.detectedAt + 1);

    expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
    expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(false);
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  it('blocks on a later genuine re-mark after the stale one was cleared', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
    vi.mocked(getLastSignInAt).mockResolvedValue(1_000_500);
    expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
    expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(false);

    vi.setSystemTime(1_001_000);
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);

    const result = await ensureCodeMieSsoAuth(configured);

    expect(result).toMatchObject({ ok: false, loginOutcome: 'started' });
    expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(true);
  });
});

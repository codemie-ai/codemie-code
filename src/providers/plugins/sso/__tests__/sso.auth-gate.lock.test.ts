import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getStoredCredentials = vi.fn();

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function () {
    return { getStoredCredentials };
  }),
}));
vi.mock('@/utils/processes.js', () => ({
  spawnDetached: vi.fn(() => 4242),
  isProcessAlive: vi.fn(() => true),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuth } from '../sso.auth-gate.js';
import { markAnalyticsAuthInvalid, getAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { spawnDetached } from '@/utils/processes.js';

const BASE_URL = 'https://codemie.example.com';
const configured = { provider: 'ai-run-sso', ssoUrl: BASE_URL, syncApiUrl: BASE_URL };

describe('ensureCodeMieSsoAuth with the real sign-in lock', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'codemie-auth-gate-lock-'));
    process.env.CODEMIE_HOME = home;
    getStoredCredentials.mockResolvedValue({ cookies: { a: 'b' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('clears a marker older than the last sign-in while the lock belongs to a newer in-progress attempt', async () => {
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
    const marker = await getAnalyticsAuthStatus();
    // An earlier sign-in newer than the marker, and a lock that now belongs to an unfinished attempt.
    writeFileSync(
      join(home, 'sso-login.lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), lastSucceededAt: marker!.detectedAt + 1 })
    );

    expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
    expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(false);
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('keeps a marker written after the earlier sign-in even though a newer attempt holds the lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(2_000_000);
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
    writeFileSync(
      join(home, 'sso-login.lock'),
      JSON.stringify({ pid: process.pid, startedAt: 2_000_000, lastSucceededAt: 1_000_000 })
    );

    const result = await ensureCodeMieSsoAuth(configured);

    expect(result).toMatchObject({ ok: false, loginOutcome: 'in-progress' });
    expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(true);
  });

  describe('a sign-in on another CodeMie URL', () => {
    const OTHER_URL = 'https://other.example.com';

    it('does not clear this profile\'s stale marker', async () => {
      await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
      const marker = await getAnalyticsAuthStatus();
      writeFileSync(
        join(home, 'sso-login.lock'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now(), succeededAt: marker!.detectedAt + 1, url: OTHER_URL })
      );

      const result = await ensureCodeMieSsoAuth(configured);

      expect(result.ok).toBe(false);
      expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(true);
    });

    it('still clears the marker for a sign-in on this profile\'s own URL', async () => {
      await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
      const marker = await getAnalyticsAuthStatus();
      writeFileSync(
        join(home, 'sso-login.lock'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now(), succeededAt: marker!.detectedAt + 1, url: `${BASE_URL}/` })
      );

      expect(await ensureCodeMieSsoAuth(configured)).toEqual({ ok: true });
      expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(false);
    });

    it('does not clear it through a carried-forward stamp made for the other URL', async () => {
      await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
      const marker = await getAnalyticsAuthStatus();
      writeFileSync(
        join(home, 'sso-login.lock'),
        JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          url: BASE_URL,
          lastSucceededAt: marker!.detectedAt + 1,
          lastSucceededUrl: OTHER_URL,
        })
      );

      const result = await ensureCodeMieSsoAuth(configured);

      expect(result.ok).toBe(false);
      expect(existsSync(join(home, 'analytics-auth-status.json'))).toBe(true);
    });
  });
});

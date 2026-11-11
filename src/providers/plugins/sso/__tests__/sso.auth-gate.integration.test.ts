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
// From source the detached-login child script (dist/bin/sso-login.js) does not exist; pretend it does.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (path: Parameters<typeof actual.existsSync>[0]) =>
    String(path).endsWith('sso-login.js') || actual.existsSync(path);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});
// The sign-in lock, cooldown and wait are real; only the browser sign-in process is not started.
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  spawnDetached: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuthOrWait } from '../sso.auth-gate.js';
import { SSOSessionExpiryPlugin } from '../proxy/plugins/sso-session-expiry.plugin.js';
import type { IncomingMessage } from 'http';
import { releaseLoginLockOnSuccess } from '@/providers/plugins/sso/sso.detached-login.js';
import { spawnDetached } from '@/utils/processes.js';

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
    // The "sign-in process" is this process, so the lock's owner check lets the test finish it.
    vi.mocked(spawnDetached).mockReturnValue(process.pid);
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
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(clearSSOCredentials).not.toHaveBeenCalled();
  });

  describe('after the session-expiry plugin records a rejection', () => {
    const cookieCredentials = {
      cookies: { _oauth2_proxy: 'cookie-value' },
      apiUrl: `${BASE_URL}/code-assistant-api`,
    };

    /** Runs the real plugin interceptor against a fake upstream response and returns what it hands on. */
    async function passThroughPlugin(response: Partial<IncomingMessage>, responseBody: Buffer): Promise<IncomingMessage> {
      const plugin = new SSOSessionExpiryPlugin();
      const interceptor = await plugin.createInterceptor({
        credentials: cookieCredentials,
        config: { targetApiUrl: `${BASE_URL}/code-assistant-api` },
      } as never);
      const tools = {
        readBody: vi.fn().mockResolvedValue(responseBody),
        retry: vi.fn(),
        fromBuffer: vi.fn().mockImplementation((source: IncomingMessage) => ({ statusCode: source.statusCode, headers: {} })),
      };
      return interceptor.onUpstreamResponse!(
        { headers: { cookie: '_oauth2_proxy=cookie-value' } } as never,
        response as IncomingMessage,
        tools as never
      );
    }

    /** Same, for a rejection: the client gets the plugin's synthetic 401. */
    async function rejectThroughPlugin(response: Partial<IncomingMessage>, responseBody: Buffer): Promise<void> {
      const result = await passThroughPlugin(response, responseBody);
      expect(result.statusCode).toBe(401);
    }

    beforeEach(() => {
      retrieveSSOCredentials.mockResolvedValue({ ...cookieCredentials, expiresAt: Date.now() + 3_600_000 });
    });

    const sessionRejectionBody = Buffer.from(JSON.stringify({ error: { message: 'Authentication failed' } }), 'utf-8');
    const rejections: Array<[string, Partial<IncomingMessage>, Buffer]> = [
      ['an oauth2 redirect', { statusCode: 302, headers: { location: `${BASE_URL}/oauth2/start?rd=/` } }, Buffer.alloc(0)],
      ['a session-shaped 401', { statusCode: 401, headers: {} }, sessionRejectionBody],
    ];

    // The plugin and the gate both ask for a sign-in; the real lock makes them one browser launch.
    it.each(rejections)('launches one sign-in for %s across plugin and gate, and proceeds once it succeeds', async (_name, response, body) => {
      await rejectThroughPlugin(response, body);
      expect(spawnDetached).toHaveBeenCalledTimes(1); // the plugin's sign-in

      // The sign-in completes shortly after the gate starts waiting for it.
      const finishSignIn = setTimeout(() => void releaseLoginLockOnSuccess(), 200);
      let result;
      try {
        result = await ensureCodeMieSsoAuthOrWait(configured, { waitMs: 60_000 });
      } finally {
        clearTimeout(finishSignIn);
      }

      expect(result).toEqual({ ok: true });
      expect(spawnDetached).toHaveBeenCalledTimes(1); // the gate joined that sign-in instead of launching another
      expect(openBrowser).not.toHaveBeenCalled();
    });

    it('starts no sign-in for a 401 that is not the backend session rejection', async () => {
      const litellmBody = Buffer.from(JSON.stringify({ error: { message: 'Invalid proxy server token passed' } }), 'utf-8');
      const result = await passThroughPlugin({ statusCode: 401, headers: {} }, litellmBody);

      expect(result.statusCode).toBe(401);
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(await ensureCodeMieSsoAuthOrWait(configured, { waitMs: 60_000 })).toEqual({ ok: true });
      expect(spawnDetached).not.toHaveBeenCalled();
    });
  });
});

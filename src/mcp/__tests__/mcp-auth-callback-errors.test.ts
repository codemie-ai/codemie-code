/**
 * MCP OAuth callback server: default timeout, typed errors, safe error page.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from 'node:http';
import {
  startCallbackServer,
  CallbackTimeoutError,
  OAuthCallbackError,
  type CallbackResult,
} from '../auth/callback-server.js';
import { useTempCodemieHome } from './helpers/temp-home.js';

useTempCodemieHome();

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Plain http GET (not fetch) so fake timers never interfere with client-side timers. */
function get(url: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function callbackUrl(redirectUrl: string, query: string): string {
  return `${redirectUrl}?${query}`;
}

/** Capture the settled outcome without leaving an unhandled rejection. */
function outcomeOf(p: Promise<CallbackResult>): Promise<{ ok?: CallbackResult; err?: Error }> {
  return p.then(
    (ok) => ({ ok }),
    (err: Error) => ({ err }),
  );
}

describe('callback server timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a 300 s default: still accepts a callback at 299 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { redirectUrl, waitForCallback } = await startCallbackServer();
    const outcome = outcomeOf(waitForCallback);

    await vi.advanceTimersByTimeAsync(299_000);
    const res = await get(callbackUrl(redirectUrl, 'code=late&state=s'));
    expect(res.status).toBe(200);

    expect((await outcome).ok).toEqual({ code: 'late', state: 's' });
  });

  it('rejects with CallbackTimeoutError after the 300 s default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { waitForCallback } = await startCallbackServer();
    const outcome = outcomeOf(waitForCallback);

    await vi.advanceTimersByTimeAsync(299_999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const { err } = await outcome;
    expect(err).toBeInstanceOf(CallbackTimeoutError);
    expect((err as CallbackTimeoutError).timeoutMs).toBe(300_000);
    expect(err?.message).toBe('OAuth authorization timed out after 300s');
  });

  it('honours MCP_PROXY_AUTH_TIMEOUT_SECONDS=10', async () => {
    process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS = '10';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { waitForCallback } = await startCallbackServer();
    const outcome = outcomeOf(waitForCallback);

    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const { err } = await outcome;
    expect(err).toBeInstanceOf(CallbackTimeoutError);
    expect((err as CallbackTimeoutError).timeoutMs).toBe(10_000);
  });

  it('an explicit timeoutMs still wins and is reported on the error', async () => {
    const { waitForCallback } = await startCallbackServer({ timeoutMs: 250 });
    const { err } = await outcomeOf(waitForCallback);
    expect(err).toBeInstanceOf(CallbackTimeoutError);
    expect((err as CallbackTimeoutError).timeoutMs).toBe(250);
    expect(err?.message).toBe('OAuth authorization timed out after 0.25s');
  });
});

describe('callback server OAuth errors', () => {
  it('rejects with OAuthCallbackError carrying the error code', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const outcome = outcomeOf(waitForCallback);
    await get(callbackUrl(redirectUrl, 'error=insufficient_scope&error_description=x'));

    const { err } = await outcome;
    expect(err).toBeInstanceOf(OAuthCallbackError);
    const typed = err as OAuthCallbackError;
    expect(typed.oauthError).toBe('insufficient_scope');
    expect(typed.description).toBe('x');
    expect(typed.message).toBe('OAuth error: insufficient_scope — x');
  });

  it('handles an error with no description', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const outcome = outcomeOf(waitForCallback);
    const res = await get(callbackUrl(redirectUrl, 'error=access_denied'));
    expect(res.status).toBe(200);

    const { err } = await outcome;
    expect(err).toBeInstanceOf(OAuthCallbackError);
    expect((err as OAuthCallbackError).oauthError).toBe('access_denied');
    expect((err as OAuthCallbackError).description).toBeUndefined();
    expect(err?.message).toBe('OAuth error: access_denied');
  });

  it('escapes HTML in the page, strips control chars from the message, sends hardening headers', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const outcome = outcomeOf(waitForCallback);
    const description = encodeURIComponent('<script>alert(1)</script>\nsecond\tline\r\u0007');
    const res = await get(callbackUrl(redirectUrl, `error=server_error&error_description=${description}`));

    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).not.toContain('<script>');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const { err } = await outcome;
    expect(err).toBeInstanceOf(OAuthCallbackError);
    // eslint-disable-next-line no-control-regex
    expect(err?.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(err?.message).toContain('second');
  });

  it('escapes and sanitises the error code too', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const outcome = outcomeOf(waitForCallback);
    const code = encodeURIComponent('<img src=x onerror=1>\n');
    const res = await get(callbackUrl(redirectUrl, `error=${code}`));

    expect(res.body).not.toContain('<img');
    expect(res.body).toContain('&lt;img');
    const { err } = await outcome;
    expect(err).toBeInstanceOf(OAuthCallbackError);
    // eslint-disable-next-line no-control-regex
    expect((err as OAuthCallbackError).oauthError).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('truncates a 10k-char description to 200 chars in the page and the error', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const outcome = outcomeOf(waitForCallback);
    const res = await get(callbackUrl(redirectUrl, `error=server_error&error_description=${'a'.repeat(10_000)}`));

    expect(res.body).not.toContain('a'.repeat(201));
    expect(res.body).toContain('a'.repeat(200));
    expect(res.body.length).toBeLessThan(2000);

    const { err } = await outcome;
    const typed = err as OAuthCallbackError;
    expect(typed.description).toBe('a'.repeat(200));
    expect(typed.message).toBe(`OAuth error: server_error — ${'a'.repeat(200)}`);
  });

  it('truncates a 10k-char error code to 200 chars', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const outcome = outcomeOf(waitForCallback);
    const res = await get(callbackUrl(redirectUrl, `error=${'b'.repeat(10_000)}`));

    expect(res.body).not.toContain('b'.repeat(201));
    const { err } = await outcome;
    expect((err as OAuthCallbackError).oauthError).toBe('b'.repeat(200));
  });

  it('sends the hardening headers on the success, missing-code and 404 responses', async () => {
    const ok = await startCallbackServer({ timeoutMs: 5000 });
    const okOutcome = outcomeOf(ok.waitForCallback);
    const okRes = await get(callbackUrl(ok.redirectUrl, 'code=abc'));
    await okOutcome;
    expect(okRes.headers['content-security-policy']).toBe("default-src 'none'");
    expect(okRes.headers['x-content-type-options']).toBe('nosniff');

    const missing = await startCallbackServer({ timeoutMs: 5000 });
    const missingOutcome = outcomeOf(missing.waitForCallback);
    const missingRes = await get(missing.redirectUrl);
    await missingOutcome;
    expect(missingRes.status).toBe(400);
    expect(missingRes.headers['content-security-policy']).toBe("default-src 'none'");
    expect(missingRes.headers['x-content-type-options']).toBe('nosniff');

    const nf = await startCallbackServer({ timeoutMs: 5000 });
    const nfOutcome = outcomeOf(nf.waitForCallback);
    const nfRes = await get(nf.redirectUrl.replace('/callback', '/nope'));
    expect(nfRes.status).toBe(404);
    expect(nfRes.headers['content-security-policy']).toBe("default-src 'none'");
    expect(nfRes.headers['x-content-type-options']).toBe('nosniff');
    nf.close();
    await nfOutcome;
  });
});

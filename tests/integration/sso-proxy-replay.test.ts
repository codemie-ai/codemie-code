/**
 * SSO proxy replay contract — end-to-end regression test.
 *
 * WHY: after a sign-in replaces the stored credentials, a request still carrying the old Cookie
 * gets an oauth2-proxy redirect. The proxy must replay that request once with the new Cookie
 * instead of treating the redirect as an expired session (which would start a second browser
 * sign-in). The replay works only if the proxy's `retry` forwards the live, mutated request
 * headers; unit tests replace `retry`, so this runs the real CodeMieProxy against a mock upstream.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/core/codemie-auth-helpers.js')>()),
  getStoredPlatformCredentials: vi.fn(),
}));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/plugins/sso/sso.detached-login.js')>()),
  startDetachedSsoLogin: vi.fn(async () => 'started'),
}));

import { getStoredPlatformCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { startDetachedSsoLogin } from '@/providers/plugins/sso/sso.detached-login.js';
import { CodeMieProxy } from '@/providers/plugins/sso/proxy/sso.proxy.js';
import type { ProxyConfig } from '@/providers/plugins/sso/proxy/proxy-types.js';
import '@/providers/plugins/sso/index.js'; // register the SSO provider
import '@/providers/plugins/sso/proxy/plugins/index.js'; // register core plugins

const GATEWAY_KEY = 'gw-secret-key';
const OLD_COOKIE = 'codemie_access_token=old-token';
const NEW_COOKIE = 'codemie_access_token=new-token';

interface UpstreamRequest {
  method: string | undefined;
  cookie: string | undefined;
  body: string;
}

function credentials(token: string): { credentials: { cookies: Record<string, string>; apiUrl: string }; url: string } {
  return { credentials: { cookies: { codemie_access_token: token }, apiUrl: 'http://placeholder' }, url: 'http://placeholder' };
}

describe('SSO proxy replay after a superseding sign-in (end-to-end, in-process)', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let upstream: http.Server;
  let proxy: CodeMieProxy;
  let proxyUrl: string;
  let received: UpstreamRequest[];
  let storedToken: string;
  /** How the mock upstream answers request number `count` (1-based); the default is the redirect-then-200 replay case. */
  let respond: (count: number, res: http.ServerResponse) => void;

  beforeEach(async () => {
    previousHome = process.env.CODEMIE_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'codemie-proxy-replay-'));
    process.env.CODEMIE_HOME = tempHome;
    received = [];
    storedToken = 'old-token';
    vi.mocked(getStoredPlatformCredentials).mockImplementation(async () => credentials(storedToken) as never);
    vi.mocked(startDetachedSsoLogin).mockClear();
    respond = (count, res) => {
      if (count === 1) {
        // The old cookie is rejected; by then a sign-in has stored the new one.
        storedToken = 'new-token';
        res.writeHead(302, { Location: '/oauth2/start?rd=%2Fv1%2Fmessages' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method, cookie: req.headers.cookie, body: Buffer.concat(chunks).toString('utf-8') });
        respond(received.length, res);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const config: ProxyConfig = {
      targetApiUrl: `http://127.0.0.1:${port}`,
      provider: 'ai-run-sso',
      gatewayKey: GATEWAY_KEY,
      timeout: 30,
    };
    proxy = new CodeMieProxy(config);
    proxyUrl = (await proxy.start()).url;
  });

  afterEach(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (previousHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function post(): Promise<Response> {
    return fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_KEY}` },
      body: JSON.stringify({ hello: 'world' }),
    });
  }

  it('replays the request once with the new Cookie, keeps the body and writes no auth marker', async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received[0].cookie).toBe(OLD_COOKIE);
    expect(received[1].cookie).toBe(NEW_COOKIE);
    expect(received[1].method).toBe('POST');
    expect(received[1].body).toBe(received[0].body);
    expect(JSON.parse(received[1].body)).toEqual({ hello: 'world' });
    expect(existsSync(join(tempHome, 'analytics-auth-status.json'))).toBe(false);
    expect(startDetachedSsoLogin).not.toHaveBeenCalled();
  });

  describe('upstream 401', () => {
    const markerPath = () => join(tempHome, 'analytics-auth-status.json');

    it('passes a 401 that is not the backend session rejection to the client unchanged and starts no sign-in', async () => {
      // A LiteLLM error relayed by the LLM proxy: valid session, different body.
      const litellm = JSON.stringify({ error: { message: 'Invalid proxy server token passed', type: 'auth_error', code: '401' } });
      respond = (_count, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json', 'X-Upstream-Error': 'litellm' });
        res.end(litellm);
      };

      const res = await post();

      expect(res.status).toBe(401);
      expect(await res.text()).toBe(litellm);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('x-upstream-error')).toBe('litellm');
      expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(litellm)));
      expect(received).toHaveLength(1);
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
      expect(existsSync(markerPath())).toBe(false);
    });

    it('turns the backend session rejection into one sign-in and the synthetic 401 at the client', async () => {
      respond = (_count, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication failed', details: 'No valid authentication credentials were provided with this request.', help: null } }));
      };

      const res = await post();
      const body = (await res.json()) as { type: string; error: { type: string; message: string } };

      expect(res.status).toBe(401);
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.message).toMatch(/^CodeMie SSO session expired\./);
      expect(received).toHaveLength(1); // the cookies are current, so there is no replay
      expect(startDetachedSsoLogin).toHaveBeenCalledTimes(1);
      expect(existsSync(markerPath())).toBe(true);
    });

    it('replays a session rejection sent with superseded cookies once and returns the retried response', async () => {
      respond = (count, res) => {
        if (count === 1) {
          storedToken = 'new-token'; // a sign-in finished while the request was in flight
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Authentication failed' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      };

      const res = await post();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(received.map((r) => r.cookie)).toEqual([OLD_COOKIE, NEW_COOKIE]);
      expect(startDetachedSsoLogin).not.toHaveBeenCalled();
      expect(existsSync(markerPath())).toBe(false);
    });
  });
});

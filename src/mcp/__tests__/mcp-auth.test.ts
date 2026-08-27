/**
 * MCP OAuth auth unit tests.
 *
 * Covers the two deterministic halves of the browser-based MCP OAuth flow:
 *   - callback-server.ts: the ephemeral localhost HTTP server that catches the
 *     `?code=…&state=…` redirect (started on an OS-assigned port, hit with a real
 *     fetch — no browser involved).
 *   - mcp-oauth-provider.ts: the in-memory OAuthClientProvider — client metadata /
 *     redirect_uri construction, token / client-info / code-verifier storage,
 *     invalidateCredentials scoping, and the callback-server lifecycle. The browser
 *     launch (execFile) is mocked so no real browser opens.
 *
 * The actual token exchange (authorization_code → tokens) lives in the MCP SDK's
 * auth() driver, not in this provider, so it is out of scope here — see findings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the browser launch. The provider imports { execFile } from 'child_process';
// we replace only execFile (spread the rest) so no real browser opens during
// redirectToAuthorization(). The mock invokes the callback with no error.
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

import { startCallbackServer, type CallbackResult } from '../auth/callback-server.js';
import { McpOAuthProvider } from '../auth/mcp-oauth-provider.js';

/** Extract the ephemeral port from a http://localhost:PORT/callback url. */
function portOf(redirectUrl: string): string {
  return new URL(redirectUrl).port;
}

describe('startCallbackServer', () => {
  it('assigns an ephemeral localhost /callback redirect url', async () => {
    const { redirectUrl, waitForCallback, close } = await startCallbackServer({ timeoutMs: 5000 });
    // Attach a handler up-front so close()'s rejection is never unhandled.
    const outcome = waitForCallback.then(
      (r) => ({ ok: r }),
      (e: Error) => ({ err: e.message }),
    );
    expect(redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(Number(portOf(redirectUrl))).toBeGreaterThan(0);
    close();
    expect(await outcome).toEqual({ err: 'Callback server closed' });
  });

  it('captures code + state on a successful callback and serves an HTML page', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const settled: Promise<CallbackResult> = waitForCallback;
    const res = await fetch(`http://localhost:${portOf(redirectUrl)}/callback?code=abc123&state=xyz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Authorization successful');
    await expect(settled).resolves.toEqual({ code: 'abc123', state: 'xyz' });
  });

  it('omits state when the callback has none', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const settled = waitForCallback;
    await fetch(`http://localhost:${portOf(redirectUrl)}/callback?code=only-code`);
    await expect(settled).resolves.toEqual({ code: 'only-code', state: undefined });
  });

  it('rejects with the OAuth error (and description) when error param is present', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const rejection = expect(waitForCallback).rejects.toThrow(/OAuth error: access_denied — denied by user/);
    const res = await fetch(
      `http://localhost:${portOf(redirectUrl)}/callback?error=access_denied&error_description=denied%20by%20user`,
    );
    expect(res.status).toBe(200); // still serves the "you can close this tab" page
    await rejection;
  });

  it('rejects and returns 400 when the code is missing', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const rejection = expect(waitForCallback).rejects.toThrow('Missing authorization code in callback');
    const res = await fetch(`http://localhost:${portOf(redirectUrl)}/callback`);
    expect(res.status).toBe(400);
    await rejection;
  });

  it('returns 404 for non-/callback paths without settling the wait', async () => {
    const { redirectUrl, waitForCallback, close } = await startCallbackServer({ timeoutMs: 5000 });
    const outcome = waitForCallback.then(
      (r) => ({ ok: r }),
      (e: Error) => ({ err: e.message }),
    );
    const res = await fetch(`http://localhost:${portOf(redirectUrl)}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
    // Still pending — closing it now yields the close rejection, proving the 404 did not settle it.
    close();
    expect(await outcome).toEqual({ err: 'Callback server closed' });
  });

  it('rejects with a timeout error when no callback arrives in time', async () => {
    const { waitForCallback } = await startCallbackServer({ timeoutMs: 250 });
    await expect(waitForCallback).rejects.toThrow(/OAuth authorization timed out after 0\.25s/);
  });

  it('is idempotent: only the first callback settles the wait', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });
    const settled = waitForCallback;
    const base = `http://localhost:${portOf(redirectUrl)}/callback`;
    await fetch(`${base}?code=first&state=s1`);
    await expect(settled).resolves.toEqual({ code: 'first', state: 's1' });
    // A second hit after the server closed should fail to connect (server is gone).
    await expect(fetch(`${base}?code=second`)).rejects.toBeTruthy();
  });
});

describe('McpOAuthProvider — metadata & storage', () => {
  const originalName = process.env.MCP_CLIENT_NAME;
  afterEach(() => {
    if (originalName === undefined) delete process.env.MCP_CLIENT_NAME;
    else process.env.MCP_CLIENT_NAME = originalName;
  });

  it('starts empty: no redirect url, tokens, client info, and a blank verifier', () => {
    const p = new McpOAuthProvider();
    expect(p.redirectUrl).toBeUndefined();
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toBeUndefined();
    expect(p.codeVerifier()).toBe('');
  });

  it('builds clientMetadata with the default client name and empty redirect_uris', () => {
    delete process.env.MCP_CLIENT_NAME;
    const p = new McpOAuthProvider();
    expect(p.clientMetadata).toEqual({
      client_name: 'CodeMie CLI',
      redirect_uris: [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('honours MCP_CLIENT_NAME override in clientMetadata', () => {
    process.env.MCP_CLIENT_NAME = 'My Custom Client';
    const p = new McpOAuthProvider();
    expect(p.clientMetadata.client_name).toBe('My Custom Client');
  });

  it('round-trips tokens, client information, and the code verifier', () => {
    const p = new McpOAuthProvider();
    p.saveTokens({ access_token: 'at', token_type: 'bearer' });
    p.saveClientInformation({ client_id: 'cid', client_name: 'CodeMie CLI' });
    p.saveCodeVerifier('verifier-123');
    expect(p.tokens()).toEqual({ access_token: 'at', token_type: 'bearer' });
    expect(p.clientInformation()).toEqual({ client_id: 'cid', client_name: 'CodeMie CLI' });
    expect(p.codeVerifier()).toBe('verifier-123');
  });
});

describe('McpOAuthProvider — invalidateCredentials scoping', () => {
  function seeded(): McpOAuthProvider {
    const p = new McpOAuthProvider();
    p.saveTokens({ access_token: 'at', token_type: 'bearer' });
    p.saveClientInformation({ client_id: 'cid' });
    p.saveCodeVerifier('v');
    return p;
  }

  it("scope 'tokens' clears only tokens", () => {
    const p = seeded();
    p.invalidateCredentials('tokens');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toEqual({ client_id: 'cid' });
    expect(p.codeVerifier()).toBe('v');
  });

  it("scope 'client' clears only client info", () => {
    const p = seeded();
    p.invalidateCredentials('client');
    expect(p.clientInformation()).toBeUndefined();
    expect(p.tokens()).toEqual({ access_token: 'at', token_type: 'bearer' });
    expect(p.codeVerifier()).toBe('v');
  });

  it("scope 'verifier' clears only the code verifier", () => {
    const p = seeded();
    p.invalidateCredentials('verifier');
    expect(p.codeVerifier()).toBe('');
    expect(p.tokens()).toEqual({ access_token: 'at', token_type: 'bearer' });
    expect(p.clientInformation()).toEqual({ client_id: 'cid' });
  });

  it("scope 'all' clears everything", () => {
    const p = seeded();
    p.invalidateCredentials('all');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toBeUndefined();
    expect(p.codeVerifier()).toBe('');
  });

  it("scope 'discovery' leaves stored credentials intact", () => {
    const p = seeded();
    p.invalidateCredentials('discovery');
    expect(p.tokens()).toEqual({ access_token: 'at', token_type: 'bearer' });
    expect(p.clientInformation()).toEqual({ client_id: 'cid' });
    expect(p.codeVerifier()).toBe('v');
  });
});

describe('McpOAuthProvider — callback server lifecycle', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileMock.mockClear();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('ensureCallbackServer populates redirectUrl and clientMetadata.redirect_uris', async () => {
    const p = new McpOAuthProvider();
    await p.ensureCallbackServer();
    try {
      expect(p.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      expect(p.clientMetadata.redirect_uris).toEqual([p.redirectUrl]);
    } finally {
      // Drive the pending wait to a handled rejection, then clean up the server.
      const rejected = expect(p.waitForAuthorizationCode()).rejects.toThrow('Callback server closed');
      p.dispose();
      await rejected;
    }
  });

  it('ensureCallbackServer is idempotent (keeps the same redirect url)', async () => {
    const p = new McpOAuthProvider();
    await p.ensureCallbackServer();
    const first = p.redirectUrl;
    await p.ensureCallbackServer();
    try {
      expect(p.redirectUrl).toBe(first);
    } finally {
      const rejected = expect(p.waitForAuthorizationCode()).rejects.toThrow('Callback server closed');
      p.dispose();
      await rejected;
    }
  });

  it('redirectToAuthorization starts the server, launches the browser, and resolves the code on callback', async () => {
    const p = new McpOAuthProvider();
    const authUrl = new URL('https://auth.example.com/authorize?client_id=cid&response_type=code&state=st');
    await p.redirectToAuthorization(authUrl);

    // Browser launch was attempted exactly once with the full authorization URL preserved.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(Array.isArray(args) ? args.join(' ') : String(args)).toContain('https://auth.example.com/authorize');

    // redirect_uri is now populated for the SDK to register.
    expect(p.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    // Deliver the browser redirect to our loopback server; waitForAuthorizationCode resolves the code.
    const codePromise = p.waitForAuthorizationCode();
    await fetch(`http://localhost:${portOf(p.redirectUrl!)}/callback?code=the-auth-code&state=st`);
    await expect(codePromise).resolves.toBe('the-auth-code');
  });

  it('redirectToAuthorization reuses an already-started callback server', async () => {
    const p = new McpOAuthProvider();
    await p.ensureCallbackServer();
    const preUrl = p.redirectUrl;
    await p.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
    try {
      // Same server reused → same redirect url; browser still launched.
      expect(p.redirectUrl).toBe(preUrl);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    } finally {
      const rejected = expect(p.waitForAuthorizationCode()).rejects.toThrow('Callback server closed');
      p.dispose();
      await rejected;
    }
  });

  it('waitForAuthorizationCode throws when no authorization flow is active', async () => {
    const p = new McpOAuthProvider();
    await expect(p.waitForAuthorizationCode()).rejects.toThrow(
      'No active authorization flow — callback server not started',
    );
  });

  it('dispose is a safe no-op when no callback server is running', () => {
    const p = new McpOAuthProvider();
    expect(() => p.dispose()).not.toThrow();
  });
});

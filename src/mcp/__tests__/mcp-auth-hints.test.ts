/**
 * Login failure hints written by McpOAuthProvider.waitForAuthorizationCode.
 *
 * The two typed callback errors (timeout, OAuth `error` redirect) are told apart by
 * `instanceof`, never by message text. Hints go to stderr with debug off, and never hold
 * the authorization code, state or callback URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No real browser: replace only execFile, as mcp-auth.test.ts does.
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

import { CallbackTimeoutError, OAuthCallbackError } from '../auth/callback-server.js';
import { McpOAuthProvider } from '../auth/mcp-oauth-provider.js';
import { useTempCodemieHome } from './helpers/temp-home.js';

const AUTH_URL = new URL('https://gateway.example/authorize?client_id=c&state=SECRET-STATE-456');
const SECRET_CODE = 'SECRET-CODE-123';
const SECRET_STATE = 'SECRET-STATE-456';

const DEBUG_VARS = ['CODEMIE_DEBUG', 'MCP_PROXY_DEBUG'] as const;

describe('login failure hints', () => {
  useTempCodemieHome();

  let stderr: ReturnType<typeof vi.spyOn>;
  const savedDebug = new Map<string, string | undefined>();
  let provider: McpOAuthProvider;

  beforeEach(() => {
    for (const name of DEBUG_VARS) {
      savedDebug.set(name, process.env[name]);
      delete process.env[name];
    }
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    execFileMock.mockClear();
    provider = new McpOAuthProvider();
  });

  afterEach(() => {
    provider.dispose();
    stderr.mockRestore();
    vi.useRealTimers();
    for (const name of DEBUG_VARS) {
      const previous = savedDebug.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    savedDebug.clear();
  });

  /** Everything written to stderr, one string. */
  function stderrText(): string {
    return stderr.mock.calls.map((args: unknown[]) => args.map(String).join(' ')).join('\n');
  }

  /** Lines written to stderr that are not the "Opening browser" notice. */
  function hintText(): string {
    return stderr.mock.calls
      .map((args: unknown[]) => args.map(String).join(' '))
      .filter((line: string) => !line.includes('Opening browser'))
      .join('\n');
  }

  /** Start a login and return the pending wait (boxed: an async function would flatten the promise). */
  async function startLogin(): Promise<{ waiting: Promise<string> }> {
    await provider.ensureCallbackServer();
    await provider.redirectToAuthorization(AUTH_URL);
    const waiting = provider.waitForAuthorizationCode();
    // Keep a handler attached so a rejection is never unhandled while the test advances time.
    waiting.catch(() => {});
    return { waiting };
  }

  async function callback(query: string): Promise<void> {
    const port = new URL(provider.redirectUrl as string).port;
    await fetch(`http://localhost:${port}/callback?${query}`);
  }

  describe('callback timeout', () => {
    it('waits exactly the configured timeout, then hints at both env vars and rethrows the same error', async () => {
      process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS = '10';
      process.env.MCP_CLIENT_NAME = 'Claude Code (jira)';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const { waiting } = await startLogin();
      let settled = false;
      const outcome = waiting.then(
        () => ({ error: undefined as unknown }),
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(hintText()).toBe('');

      await vi.advanceTimersByTimeAsync(1);
      const { error } = await outcome;

      expect(error).toBeInstanceOf(CallbackTimeoutError);
      expect((error as CallbackTimeoutError).timeoutMs).toBe(10_000);

      const hint = hintText();
      expect(hint).toContain('MCP_PROXY_AUTH_TIMEOUT_SECONDS');
      expect(hint).toContain('Claude Code (jira)');
      expect(hint).toContain('MCP_CLIENT_NAME');
      expect(hint).toContain('insufficient_scope');
    });

    it('names the default client name when MCP_CLIENT_NAME is unset', async () => {
      process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS = '10';
      delete process.env.MCP_CLIENT_NAME;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const { waiting } = await startLogin();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(waiting).rejects.toBeInstanceOf(CallbackTimeoutError);

      expect(hintText()).toContain('CodeMie CLI');
    });

    it('says the client name shown is this proxy process env', async () => {
      process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS = '10';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const { waiting } = await startLogin();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(waiting).rejects.toBeInstanceOf(CallbackTimeoutError);

      expect(hintText()).toMatch(/proxy process/i);
    });

    it('never writes the callback URL or the state to stderr', async () => {
      process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS = '10';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const { waiting } = await startLogin();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(waiting).rejects.toBeInstanceOf(CallbackTimeoutError);

      const all = stderrText();
      expect(all).not.toContain(provider.redirectUrl as string);
      expect(all).not.toContain(SECRET_STATE);
    });
  });

  describe('insufficient_scope callback', () => {
    it('hints at MCP_CLIENT_NAME only, does not offer a longer timeout, and rethrows the same error', async () => {
      process.env.MCP_CLIENT_NAME = 'Claude Code (jira)';
      const { waiting } = await startLogin();

      await callback(
        `error=insufficient_scope&error_description=scopes%20not%20allowed&code=${SECRET_CODE}&state=${SECRET_STATE}`
      );

      const error = await waiting.then(
        () => undefined as unknown,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(OAuthCallbackError);
      expect(error).not.toBeInstanceOf(CallbackTimeoutError);
      expect((error as OAuthCallbackError).oauthError).toBe('insufficient_scope');

      const hint = hintText();
      expect(hint).toContain('MCP_CLIENT_NAME');
      expect(hint).toContain('Claude Code (jira)');
      expect(hint).not.toContain('MCP_PROXY_AUTH_TIMEOUT_SECONDS');
      expect(hint).toMatch(/proxy process/i);
    });

    it('never writes the code, the state or the callback URL to stderr', async () => {
      const { waiting } = await startLogin();

      await callback(
        `error=insufficient_scope&error_description=nope&code=${SECRET_CODE}&state=${SECRET_STATE}`
      );
      await waiting.catch(() => {});

      const all = stderrText();
      expect(all).not.toContain(SECRET_CODE);
      expect(all).not.toContain(SECRET_STATE);
      expect(all).not.toContain(provider.redirectUrl as string);
    });
  });

  describe('other failures', () => {
    it('writes no hint for another OAuth error code', async () => {
      const { waiting } = await startLogin();

      await callback('error=access_denied&error_description=user%20said%20no');

      const error = await waiting.then(
        () => undefined as unknown,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(OAuthCallbackError);
      expect((error as OAuthCallbackError).oauthError).toBe('access_denied');
      expect(hintText()).toBe('');
    });

    it('passes a dispose() mid-wait through untouched, with no hint', async () => {
      const { waiting } = await startLogin();

      provider.dispose();

      const error = await waiting.then(
        () => undefined as unknown,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CallbackTimeoutError);
      expect(error).not.toBeInstanceOf(OAuthCallbackError);
      expect((error as Error).message).toBe('Callback server closed');
      expect(hintText()).toBe('');
    });

    it('writes no hint after a successful callback', async () => {
      const { waiting } = await startLogin();

      await callback(`code=${SECRET_CODE}&state=${SECRET_STATE}`);

      await expect(waiting).resolves.toBe(SECRET_CODE);
      expect(hintText()).toBe('');
    });
  });
});

/**
 * Unit tests for the MCP proxy logger and the deterministic parts of the
 * stdio<->HTTP bridge.
 *
 * proxy-logger.ts: file logging + level/debug-env gating. `enabled` and the
 * log-file path are captured at module-eval time, so each gating case uses a
 * fresh temp HOME + vi.resetModules() + dynamic import.
 *
 * stdio-http-bridge.ts: construction, URL/config handling, and the message
 * routing wiring (stdio<->HTTP) are exercised with the MCP SDK client/server
 * transports and the OAuth provider fully mocked — NO real remote connection,
 * browser, or callback server. Paths that require a live server / real OAuth
 * (redirectToAuthorization, waitForAuthorizationCode, finishAuth token
 * exchange, and the process.exit(1) connect-failure branch) are documented in
 * findings and are not exercised here.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Shared temp HOME so the import-time mkdirSync in proxy-logger never touches
// the developer's real ~/.codemie.
// ---------------------------------------------------------------------------
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'mcp-bridge-logger-'));

const ENV_SNAPSHOT = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CODEMIE_DEBUG: process.env.CODEMIE_DEBUG,
  MCP_PROXY_DEBUG: process.env.MCP_PROXY_DEBUG,
};

function resetDebugEnv(): void {
  delete process.env.CODEMIE_DEBUG;
  delete process.env.MCP_PROXY_DEBUG;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterAll(() => {
  restoreEnv();
  try {
    rmSync(HOME_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ===========================================================================
// proxy-logger.ts
// ===========================================================================
describe('proxy-logger', () => {
  let home: string;

  async function importLogger(env: Record<string, string | undefined>) {
    resetDebugEnv();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    return import('../proxy-logger.js');
  }

  function logFilePath(): string {
    return join(home, '.codemie', 'logs', 'mcp-proxy.log');
  }

  beforeEach(() => {
    home = mkdtempSync(join(HOME_ROOT, 'home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    resetDebugEnv();
  });

  it('writes a timestamped line when MCP_PROXY_DEBUG=true', async () => {
    const { proxyLog } = await importLogger({ MCP_PROXY_DEBUG: 'true' });
    proxyLog('hello world');

    expect(existsSync(logFilePath())).toBe(true);
    const content = readFileSync(logFilePath(), 'utf8');
    // Format: [<ISO timestamp>] <message>\n
    expect(content).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello world\n$/,
    );
  });

  it('enables logging when MCP_PROXY_DEBUG=1', async () => {
    const { proxyLog } = await importLogger({ MCP_PROXY_DEBUG: '1' });
    proxyLog('via numeric flag');
    expect(readFileSync(logFilePath(), 'utf8')).toContain('via numeric flag');
  });

  it('enables logging when CODEMIE_DEBUG=true', async () => {
    const { proxyLog } = await importLogger({ CODEMIE_DEBUG: 'true' });
    proxyLog('via codemie debug');
    expect(readFileSync(logFilePath(), 'utf8')).toContain('via codemie debug');
  });

  it('enables logging when CODEMIE_DEBUG=1', async () => {
    const { proxyLog } = await importLogger({ CODEMIE_DEBUG: '1' });
    proxyLog('codemie numeric');
    expect(readFileSync(logFilePath(), 'utf8')).toContain('codemie numeric');
  });

  it('is a no-op (no file written) when no debug env is set', async () => {
    const { proxyLog } = await importLogger({});
    proxyLog('should not appear');
    expect(existsSync(logFilePath())).toBe(false);
  });

  it('is a no-op for non-truthy debug values (e.g. "false", "0")', async () => {
    const { proxyLog } = await importLogger({ MCP_PROXY_DEBUG: 'false', CODEMIE_DEBUG: '0' });
    proxyLog('nope');
    expect(existsSync(logFilePath())).toBe(false);
  });

  it('appends (does not overwrite) across multiple calls', async () => {
    const { proxyLog } = await importLogger({ MCP_PROXY_DEBUG: 'true' });
    proxyLog('line one');
    proxyLog('line two');
    const lines = readFileSync(logFilePath(), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('line one');
    expect(lines[1]).toContain('line two');
  });

  it('gating is decided at import time, not per-call', async () => {
    // Import with debug OFF -> proxyLog captured `enabled=false`.
    const { proxyLog } = await importLogger({});
    // Flipping the env afterwards must NOT retroactively enable logging.
    process.env.MCP_PROXY_DEBUG = 'true';
    proxyLog('late flag');
    expect(existsSync(logFilePath())).toBe(false);
  });
});

// ===========================================================================
// stdio-http-bridge.ts  (SDK + OAuth provider mocked — no real connection)
// ===========================================================================

// Mock state for the SDK transports and the OAuth provider, created in a
// hoisted block so the vi.mock factories below can reference it without TDZ.
const mocks = vi.hoisted(() => {
  const httpInstances: any[] = [];
  const stdioInstances: any[] = [];
  const oauthInstances: any[] = [];

  class MockStreamableHTTPClientTransport {
    url: unknown;
    opts: any;
    onmessage: ((m: unknown) => void) | undefined;
    onclose: (() => void) | undefined;
    onerror: ((e: Error) => void) | undefined;
    start = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    terminateSession = vi.fn().mockResolvedValue(undefined);
    finishAuth = vi.fn().mockResolvedValue(undefined);
    constructor(url: unknown, opts: any) {
      this.url = url;
      this.opts = opts;
      httpInstances.push(this);
    }
  }

  class MockStdioServerTransport {
    onmessage: ((m: unknown) => void) | undefined;
    onclose: (() => void) | undefined;
    onerror: ((e: Error) => void) | undefined;
    start = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      stdioInstances.push(this);
    }
  }

  class MockUnauthorizedError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'UnauthorizedError';
    }
  }

  class MockOAuthProvider {
    ensureCallbackServer = vi.fn().mockResolvedValue(undefined);
    waitForAuthorizationCode = vi.fn().mockResolvedValue('auth-code');
    dispose = vi.fn();
    constructor() {
      oauthInstances.push(this);
    }
  }

  return {
    httpInstances,
    stdioInstances,
    oauthInstances,
    MockStreamableHTTPClientTransport,
    MockStdioServerTransport,
    MockUnauthorizedError,
    MockOAuthProvider,
  };
});

vi.mock('@modelcontextprotocol/client', () => ({
  StreamableHTTPClientTransport: mocks.MockStreamableHTTPClientTransport,
  UnauthorizedError: mocks.MockUnauthorizedError,
}));

vi.mock('@modelcontextprotocol/server', () => ({
  StdioServerTransport: mocks.MockStdioServerTransport,
}));

vi.mock('../auth/mcp-oauth-provider.js', () => ({
  McpOAuthProvider: mocks.MockOAuthProvider,
}));

describe('StdioHttpBridge', () => {
  let StdioHttpBridge: typeof import('../stdio-http-bridge.js').StdioHttpBridge;
  let logs: string[];
  const SERVER_URL = 'https://example.com/mcp';

  /** Yield to the microtask/timer queue so mocked async chains settle. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(async () => {
    // Keep proxy-logger a no-op and its import-time mkdir inside temp HOME.
    resetDebugEnv();
    process.env.HOME = HOME_ROOT;
    process.env.USERPROFILE = HOME_ROOT;

    mocks.httpInstances.length = 0;
    mocks.stdioInstances.length = 0;
    mocks.oauthInstances.length = 0;

    vi.resetModules();

    const loggerMod = await import('../../utils/logger.js');
    logs = [];
    vi.spyOn(loggerMod.logger, 'debug').mockImplementation((msg: string) => {
      logs.push(msg);
    });

    ({ StdioHttpBridge } = await import('../stdio-http-bridge.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs the stdio transport and OAuth provider and logs the server URL', () => {
     
    const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
    expect(mocks.stdioInstances).toHaveLength(1);
    expect(mocks.oauthInstances).toHaveLength(1);
    // URL is normalized via new URL().toString()
    expect(logs).toContain('[mcp-proxy] Bridge created for https://example.com/mcp');
    expect(bridge).toBeInstanceOf(StdioHttpBridge);
  });

  it('normalizes an origin-only URL with a trailing slash', () => {
    new StdioHttpBridge({ serverUrl: 'https://example.com' });
    expect(logs).toContain('[mcp-proxy] Bridge created for https://example.com/');
  });

  it('throws on an invalid server URL', () => {
    expect(() => new StdioHttpBridge({ serverUrl: 'not a url' })).toThrow(TypeError);
  });

  it('start() wires stdio handlers and starts the stdio transport', async () => {
    const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
    await bridge.start();

    const stdio = mocks.stdioInstances[0];
    expect(typeof stdio.onmessage).toBe('function');
    expect(typeof stdio.onclose).toBe('function');
    expect(typeof stdio.onerror).toBe('function');
    expect(stdio.start).toHaveBeenCalledTimes(1);
    expect(logs).toContain('[mcp-proxy] Stdio transport started, waiting for messages');
  });

  it('lazily connects the HTTP transport on the first stdio message and flushes it', async () => {
    const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
    await bridge.start();

    const stdio = mocks.stdioInstances[0];
    const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };
    stdio.onmessage!(msg);
    await flush();

    // OAuth callback server pre-started, HTTP transport created + started
    expect(mocks.oauthInstances[0].ensureCallbackServer).toHaveBeenCalledTimes(1);
    expect(mocks.httpInstances).toHaveLength(1);

    const http = mocks.httpInstances[0];
    expect(http.start).toHaveBeenCalledTimes(1);
    // Server URL passed as a URL instance; fetch + authProvider wired
    expect(String(http.url)).toBe('https://example.com/mcp');
    expect(typeof http.opts.fetch).toBe('function');
    expect(http.opts.authProvider).toBe(mocks.oauthInstances[0]);

    // The queued first message was flushed to the HTTP transport
    expect(http.send).toHaveBeenCalledWith(msg);
    expect(logs).toContain('[mcp-proxy] HTTP transport connected');
    expect(logs).toContain('[mcp-proxy] Flushed 1 pending message(s)');
  });

  it('forwards subsequent stdio messages straight to the connected HTTP transport', async () => {
    const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
    await bridge.start();
    const stdio = mocks.stdioInstances[0];

    stdio.onmessage!({ jsonrpc: '2.0', id: 1, method: 'first' });
    await flush();
    const http = mocks.httpInstances[0];
    http.send.mockClear();

    const second = { jsonrpc: '2.0', id: 2, method: 'second' };
    stdio.onmessage!(second);
    await flush();

    expect(http.send).toHaveBeenCalledTimes(1);
    expect(http.send).toHaveBeenCalledWith(second);
  });

  it('routes HTTP server messages back to the stdio transport', async () => {
    const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
    await bridge.start();
    const stdio = mocks.stdioInstances[0];

    stdio.onmessage!({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await flush();
    const http = mocks.httpInstances[0];

    const serverMsg = { jsonrpc: '2.0', id: 1, result: {} };
    http.onmessage!(serverMsg);

    expect(stdio.send).toHaveBeenCalledWith(serverMsg);
    expect(logs.some((l) => l.startsWith('[mcp-proxy] Received HTTP message:'))).toBe(true);
  });

  it('shuts down both transports and the OAuth provider, and is idempotent', async () => {
    const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
    await bridge.start();
    mocks.stdioInstances[0].onmessage!({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await flush();

    const http = mocks.httpInstances[0];
    const stdio = mocks.stdioInstances[0];
    const oauth = mocks.oauthInstances[0];

    await bridge.shutdown();

    expect(oauth.dispose).toHaveBeenCalledTimes(1);
    expect(http.terminateSession).toHaveBeenCalledTimes(1);
    expect(http.close).toHaveBeenCalledTimes(1);
    expect(stdio.close).toHaveBeenCalledTimes(1);
    expect(logs).toContain('[mcp-proxy] Bridge shutdown complete');

    // Second shutdown is a no-op.
    await bridge.shutdown();
    expect(oauth.dispose).toHaveBeenCalledTimes(1);
    expect(stdio.close).toHaveBeenCalledTimes(1);
  });

  it('ignores stdio messages received after shutdown has begun', async () => {
    const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
    await bridge.start();
    await bridge.shutdown();

    const before = mocks.httpInstances.length;
    mocks.stdioInstances[0].onmessage!({ jsonrpc: '2.0', id: 9, method: 'late' });
    await flush();

    // No HTTP connection attempt was made for the post-shutdown message.
    expect(mocks.httpInstances.length).toBe(before);
  });

  describe('cookie-aware fetch wrapper', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    function fakeResponse(setCookie?: string[]) {
      return {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: {
          get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
          getSetCookie: () => setCookie ?? [],
        },
      } as unknown as Response;
    }

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    async function getCookieFetch(): Promise<typeof fetch> {
      const bridge = new StdioHttpBridge({ serverUrl: SERVER_URL });
      await bridge.start();
      mocks.stdioInstances[0].onmessage!({ jsonrpc: '2.0', id: 1, method: 'ping' });
      await flush();
      return mocks.httpInstances[0].opts.fetch as typeof fetch;
    }

    it('captures Set-Cookie then injects the stored cookie on the next request', async () => {
      fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(fakeResponse(['sid=abc123; Path=/; HttpOnly']))
        .mockResolvedValueOnce(fakeResponse([]));

      const cookieFetch = await getCookieFetch();

      // First request to the origin sets a cookie.
      await cookieFetch('https://api.example.com/rpc', {
        method: 'POST',
        body: 'payload',
        headers: new Headers(),
      });
      expect(logs.some((l) => l.includes('Cookie stored for https://api.example.com'))).toBe(true);

      // Second request to the same origin must carry the stored cookie.
      await cookieFetch('https://api.example.com/rpc', {
        method: 'POST',
        headers: new Headers(),
      });

      const secondInit = fetchSpy.mock.calls[1][1] as RequestInit;
      const headers = secondInit.headers as Headers;
      expect(headers.get('Cookie')).toBe('sid=abc123');
      expect(logs).toContain('[mcp-proxy] Injected cookies for https://api.example.com');
    });

    it('logs method, URL, and response status without throwing when no cookies are set', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse([]));
      const cookieFetch = await getCookieFetch();

      const res = await cookieFetch('https://api.example.com/health', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(logs).toContain('[mcp-proxy] HTTP GET https://api.example.com/health');
      expect(logs).toContain('[mcp-proxy] HTTP response: 200 OK');
      // No cookies were captured/injected.
      expect(logs.some((l) => l.includes('Cookie stored'))).toBe(false);
      expect(logs.some((l) => l.includes('Injected cookies'))).toBe(false);
    });
  });
});

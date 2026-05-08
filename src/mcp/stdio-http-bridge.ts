/**
 * Stdio-to-HTTP MCP Bridge
 *
 * Pipes JSON-RPC messages between a StdioServerTransport (Claude Code side)
 * and a StreamableHTTPClientTransport (real MCP server side).
 *
 * Lazy connect: the HTTP transport is created and started only when the first
 * stdio message arrives. If the server requires OAuth, the auth flow runs during
 * that first connection (blocking the first message until auth completes).
 *
 * Cookie jar: Node's fetch doesn't persist cookies between requests. Some MCP
 * auth gateways set session cookies during the OAuth flow that must be sent with
 * subsequent requests. The bridge maintains a per-origin cookie jar automatically.
 */

import {
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { logger } from '../utils/logger.js';
import { proxyLog } from './proxy-logger.js';
import { McpOAuthProvider } from './auth/mcp-oauth-provider.js';

function log(msg: string): void {
  logger.debug(msg);
  proxyLog(msg);
}

/** Serialize an error with all available details (message, cause, status, body, stack). */
function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [`${error.constructor.name}: ${error.message}`];
  for (const key of ['status', 'statusCode', 'code', 'body', 'response', 'statusText', 'data']) {
    const val = (error as unknown as Record<string, unknown>)[key];
    if (val !== undefined) parts.push(`  ${key}: ${JSON.stringify(val).slice(0, 500)}`);
  }
  if (error.cause) parts.push(`  cause: ${errorDetail(error.cause)}`);
  if (error.stack) parts.push(`  stack: ${error.stack}`);
  return parts.join('\n');
}

/**
 * Minimal cookie jar: stores Set-Cookie values keyed by origin, sends them
 * back on subsequent requests to the same origin.
 */
class CookieJar {
  /** origin → Map<cookie-name, full-cookie-string> */
  private cookies = new Map<string, Map<string, string>>();

  /** Extract and store cookies from a response's Set-Cookie headers. */
  capture(requestUrl: string, response: Response): void {
    const origin = new URL(requestUrl).origin;
    // getSetCookie() returns individual Set-Cookie header values
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;

    let jar = this.cookies.get(origin);
    if (!jar) {
      jar = new Map();
      this.cookies.set(origin, jar);
    }
    for (const raw of setCookies) {
      const name = raw.split('=')[0]?.trim();
      if (name) {
        jar.set(name, raw.split(';')[0]!); // store "name=value" only
        log(`[mcp-proxy] Cookie stored for ${origin}: ${name}=***`);
      }
    }
  }

  /** Build a Cookie header value for the given request URL. */
  headerFor(requestUrl: string): string | undefined {
    const origin = new URL(requestUrl).origin;
    const jar = this.cookies.get(origin);
    if (!jar || jar.size === 0) return undefined;
    return [...jar.values()].join('; ');
  }
}

export interface BridgeOptions {
  /** The real MCP server URL to connect to */
  serverUrl: string;
}

export class StdioHttpBridge {
  private stdioTransport: StdioServerTransport;
  private httpTransport: StreamableHTTPClientTransport | null = null;
  private oauthProvider: McpOAuthProvider;
  private serverUrl: URL;
  private cookieJar = new CookieJar();
  private connected = false;
  private connecting = false;
  private shuttingDown = false;
  private pendingMessages: JSONRPCMessage[] = [];

  constructor(options: BridgeOptions) {
    this.serverUrl = new URL(options.serverUrl);
    this.oauthProvider = new McpOAuthProvider();
    this.stdioTransport = new StdioServerTransport();
    log(`[mcp-proxy] Bridge created for ${this.serverUrl}`);
  }

  /**
   * Start the bridge: begin listening on stdio immediately.
   * HTTP connection is deferred until the first message arrives.
   */
  async start(): Promise<void> {
    this.stdioTransport.onmessage = (message: JSONRPCMessage) => {
      this.handleStdioMessage(message);
    };

    this.stdioTransport.onclose = () => {
      log('[mcp-proxy] Stdio transport closed');
      this.shutdown();
    };

    this.stdioTransport.onerror = (error: Error) => {
      log(`[mcp-proxy] Stdio transport error: ${error.message}`);
    };

    await this.stdioTransport.start();
    log('[mcp-proxy] Stdio transport started, waiting for messages');
  }

  /**
   * Handle a message from Claude Code (stdio side).
   * On the first message, lazily connect the HTTP transport.
   */
  private handleStdioMessage(message: JSONRPCMessage): void {
    if (this.shuttingDown) return;

    log(`[mcp-proxy] Received stdio message: ${JSON.stringify(message).slice(0, 200)}`);

    if (this.connected && this.httpTransport) {
      this.httpTransport.send(message).catch((error: unknown) => {
        log(`[mcp-proxy] Error forwarding to HTTP:\n${errorDetail(error)}`);
        this.shutdown();
      });
      return;
    }

    this.pendingMessages.push(message);
    log(`[mcp-proxy] Queued message (${this.pendingMessages.length} pending), connecting=${this.connecting}`);

    if (!this.connecting) {
      this.connecting = true;
      this.connectHttpTransport().catch((error: unknown) => {
        if (this.shuttingDown) {
          log(`[mcp-proxy] Connection aborted during shutdown: ${errorDetail(error)}`);
          return;
        }
        log(`[mcp-proxy] Failed to connect to MCP server:\n${errorDetail(error)}`);
        process.exit(1);
      });
    }
  }

  /**
   * Lazily create and connect the HTTP transport to the real MCP server.
   * Handles OAuth authorization if the server returns 401.
   */
  private async connectHttpTransport(): Promise<void> {
    log(`[mcp-proxy] Connecting to MCP server: ${this.serverUrl}`);

    await this.oauthProvider.ensureCallbackServer();
    log('[mcp-proxy] Callback server pre-started');

    this.httpTransport = this.createHttpTransport(this.oauthProvider);
    log('[mcp-proxy] HTTP transport created with auth provider');

    try {
      log('[mcp-proxy] Starting HTTP transport...');
      await this.httpTransport.start();
      log('[mcp-proxy] HTTP transport started');

      this.connected = true;
      log('[mcp-proxy] HTTP transport connected');

      try {
        await this.flushPendingMessages();
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          log('[mcp-proxy] Auth required on first send, completing OAuth flow');
          await this.handleOAuthFlow(this.httpTransport);
          log('[mcp-proxy] OAuth complete, retrying queued messages');
          await this.flushPendingMessages();
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        log('[mcp-proxy] Auth required on start, completing OAuth flow');
        await this.handleOAuthFlow(this.httpTransport!);

        this.connected = true;
        log('[mcp-proxy] HTTP transport connected after OAuth');

        await this.flushPendingMessages();
      } else {
        throw error;
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Create an HTTP transport with cookie jar and logging.
   */
  private createHttpTransport(authProvider?: McpOAuthProvider): StreamableHTTPClientTransport {
    const jar = this.cookieJar;

    // Wrap fetch to: (1) inject cookies, (2) capture Set-Cookie, (3) log details
    const cookieFetch: typeof fetch = async (input, init) => {
      const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method ?? 'GET';
      log(`[mcp-proxy] HTTP ${method} ${reqUrl}`);
      if (init?.body) log(`[mcp-proxy] Request body: ${String(init.body).slice(0, 300)}`);

      // Inject stored cookies into the request
      const cookieHeader = jar.headerFor(reqUrl);
      if (cookieHeader && init?.headers) {
        const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers as Record<string, string>);
        headers.set('Cookie', cookieHeader);
        init = { ...init, headers };
        log(`[mcp-proxy] Injected cookies for ${new URL(reqUrl).origin}`);
      }

      // Log auth header presence (not value)
      if (init?.headers instanceof Headers) {
        log(`[mcp-proxy] Has Authorization: ${init.headers.has('Authorization')}`);
        log(`[mcp-proxy] Request headers: ${[...init.headers.keys()].join(', ')}`);
      }

      const response = await fetch(input, init);

      log(`[mcp-proxy] HTTP response: ${response.status} ${response.statusText}`);
      const ct = response.headers.get('content-type');
      if (ct) log(`[mcp-proxy] Response content-type: ${ct}`);

      // Capture any Set-Cookie headers from the response
      jar.capture(reqUrl, response);

      // Log error response bodies
      if (!response.ok) {
        const cloned = response.clone();
        const errorBody = await cloned.text().catch(() => '(unreadable)');
        log(`[mcp-proxy] Error response body: ${errorBody.slice(0, 500)}`);
      }

      return response;
    };

    const transport = new StreamableHTTPClientTransport(this.serverUrl, {
      fetch: cookieFetch,
      ...(authProvider ? { authProvider } : {}),
    });

    transport.onmessage = (message: JSONRPCMessage) => {
      log(`[mcp-proxy] Received HTTP message: ${JSON.stringify(message).slice(0, 200)}`);
      this.stdioTransport.send(message).catch((error: Error) => {
        log(`[mcp-proxy] Error forwarding to stdio: ${error.message}`);
      });
    };

    transport.onclose = () => {
      log('[mcp-proxy] HTTP transport closed');
      this.shutdown();
    };

    transport.onerror = (error: Error) => {
      log(`[mcp-proxy] HTTP transport error:\n${errorDetail(error)}`);
    };

    return transport;
  }

  /**
   * Handle the OAuth authorization code flow.
   */
  private async handleOAuthFlow(transport: StreamableHTTPClientTransport): Promise<void> {
    log('[mcp-proxy] Waiting for authorization code from browser...');
    const code = await this.oauthProvider.waitForAuthorizationCode();
    log('[mcp-proxy] Authorization code received, exchanging for token');

    await transport.finishAuth(code);
    log('[mcp-proxy] Token exchange complete, transport ready');
  }

  /**
   * Forward any messages that arrived while we were connecting/authenticating.
   * UnauthorizedError is re-thrown so the caller can handle the OAuth flow.
   */
  private async flushPendingMessages(): Promise<void> {
    const messages = this.pendingMessages;
    this.pendingMessages = [];

    for (const message of messages) {
      try {
        await this.httpTransport!.send(message);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          const remaining = messages.slice(messages.indexOf(message));
          this.pendingMessages = remaining.concat(this.pendingMessages);
          log(`[mcp-proxy] UnauthorizedError during flush, re-queued ${remaining.length} message(s)`);
          throw error;
        }
        log(`[mcp-proxy] Error flushing pending message:\n${errorDetail(error)}`);
      }
    }

    if (messages.length > 0) {
      log(`[mcp-proxy] Flushed ${messages.length} pending message(s)`);
    }
  }

  /**
   * Graceful shutdown: close both transports. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    log('[mcp-proxy] Shutting down bridge');
    this.oauthProvider.dispose();

    try {
      if (this.httpTransport) {
        await this.httpTransport.terminateSession();
        await this.httpTransport.close();
      }
    } catch (error) {
      log(`[mcp-proxy] Error closing HTTP transport: ${(error as Error).message}`);
    }

    try {
      await this.stdioTransport.close();
    } catch (error) {
      log(`[mcp-proxy] Error closing stdio transport: ${(error as Error).message}`);
    }

    log('[mcp-proxy] Bridge shutdown complete');
  }
}

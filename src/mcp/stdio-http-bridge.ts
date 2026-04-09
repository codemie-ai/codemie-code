/**
 * Stdio-to-HTTP MCP Bridge
 *
 * Pipes JSON-RPC messages between a StdioServerTransport (Claude Code side)
 * and a StreamableHTTPClientTransport (real MCP server side).
 *
 * Lazy connect: the HTTP transport is created and started only when the first
 * stdio message arrives. If the server requires OAuth, the auth flow runs during
 * that first connection (blocking the first message until auth completes).
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
  // Capture any extra properties the SDK may attach (status, statusCode, body, response, etc.)
  for (const key of ['status', 'statusCode', 'code', 'body', 'response', 'statusText']) {
    const val = (error as unknown as Record<string, unknown>)[key];
    if (val !== undefined) parts.push(`  ${key}: ${JSON.stringify(val).slice(0, 500)}`);
  }
  if (error.cause) parts.push(`  cause: ${errorDetail(error.cause)}`);
  if (error.stack) parts.push(`  stack: ${error.stack}`);
  return parts.join('\n');
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
    // Wire up stdio transport to handle incoming messages
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

    // Start listening on stdio
    await this.stdioTransport.start();
    log('[mcp-proxy] Stdio transport started, waiting for messages');
  }

  /**
   * Handle a message from Claude Code (stdio side).
   * On the first message, lazily connect the HTTP transport.
   * Drops messages if shutdown is in progress.
   */
  private handleStdioMessage(message: JSONRPCMessage): void {
    if (this.shuttingDown) return;

    log(`[mcp-proxy] Received stdio message: ${JSON.stringify(message).slice(0, 200)}`);

    if (this.connected && this.httpTransport) {
      // Fast path: already connected, forward immediately
      this.httpTransport.send(message).catch((error: unknown) => {
        log(`[mcp-proxy] Error forwarding to HTTP:\n${errorDetail(error)}`);
        this.shutdown();
      });
      return;
    }

    // Queue message while connecting
    this.pendingMessages.push(message);
    log(`[mcp-proxy] Queued message (${this.pendingMessages.length} pending), connecting=${this.connecting}`);

    if (!this.connecting) {
      this.connecting = true;
      this.connectHttpTransport().catch((error: unknown) => {
        // Suppress connection errors during shutdown — not a fatal failure
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

    // First attempt: connect WITHOUT auth provider.
    // If the server doesn't require auth, this avoids the transport sending
    // OAuth client metadata (client_name etc.) that the server may reject.
    this.httpTransport = this.createHttpTransport();
    log('[mcp-proxy] HTTP transport created (no auth)');

    try {
      try {
        log('[mcp-proxy] Starting HTTP transport...');
        await this.httpTransport.start();
        log('[mcp-proxy] HTTP transport started successfully (no auth needed)');
      } catch (error) {
        log(`[mcp-proxy] HTTP transport start error:\n${errorDetail(error)}`);
        if (error instanceof UnauthorizedError) {
          log('[mcp-proxy] Server requires authorization, reconnecting with OAuth');

          // Pre-start callback server so clientMetadata.redirect_uris is populated
          // before the SDK calls registerClient() during the OAuth flow.
          await this.oauthProvider.ensureCallbackServer();
          log('[mcp-proxy] Callback server pre-started');

          // Recreate transport WITH auth provider
          this.httpTransport = this.createHttpTransport(this.oauthProvider);
          log('[mcp-proxy] HTTP transport recreated with auth provider');

          // Start will trigger the OAuth flow via the provider
          try {
            await this.httpTransport.start();
            log('[mcp-proxy] HTTP transport started (may need browser auth)');
          } catch (authError) {
            if (authError instanceof UnauthorizedError) {
              log('[mcp-proxy] OAuth redirect initiated, waiting for browser auth');
              await this.handleOAuthFlow();
            } else {
              throw authError;
            }
          }
        } else {
          throw error;
        }
      }

      this.connected = true;
      log('[mcp-proxy] HTTP transport connected');

      // Flush any queued messages
      await this.flushPendingMessages();
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Create an HTTP transport with common event handlers.
   */
  private createHttpTransport(authProvider?: McpOAuthProvider): StreamableHTTPClientTransport {
    const opts = authProvider ? { authProvider } : {};
    const transport = new StreamableHTTPClientTransport(this.serverUrl, opts);

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
   * 1. The provider's redirectToAuthorization() has already opened the browser
   * 2. Wait for the callback with the authorization code
   * 3. Call finishAuth() on the transport
   * 4. Restart the transport
   */
  private async handleOAuthFlow(): Promise<void> {
    // Wait for the user to complete browser authorization
    log('[mcp-proxy] Waiting for authorization code from browser...');
    const code = await this.oauthProvider.waitForAuthorizationCode();
    log('[mcp-proxy] Authorization code received, exchanging for token');

    // Exchange the code for tokens
    await this.httpTransport!.finishAuth(code);
    log('[mcp-proxy] Token exchange complete, reconnecting');

    // Restart the transport — now with valid tokens
    await this.httpTransport!.start();
    log('[mcp-proxy] Reconnected after OAuth');
  }

  /**
   * Forward any messages that arrived while we were connecting/authenticating.
   */
  private async flushPendingMessages(): Promise<void> {
    const messages = this.pendingMessages;
    this.pendingMessages = [];

    for (const message of messages) {
      try {
        await this.httpTransport!.send(message);
      } catch (error) {
        log(`[mcp-proxy] Error flushing pending message:\n${errorDetail(error)}`);
      }
    }

    if (messages.length > 0) {
      log(`[mcp-proxy] Flushed ${messages.length} pending message(s)`);
    }
  }

  /**
   * Graceful shutdown: close both transports. Idempotent — safe to call multiple times.
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

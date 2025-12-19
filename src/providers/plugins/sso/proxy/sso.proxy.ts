/**
 * CodeMie Proxy Server - Plugin-Based Architecture
 *
 * KISS: Does ONE thing - forwards HTTP requests with streaming
 * SOLID: Single responsibility, plugins injected via registry
 * NO analytics-specific logic in core!
 *
 * Architecture:
 * - ProxyHTTPClient: Handles HTTP forwarding with streaming
 * - PluginRegistry: Manages plugin lifecycle and ordering
 * - ProxyInterceptors: Plugin-based hooks for extensibility
 * - Main Proxy: Orchestrates the flow with zero buffering
 *
 * Flow:
 * 1. Build context
 * 2. Run onRequest hooks
 * 3. Forward to upstream (get response headers)
 * 4. Run onResponseHeaders hooks
 * 5. Stream response body (with optional chunk hooks)
 * 6. Run onResponseComplete hooks
 *
 * NO BUFFERING by default!
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { URL } from 'url';
import { ProviderRegistry } from '../../../core/registry.js';
import { logger } from '../../../../utils/logger.js';
import { ProxyHTTPClient } from './proxy-http-client.js';
import { ProxyConfig, ProxyContext } from './proxy-types.js';
import { AuthenticationError, NetworkError, TimeoutError, normalizeError } from './proxy-errors.js';
import { getPluginRegistry } from './plugins/registry.js';
import { PluginContext, ProxyInterceptor, ResponseMetadata } from './plugins/types.js';
import './plugins/index.js'; // Auto-register core plugins

/**
 * CodeMie Proxy - Plugin-based HTTP proxy with streaming
 * KISS: Core responsibility = forward requests + run plugin hooks
 */
export class CodeMieProxy {
  private server: Server | null = null;
  private httpClient: ProxyHTTPClient;
  private interceptors: ProxyInterceptor[] = [];
  private actualPort: number = 0;

  constructor(private config: ProxyConfig) {
    // Initialize HTTP client with streaming support
    this.httpClient = new ProxyHTTPClient({
      timeout: config.timeout || 300000,
      rejectUnauthorized: false // Allow self-signed certificates
    });
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<{ port: number; url: string }> {
    // 1. Check if provider uses SSO authentication
    const provider = ProviderRegistry.getProvider(this.config.provider || '');
    const isSSOProvider = provider?.authType === 'sso';

    // 2. Load credentials (if needed for SSO)
    let credentials: any = null;
    if (isSSOProvider) {
      const { CodeMieSSO } = await import('../sso.auth.js');
      const sso = new CodeMieSSO();
      credentials = await sso.getStoredCredentials(this.config.targetApiUrl);

      if (!credentials) {
        throw new AuthenticationError(
          `SSO credentials not found for ${this.config.targetApiUrl}. Please run: codemie profile login --url ${this.config.targetApiUrl}`
        );
      }
    }

    // 3. Build plugin context (includes profile config read once at CLI level)
    const pluginContext: PluginContext = {
      config: this.config,
      logger,
      credentials: credentials || undefined,
      profileConfig: this.config.profileConfig
    };

    // 4. Initialize plugins from registry
    const registry = getPluginRegistry();
    this.interceptors = await registry.initialize(pluginContext);

    // 5. Call onProxyStart lifecycle hooks
    await this.runHook('onProxyStart', interceptor =>
      interceptor.onProxyStart?.()
    );

    // 6. Find available port
    this.actualPort = this.config.port || await this.findAvailablePort();

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          // Top-level error handler
          if (!res.headersSent) {
            this.sendErrorResponse(res, error);
          }
        });
      });

      this.server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          // Try a different random port
          this.actualPort = 0; // Let system assign
          this.server?.listen(this.actualPort, 'localhost');
        } else {
          reject(error);
        }
      });

      this.server.listen(this.actualPort, 'localhost', () => {
        const address = this.server?.address();
        if (typeof address === 'object' && address) {
          this.actualPort = address.port;
        }

        const gatewayUrl = `http://localhost:${this.actualPort}`;
        logger.debug(`Proxy started: ${gatewayUrl}`);
        resolve({ port: this.actualPort, url: gatewayUrl });
      });
    });
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    // 1. Call onProxyStop lifecycle hooks (before stopping server)
    await this.runHook('onProxyStop', interceptor =>
      interceptor.onProxyStop?.()
    );

    // 2. Stop server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          logger.debug('[CodeMieProxy] Stopped');
          resolve();
        });
      });
    }

    // 3. Cleanup HTTP client
    this.httpClient.close();
  }

  /**
   * Handle incoming request - STREAMING ONLY
   *
   * Flow:
   * 1. Build context
   * 2. Run onRequest hooks
   * 3. Forward to upstream (get response headers)
   * 4. Run onResponseHeaders hooks
   * 5. Stream response body (with optional chunk hooks)
   * 6. Run onResponseComplete hooks
   *
   * NO BUFFERING!
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // 1. Build context
      const context = await this.buildContext(req);

      // 2. Run onRequest interceptors (with early termination if blocked)
      await this.runHook('onRequest', interceptor =>
        interceptor.onRequest?.(context)
      , context);

      // 2.5. Check if request was blocked by any interceptor
      if (context.metadata.blocked) {
        // Request blocked - return 200 OK immediately without forwarding
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
        logger.debug(`[proxy] Request blocked: ${context.url}`);
        return;
      }

      // 3. Forward request to upstream
      const targetUrl = this.buildTargetUrl(req.url!);
      context.targetUrl = targetUrl.toString();

      logger.debug(`[proxy] Forwarding request to upstream for ${context.requestId}`);
      const upstreamResponse = await this.httpClient.forward(targetUrl, {
        method: req.method!,
        headers: context.headers,
        body: context.requestBody || undefined
      });
      logger.debug(`[proxy] Received upstream response object for ${context.requestId}`);

      // 4. Run onResponseHeaders hooks (BEFORE streaming)
      await this.runHook('onResponseHeaders', interceptor =>
        interceptor.onResponseHeaders?.(context, upstreamResponse.headers)
      );

      // 5. Stream response to client
      logger.debug(`[proxy] Starting response streaming for ${context.requestId}`);
      const metadata = await this.streamResponse(
        context,
        upstreamResponse,
        res,
        startTime
      );
      logger.debug(`[proxy] Response streaming completed for ${context.requestId}`, {
        statusCode: metadata.statusCode,
        bytesSent: metadata.bytesSent
      });

      // 6. Run onResponseComplete hooks (AFTER streaming)
      logger.debug(`[proxy] Running onResponseComplete hooks for ${context.requestId}`);
      await this.runHook('onResponseComplete', interceptor =>
        interceptor.onResponseComplete?.(context, metadata)
      );
      logger.debug(`[proxy] All hooks completed for ${context.requestId}`);

      // 7. Final completion marker
      logger.debug(`[proxy] Request handling finished for ${context.requestId}`, {
        url: context.url,
        durationMs: Date.now() - context.requestStartTime
      });

    } catch (error) {
      logger.debug(`[proxy] Error during request handling:`, error);
      await this.handleError(error, req, res);
    }
  }

  /**
   * Build proxy context from incoming request
   */
  private async buildContext(req: IncomingMessage): Promise<ProxyContext> {
    const requestBody = await this.readBody(req);

    // Prepare headers for forwarding
    const forwardHeaders: Record<string, string> = {};
    if (req.headers) {
      Object.entries(req.headers).forEach(([key, value]) => {
        if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'connection') {
          forwardHeaders[key] = Array.isArray(value) ? value[0] : value || '';
        }
      });
    }

    return {
      requestId: randomUUID(),
      sessionId: this.config.sessionId || 'unknown',
      agentName: this.config.clientType || 'unknown',
      method: req.method || 'GET',
      url: req.url || '/',
      headers: forwardHeaders,
      requestBody,
      requestStartTime: Date.now(),
      metadata: {}
    };
  }

  /**
   * Build target URL from request path
   */
  private buildTargetUrl(requestPath: string): URL {
    // Construct target URL by properly joining base URL with request path
    let targetUrlString: string;

    if (this.config.targetApiUrl.endsWith('/')) {
      targetUrlString = `${this.config.targetApiUrl}${requestPath.startsWith('/') ? requestPath.slice(1) : requestPath}`;
    } else {
      targetUrlString = `${this.config.targetApiUrl}${requestPath.startsWith('/') ? requestPath : '/' + requestPath}`;
    }

    return new URL(targetUrlString);
  }

  /**
   * Read request body as Buffer to preserve byte integrity
   * CRITICAL: Must use Buffer to avoid corrupting multi-byte UTF-8 characters
   */
  private async readBody(req: IncomingMessage): Promise<Buffer | null> {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
      return null;
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
      });
      req.on('error', reject);
    });
  }

  /**
   * Stream response with optional chunk transformation
   */
  private async streamResponse(
    context: ProxyContext,
    upstream: IncomingMessage,
    downstream: ServerResponse,
    startTime: number
  ): Promise<ResponseMetadata> {
    // Set status and headers
    downstream.statusCode = upstream.statusCode || 200;
    logger.debug(`[proxy-stream] Set response status: ${upstream.statusCode} for ${context.requestId}`);

    for (const [key, value] of Object.entries(upstream.headers)) {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase()) && value !== undefined) {
        downstream.setHeader(key, value);
      }
    }
    logger.debug(`[proxy-stream] Headers set for ${context.requestId}`);

    // Stream with optional chunk hooks
    let bytesSent = 0;
    let chunkCount = 0;

    logger.debug(`[proxy-stream] Starting chunk iteration for ${context.requestId}`);

    // Track upstream stream lifecycle
    upstream.on('end', () => {
      logger.debug(`[proxy-stream] Upstream 'end' event fired for ${context.requestId}`);
    });

    upstream.on('close', () => {
      logger.debug(`[proxy-stream] Upstream 'close' event fired for ${context.requestId}`);
    });

    // Track downstream connection state
    let downstreamClosed = false;
    downstream.on('close', () => {
      logger.debug(`[proxy-stream] Downstream connection closed during streaming for ${context.requestId}`);
      downstreamClosed = true;
    });

    downstream.on('finish', () => {
      logger.debug(`[proxy-stream] Downstream finished event for ${context.requestId}`);
    });

    downstream.on('error', (error) => {
      logger.debug(`[proxy-stream] Downstream error for ${context.requestId}:`, error);
    });

    for await (const chunk of upstream) {
      chunkCount++;
      let processedChunk: Buffer | null = Buffer.from(chunk);

      // Run onResponseChunk hooks (optional transform)
      for (const interceptor of this.interceptors) {
        if (interceptor.onResponseChunk && processedChunk) {
          try {
            processedChunk = await interceptor.onResponseChunk(context, processedChunk);
          } catch (error) {
            logger.error(`[CodeMieProxy] Chunk hook error:`, error);
            // Continue streaming even if hook fails
          }
        }
      }

      // Write to client (if not filtered out)
      if (processedChunk) {
        downstream.write(processedChunk);
        bytesSent += processedChunk.length;
      }

      // Check if downstream disconnected
      if (downstreamClosed) {
        logger.debug(`[proxy-stream] Downstream closed, stopping chunk iteration for ${context.requestId}`);
        break;
      }
    }
    logger.debug(`[proxy-stream] Finished chunk iteration for ${context.requestId}. Total chunks: ${chunkCount}, bytes: ${bytesSent}`);

    // Explicitly destroy upstream to ensure connection closes
    if (!upstream.destroyed) {
      logger.debug(`[proxy-stream] Destroying upstream stream for ${context.requestId}`);
      upstream.destroy();
    }

    logger.debug(`[proxy-stream] Calling downstream.end() for ${context.requestId}`);
    downstream.end();
    logger.debug(`[proxy-stream] downstream.end() completed for ${context.requestId}`);

    const durationMs = Date.now() - startTime;

    return {
      statusCode: upstream.statusCode || 200,
      statusMessage: upstream.statusMessage || 'OK',
      headers: upstream.headers,
      bytesSent,
      durationMs
    };
  }

  /**
   * Run interceptor hook safely (errors don't break flow)
   * For onRequest hooks: stop execution if any plugin blocks the request
   */
  private async runHook(
    hookName: string,
    fn: (interceptor: ProxyInterceptor) => Promise<void> | void | undefined,
    context?: ProxyContext
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      try {
        await fn(interceptor);

        // For onRequest hooks: check if request was blocked and stop early
        if (hookName === 'onRequest' && context?.metadata.blocked) {
          logger.debug(`[proxy] Request blocked by ${interceptor.name}, skipping remaining onRequest hooks`);
          break;
        }
      } catch (error) {
        logger.error(`[CodeMieProxy] Hook ${hookName} error in ${interceptor.name}:`, error);
        // Continue with other interceptors
      }
    }
  }

  /**
   * Handle errors with proper status codes and structure
   */
  private async handleError(
    error: unknown,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Check if this is a normal client disconnect (abort)
    const isAbortError = error && typeof error === 'object' &&
      ((error as any).isAborted ||
       (error as Error).message === 'aborted' ||
       (error as any).code === 'ECONNABORTED' ||
       (error as any).code === 'ERR_STREAM_PREMATURE_CLOSE');

    if (isAbortError) {
      // Client disconnected normally (user closed agent) - don't log or respond
      logger.debug('[proxy] Client disconnected');
      if (!res.headersSent) {
        res.end();
      }
      return;
    }

    // Build minimal context for error tracking
    const context: ProxyContext = {
      requestId: randomUUID(),
      sessionId: this.config.sessionId || 'unknown',
      agentName: this.config.clientType || 'unknown',
      method: req.method || 'GET',
      url: req.url || '/',
      headers: {},
      requestBody: null,
      requestStartTime: Date.now(),
      metadata: {}
    };

    // Run onError interceptors
    const errorObj = error instanceof Error ? error : new Error(String(error));
    for (const interceptor of this.interceptors) {
      if (interceptor.onError) {
        try {
          await interceptor.onError(context, errorObj);
        } catch (interceptorError) {
          logger.error('Interceptor error:', interceptorError);
        }
      }
    }

    // Send structured error response
    this.sendErrorResponse(res, error, context);
  }

  /**
   * Send error response to client
   */
  private sendErrorResponse(
    res: ServerResponse,
    error: unknown,
    context?: ProxyContext
  ): void {
    const proxyError = normalizeError(error, context ? {
      requestId: context.requestId,
      url: context.url
    } : undefined);

    res.statusCode = proxyError.statusCode;
    res.setHeader('Content-Type', 'application/json');

    res.end(JSON.stringify({
      error: proxyError.toJSON(),
      requestId: context?.requestId,
      timestamp: new Date().toISOString()
    }, null, 2));

    // Log error at appropriate level
    // NetworkError and TimeoutError are operational errors (not programming errors)
    // Log them at debug level to avoid noise in production logs
    if (proxyError instanceof NetworkError || proxyError instanceof TimeoutError) {
      logger.debug(`[proxy] Operational error: ${proxyError.message}`);
    } else {
      logger.error('[proxy] Error:', proxyError);
    }
  }

  /**
   * Find an available port for the proxy server
   */
  private async findAvailablePort(startPort: number = 3001): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();

      server.listen(0, 'localhost', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : startPort;

        server.close(() => {
          resolve(port);
        });
      });

      server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          resolve(this.findAvailablePort(startPort + 1));
        } else {
          reject(error);
        }
      });
    });
  }
}

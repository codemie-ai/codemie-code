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
import { CredentialStore } from './credential-store.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { logger } from './logger.js';
import { getAnalytics } from '../analytics/index.js';
import { loadAnalyticsConfig } from '../analytics/config.js';
import { RemoteAnalyticsSubmitter } from '../analytics/remote-submission/index.js';
import { ProxyHTTPClient } from '../proxy/http-client.js';
import { ProxyConfig, ProxyContext } from '../proxy/types.js';
import { AuthenticationError, NetworkError, TimeoutError, normalizeError } from '../proxy/errors.js';
import { getPluginRegistry } from '../proxy/plugins/registry.js';
import { PluginContext, ProxyInterceptor, ResponseMetadata } from '../proxy/plugins/types.js';
import '../proxy/plugins/index.js'; // Auto-register core plugins

/**
 * CodeMie Proxy - Plugin-based HTTP proxy with streaming
 * KISS: Core responsibility = forward requests + run plugin hooks
 */
export class CodeMieProxy {
  private server: Server | null = null;
  private httpClient: ProxyHTTPClient;
  private interceptors: ProxyInterceptor[] = [];
  private actualPort: number = 0;
  private remoteSubmitter: RemoteAnalyticsSubmitter | null = null;

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
      const store = CredentialStore.getInstance();
      credentials = await store.retrieveSSOCredentials();

      if (!credentials) {
        throw new AuthenticationError(
          'SSO credentials not found. Please run: codemie auth login'
        );
      }
    }

    // 3. Build plugin context
    const pluginContext: PluginContext = {
      config: this.config,
      logger,
      credentials: credentials || undefined,
      analytics: getAnalytics()
    };

    // 4. Initialize plugins from registry
    const registry = getPluginRegistry();
    this.interceptors = await registry.initialize(pluginContext);

    // 5. Start analytics metrics submitter (writes codemie_coding_agent_usage_total metrics)
    const analyticsConfig = loadAnalyticsConfig();
    if (analyticsConfig.enabled) {
      await this.startAnalyticsMetricsSubmitter(isSSOProvider ? credentials : null);
    }

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
   * Start analytics metrics submitter
   * Writes codemie_coding_agent_usage metrics to ~/.codemie/analytics/YYYY-MM-DD.jsonl
   */
  private async startAnalyticsMetricsSubmitter(credentials: any | null): Promise<void> {
    try {
      const analyticsConfig = loadAnalyticsConfig();

      // Build config
      const submitterConfig: any = {
        enabled: true,
        target: analyticsConfig.target,
        interval: parseInt(process.env.CODEMIE_ANALYTICS_REMOTE_INTERVAL || '300000', 10),
        batchSize: parseInt(process.env.CODEMIE_ANALYTICS_REMOTE_BATCH_SIZE || '100', 10)
      };

      // Add remote config only if SSO provider with credentials
      if (credentials && this.config.targetApiUrl) {
        const cookieString = Object.entries(credentials.cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join('; ');

        submitterConfig.baseUrl = this.config.targetApiUrl;
        submitterConfig.cookies = cookieString;
      }

      this.remoteSubmitter = new RemoteAnalyticsSubmitter(submitterConfig);
      this.remoteSubmitter.start();

      logger.debug(`Analytics metrics submitter started (target: ${analyticsConfig.target})`);
    } catch (error) {
      logger.error(`Failed to start analytics metrics submitter: ${error}`);
    }
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    // Stop remote analytics submitter
    if (this.remoteSubmitter) {
      this.remoteSubmitter.stop();
      logger.debug('Remote analytics submitter stopped');
    }

    // Flush analytics before stopping to ensure all events are written
    const analytics = getAnalytics();
    if (analytics.isEnabled) {
      logger.debug('Flushing analytics before proxy shutdown...');
      await analytics.flush();
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          logger.debug('[CodeMieProxy] Stopped');
          resolve();
        });
      });
    }

    // Cleanup HTTP client
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

      // 2. Run onRequest interceptors
      await this.runHook('onRequest', interceptor =>
        interceptor.onRequest?.(context)
      );

      // 3. Forward request to upstream
      const targetUrl = this.buildTargetUrl(req.url!);
      context.targetUrl = targetUrl.toString();

      const upstreamResponse = await this.httpClient.forward(targetUrl, {
        method: req.method!,
        headers: context.headers,
        body: context.requestBody || undefined
      });

      // 4. Run onResponseHeaders hooks (BEFORE streaming)
      await this.runHook('onResponseHeaders', interceptor =>
        interceptor.onResponseHeaders?.(context, upstreamResponse.headers)
      );

      // 5. Stream response to client
      const metadata = await this.streamResponse(
        context,
        upstreamResponse,
        res,
        startTime
      );

      // 6. Run onResponseComplete hooks (AFTER streaming)
      await this.runHook('onResponseComplete', interceptor =>
        interceptor.onResponseComplete?.(context, metadata)
      );

    } catch (error) {
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
      sessionId: this.config.sessionId || logger.getSessionId(),
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
   * Read request body
   */
  private async readBody(req: IncomingMessage): Promise<string | null> {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
      return null;
    }

    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body || null);
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

    for (const [key, value] of Object.entries(upstream.headers)) {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase()) && value !== undefined) {
        downstream.setHeader(key, value);
      }
    }

    // Stream with optional chunk hooks
    let bytesSent = 0;

    for await (const chunk of upstream) {
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
    }

    downstream.end();

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
   */
  private async runHook(
    hookName: string,
    fn: (interceptor: ProxyInterceptor) => Promise<void> | void | undefined
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      try {
        await fn(interceptor);
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
    if (error && typeof error === 'object' && (error as any).isAborted) {
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
      sessionId: this.config.sessionId || logger.getSessionId(),
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

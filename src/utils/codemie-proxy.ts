/**
 * CodeMie Proxy Server - Refactored
 *
 * Clean, modular proxy implementation following SOLID principles.
 * Uses interceptor pattern for extensibility (Open/Closed).
 *
 * Architecture:
 * - ProxyHTTPClient: Handles HTTP forwarding with streaming
 * - Interceptors: Plugin-based request/response/error handling
 * - Main Proxy: Orchestrates the flow
 *
 * KISS: Simple flow - build context → run interceptors → forward → stream
 * DRY: Reuses Analytics system, delegates to interceptors
 * SOLID: Each component has single responsibility, extensible via plugins
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { URL } from 'url';
import { CredentialStore } from './credential-store.js';
import { SSOCredentials } from '../types/sso.js';
import { logger } from './logger.js';
import { getAnalytics } from '../analytics/index.js';
import { ProxyHTTPClient } from './proxy/http-client.js';
import {
  ProxyInterceptor,
  SSOAuthInterceptor,
  HeaderInjectionInterceptor,
  AnalyticsInterceptor
} from './proxy/interceptors.js';
import { ProxyConfig, ProxyContext, UpstreamResponse } from './proxy/types.js';
import { AuthenticationError, NetworkError, TimeoutError, normalizeError } from './proxy/errors.js';

// Re-export types for backward compatibility
export type GatewayConfig = ProxyConfig;

/**
 * CodeMie Proxy - Simple HTTP proxy with interceptor support
 * KISS: Core responsibility = forward requests + run interceptors
 */
export class CodeMieProxy {
  private server: Server | null = null;
  private credentials: SSOCredentials | null = null;
  private httpClient: ProxyHTTPClient;
  private interceptors: ProxyInterceptor[] = [];
  private actualPort: number = 0;

  constructor(private config: ProxyConfig) {
    // Initialize HTTP client with streaming support
    this.httpClient = new ProxyHTTPClient({
      timeout: config.timeout || 300000,
      rejectUnauthorized: false // Allow self-signed certificates
    });

    // Register interceptors (Open/Closed: add more without modifying this)
    this.registerInterceptors();
  }

  /**
   * Register interceptors
   * Easy to add new interceptors without modifying handleRequest
   */
  private registerInterceptors(): void {
    // Will be initialized with credentials after start()
    // Interceptors added dynamically in start()
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<{ port: number; url: string }> {
    // Load SSO credentials
    const store = CredentialStore.getInstance();
    this.credentials = await store.retrieveSSOCredentials();

    if (!this.credentials) {
      throw new AuthenticationError(
        'SSO credentials not found. Please run: codemie auth login'
      );
    }

    // Now register interceptors with credentials
    this.interceptors = [];

    // 1. SSO Authentication
    this.interceptors.push(new SSOAuthInterceptor(this.credentials));

    // 2. Header Injection
    this.interceptors.push(new HeaderInjectionInterceptor({
      sessionId: logger.getSessionId(),
      provider: this.config.provider,
      integrationId: this.config.integrationId,
      model: this.config.model,
      timeout: this.config.timeout,
      clientType: this.config.clientType
    }));

    // 3. Analytics tracking (only if enabled)
    const analytics = getAnalytics();
    if (analytics.isEnabled) {
      this.interceptors.push(new AnalyticsInterceptor());
    }

    // Future: Add more interceptors here without touching handleRequest!
    // this.interceptors.push(new RetryInterceptor({ maxRetries: 3 }));
    // this.interceptors.push(new CachingInterceptor());

    // Find available port
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
    // Flush analytics before stopping to ensure all events are written
    const analytics = getAnalytics();
    if (analytics.isEnabled) {
      logger.debug('Flushing analytics before proxy shutdown...');
      await analytics.flush();
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          logger.debug('Proxy stopped');
          resolve();
        });
      });
    }

    // Cleanup HTTP client
    this.httpClient.close();
  }

  /**
   * Core request handler - Clean, simple flow
   * KISS: Build context → run interceptors → forward → stream
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      // 1. Build context (DRY: single place for context creation)
      const context = await this.buildContext(req);

      // 2. Run onRequest interceptors
      for (const interceptor of this.interceptors) {
        if (interceptor.onRequest) {
          await interceptor.onRequest(context);
        }
      }

      // 3. Forward request to upstream (streaming, no buffering)
      const targetUrl = this.buildTargetUrl(req.url!);
      context.targetUrl = targetUrl.toString();

      const upstreamResponse = await this.httpClient.forward(targetUrl, {
        method: req.method!,
        headers: context.headers,
        body: context.requestBody || undefined
      });

      // 4. Read response body for analytics (buffered, but needed)
      // This is a trade-off: analytics needs the body
      const responseBody = await this.httpClient.readResponseBody(upstreamResponse);

      const response: UpstreamResponse = {
        statusCode: upstreamResponse.statusCode || 200,
        statusMessage: upstreamResponse.statusMessage || 'OK',
        headers: upstreamResponse.headers,
        body: responseBody
      };

      // 5. Run onResponse interceptors (before streaming to client)
      for (const interceptor of this.interceptors) {
        if (interceptor.onResponse) {
          await interceptor.onResponse(context, response);
        }
      }

      // 6. Send response to client
      this.sendResponse(res, response);

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
   * Send successful response to client
   */
  private sendResponse(res: ServerResponse, response: UpstreamResponse): void {
    res.statusCode = response.statusCode;

    // Copy headers (skip problematic ones)
    for (const [key, value] of Object.entries(response.headers)) {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase()) && value !== undefined) {
        res.setHeader(key, value);
      }
    }

    // Send body
    if (response.body) {
      res.end(response.body);
    } else {
      res.end();
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

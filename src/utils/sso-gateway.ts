/**
 * Local Authentication Gateway for SSO-enabled Claude binary
 *
 * This creates a local HTTP server that proxies requests from the claude binary
 * to the codemie API, adding SSO authentication cookies in the process.
 *
 * Debug Logging:
 * When debug mode is enabled, all requests and responses are logged to the
 * unified debug session directory in JSONL (JSON Lines) format at:
 *   ~/.codemie/debug/session-<timestamp>/requests.jsonl
 *
 * Each line in the file is a JSON object with a 'type' field:
 *   - session_start: Gateway initialization
 *   - request: HTTP request details (headers, body, URL)
 *   - response: HTTP response details (status, headers, body preview)
 *   - session_end: Gateway shutdown with session statistics
 *
 * Sensitive data (Cookie, Authorization headers) is automatically redacted.
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { CredentialStore } from './credential-store.js';
import { SSOCredentials } from '../types/sso.js';
import { logger } from './logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';

export interface GatewayConfig {
  targetApiUrl: string;
  port?: number;
  debug?: boolean;
  clientType?: string; // Client type for X-CodeMie-Client header
}

export class SSOGateway {
  private server: Server | null = null;
  private credentials: SSOCredentials | null = null;
  private config: GatewayConfig;
  private actualPort: number = 0;
  private debugLogFile: string | null = null;
  private requestCounter: number = 0;
  private sessionStartTime: string = '';

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /**
   * Start the gateway server on a random available port
   */
  async start(): Promise<{ port: number; url: string }> {
    // Load SSO credentials
    const store = CredentialStore.getInstance();
    this.credentials = await store.retrieveSSOCredentials();

    if (!this.credentials) {
      throw new Error('SSO credentials not found. Please run: codemie auth login');
    }

    if (this.config.debug) {
      await this.initializeDebugLogging();
    }

    // Find available port
    this.actualPort = this.config.port || await this.findAvailablePort();

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          logger.error('Gateway request error:', error);

          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');

            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorResponse: Record<string, unknown> = {
              error: 'Internal Server Error',
              message: errorMessage,
              timestamp: new Date().toISOString()
            };

            if (this.config.debug && error instanceof Error && error.stack) {
              errorResponse.stack = error.stack;
            }

            res.end(JSON.stringify(errorResponse, null, 2));
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
        resolve({ port: this.actualPort, url: gatewayUrl });
      });
    });
  }

  /**
   * Stop the gateway server
   */
  async stop(): Promise<void> {
    if (this.server) {
      if (this.config.debug && this.debugLogFile) {
        try {
          const sessionEnd = {
            type: 'session_end',
            timestamp: new Date().toISOString(),
            totalRequests: this.requestCounter,
            duration: Date.now() - new Date(this.sessionStartTime).getTime()
          };
          await fs.appendFile(this.debugLogFile, JSON.stringify(sessionEnd) + '\n', 'utf-8');
        } catch (error) {
          logger.error('Failed to write session end log:', error);
        }
      }

      return new Promise((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
    }
  }

  /**
   * Handle incoming requests from claude binary
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.credentials) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Unauthorized',
        message: 'SSO credentials not available. Please run: codemie auth login',
        timestamp: new Date().toISOString()
      }, null, 2));
      return;
    }

    // Assign request ID for tracking
    const requestId = ++this.requestCounter;
    const requestTimestamp = new Date().toISOString();

    try {
      // Construct target URL by properly joining base URL with request path
      // This ensures we preserve both the API path and query parameters
      const requestUrl = req.url || '/';
      let targetUrl: string;

      // If targetApiUrl already includes path components (like /code-assistant-api),
      // we need to append the request path correctly
      if (this.config.targetApiUrl.endsWith('/')) {
        // Remove leading slash from request URL to avoid double slashes
        targetUrl = `${this.config.targetApiUrl}${requestUrl.startsWith('/') ? requestUrl.slice(1) : requestUrl}`;
      } else {
        // Ensure proper slash separation
        targetUrl = `${this.config.targetApiUrl}${requestUrl.startsWith('/') ? requestUrl : '/' + requestUrl}`;
      }

      // Prepare headers for forwarding
      const forwardHeaders: Record<string, string> = {};

      // Copy relevant headers from claude
      if (req.headers) {
        Object.entries(req.headers).forEach(([key, value]) => {
          if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'connection') {
            forwardHeaders[key] = Array.isArray(value) ? value[0] : value || '';
          }
        });
      }

      // Add SSO authentication cookies
      const cookieHeader = Object.entries(this.credentials.cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');

      forwardHeaders['Cookie'] = cookieHeader;

      // Add CodeMie integration header only if integration is configured
      try {
        const { ConfigLoader } = await import('./config-loader.js');
        const config = await ConfigLoader.load();

        // Only add integration header when provider is ai-run-sso AND integration exists
        if (config.provider === 'ai-run-sso' && config.codeMieIntegration?.id) {
          forwardHeaders['X-CodeMie-Integration'] = config.codeMieIntegration.id;
        }
      } catch {
        // Non-fatal error - continue without integration header
      }

      if (this.config.clientType) {
        forwardHeaders['X-CodeMie-Client'] = this.config.clientType;
      }

      // Handle request body for POST/PUT requests
      let body = '';
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        body = await this.readRequestBody(req);
      }

      if (this.config.debug) {
        await this.logRequestToFile(requestId, {
          method: req.method || 'GET',
          url: requestUrl,
          targetUrl,
          headers: forwardHeaders,
          body: body || undefined,
          timestamp: requestTimestamp
        });
      }

      // Use native Node.js https module for better SSL control (following codemie-model-fetcher pattern)
      // Always disable SSL verification to handle enterprise certificates like codemie-model-fetcher does
      const https = await import('https');
      const { URL } = await import('url');

      const parsedUrl = new URL(targetUrl);

      const requestOptions: any = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method || 'GET',
        headers: forwardHeaders,
        rejectUnauthorized: false, // Always allow self-signed certificates like codemie-model-fetcher
        timeout: 30000
      };

      const responseData = await this.makeHttpRequest(https, parsedUrl, requestOptions, body);

      // Create a Response-like object
      const response = new Response(responseData.data, {
        status: responseData.statusCode || 200,
        statusText: responseData.statusMessage || 'OK',
        headers: responseData.headers as any
      });

      // Forward response status and headers
      res.statusCode = response.status;

      // Copy response headers
      response.headers.forEach((value, key) => {
        // Skip headers that might cause issues
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      // Stream response body
      if (response.body) {
        const reader = response.body.getReader();

        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();

          if (done) {
            res.end();
            return;
          }

          res.write(Buffer.from(value));
          return pump();
        };

        await pump();
      } else {
        res.end();
      }

      if (this.config.debug) {
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Extract response body preview (first 1000 chars)
        let bodyPreview: string | undefined;
        if (responseData.data) {
          const bodyText = responseData.data.toString('utf-8');
          bodyPreview = bodyText.length > 1000
            ? bodyText.substring(0, 1000) + '...[truncated]'
            : bodyText;
        }

        await this.logResponseToFile(requestId, {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: responseHeaders,
          bodyPreview,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      logger.error('Gateway proxy error:', error);

      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorResponse: Record<string, unknown> = {
        error: 'Bad Gateway',
        message: errorMessage,
        timestamp: new Date().toISOString()
      };

      if (this.config.debug && error instanceof Error && error.stack) {
        errorResponse.stack = error.stack;
      }

      res.end(JSON.stringify(errorResponse, null, 2));
    }
  }

  /**
   * Read request body from incoming request
   */
  private async readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  /**
   * Make HTTP request without async promise executor
   */
  private async makeHttpRequest(
    https: any,
    parsedUrl: any,
    requestOptions: any,
    body: string
  ): Promise<{ statusCode?: number; statusMessage?: string; data: Buffer; headers: any }> {
    const protocol = parsedUrl.protocol === 'https:' ? https : await import('http');

    return new Promise((resolve, reject) => {
      const req = protocol.request(requestOptions, (res: any) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: any) => {
          chunks.push(Buffer.from(chunk));
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            data: Buffer.concat(chunks),
            headers: res.headers
          });
        });
      });

      req.on('error', (error: Error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      // Write body for POST/PUT requests
      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Find an available port for the gateway server
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

  /**
   * Initialize debug logging - uses session directory from main logger
   */
  private async initializeDebugLogging(): Promise<void> {
    this.sessionStartTime = new Date().toISOString();

    try {
      // Get session directory from main logger
      const sessionDir = logger.getDebugSessionDir();
      if (!sessionDir) {
        logger.error('Debug session directory not available');
        this.debugLogFile = null;
        return;
      }

      // Create requests.jsonl in the same session directory
      const filename = 'requests.jsonl';
      this.debugLogFile = join(sessionDir, filename);

      // Write session header
      const sessionHeader = {
        type: 'session_start',
        timestamp: this.sessionStartTime,
        gatewayConfig: {
          targetApiUrl: this.config.targetApiUrl,
          clientType: this.config.clientType
        }
      };

      await fs.writeFile(this.debugLogFile, JSON.stringify(sessionHeader) + '\n', 'utf-8');
    } catch (error) {
      logger.error('Failed to create debug log file:', error);
      this.debugLogFile = null;
    }
  }

  /**
   * Append request details to session debug file
   */
  private async logRequestToFile(
    requestId: number,
    data: {
      method: string;
      url: string;
      targetUrl: string;
      headers: Record<string, string>;
      body?: string;
      timestamp: string;
    }
  ): Promise<void> {
    if (!this.debugLogFile) return;

    try {
      // Sanitize sensitive data
      const sanitizedHeaders = { ...data.headers };
      if (sanitizedHeaders['Cookie']) {
        sanitizedHeaders['Cookie'] = '[REDACTED]';
      }
      if (sanitizedHeaders['Authorization']) {
        sanitizedHeaders['Authorization'] = '[REDACTED]';
      }

      const logEntry = {
        type: 'request',
        requestId,
        timestamp: data.timestamp,
        method: data.method,
        url: data.url,
        targetUrl: data.targetUrl,
        headers: sanitizedHeaders,
        body: data.body
      };

      // Append to file (JSONL format - one JSON object per line)
      await fs.appendFile(this.debugLogFile, JSON.stringify(logEntry) + '\n', 'utf-8');
    } catch (error) {
      logger.error('Failed to write request log:', error);
    }
  }

  /**
   * Append response details to session debug file
   */
  private async logResponseToFile(
    requestId: number,
    data: {
      statusCode: number;
      statusMessage: string;
      headers: Record<string, string>;
      bodyPreview?: string;
      timestamp: string;
    }
  ): Promise<void> {
    if (!this.debugLogFile) return;

    try {
      const logEntry = {
        type: 'response',
        requestId,
        timestamp: data.timestamp,
        statusCode: data.statusCode,
        statusMessage: data.statusMessage,
        headers: data.headers,
        bodyPreview: data.bodyPreview
      };

      // Append to file (JSONL format - one JSON object per line)
      await fs.appendFile(this.debugLogFile, JSON.stringify(logEntry) + '\n', 'utf-8');
    } catch (error) {
      logger.error('Failed to write response log:', error);
    }
  }
}
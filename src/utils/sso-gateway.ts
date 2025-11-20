/**
 * Local Authentication Gateway for SSO-enabled Claude binary
 *
 * This creates a local HTTP server that proxies requests from the claude binary
 * to the codemie API, adding SSO authentication cookies in the process.
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { CredentialStore } from './credential-store.js';
import { SSOCredentials } from '../types/sso.js';
import { logger } from './logger.js';

export interface GatewayConfig {
  targetApiUrl: string;
  port?: number;
  debug?: boolean;
}

export class SSOGateway {
  private server: Server | null = null;
  private credentials: SSOCredentials | null = null;
  private config: GatewayConfig;
  private actualPort: number = 0;

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

    // Find available port
    this.actualPort = this.config.port || await this.findAvailablePort();

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          logger.error('Gateway request error:', error);
          res.statusCode = 500;
          res.end('Internal Server Error');
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

        if (this.config.debug) {
          logger.info(`[DEBUG] SSO Gateway started on ${gatewayUrl}`);
          logger.info(`[DEBUG] Proxying to: ${this.config.targetApiUrl}`);
        }

        resolve({ port: this.actualPort, url: gatewayUrl });
      });
    });
  }

  /**
   * Stop the gateway server
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          if (this.config.debug) {
            logger.info('[DEBUG] SSO Gateway stopped');
          }
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
      res.end('SSO credentials not available');
      return;
    }

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

      // Handle request body for POST/PUT requests
      let body = '';
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        body = await this.readRequestBody(req);
      }

      if (this.config.debug) {
        console.log(`[DEBUG] About to fetch: ${targetUrl}`);
        console.log(`[DEBUG] Method: ${req.method || 'GET'}`);
        console.log(`[DEBUG] Cookie header present: ${!!forwardHeaders['Cookie']}`);
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

      if (this.config.debug) {
        console.log(`[DEBUG] Using native https with SSL verification disabled (like codemie-model-fetcher)`);
      }

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
        logger.info(`[DEBUG] Proxied ${req.method} ${req.url} -> ${response.status}`);

        // Log request details for OpenAPI spec creation
        console.log(`\n=== REQUEST DETAILS ===`);
        console.log(`Method: ${req.method}`);
        console.log(`Original URL: ${req.url}`);
        console.log(`Target URL: ${targetUrl}`);
        console.log(`Headers:`, JSON.stringify(forwardHeaders, null, 2));
        if (body) {
          console.log(`Body:`, body);
        }
        console.log(`Response Status: ${response.status}`);
        console.log(`======================\n`);
      }

    } catch (error) {
      logger.error('Gateway proxy error:', error);

      if (this.config.debug) {
        console.log(`[DEBUG] Proxy error for request: ${req.url}`);
        console.log(`[DEBUG] Error details:`, error);
      }

      res.statusCode = 502;
      res.end('Bad Gateway');
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
}
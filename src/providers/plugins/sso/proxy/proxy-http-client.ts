/**
 * Simple Streaming HTTP Client
 *
 * KISS: Does one thing well - forwards HTTP requests with streaming.
 * Memory efficient: Returns streams directly, no buffering.
 * Proxy support: Respects HTTP_PROXY/HTTPS_PROXY environment variables.
 */

import { pipeline } from 'stream/promises';
import https from 'https';
import http from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { NetworkError } from './proxy-errors.js';
import { logger } from '../../../../utils/logger.js';
import {
  getEnvNoProxyEntries,
  getEnvProxyUrl,
  parseNoProxyRules,
  shouldBypassProxy,
  type NoProxyRule,
} from '../../../../utils/system-proxy.js';

export interface HTTPClientOptions {
  timeout?: number;
  rejectUnauthorized?: boolean;
}

export interface ForwardRequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: Buffer | string; // Accept Buffer or string
}

/**
 * Simple streaming HTTP client for proxy forwarding
 */
export class ProxyHTTPClient {
  private directHttpsAgent: https.Agent;
  private directHttpAgent: http.Agent;
  private proxyHttpsAgent: https.Agent | undefined;
  private proxyHttpAgent: http.Agent | undefined;
  private timeout: number;
  private rejectUnauthorized: boolean;
  private noProxyRules: NoProxyRule[];

  constructor(options: HTTPClientOptions = {}) {
    // Use provided timeout or 0 for unlimited (AI requests can be very long)
    this.timeout = options.timeout || 0;
    this.rejectUnauthorized = options.rejectUnauthorized ?? false;

    // Proxy configuration comes from the environment. On Windows these are
    // seeded from Internet Settings by primeProxyEnv() during CLI bootstrap.
    const httpsProxyUrl = getEnvProxyUrl('https:');
    const httpProxyUrl = getEnvProxyUrl('http:');
    const noProxyEntries = getEnvNoProxyEntries();
    this.noProxyRules = parseNoProxyRules(noProxyEntries);

    // Connection pooling with keep-alive
    // NO timeout on agent - we handle it at request level
    const baseAgentOptions = {
      rejectUnauthorized: this.rejectUnauthorized,
      keepAlive: true,
      maxSockets: 50
    };

    // Create HTTPS agent (with proxy support if configured)
    if (httpsProxyUrl) {
      logger.debug('[proxy-http-client] Using HTTPS proxy:', httpsProxyUrl);
      this.proxyHttpsAgent = new HttpsProxyAgent(httpsProxyUrl, baseAgentOptions);
    }
    this.directHttpsAgent = new https.Agent(baseAgentOptions);

    // Create HTTP agent (with proxy support if configured)
    if (httpProxyUrl) {
      logger.debug('[proxy-http-client] Using HTTP proxy:', httpProxyUrl);
      this.proxyHttpAgent = new HttpProxyAgent(httpProxyUrl, {
        keepAlive: true,
        maxSockets: 50
      });
    }
    this.directHttpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 50
    });

    logger.debug('[proxy-http-client] NO_PROXY rules loaded', {
      entries: noProxyEntries,
      totalRules: this.noProxyRules.length,
    });
  }

  private getAgentForUrl(url: URL): http.Agent {
    const port = Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
    const bypass = shouldBypassProxy(url.hostname, port, this.noProxyRules);

    if (url.protocol === 'https:') {
      if (!bypass && this.proxyHttpsAgent) {
        logger.debug('[proxy-http-client] Routing HTTPS request via proxy', { host: url.hostname, port });
        return this.proxyHttpsAgent;
      }
      logger.debug('[proxy-http-client] Routing HTTPS request directly (no_proxy match or proxy disabled)', {
        host: url.hostname,
        port,
        bypass,
      });
      return this.directHttpsAgent;
    }

    if (!bypass && this.proxyHttpAgent) {
      logger.debug('[proxy-http-client] Routing HTTP request via proxy', { host: url.hostname, port });
      return this.proxyHttpAgent;
    }
    logger.debug('[proxy-http-client] Routing HTTP request directly (no_proxy match or proxy disabled)', {
      host: url.hostname,
      port,
      bypass,
    });
    return this.directHttpAgent;
  }

  /**
   * Forward request with streaming - no buffering
   * Returns response stream directly for memory efficiency
   */
  async forward(
    url: URL,
    options: ForwardRequestOptions
  ): Promise<http.IncomingMessage> {
    const protocol = url.protocol === 'https:' ? https : http;
    const agent = this.getAgentForUrl(url);

    logger.debug('[http-client] Forwarding request to upstream', {
      url: url.toString(),
      method: options.method,
      hasBody: !!options.body
    });

    return new Promise((resolve, reject) => {
      const requestOptions: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        agent,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: this.rejectUnauthorized } : {}),
        // Only set timeout if explicitly configured (0 = unlimited)
        timeout: Math.max(this.timeout, 0)
      };

      const req = protocol.request(requestOptions, (res) => {
        logger.debug('[http-client] Received response from upstream', {
          url: url.toString(),
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers
        });

        // Track response stream lifecycle
        res.on('end', () => {
          logger.debug('[http-client] Upstream response stream ended', {
            url: url.toString()
          });
        });

        res.on('close', () => {
          logger.debug('[http-client] Upstream response connection closed', {
            url: url.toString()
          });
        });

        res.on('error', (error) => {
          logger.debug('[http-client] Upstream response stream error', {
            url: url.toString(),
            error: error.message
          });
        });

        resolve(res);
      });

      req.on('error', (error: any) => {
        // Handle client disconnection (normal behavior when user closes agent)
        if (error.message === 'aborted' || error.code === 'ECONNABORTED' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          // Silent rejection for normal client disconnect - don't log as error
          logger.debug('[http-client] Client disconnected during request', {
            url: url.toString(),
            errorCode: error.code
          });
          const abortError = new Error('Client disconnected');
          (abortError as any).isAborted = true;
          reject(abortError);
          return;
        }

        // Convert to proxy error types
        // Check both error code and message for network errors
        const isNetworkError = error.code === 'ECONNREFUSED' ||
                              error.code === 'ENOTFOUND' ||
                              error.code === 'ECONNRESET' ||
                              error.message?.includes('socket hang up') ||
                              error.message?.includes('ECONNRESET');

        if (isNetworkError) {
          // Log details to debug file only - no console spam
          logger.debug('[http-client] Network error during request', {
            url: url.toString(),
            errorCode: error.code,
            errorMessage: error.message,
            hostname: url.hostname
          });
          reject(new NetworkError(`Cannot connect to upstream: ${error.message}`, {
            errorCode: error.code || 'NETWORK_ERROR',
            hostname: url.hostname
          }));
        } else {
          // Log details to debug file only - no console spam
          logger.debug('[http-client] Request error', {
            url: url.toString(),
            errorCode: error.code,
            errorMessage: error.message,
            errorStack: error.stack
          });
          reject(error);
        }
      });

      // Only set timeout handler if timeout is configured
      if (this.timeout > 0) {
        req.on('timeout', () => {
          logger.warn('[http-client] Request timeout (non-fatal)', {
            url: url.toString(),
            timeout: this.timeout,
            method: options.method
          });
          // DON'T destroy the request - let it continue
          // This prevents breaking long-running AI requests
        });
      }

      // Track request lifecycle
      req.on('finish', () => {
        logger.debug('[http-client] Request finished (all data sent)', {
          url: url.toString()
        });
      });

      req.on('close', () => {
        logger.debug('[http-client] Request connection closed', {
          url: url.toString()
        });
      });

      // Write body for POST/PUT/PATCH requests
      if (options.body) {
        req.write(options.body);
      }

      req.end();
      logger.debug('[http-client] Request.end() called', {
        url: url.toString()
      });
    });
  }

  /**
   * Stream response to client with backpressure handling
   * Uses Node.js pipeline for automatic backpressure
   */
  async pipeResponse(
    upstream: http.IncomingMessage,
    downstream: http.ServerResponse,
    skipHeaders: string[] = ['transfer-encoding', 'connection']
  ): Promise<void> {
    // Copy status code
    downstream.statusCode = upstream.statusCode || 200;

    // Copy headers (skip problematic ones)
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (!skipHeaders.includes(key.toLowerCase()) && value !== undefined) {
        downstream.setHeader(key, value);
      }
    }

    // Stream with automatic backpressure handling
    try {
      await pipeline(upstream, downstream);
      logger.debug('[http-client] Response streamed successfully');
    } catch (error) {
      // Pipeline handles cleanup automatically
      logger.error('[http-client] Stream pipeline error:', error);
      throw error;
    }
  }

  /**
   * Read response body into buffer
   * Only use when body is needed (e.g., for analytics)
   * WARNING: Buffers entire response in memory!
   */
  async readResponseBody(response: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  /**
   * Close HTTP client and cleanup agents
   */
  close(): void {
    this.directHttpsAgent.destroy();
    this.directHttpAgent.destroy();
    this.proxyHttpsAgent?.destroy();
    this.proxyHttpAgent?.destroy();
  }
}

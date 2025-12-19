/**
 * Simple Streaming HTTP Client
 *
 * KISS: Does one thing well - forwards HTTP requests with streaming.
 * Memory efficient: Returns streams directly, no buffering.
 */

import { pipeline } from 'stream/promises';
import https from 'https';
import http from 'http';
import { NetworkError } from './proxy-errors.js';
import { logger } from '../../../../utils/logger.js';

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
  private httpsAgent: https.Agent;
  private httpAgent: http.Agent;
  private timeout: number;

  constructor(options: HTTPClientOptions = {}) {
    // Use provided timeout or 0 for unlimited (AI requests can be very long)
    this.timeout = options.timeout || 0;

    // Connection pooling with keep-alive
    // NO timeout on agent - we handle it at request level
    const agentOptions = {
      rejectUnauthorized: options.rejectUnauthorized ?? false,
      keepAlive: true,
      maxSockets: 50
    };

    this.httpsAgent = new https.Agent(agentOptions);
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 50
    });
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
    const agent = url.protocol === 'https:' ? this.httpsAgent : this.httpAgent;

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
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}

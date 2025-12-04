/**
 * Simple Streaming HTTP Client
 *
 * KISS: Does one thing well - forwards HTTP requests with streaming.
 * Memory efficient: Returns streams directly, no buffering.
 */

import { pipeline } from 'stream/promises';
import https from 'https';
import http from 'http';
import { TimeoutError, NetworkError } from './errors.js';
import { logger } from '../utils/logger.js';

export interface HTTPClientOptions {
  timeout?: number;
  rejectUnauthorized?: boolean;
}

export interface ForwardRequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Simple streaming HTTP client for proxy forwarding
 */
export class ProxyHTTPClient {
  private httpsAgent: https.Agent;
  private httpAgent: http.Agent;
  private timeout: number;

  constructor(options: HTTPClientOptions = {}) {
    this.timeout = options.timeout || 300000; // 5 minutes default

    // Connection pooling with keep-alive
    const agentOptions = {
      rejectUnauthorized: options.rejectUnauthorized ?? false,
      keepAlive: true,
      maxSockets: 50,
      timeout: 30000 // Connection timeout
    };

    this.httpsAgent = new https.Agent(agentOptions);
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 50,
      timeout: 30000
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

    return new Promise((resolve, reject) => {
      const requestOptions: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        agent,
        timeout: this.timeout
      };

      const req = protocol.request(requestOptions, (res) => {
        resolve(res);
      });

      req.on('error', (error: any) => {
        // Handle client disconnection (normal behavior when user closes agent)
        if (error.message === 'aborted' || error.code === 'ECONNABORTED' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          // Silent rejection for normal client disconnect - don't log as error
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
          reject(new NetworkError(`Cannot connect to upstream: ${error.message}`, {
            errorCode: error.code || 'NETWORK_ERROR',
            hostname: url.hostname
          }));
        } else {
          reject(error);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new TimeoutError(`Request timeout after ${this.timeout}ms`, {
          timeout: this.timeout,
          url: url.toString()
        }));
      });

      // Write body for POST/PUT/PATCH requests
      if (options.body) {
        req.write(options.body);
      }

      req.end();
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

/**
 * Simple HTTP Client for Provider Plugins
 *
 * Lightweight HTTP client with timeout, redirect, and retry support
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { logger } from '../../../utils/logger.js';
import { sanitizeHeaders } from '../../../utils/sanitize.js';

export interface HTTPClientConfig {
  timeout?: number;                  // Timeout in milliseconds (default: 5000)
  headers?: Record<string, string>;  // Additional headers
  maxRedirects?: number;             // Maximum redirects to follow (default: 5)
  maxRetries?: number;               // Maximum retries on failure (default: 3)
  rejectUnauthorized?: boolean;      // Allow self-signed certificates (default: false)
}

export interface HTTPResponse<T = unknown> {
  status: number;
  statusText: string;
  data: T;
  headers: Record<string, string>;
}

/**
 * Simple HTTP Client
 */
export class HTTPClient {
  private config: Required<HTTPClientConfig>;

  constructor(config: HTTPClientConfig = {}) {
    this.config = {
      timeout: 5000,
      maxRedirects: 5,
      maxRetries: 3,
      rejectUnauthorized: false,
      headers: {},
      ...config
    };
  }

  /**
   * Perform HTTP GET request with retry logic
   */
  async get<T = unknown>(url: string, headers?: Record<string, string>): Promise<HTTPResponse<T>> {
    return this.withRetry(() => this.request<T>('GET', url, undefined, headers));
  }

  /**
   * Perform HTTP POST request with retry logic
   */
  async post<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<HTTPResponse<T>> {
    return this.withRetry(() => this.request<T>('POST', url, data, headers));
  }

  /**
   * Perform HTTP GET request with redirect support (returns raw string)
   */
  async getRaw(url: string, headers?: Record<string, string>): Promise<{ statusCode?: number; statusMessage?: string; headers: http.IncomingHttpHeaders; data: string }> {
    return this.requestWithRedirects(url, {
      method: 'GET',
      headers: {
        ...this.config.headers,
        ...headers
      },
      rejectUnauthorized: this.config.rejectUnauthorized,
      timeout: this.config.timeout
    });
  }

  /**
   * Perform HTTP request
   */
  private async request<T>(
    method: string,
    url: string,
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<HTTPResponse<T>> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.config.headers,
        ...headers
      };

      const body = data ? JSON.stringify(data) : undefined;

      if (body) {
        requestHeaders['Content-Length'] = Buffer.byteLength(body).toString();
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: requestHeaders,
        timeout: this.config.timeout
      };

      const req = client.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsedData = responseData ? JSON.parse(responseData) : null;
            const response: HTTPResponse<T> = {
              status: res.statusCode || 0,
              statusText: res.statusMessage || '',
              data: parsedData,
              headers: res.headers as Record<string, string>
            };

            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${this.config.timeout}ms`));
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Make HTTP request with automatic redirect following
   * Handles 301, 302, 303, 307, 308 redirects following HTTP standards
   */
  private async requestWithRedirects(
    url: string,
    requestOptions: https.RequestOptions,
    redirectCount: number = 0
  ): Promise<{ statusCode?: number; statusMessage?: string; headers: http.IncomingHttpHeaders; data: string }> {
    if (redirectCount >= this.config.maxRedirects) {
      throw new Error(`Too many redirects (${redirectCount}). Possible redirect loop.`);
    }

    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options: https.RequestOptions = {
      ...requestOptions,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
    };

    if (logger.isDebugMode()) {
      logger.debug(`[HTTP Request] ${options.method} ${url}`);
      logger.debug(`[Headers]`, sanitizeHeaders(requestOptions.headers as Record<string, unknown>));
      if (redirectCount > 0) {
        logger.debug(`[Redirect] Following redirect #${redirectCount}`);
      }
    }

    return new Promise((resolve, reject) => {
      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', async () => {
          const statusCode = res.statusCode || 0;

          if (logger.isDebugMode()) {
            logger.debug(`[HTTP Response] ${statusCode} ${res.statusMessage}`);
            logger.debug(`[Response Headers]`, sanitizeHeaders(res.headers as Record<string, unknown>));
          }

          // Handle redirects (301, 302, 303, 307, 308)
          if (statusCode >= 300 && statusCode < 400) {
            const location = res.headers['location'];

            if (!location) {
              reject(new Error(`Redirect ${statusCode} without Location header`));
              return;
            }

            // Resolve relative URLs against current URL
            const redirectUrl = new URL(location, url).toString();

            logger.info(`[Redirect] ${statusCode} -> ${redirectUrl}`);

            // Update cookies from Set-Cookie headers if present
            const setCookieHeaders = res.headers['set-cookie'];
            if (setCookieHeaders && requestOptions.headers) {
              const existingCookies = (requestOptions.headers['cookie'] as string) || '';
              const newCookies = setCookieHeaders
                .map(cookie => cookie.split(';')[0]) // Extract cookie name=value
                .join('; ');

              requestOptions.headers['cookie'] = existingCookies
                ? `${existingCookies}; ${newCookies}`
                : newCookies;
            }

            // For 303, change POST/PUT to GET
            if (statusCode === 303 && options.method !== 'GET' && options.method !== 'HEAD') {
              requestOptions.method = 'GET';
              delete requestOptions.headers?.['content-length'];
              delete requestOptions.headers?.['content-type'];
            }

            try {
              // Follow the redirect
              const redirectResponse = await this.requestWithRedirects(
                redirectUrl,
                requestOptions,
                redirectCount + 1
              );
              resolve(redirectResponse);
            } catch (error) {
              reject(error);
            }
            return;
          }

          // Not a redirect, return response
          resolve({
            statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            data
          });
        });
      });

      req.on('error', (error) => {
        if (logger.isDebugMode()) {
          logger.error(`[HTTP Error]`, error);
        }
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Retry wrapper with exponential backoff
   */
  private async withRetry<T>(
    fn: () => Promise<T>
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry auth errors
        if (lastError.message.includes('SSO session expired') ||
            lastError.message.includes('401') ||
            lastError.message.includes('403')) {
          throw lastError;
        }

        // Log retry attempt
        logger.warn(`[Retry] Request failed (attempt ${attempt}/${this.config.maxRetries}): ${lastError.message}`);

        if (attempt < this.config.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          logger.debug(`[Retry] Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}

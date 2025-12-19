/**
 * Metrics API Client
 *
 * HTTP client for sending metrics to CodeMie API.
 * Features:
 * - Exponential backoff retry
 * - SSO cookie authentication
 * - JSON batch sending
 * - Error classification (retryable vs non-retryable)
 */

import {logger} from '../../../../../utils/logger.js';
import {CODEMIE_ENDPOINTS} from '../../sso.http-client.js';
import type {MetricsApiConfig, MetricsSyncResponse, SessionMetric, MetricsApiError} from './sso.metrics-types.js';

export class MetricsApiClient {
  private readonly config: Required<MetricsApiConfig>;

  constructor(config: MetricsApiConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      cookies: config.cookies || '',
      timeout: config.timeout || 30000,
      retryAttempts: config.retryAttempts || 3,
      retryDelays: config.retryDelays || [1000, 2000, 5000],
      version: config.version || process.env.CODEMIE_CLI_VERSION || 'unknown',
      clientType: config.clientType || 'codemie-cli'
    };
  }

  /**
   * Send single aggregated metric to API (JSON format)
   */
  async sendMetric(metric: SessionMetric): Promise<MetricsSyncResponse> {
    let lastError: Error | undefined;

    // Retry with exponential backoff
    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.config.retryDelays[attempt - 1] || 5000;
          logger.debug(`[MetricsApiClient] Retry attempt ${attempt} after ${delay}ms`);
          await this.sleep(delay);
        }

        return await this.sendRequest(metric);

      } catch (error) {
        lastError = error as Error;

        // Better error logging (Error objects don't serialize well)
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : 'Unknown';
        const statusCode = (error as any).statusCode;

        // Check if error is retryable
        if (!this.isRetryable(error as Error)) {
          logger.error(`[MetricsApiClient] Non-retryable error [${errorName}]: ${errorMessage}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
          throw error;
        }

        logger.warn(`[MetricsApiClient] Attempt ${attempt + 1} failed [${errorName}]: ${errorMessage}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
      }
    }

    // All retries exhausted
    throw new Error(`Failed after ${this.config.retryAttempts} retries: ${lastError?.message}`);
  }

  /**
   * Send HTTP request to API
   */
  private async sendRequest(metric: SessionMetric): Promise<MetricsSyncResponse> {
    const url = `${this.config.baseUrl}${CODEMIE_ENDPOINTS.METRICS}`;

    // Convert to JSON
    const body = JSON.stringify(metric);

    logger.debug(`[MetricsApiClient] Sending metric to ${url}. Body ${body}`);

    // Create headers (match SSO endpoint headers)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `codemie-cli/${this.config.version}`,
      'X-CodeMie-CLI': `codemie-cli/${this.config.version}`,
      'X-CodeMie-Client': this.config.clientType
    };

    // Add cookies if present (SSO authentication)
    if (this.config.cookies) {
      headers['Cookie'] = this.config.cookies;
    }

    // Send request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Parse response - could be success response or error response
      const data = await response.json() as MetricsSyncResponse | MetricsApiError;

      // Check response status first
      if (!response.ok) {
        // Handle FastAPI ExtendedHTTPException format
        if ('code' in data && 'details' in data) {
          const errorData = data as MetricsApiError;
          let errorMessage = `API returned ${response.status}: ${errorData.message}`;
          if (errorData.details) {
            errorMessage += `\nDetails: ${errorData.details}`;
          }
          if (errorData.help) {
            errorMessage += `\nHelp: ${errorData.help}`;
          }

          const error = new Error(errorMessage);
          (error as any).statusCode = response.status;
          (error as any).response = data;
          throw error;
        }

        // Fallback for non-extended error format
        const errorMessage = 'message' in data ? data.message : response.statusText;
        const error = new Error(`API returned ${response.status}: ${errorMessage}`);
        (error as any).statusCode = response.status;
        (error as any).response = data;
        throw error;
      }

      // Successfully got 200 response, check if metric was processed
      const successData = data as MetricsSyncResponse;

      logger.debug(
        `[MetricsApiClient] Response from ${url}: success=${successData.success}, message="${successData.message}"`
      );

      // Check if the API reported failure in the response body (success=false with 200 status)
      if (!successData.success) {
        const error = new Error(`API reported failure: ${successData.message}`);
        (error as any).response = data;
        throw error;
      }

      logger.info(
        `[MetricsApiClient] Successfully sent metric: ${successData.message}`
      );

      return successData;

    } catch (error) {
      clearTimeout(timeoutId);

      if ((error as Error).name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeout}ms`);
      }

      throw error;
    }
  }

  /**
   * Check if error is retryable
   */
  private isRetryable(error: Error): boolean {
    const statusCode = (error as any).statusCode;

    // Retryable errors
    if (!statusCode) {
      // Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
      return true;
    }

    // Retry on 5xx and 429 (rate limit)
    if (statusCode >= 500 || statusCode === 429) {
      return true;
    }

    // Non-retryable errors (4xx except 429)
    // 401 Unauthorized, 403 Forbidden, 400 Bad Request
    return false;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

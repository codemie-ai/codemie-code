/**
 * API Metrics Plugin
 *
 * Tracks API request/response patterns, success/failure rates, and latency.
 * Useful for monitoring 3rd party agent API health and performance.
 */

import { AnalyticsPlugin } from './types.js';
import { AnalyticsEvent } from '../types.js';

export class APIMetricsPlugin implements AnalyticsPlugin {
  name = 'api-metrics';
  version = '1.0.0';

  // Track metrics per session
  private sessionMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalLatency: 0,
    minLatency: Infinity,
    maxLatency: 0,
    statusCodes: {} as Record<number, number>,
    errorTypes: {} as Record<string, number>
  };

  /**
   * Process events to track metrics (no enrichment to individual events)
   */
  async processEvent(event: AnalyticsEvent): Promise<AnalyticsEvent | null> {
    // Track API request metrics
    if (event.eventType === 'api_request') {
      this.sessionMetrics.totalRequests++;
    }

    // Track API response metrics
    if (event.eventType === 'api_response') {
      const statusCode = event.attributes.statusCode as number;
      const latency = event.metrics?.latencyMs as number;

      // Count successful vs failed
      if (statusCode >= 200 && statusCode < 400) {
        this.sessionMetrics.successfulRequests++;
      } else {
        this.sessionMetrics.failedRequests++;
      }

      // Track status codes
      this.sessionMetrics.statusCodes[statusCode] =
        (this.sessionMetrics.statusCodes[statusCode] || 0) + 1;

      // Track latency stats
      if (latency) {
        this.sessionMetrics.totalLatency += latency;
        this.sessionMetrics.minLatency = Math.min(this.sessionMetrics.minLatency, latency);
        this.sessionMetrics.maxLatency = Math.max(this.sessionMetrics.maxLatency, latency);
      }
    }

    // Track proxy errors
    if (event.eventType === 'proxy_error') {
      const errorType = event.attributes.errorType as string || 'unknown';
      this.sessionMetrics.errorTypes[errorType] =
        (this.sessionMetrics.errorTypes[errorType] || 0) + 1;
    }

    // Return event unchanged (no enrichment)
    return event;
  }

  /**
   * Get current aggregated metrics
   */
  getMetrics(): Record<string, unknown> {
    const successRate = this.sessionMetrics.totalRequests > 0
      ? this.sessionMetrics.successfulRequests / this.sessionMetrics.totalRequests
      : 0;

    const averageLatency = this.sessionMetrics.successfulRequests > 0
      ? this.sessionMetrics.totalLatency / this.sessionMetrics.successfulRequests
      : 0;

    return {
      totalRequests: this.sessionMetrics.totalRequests,
      successfulRequests: this.sessionMetrics.successfulRequests,
      failedRequests: this.sessionMetrics.failedRequests,
      successRate: Math.round(successRate * 100) / 100,
      averageLatencyMs: Math.round(averageLatency),
      minLatencyMs: this.sessionMetrics.minLatency === Infinity ? 0 : this.sessionMetrics.minLatency,
      maxLatencyMs: this.sessionMetrics.maxLatency,
      statusCodes: { ...this.sessionMetrics.statusCodes },
      errorTypes: { ...this.sessionMetrics.errorTypes }
    };
  }

  /**
   * Reset metrics (useful for new sessions)
   */
  reset(): void {
    this.sessionMetrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
      minLatency: Infinity,
      maxLatency: 0,
      statusCodes: {},
      errorTypes: {}
    };
  }
}

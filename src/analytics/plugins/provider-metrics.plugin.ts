/**
 * Provider Metrics Plugin
 *
 * Tracks metrics per provider (ai-run-sso, litellm, openai, azure, bedrock).
 * Helps compare provider reliability and performance.
 */

import { AnalyticsPlugin } from './types.js';
import { AnalyticsEvent } from '../types.js';

interface ProviderStats {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalLatency: number;
  timeouts: number;
  networkErrors: number;
  authErrors: number;
}

export class ProviderMetricsPlugin implements AnalyticsPlugin {
  name = 'provider-metrics';
  version = '1.0.0';

  // Track metrics per provider
  private providerMetrics = new Map<string, ProviderStats>();

  /**
   * Process events to track metrics (no enrichment to individual events)
   */
  async processEvent(event: AnalyticsEvent): Promise<AnalyticsEvent | null> {
    // Extract provider from event
    const provider = event.provider || event.attributes.provider as string;

    if (!provider) {
      return event;
    }

    // Initialize provider stats if needed
    if (!this.providerMetrics.has(provider)) {
      this.providerMetrics.set(provider, {
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        totalLatency: 0,
        timeouts: 0,
        networkErrors: 0,
        authErrors: 0
      });
    }

    const stats = this.providerMetrics.get(provider)!;

    // Track API requests
    if (event.eventType === 'api_request') {
      stats.requestCount++;
    }

    // Track API responses
    if (event.eventType === 'api_response') {
      const statusCode = event.attributes.statusCode as number;
      const latency = event.metrics?.latencyMs as number;

      if (statusCode >= 200 && statusCode < 400) {
        stats.successCount++;
      } else {
        stats.failureCount++;

        // Track specific error types
        if (statusCode === 401 || statusCode === 403) {
          stats.authErrors++;
        }
      }

      if (latency) {
        stats.totalLatency += latency;
      }
    }

    // Track proxy errors
    if (event.eventType === 'proxy_error') {
      const errorType = event.attributes.errorType as string;

      if (errorType === 'TimeoutError') {
        stats.timeouts++;
      } else if (errorType === 'NetworkError') {
        stats.networkErrors++;
      } else if (errorType === 'AuthenticationError') {
        stats.authErrors++;
      }

      stats.failureCount++;
    }

    // Return event unchanged (no enrichment)
    return event;
  }

  /**
   * Get current aggregated metrics for all providers
   */
  getMetrics(): Record<string, unknown> {
    const providerMetrics: Record<string, any> = {};

    for (const [provider, stats] of this.providerMetrics.entries()) {
      const successRate = stats.requestCount > 0
        ? stats.successCount / stats.requestCount
        : 0;

      const errorRate = stats.requestCount > 0
        ? stats.failureCount / stats.requestCount
        : 0;

      const avgLatency = stats.successCount > 0
        ? stats.totalLatency / stats.successCount
        : 0;

      providerMetrics[provider] = {
        requestCount: stats.requestCount,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        successRate: Math.round(successRate * 100) / 100,
        errorRate: Math.round(errorRate * 100) / 100,
        averageLatencyMs: Math.round(avgLatency),
        timeouts: stats.timeouts,
        networkErrors: stats.networkErrors,
        authErrors: stats.authErrors
      };
    }

    return {
      providers: providerMetrics,
      providerCount: this.providerMetrics.size
    };
  }

  /**
   * Reset metrics (useful for new sessions)
   */
  reset(): void {
    this.providerMetrics.clear();
  }

  /**
   * Get all provider metrics (useful for session end reporting)
   * @deprecated Use getMetrics() instead
   */
  getAllProviderMetrics(): Record<string, ProviderStats> {
    const result: Record<string, ProviderStats> = {};
    for (const [provider, stats] of this.providerMetrics.entries()) {
      result[provider] = { ...stats };
    }
    return result;
  }
}

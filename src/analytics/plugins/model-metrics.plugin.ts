/**
 * Model Metrics Plugin
 *
 * Tracks metrics per model (Claude, GPT, Gemini, etc.).
 * Helps identify which models perform better for different use cases.
 */

import { AnalyticsPlugin } from './types.js';
import { AnalyticsEvent } from '../types.js';

interface ModelStats {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalLatency: number;
  totalTokens: number;
}

export class ModelMetricsPlugin implements AnalyticsPlugin {
  name = 'model-metrics';
  version = '1.0.0';

  // Track metrics per model
  private modelMetrics = new Map<string, ModelStats>();

  async enrichMetrics(event: AnalyticsEvent): Promise<Record<string, unknown>> {
    // Extract model from event
    const model = event.model || event.attributes.model as string;

    if (!model) {
      return {};
    }

    // Initialize model stats if needed
    if (!this.modelMetrics.has(model)) {
      this.modelMetrics.set(model, {
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        totalLatency: 0,
        totalTokens: 0
      });
    }

    const stats = this.modelMetrics.get(model)!;

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
      }

      if (latency) {
        stats.totalLatency += latency;
      }

      // Track token usage if available
      const responseBody = event.attributes.responseBody as any;
      if (responseBody?.usage) {
        const totalTokens = responseBody.usage.total_tokens ||
                           (responseBody.usage.input_tokens + responseBody.usage.output_tokens) ||
                           0;
        stats.totalTokens += totalTokens;
      }

      // Calculate model-specific metrics
      const successRate = stats.requestCount > 0
        ? stats.successCount / stats.requestCount
        : 0;

      const avgLatency = stats.successCount > 0
        ? stats.totalLatency / stats.successCount
        : 0;

      return {
        model_name: model,
        model_request_count: stats.requestCount,
        model_success_rate: Math.round(successRate * 100) / 100,
        model_avg_latency_ms: Math.round(avgLatency),
        model_total_tokens: stats.totalTokens
      };
    }

    return {};
  }

  /**
   * Get current aggregated metrics for all models
   */
  getMetrics(): Record<string, unknown> {
    const modelMetrics: Record<string, any> = {};

    for (const [model, stats] of this.modelMetrics.entries()) {
      const successRate = stats.requestCount > 0
        ? stats.successCount / stats.requestCount
        : 0;

      const avgLatency = stats.successCount > 0
        ? stats.totalLatency / stats.successCount
        : 0;

      modelMetrics[model] = {
        requestCount: stats.requestCount,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        successRate: Math.round(successRate * 100) / 100,
        averageLatencyMs: Math.round(avgLatency),
        totalTokens: stats.totalTokens
      };
    }

    return {
      models: modelMetrics,
      modelCount: this.modelMetrics.size
    };
  }

  /**
   * Reset metrics (useful for new sessions)
   */
  reset(): void {
    this.modelMetrics.clear();
  }

  /**
   * Get all model metrics (useful for session end reporting)
   * @deprecated Use getMetrics() instead
   */
  getAllModelMetrics(): Record<string, ModelStats> {
    const result: Record<string, ModelStats> = {};
    for (const [model, stats] of this.modelMetrics.entries()) {
      result[model] = { ...stats };
    }
    return result;
  }
}

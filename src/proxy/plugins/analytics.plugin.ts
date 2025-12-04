/**
 * Analytics Plugin - STREAMING VERSION
 * Priority: 100 (runs last)
 *
 * Key difference: Uses onResponseComplete instead of buffering
 * Tracks metadata only, no body capture by default
 *
 * SOLID: Single responsibility = track analytics
 * KISS: Simple tracking, reuses Analytics system
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor, ResponseMetadata } from './types.js';
import { ProxyContext } from '../types.js';
import { Analytics } from '../../analytics/index.js';
import { logger } from '../../utils/logger.js';

export class AnalyticsPlugin implements ProxyPlugin {
  id = '@codemie/proxy-analytics';
  name = 'Analytics';
  version = '2.0.0';
  priority = 100; // Run last

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (!context.analytics) {
      throw new Error('Analytics instance required');
    }

    return new AnalyticsInterceptor(context.analytics);
  }
}

class AnalyticsInterceptor implements ProxyInterceptor {
  name = 'analytics';

  constructor(private analytics: Analytics) {}

  async onRequest(context: ProxyContext): Promise<void> {
    if (!this.analytics.isEnabled) return;

    try {
      // Track request metadata only (no body parsing)
      await this.analytics.track('api_request', {
        requestId: context.requestId,
        method: context.method,
        url: context.url,
        targetUrl: context.targetUrl,
        bodySize: context.requestBody?.length || 0
      });

      logger.debug(`[${this.name}] Tracked API request: ${context.method} ${context.url}`);
    } catch (error) {
      logger.error(`[${this.name}] Error tracking request:`, error);
    }
  }

  async onResponseComplete(
    context: ProxyContext,
    metadata: ResponseMetadata
  ): Promise<void> {
    if (!this.analytics.isEnabled) return;

    try {
      // Track response metadata (after streaming complete)
      await this.analytics.track('api_response', {
        requestId: context.requestId,
        statusCode: metadata.statusCode,
        statusMessage: metadata.statusMessage,
        bytesSent: metadata.bytesSent
      }, {
        latencyMs: metadata.durationMs
      });

      logger.debug(`[${this.name}] Tracked API response: ${metadata.statusCode} ${context.url} (${metadata.durationMs}ms)`);
    } catch (error) {
      logger.error(`[${this.name}] Error tracking response:`, error);
    }
  }

  async onError(context: ProxyContext, error: Error): Promise<void> {
    if (!this.analytics.isEnabled) return;

    try {
      await this.analytics.track('proxy_error', {
        requestId: context.requestId,
        errorType: error.name,
        errorMessage: error.message,
        url: context.url
      });

      logger.debug(`[${this.name}] Tracked error`);
    } catch (trackError) {
      logger.error(`[${this.name}] Error tracking error:`, trackError);
    }
  }
}

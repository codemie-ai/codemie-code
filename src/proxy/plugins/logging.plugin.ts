/**
 * Logging Plugin - Request/Response Logging to Log Files
 * Priority: 50 (runs before analytics)
 *
 * Purpose: Logs detailed proxy request/response information to log files
 * Separates operational logging from analytics metrics
 *
 * Log Level: INFO (file-only, no console output)
 * Log Location: ~/.codemie/logs/debug-YYYY-MM-DD.log
 *
 * SOLID: Single responsibility = log proxy activity
 * KISS: Simple logging, reuses Logger system
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor, ResponseMetadata } from './types.js';
import { ProxyContext } from '../types.js';
import { logger } from '../../utils/logger.js';

export class LoggingPlugin implements ProxyPlugin {
  id = '@codemie/proxy-logging';
  name = 'Logging';
  version = '1.0.0';
  priority = 50; // Run before analytics

  async createInterceptor(_context: PluginContext): Promise<ProxyInterceptor> {
    return new LoggingInterceptor();
  }
}

class LoggingInterceptor implements ProxyInterceptor {
  name = 'logging';

  async onRequest(context: ProxyContext): Promise<void> {
    try {
      logger.info(
        `[proxy-request] ${context.method} ${context.url}`,
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
          agent: context.agentName,
          targetUrl: context.targetUrl,
          bodySize: context.requestBody?.length || 0,
          headers: this.sanitizeHeaders(context.headers)
        }
      );
    } catch (error) {
      // Don't break proxy flow on logging errors
      logger.error(`[${this.name}] Error logging request:`, error);
    }
  }

  async onResponseComplete(
    context: ProxyContext,
    metadata: ResponseMetadata
  ): Promise<void> {
    try {
      logger.info(
        `[proxy-response] ${metadata.statusCode} ${context.url} (${metadata.durationMs}ms)`,
        {
          requestId: context.requestId,
          statusCode: metadata.statusCode,
          statusMessage: metadata.statusMessage,
          bytesSent: metadata.bytesSent,
          durationMs: metadata.durationMs
        }
      );
    } catch (error) {
      // Don't break proxy flow on logging errors
      logger.error(`[${this.name}] Error logging response:`, error);
    }
  }

  async onError(context: ProxyContext, error: Error): Promise<void> {
    try {
      logger.info(
        `[proxy-error] ${error.name}: ${error.message}`,
        {
          requestId: context.requestId,
          url: context.url,
          errorType: error.name,
          errorStack: error.stack
        }
      );
    } catch (logError) {
      // Don't break proxy flow on logging errors
      logger.error(`[${this.name}] Error logging error:`, logError);
    }
  }

  /**
   * Sanitize headers to remove sensitive data
   */
  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();

      // Mask sensitive headers
      if (lowerKey.includes('authorization') ||
          lowerKey.includes('api-key') ||
          lowerKey.includes('token') ||
          lowerKey.includes('cookie')) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

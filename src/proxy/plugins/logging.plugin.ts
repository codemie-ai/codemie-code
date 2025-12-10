/**
 * Logging Plugin - Request/Response Logging
 * Priority: 50 (runs before analytics)
 *
 * Purpose: Logs detailed proxy request/response information
 * Separates operational logging from analytics metrics
 *
 * Log Level: DEBUG (file + console when CODEMIE_DEBUG=1)
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
  private chunkCount = 0;
  private totalBytes = 0;

  async onRequest(context: ProxyContext): Promise<void> {
    try {
      // Reset counters for new request
      this.chunkCount = 0;
      this.totalBytes = 0;

      logger.debug(
        `[proxy-request] ${context.method} ${context.url}`,
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
          agent: context.agentName,
          profile: context.profile,
          provider: context.provider,
          model: context.model,
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

  async onResponseHeaders(
    context: ProxyContext,
    headers: Record<string, string | string[] | undefined>
  ): Promise<void> {
    try {
      logger.debug(
        `[proxy-response-headers] ${context.url}`,
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
          agent: context.agentName,
          profile: context.profile,
          provider: context.provider,
          model: context.model,
          headers: {
            'content-type': headers['content-type'],
            'content-length': headers['content-length'],
            'transfer-encoding': headers['transfer-encoding']
          }
        }
      );
    } catch (error) {
      logger.error(`[${this.name}] Error logging response headers:`, error);
    }
  }

  async onResponseChunk(
    context: ProxyContext,
    chunk: Buffer
  ): Promise<Buffer | null> {
    try {
      this.chunkCount++;
      this.totalBytes += chunk.length;

      // Log every 10th chunk to avoid spam (or first/last chunks)
      if (this.chunkCount === 1 || this.chunkCount % 10 === 0) {
        logger.debug(
          `[proxy-streaming] ${context.url}`,
          {
            requestId: context.requestId,
            sessionId: context.sessionId,
            chunkNumber: this.chunkCount,
            chunkSize: chunk.length,
            totalBytes: this.totalBytes
          }
        );
      }
    } catch (error) {
      logger.error(`[${this.name}] Error logging chunk:`, error);
    }

    return chunk;
  }

  async onResponseComplete(
    context: ProxyContext,
    metadata: ResponseMetadata
  ): Promise<void> {
    try {
      logger.debug(
        `[proxy-response] ${metadata.statusCode} ${context.url} (${metadata.durationMs}ms)`,
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
          agent: context.agentName,
          profile: context.profile,
          provider: context.provider,
          model: context.model,
          statusCode: metadata.statusCode,
          statusMessage: metadata.statusMessage,
          bytesSent: metadata.bytesSent,
          durationMs: metadata.durationMs,
          totalChunks: this.chunkCount,
          totalBytesStreamed: this.totalBytes
        }
      );

      // Log completion marker to track if we reach this point
      logger.debug(
        `[proxy-complete] Request fully processed for ${context.url}`,
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
          agent: context.agentName,
          profile: context.profile,
          provider: context.provider,
          model: context.model,
          finalStatus: 'success'
        }
      );
    } catch (error) {
      // Don't break proxy flow on logging errors
      logger.error(`[${this.name}] Error logging response:`, error);
    }
  }

  async onError(context: ProxyContext, error: Error): Promise<void> {
    try {
      logger.debug(
        `[proxy-error] ${error.name}: ${error.message}`,
        {
          requestId: context.requestId,
          sessionId: context.sessionId,
          agent: context.agentName,
          profile: context.profile,
          provider: context.provider,
          model: context.model,
          url: context.url,
          errorType: error.name,
          errorMessage: error.message,
          errorStack: error.stack
        }
      );
    } catch (logError) {
      // Don't break proxy flow on logging errors
      logger.error(`[${this.name}] Error logging error:`, logError);
    }
  }

  /**
   * Filter headers to only include X-Codemie headers
   */
  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      // Only include X-Codemie headers
      if (key.toLowerCase().startsWith('x-codemie')) {
        filtered[key] = value;
      }
    }

    return filtered;
  }
}

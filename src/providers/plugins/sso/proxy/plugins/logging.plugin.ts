/**
 * Logging Plugin - Request/Response Logging
 * Priority: 50 (runs before analytics)
 *
 * Purpose: Logs detailed proxy request/response information with smart content handling
 * Separates operational logging from analytics metrics
 *
 * Logs:
 * - Request: method, URL, content-type, headers, body (parsed JSON or raw)
 * - Response: status, content-type, headers, body (smart handling based on type)
 *   - JSON: Parsed and structured
 *   - SSE (Server-Sent Events): First/last events + stats (avoids logging full stream)
 *   - Other: Raw content (truncated if > 1000 bytes)
 * - Streaming: chunk count, bytes transferred, streaming detection
 *
 * Log Level: DEBUG (file + console when CODEMIE_DEBUG=1)
 * Log Location: ~/.codemie/logs/debug-YYYY-MM-DD.log
 *
 * SOLID: Single responsibility = log proxy activity
 * KISS: Simple logging, reuses Logger system
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor, ResponseMetadata } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

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
  private responseChunks: Buffer[] = [];
  private responseContentType: string | null = null;

  async onRequest(context: ProxyContext): Promise<void> {
    try {
      // Reset counters for new request
      this.chunkCount = 0;
      this.totalBytes = 0;
      this.responseChunks = [];
      this.responseContentType = null;

      // Get request content type
      const contentType = context.headers['content-type'] || context.headers['Content-Type'] || 'unknown';

      // Parse request body based on content type
      let requestBodyParsed: any = null;
      if (context.requestBody) {
        try {
          const bodyString = context.requestBody.toString('utf-8');
          if (contentType.includes('application/json')) {
            requestBodyParsed = JSON.parse(bodyString);
          } else {
            // Log raw for non-JSON
            requestBodyParsed = bodyString;
          }
        } catch {
          // Parse error - log as string
          requestBodyParsed = context.requestBody.toString('utf-8');
        }
      }

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
          contentType,
          bodySize: context.requestBody?.length || 0,
          headers: this.sanitizeHeaders(context.headers),
          requestBody: requestBodyParsed
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
      // Capture response content type for use in response body logging
      const contentTypeHeader = headers['content-type'] || headers['Content-Type'];
      this.responseContentType = Array.isArray(contentTypeHeader)
        ? contentTypeHeader[0]
        : contentTypeHeader || 'unknown';

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
            'content-type': this.responseContentType,
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

      // Collect chunks for full response body
      this.responseChunks.push(Buffer.from(chunk));

      // Log every 1000th chunk to avoid spam (or first/last chunks)
      if (this.chunkCount === 1 || this.chunkCount % 1000 === 0) {
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
      // Capture chunks for logging (use local reference to avoid race conditions)
      const chunksToLog = this.responseChunks;
      const chunkCount = this.chunkCount;
      const totalBytes = this.totalBytes;
      const contentType = this.responseContentType || 'unknown';

      // CRITICAL: Clear state immediately for next request
      this.responseChunks = [];
      this.chunkCount = 0;
      this.totalBytes = 0;
      this.responseContentType = null;

      // Process response body asynchronously (don't block)
      // Use setImmediate to defer heavy work to next tick
      setImmediate(() => {
        try {
          let responseBodyParsed: any = null;
          let isStreaming = false;

          if (chunksToLog.length > 0) {
            const fullBody = Buffer.concat(chunksToLog).toString('utf-8');

            // Check if this is a streaming response (SSE)
            isStreaming = contentType.includes('text/event-stream') || fullBody.startsWith('event:');

            if (isStreaming) {
              // For streaming responses, log first and last few events instead of full body
              const lines = fullBody.split('\n').filter(line => line.trim());
              const eventCount = lines.filter(line => line.startsWith('event:')).length;

              responseBodyParsed = {
                type: 'text/event-stream',
                eventCount,
                firstEvents: lines.slice(0, 10).join('\n'),
                lastEvents: lines.slice(-10).join('\n'),
                totalLines: lines.length,
                bodySizeBytes: fullBody.length
              };
            } else if (contentType.includes('application/json')) {
              // Parse JSON responses
              try {
                responseBodyParsed = JSON.parse(fullBody);
              } catch {
                // Invalid JSON - log as string
                responseBodyParsed = fullBody;
              }
            } else {
              // Log raw for other content types (truncate if too long)
              responseBodyParsed = fullBody.length > 1000
                ? fullBody.substring(0, 1000) + '... (truncated)'
                : fullBody;
            }
          }

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
              contentType,
              isStreaming,
              bytesSent: metadata.bytesSent,
              durationMs: metadata.durationMs,
              totalChunks: chunkCount,
              totalBytesStreamed: totalBytes,
              responseBody: responseBodyParsed
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
          logger.error(`[${this.name}] Error logging response (deferred):`, error);
        }
      });
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

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
  private responseContentType: string | null = null;
  private isStreaming = false;

  // Bounded preview buffers — never the full body for SSE.
  private headPreview: Buffer[] = [];
  private tailPreview: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;

  // Non-streaming JSON capture, capped to NON_STREAM_MAX.
  private nonStreamingChunks: Buffer[] = [];
  private nonStreamingTruncated = false;

  private static readonly PREVIEW_LIMIT = 4096;       // 4 KB head + 4 KB tail
  private static readonly NON_STREAM_MAX = 64 * 1024; // 64 KB max for buffered JSON bodies

  async onRequest(context: ProxyContext): Promise<void> {
    try {
      // Reset counters for new request
      this.chunkCount = 0;
      this.totalBytes = 0;
      this.responseContentType = null;
      this.isStreaming = false;
      this.headPreview = [];
      this.tailPreview = [];
      this.headBytes = 0;
      this.tailBytes = 0;
      this.nonStreamingChunks = [];
      this.nonStreamingTruncated = false;

      // Get request content type
      const contentType = context.headers['content-type'] || context.headers['Content-Type'] || 'unknown';
      const isSessionSyncEndpoint = this.isSessionSyncEndpoint(context.url);

      // Parse request body based on content type
      let requestBodyParsed: any = null;
      if (context.requestBody && !isSessionSyncEndpoint) {
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
          requestBody: isSessionSyncEndpoint ? '[omitted: session sync payload]' : requestBodyParsed
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

      const transferEncoding = headers['transfer-encoding'] || headers['Transfer-Encoding'];
      const transferEncodingStr = Array.isArray(transferEncoding)
        ? transferEncoding[0]
        : transferEncoding;
      this.isStreaming =
        (this.responseContentType?.includes('text/event-stream') ?? false) ||
        (((transferEncodingStr?.includes('chunked')) ?? false) &&
         !(this.responseContentType?.includes('application/json') ?? false));

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

      if (this.isStreaming) {
        // Streaming: only keep bounded head/tail previews, never full body.
        if (this.headBytes < LoggingInterceptor.PREVIEW_LIMIT) {
          const remaining = LoggingInterceptor.PREVIEW_LIMIT - this.headBytes;
          const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
          this.headPreview.push(Buffer.from(slice));
          this.headBytes += slice.length;
        }
        // Rolling tail buffer: retain only the last PREVIEW_LIMIT bytes.
        this.tailPreview.push(chunk);
        this.tailBytes += chunk.length;
        while (
          this.tailPreview.length > 1 &&
          this.tailBytes - (this.tailPreview[0]?.length ?? 0) >= LoggingInterceptor.PREVIEW_LIMIT
        ) {
          const dropped = this.tailPreview.shift();
          if (dropped) this.tailBytes -= dropped.length;
        }
      } else if (!this.nonStreamingTruncated) {
        // Non-streaming JSON: bounded buffer up to NON_STREAM_MAX.
        if (this.totalBytes <= LoggingInterceptor.NON_STREAM_MAX) {
          this.nonStreamingChunks.push(Buffer.from(chunk));
        } else {
          this.nonStreamingTruncated = true;
          this.nonStreamingChunks = []; // drop partial buffer; log size only.
        }
      }

      if (this.chunkCount === 1 || this.chunkCount % 1000 === 0) {
        logger.debug(`[proxy-streaming] ${context.url}`, {
          requestId: context.requestId,
          chunkNumber: this.chunkCount,
          chunkSize: chunk.length,
          totalBytes: this.totalBytes,
          streaming: this.isStreaming,
        });
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
      const isSessionSyncEndpoint = this.isSessionSyncEndpoint(context.url);
      const contentType = this.responseContentType || 'unknown';
      const streaming = this.isStreaming;

      // Snapshot state, then clear immediately so next request starts fresh.
      const headBuf = Buffer.concat(this.headPreview);
      const tailBuf = Buffer.concat(this.tailPreview);
      const nonStreamingBuf = streaming || this.nonStreamingTruncated
        ? null
        : Buffer.concat(this.nonStreamingChunks);
      const truncated = this.nonStreamingTruncated;
      const totalBytes = this.totalBytes;
      const chunkCount = this.chunkCount;

      this.headPreview = [];
      this.tailPreview = [];
      this.headBytes = 0;
      this.tailBytes = 0;
      this.nonStreamingChunks = [];
      this.nonStreamingTruncated = false;
      this.chunkCount = 0;
      this.totalBytes = 0;
      this.responseContentType = null;
      this.isStreaming = false;

      // Defer heavy formatting work off the response hot path.
      setImmediate(() => {
        try {
          let responseBodyParsed: unknown = null;

          if (isSessionSyncEndpoint) {
            responseBodyParsed = '[omitted: session sync payload]';
          } else if (streaming) {
            responseBodyParsed = {
              type: contentType,
              mode: 'streaming-bounded',
              totalBytes,
              chunkCount,
              headPreview: headBuf.toString('utf-8'),
              tailPreview: tailBuf.toString('utf-8'),
            };
          } else if (truncated) {
            responseBodyParsed = `[truncated: body exceeded ${LoggingInterceptor.NON_STREAM_MAX} bytes; total ${totalBytes}]`;
          } else if (nonStreamingBuf && nonStreamingBuf.length > 0) {
            const fullBody = nonStreamingBuf.toString('utf-8');
            if (contentType.includes('application/json')) {
              try {
                responseBodyParsed = JSON.parse(fullBody);
              } catch {
                responseBodyParsed = fullBody;
              }
            } else {
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
              isStreaming: streaming,
              bytesSent: metadata.bytesSent,
              durationMs: metadata.durationMs,
              totalChunks: chunkCount,
              totalBytesStreamed: totalBytes,
              responseBody: responseBodyParsed,
            }
          );
        } catch (error) {
          logger.error(`[${this.name}] Error logging response (deferred):`, error);
        }
      });
    } catch (error) {
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

  private isSessionSyncEndpoint(url: string): boolean {
    return /^\/v1\/metrics(?:[/?#]|$)/i.test(url) ||
      /^\/v1\/conversations(?:[/?#]|$)/i.test(url);
  }
}

/**
 * Proxy Interceptor System
 *
 * Plugin-based architecture for extending proxy functionality.
 * SOLID: Open/Closed - add features without modifying core proxy.
 */

import { ProxyContext, UpstreamResponse } from './types.js';
import { SSOCredentials } from '../../types/sso.js';
import { getAnalytics } from '../../analytics/index.js';
import { logger } from '../logger.js';

/**
 * Interceptor interface - Optional hooks for request/response/error
 * Interface Segregation: Implement only what you need
 */
export interface ProxyInterceptor {
  name: string;

  /** Called before forwarding request to upstream */
  onRequest?(context: ProxyContext): Promise<void>;

  /** Called after receiving response from upstream */
  onResponse?(context: ProxyContext, response: UpstreamResponse): Promise<void>;

  /** Called on any error */
  onError?(context: ProxyContext, error: Error): Promise<void>;
}

/**
 * SSO Authentication Interceptor
 * Injects authentication cookies into requests
 */
export class SSOAuthInterceptor implements ProxyInterceptor {
  name = 'sso-auth';

  constructor(private credentials: SSOCredentials) {}

  async onRequest(context: ProxyContext): Promise<void> {
    // Inject SSO cookies
    const cookieHeader = Object.entries(this.credentials.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    context.headers['Cookie'] = cookieHeader;

    logger.debug(`[${this.name}] Injected SSO cookies`);
  }
}

/**
 * Header Injection Interceptor
 * Adds CodeMie-specific headers
 */
export class HeaderInjectionInterceptor implements ProxyInterceptor {
  name = 'header-injection';

  constructor(
    private config: {
      sessionId: string;
      provider?: string;
      integrationId?: string;
      model?: string;
      timeout?: number;
      clientType?: string;
    }
  ) {}

  async onRequest(context: ProxyContext): Promise<void> {
    // Request ID header
    context.headers['X-CodeMie-Request-ID'] = context.requestId;

    // Session ID header
    context.headers['X-CodeMie-Session-ID'] = this.config.sessionId;

    // Add integration header only for ai-run-sso provider
    if (this.config.provider === 'ai-run-sso' && this.config.integrationId) {
      context.headers['X-CodeMie-Integration'] = this.config.integrationId;
    }

    // Add model header if configured (for all providers)
    if (this.config.model) {
      context.headers['X-CodeMie-CLI-Model'] = this.config.model;
    }

    // Add timeout header if configured (for all providers)
    if (this.config.timeout) {
      context.headers['X-CodeMie-CLI-Timeout'] = String(this.config.timeout);
    }

    // Add client type header
    if (this.config.clientType) {
      context.headers['X-CodeMie-Client'] = this.config.clientType;
    }

    logger.debug(`[${this.name}] Injected CodeMie headers`);
  }
}

/**
 * Analytics Tracking Interceptor
 * Uses existing Analytics system - DRY principle
 */
export class AnalyticsInterceptor implements ProxyInterceptor {
  name = 'analytics';

  async onRequest(context: ProxyContext): Promise<void> {
    try {
      const analytics = getAnalytics();
      if (!analytics.isEnabled) {
        return;
      }

      // Track request start time
      context.requestStartTime = Date.now();

      // Parse request body for analytics
      let requestBodyParsed: any = null;
      try {
        if (context.requestBody) {
          requestBodyParsed = JSON.parse(context.requestBody);
        }
      } catch {
        // Not JSON, skip parsing
      }

      // Truncate large request bodies
      const MAX_BODY_SIZE = 100000; // 100KB limit
      let requestBodyToLog: any = null;
      let requestBodyTruncated = false;
      const originalRequestBodySize = context.requestBody?.length || 0;

      if (requestBodyParsed) {
        const bodyStr = JSON.stringify(requestBodyParsed);
        if (bodyStr.length > MAX_BODY_SIZE) {
          requestBodyToLog = {
            model: requestBodyParsed.model,
            temperature: requestBodyParsed.temperature,
            max_tokens: requestBodyParsed.max_tokens,
            messageCount: requestBodyParsed.messages?.length || 0,
            contentTruncated: '[Content truncated - exceeded 100KB limit]',
            originalSize: bodyStr.length
          };
          requestBodyTruncated = true;
        } else {
          requestBodyToLog = requestBodyParsed;
        }
      }

      await analytics.track('api_request', {
        requestId: context.requestId,
        method: context.method,
        url: context.url,
        targetUrl: context.targetUrl,
        hasBody: !!context.requestBody,
        bodySize: originalRequestBodySize,
        bodyTruncated: requestBodyTruncated,
        ...(requestBodyToLog ? { requestBody: requestBodyToLog } : {})
      });

      logger.debug(`[${this.name}] Tracked API request: ${context.method} ${context.url}`);
    } catch (error) {
      // Silently fail - analytics should not block requests
      logger.error(`[${this.name}] Error tracking request:`, error);
    }
  }

  async onResponse(context: ProxyContext, response: UpstreamResponse): Promise<void> {
    try {
      const analytics = getAnalytics();
      if (!analytics.isEnabled) {
        return;
      }

      const latency = Date.now() - context.requestStartTime;

      let responseBodyParsed: any = null;
      const MAX_BODY_SIZE = 100000; // 100KB limit

      if (response.body) {
        const contentType = response.headers['content-type'] || '';
        const isStreaming = contentType.includes('text/event-stream');

        if (isStreaming) {
          // Store SSE text for response extraction
          const sseText = response.body.toString('utf-8');
          responseBodyParsed = { _sseContent: sseText, streaming: true };
        } else {
          // Standard JSON response
          try {
            responseBodyParsed = JSON.parse(response.body.toString('utf-8'));
          } catch {
            // Not JSON, ignore
          }
        }
      }

      // Truncate response body if needed
      let responseBodyToLog: any = null;
      let bodyTruncated = false;
      const originalBodySize = response.body?.length || 0;

      if (responseBodyParsed) {
        const bodyStr = JSON.stringify(responseBodyParsed);
        if (bodyStr.length > MAX_BODY_SIZE) {
          responseBodyToLog = {
            usage: responseBodyParsed.usage,
            model: responseBodyParsed.model,
            id: responseBodyParsed.id,
            object: responseBodyParsed.object,
            contentTruncated: '[Content truncated - exceeded 100KB limit]',
            originalSize: bodyStr.length
          };
          bodyTruncated = true;
        } else {
          responseBodyToLog = responseBodyParsed;
        }
      }

      await analytics.track('api_response', {
        requestId: context.requestId,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        ...(responseBodyToLog ? { responseBody: responseBodyToLog } : {}),
        bodySize: originalBodySize,
        bodyTruncated
      }, {
        latencyMs: latency
      });

      logger.debug(`[${this.name}] Tracked API response: ${response.statusCode} ${context.url} (${latency}ms)`);
    } catch (error) {
      // Silently fail - analytics should not block requests
      logger.error(`[${this.name}] Error tracking response:`, error);
    }
  }

  async onError(context: ProxyContext, error: Error): Promise<void> {
    try {
      const analytics = getAnalytics();
      if (!analytics.isEnabled) {
        return;
      }

      await analytics.track('proxy_error', {
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

  /**
   * Extract response content from various API formats
   * Reuses logic from original proxy
   */
  private async extractResponseContent(responseBody: any): Promise<string | null> {
    let responseContent: string | null = null;

    // SSE streaming content
    if (responseBody._sseContent) {
      responseContent = await this.extractSSEContent(responseBody._sseContent);
    }
    // OpenAI/Claude streaming format (choices array)
    else if (responseBody.choices && Array.isArray(responseBody.choices) && responseBody.choices.length > 0) {
      const choice = responseBody.choices[0];
      if (choice.message?.content) {
        responseContent = choice.message.content;
      } else if (choice.delta?.content) {
        responseContent = choice.delta.content;
      }
    }
    // Claude Messages API format (content array)
    else if (responseBody.content && Array.isArray(responseBody.content)) {
      responseContent = responseBody.content
        .filter((c: any) => c.type === 'text' && c.text)
        .map((c: any) => c.text)
        .join('\n');
    }
    // Gemini format: candidates with content.parts
    else if (responseBody.candidates && Array.isArray(responseBody.candidates) && responseBody.candidates.length > 0) {
      const candidate = responseBody.candidates[0];
      if (candidate.content?.parts && Array.isArray(candidate.content.parts)) {
        const textParts = candidate.content.parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text);
        if (textParts.length > 0) {
          responseContent = textParts.join('');
        }
      }
    }
    // Fallback: check for top-level content field
    else if (responseBody.content && typeof responseBody.content === 'string') {
      responseContent = responseBody.content;
    }

    return responseContent;
  }

  /**
   * Extract content from SSE stream
   * Simplified from original - focuses on content extraction
   */
  private async extractSSEContent(sseText: string): Promise<string | null> {
    try {
      const lines = sseText.split('\n');
      const contentParts: string[] = [];

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();

          if (!dataStr || dataStr === '[DONE]') {
            continue;
          }

          try {
            const data = JSON.parse(dataStr);

            // Claude streaming format
            if (data.type === 'content_block_delta' && data.delta?.text) {
              contentParts.push(data.delta.text);
            }
            // OpenAI streaming format
            else if (data.choices && Array.isArray(data.choices)) {
              for (const choice of data.choices) {
                if (choice.delta?.content) {
                  contentParts.push(choice.delta.content);
                }
              }
            }
            // Gemini streaming format
            else if (data.candidates && Array.isArray(data.candidates)) {
              for (const candidate of data.candidates) {
                if (candidate.content?.parts && Array.isArray(candidate.content.parts)) {
                  for (const part of candidate.content.parts) {
                    if (part.text) {
                      contentParts.push(part.text);
                    }
                  }
                }
              }
            }
          } catch {
            continue;
          }
        }
      }

      return contentParts.length > 0 ? contentParts.join('') : null;
    } catch (error) {
      logger.debug('SSE content extraction error:', error);
      return null;
    }
  }
}

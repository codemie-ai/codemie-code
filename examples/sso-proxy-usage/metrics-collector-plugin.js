/**
 * Custom Metrics Collector Plugin for sso-proxy-usage example
 * 
 * This plugin collects metrics from proxy requests and writes them to JSONL
 * for syncing by the SSOSessionSyncPlugin.
 * 
 * This demonstrates how external applications can implement custom metrics
 * collection when using codemie-code as a dependency.
 */

import { randomUUID } from 'crypto';
import { brotliDecompressSync } from 'zlib';

/**
 * Custom Metrics Collector Plugin
 * Priority: 75 (runs after logging at 50, before sync at 100)
 */
export class MetricsCollectorPlugin {
  id = '@example/metrics-collector';
  name = 'Metrics Collector (Example)';
  version = '1.0.0';
  priority = 75; // Run after logging (50), before sync (100)

  async createInterceptor(context) {
    // Only create if we have session ID
    if (!context.config.sessionId) {
      throw new Error('Session ID not available (metrics collection disabled)');
    }

    // Import MetricsWriter from main package exports
    try {
      const codeModule = await import('@codemieai/code');
      const MetricsWriter = codeModule.MetricsWriter;
      
      if (!MetricsWriter) {
        throw new Error('MetricsWriter not found in @codemieai/code exports. Make sure the package is rebuilt with latest changes.');
      }
      
      const interceptor = new MetricsCollectorInterceptor(
        context.config.sessionId,
        new MetricsWriter(context.config.sessionId)
      );
      
      return interceptor;
    } catch (error) {
      throw error;
    }
  }
}

/**
 * Metrics Collector Interceptor
 * Collects metrics from proxy requests and writes to JSONL
 */
class MetricsCollectorInterceptor {
  name = 'metrics-collector';

  constructor(sessionId, metricsWriter) {
    this.sessionId = sessionId;
    this.metricsWriter = metricsWriter;
    
    // Per-request state
    this.requestState = null;
  }

  /**
   * Collect request data for metrics
   */
  async onRequest(context) {
    try {
      // Only collect metrics for API endpoints
      if (!context.url.includes('/v1/') && !context.url.includes('/messages')) {
        return;
      }

      // Reset request state
      this.requestState = {
        responseChunks: [],
        model: context.model,
        messages: []
      };

      // Parse request body to extract model and messages
      if (context.requestBody) {
        try {
          const bodyString = context.requestBody.toString('utf-8');
          const contentType = context.headers['content-type'] || context.headers['Content-Type'] || '';
          
          if (contentType.includes('application/json')) {
            const requestBody = JSON.parse(bodyString);
            this.requestState.model = requestBody.model || context.model;
            this.requestState.messages = requestBody.messages || [];
          }
        } catch (error) {
          // Ignore parse errors
        }
      }
    } catch (error) {
      // Don't break proxy flow
    }
  }

  /**
   * Collect response chunks
   */
  async onResponseChunk(context, chunk) {
    try {
      if (this.requestState && (context.url.includes('/v1/') || context.url.includes('/messages'))) {
        this.requestState.responseChunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      // Ignore errors
    }
    return chunk; // Pass through unchanged
  }

  /**
   * Extract metrics from response and write to JSONL
   */
  async onResponseComplete(context, metadata) {
    try {
      // Only process API endpoints
      if (!this.requestState || (!context.url.includes('/v1/') && !context.url.includes('/messages'))) {
        return;
      }

      // Skip if response was not successful
      if (metadata.statusCode < 200 || metadata.statusCode >= 300) {
        this.requestState = null;
        return;
      }

      // Extract response body as Buffer first
      const responseBuffer = this.requestState.responseChunks.length > 0
        ? Buffer.concat(this.requestState.responseChunks)
        : null;

      if (!responseBuffer) {
        this.requestState = null;
        return;
      }

      // Check if response is compressed
      const contentEncoding = Array.isArray(metadata.headers['content-encoding'])
        ? metadata.headers['content-encoding'][0]
        : metadata.headers['content-encoding'] || '';
      
      let responseBody;
      try {
        const encoding = typeof contentEncoding === 'string' ? contentEncoding.toLowerCase() : '';
        const isBrotli = encoding.includes('br');
        
        if (isBrotli) {
          try {
            const decompressed = brotliDecompressSync(responseBuffer);
            responseBody = decompressed.toString('utf-8');
          } catch (brotliError) {
            throw new Error(`Failed to decompress Brotli response: ${brotliError.message}`);
          }
        } else {
          // No compression, use as-is
          responseBody = responseBuffer.toString('utf-8');
        }
        
        console.log(`[MetricsCollector] Response preview (first 200 chars): ${responseBody.substring(0, 200)}`);
      } catch (error) {
        throw error;
      }

      // Parse response to extract token usage
      let tokenUsage = null;
      let model = this.requestState.model;
      let userPrompts = [];

      try {
        // Check content type
        const contentType = Array.isArray(metadata.headers['content-type'])
          ? metadata.headers['content-type'][0]
          : metadata.headers['content-type'] || '';
        
        // Handle streaming responses (SSE)
        if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
          // For SSE, look for the last data chunk with usage info
          const lines = responseBody.split('\n').filter(line => line.trim());
          
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].startsWith('data: ')) {
              try {
                const jsonStr = lines[i].substring(6).trim();
                // Skip empty data lines
                if (!jsonStr || jsonStr === '[DONE]') continue;
                
                const data = JSON.parse(jsonStr);
                if (data.usage) {
                  tokenUsage = {
                    input: data.usage.input_tokens || data.usage.prompt_tokens || 0,
                    output: data.usage.output_tokens || data.usage.completion_tokens || 0,
                    cacheRead: data.usage.cache_read_input_tokens || data.usage.input_token_details?.cache_read
                  };
                  model = model || data.model;
                  break;
                }
              } catch (parseError) {
                // Not valid JSON, continue to next line
              }
            }
          }
        } else {
          // Handle JSON responses
          const trimmedBody = responseBody.trim();
          if (!trimmedBody.startsWith('{') && !trimmedBody.startsWith('[')) {
            throw new Error('Response is not JSON format');
          }
          
          const response = JSON.parse(trimmedBody);
          
          // Extract token usage from various response formats
          if (response.usage) {
            tokenUsage = {
              input: response.usage.input_tokens || response.usage.prompt_tokens || 0,
              output: response.usage.output_tokens || response.usage.completion_tokens || 0,
              cacheRead: response.usage.cache_read_input_tokens || response.usage.input_token_details?.cache_read
            };
          } else if (response.metadata?.usage) {
            tokenUsage = {
              input: response.metadata.usage.input_tokens || response.metadata.usage.prompt_tokens || 0,
              output: response.metadata.usage.output_tokens || response.metadata.usage.completion_tokens || 0,
              cacheRead: response.metadata.usage.cache_read_input_tokens
            };
          }

          model = model || response.model;
        }

        // Extract user prompts from request messages
        if (this.requestState.messages) {
          userPrompts = this.requestState.messages
            .filter((msg) => msg.role === 'user')
            .map((msg) => ({
              count: 1,
              text: typeof msg.content === 'string' ? msg.content : undefined
            }));
        }

        // Only write delta if we have token usage
        if (tokenUsage && (tokenUsage.input > 0 || tokenUsage.output > 0)) {
          console.log(`[MetricsCollector] Found token usage: ${tokenUsage.input} in, ${tokenUsage.output} out`);
          
          const delta = {
            recordId: randomUUID(),
            sessionId: context.sessionId,
            agentSessionId: context.sessionId, // For external usage, use same session ID
            timestamp: Date.now(),
            tokens: {
              input: tokenUsage.input,
              output: tokenUsage.output,
              ...(tokenUsage.cacheRead && { cacheRead: tokenUsage.cacheRead })
            },
            tools: {}, // No tools for proxy requests
            ...(model && { models: [model] }),
            ...(userPrompts.length > 0 && { userPrompts })
          };

          await this.metricsWriter.appendDelta(delta);
        }
      } catch (error) {
        // Ignore extraction errors
      }

      // Clear request state
      this.requestState = null;

    } catch (error) {
      // Don't break proxy flow
      this.requestState = null;
    }
  }
}

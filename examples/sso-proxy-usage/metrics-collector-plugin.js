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
import { gunzipSync, brotliDecompressSync, inflateSync } from 'zlib';

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
    console.log(`[MetricsCollectorPlugin] createInterceptor called for session: ${context.config.sessionId}`);
    
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
      
      console.log(`[MetricsCollectorPlugin] MetricsWriter imported successfully`);
      
      const interceptor = new MetricsCollectorInterceptor(
        context.config.sessionId,
        new MetricsWriter(context.config.sessionId)
      );
      
      console.log(`[MetricsCollectorPlugin] Interceptor created successfully`);
      return interceptor;
    } catch (error) {
      console.error(`[MetricsCollectorPlugin] Failed to import MetricsWriter:`, error);
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
      console.log(`[MetricsCollector] onRequest called for: ${context.url}`);
      
      // Only collect metrics for API endpoints
      if (!context.url.includes('/v1/') && !context.url.includes('/messages')) {
        console.log(`[MetricsCollector] Skipping non-API endpoint: ${context.url}`);
        return;
      }
      
      console.log(`[MetricsCollector] Processing API request: ${context.url}`);

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
      console.log(`[MetricsCollector] onResponseComplete called for: ${context.url}, status: ${metadata.statusCode}`);
      
      // Only process API endpoints
      if (!this.requestState || (!context.url.includes('/v1/') && !context.url.includes('/messages'))) {
        console.log(`[MetricsCollector] Skipping non-API endpoint or no request state`);
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

      console.log(`[MetricsCollector] Response buffer length: ${responseBuffer?.length || 0}, chunks: ${this.requestState.responseChunks.length}`);

      if (!responseBuffer) {
        console.log(`[MetricsCollector] No response body, skipping`);
        this.requestState = null;
        return;
      }

      // Check if response is compressed (gzip)
      const contentEncoding = Array.isArray(metadata.headers['content-encoding'])
        ? metadata.headers['content-encoding'][0]
        : metadata.headers['content-encoding'] || '';
      
      console.log(`[MetricsCollector] Content-Encoding header: "${contentEncoding}"`);
      console.log(`[MetricsCollector] All response headers:`, Object.keys(metadata.headers));
      
      let responseBody;
      try {
        const encoding = typeof contentEncoding === 'string' ? contentEncoding.toLowerCase() : '';
        
        // Check compression type
        const isBrotli = encoding.includes('br');
        const isGzip = encoding.includes('gzip');
        const isDeflate = encoding.includes('deflate');
        
        // Also check magic bytes
        const isGzipMagic = responseBuffer.length >= 2 && 
          responseBuffer[0] === 0x1f && responseBuffer[1] === 0x8b;
        const isBrotliMagic = responseBuffer.length >= 1 && 
          responseBuffer[0] === 0xce || responseBuffer[0] === 0x81; // Brotli can start with various bytes
        
        console.log(`[MetricsCollector] Compression detection - br: ${isBrotli}, gzip: ${isGzip}, deflate: ${isDeflate}`);
        console.log(`[MetricsCollector] Magic bytes - gzip: ${isGzipMagic}, brotli: ${isBrotliMagic}`);
        
        if (isBrotli) {
          console.log(`[MetricsCollector] Detected Brotli compression, decompressing...`);
          try {
            const decompressed = brotliDecompressSync(responseBuffer);
            responseBody = decompressed.toString('utf-8');
            console.log(`[MetricsCollector] Successfully decompressed Brotli: ${responseBuffer.length} -> ${decompressed.length} bytes`);
          } catch (brotliError) {
            console.error(`[MetricsCollector] Brotli decompression failed:`, brotliError.message);
            // Try as plain text
            responseBody = responseBuffer.toString('utf-8');
            console.log(`[MetricsCollector] Falling back to plain text interpretation`);
          }
        } else if (isGzip || isGzipMagic) {
          console.log(`[MetricsCollector] Detected gzip compression, decompressing...`);
          try {
            const decompressed = gunzipSync(responseBuffer);
            responseBody = decompressed.toString('utf-8');
            console.log(`[MetricsCollector] Successfully decompressed gzip: ${responseBuffer.length} -> ${decompressed.length} bytes`);
          } catch (gzipError) {
            console.error(`[MetricsCollector] Gzip decompression failed:`, gzipError.message);
            responseBody = responseBuffer.toString('utf-8');
            console.log(`[MetricsCollector] Falling back to plain text interpretation`);
          }
        } else if (isDeflate) {
          console.log(`[MetricsCollector] Detected deflate compression, decompressing...`);
          try {
            const decompressed = inflateSync(responseBuffer);
            responseBody = decompressed.toString('utf-8');
            console.log(`[MetricsCollector] Successfully decompressed deflate: ${responseBuffer.length} -> ${decompressed.length} bytes`);
          } catch (deflateError) {
            console.error(`[MetricsCollector] Deflate decompression failed:`, deflateError.message);
            responseBody = responseBuffer.toString('utf-8');
            console.log(`[MetricsCollector] Falling back to plain text interpretation`);
          }
        } else {
          // Try UTF-8 first
          responseBody = responseBuffer.toString('utf-8');
          
          // If it looks like binary/garbled, try Brotli (most common modern compression)
          if (responseBody.length > 0 && (responseBody.charCodeAt(0) < 32 || responseBody.charCodeAt(0) > 126)) {
            console.log(`[MetricsCollector] Response looks binary, trying Brotli decompression...`);
            try {
              const decompressed = brotliDecompressSync(responseBuffer);
              responseBody = decompressed.toString('utf-8');
              console.log(`[MetricsCollector] Successfully decompressed (auto-detected Brotli): ${responseBuffer.length} -> ${decompressed.length} bytes`);
            } catch {
              // Try gzip as fallback
              try {
                const decompressed = gunzipSync(responseBuffer);
                responseBody = decompressed.toString('utf-8');
                console.log(`[MetricsCollector] Successfully decompressed (auto-detected gzip): ${responseBuffer.length} -> ${decompressed.length} bytes`);
              } catch {
                console.log(`[MetricsCollector] Auto-decompression failed, keeping original`);
              }
            }
          }
        }
        
        console.log(`[MetricsCollector] Final response body length: ${responseBody.length}`);
        console.log(`[MetricsCollector] Response preview (first 200 chars): ${responseBody.substring(0, 200)}`);
        console.log(`[MetricsCollector] Response starts with: "${responseBody.substring(0, 10)}"`);
      } catch (error) {
        console.error(`[MetricsCollector] Error processing response body:`, error);
        responseBody = responseBuffer.toString('utf-8');
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
        
        console.log(`[MetricsCollector] Content-Type: ${contentType}`);
        
        // Handle streaming responses (SSE)
        if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
          console.log(`[MetricsCollector] Detected SSE stream, parsing...`);
          // For SSE, look for the last data chunk with usage info
          const lines = responseBody.split('\n').filter(line => line.trim());
          console.log(`[MetricsCollector] SSE lines count: ${lines.length}`);
          
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
                  console.log(`[MetricsCollector] Found usage in SSE data chunk`);
                  break;
                }
              } catch (parseError) {
                // Not valid JSON, continue to next line
                console.log(`[MetricsCollector] Skipping non-JSON SSE line: ${lines[i].substring(0, 50)}...`);
              }
            }
          }
        } else {
          // Handle JSON responses - try to parse as JSON
          console.log(`[MetricsCollector] Attempting to parse as JSON...`);
          
          // Check if response body looks like JSON (starts with { or [)
          const trimmedBody = responseBody.trim();
          if (!trimmedBody.startsWith('{') && !trimmedBody.startsWith('[')) {
            console.log(`[MetricsCollector] Response doesn't look like JSON, first 100 chars: ${trimmedBody.substring(0, 100)}`);
            throw new Error('Response is not JSON format');
          }
          
          try {
            const response = JSON.parse(trimmedBody);
            console.log(`[MetricsCollector] Successfully parsed JSON response`);
            
            // Extract token usage from various response formats
            if (response.usage) {
              tokenUsage = {
                input: response.usage.input_tokens || response.usage.prompt_tokens || 0,
                output: response.usage.output_tokens || response.usage.completion_tokens || 0,
                cacheRead: response.usage.cache_read_input_tokens || response.usage.input_token_details?.cache_read
              };
              console.log(`[MetricsCollector] Found usage in response.usage`);
            } else if (response.metadata?.usage) {
              tokenUsage = {
                input: response.metadata.usage.input_tokens || response.metadata.usage.prompt_tokens || 0,
                output: response.metadata.usage.output_tokens || response.metadata.usage.completion_tokens || 0,
                cacheRead: response.metadata.usage.cache_read_input_tokens
              };
              console.log(`[MetricsCollector] Found usage in response.metadata.usage`);
            } else {
              console.log(`[MetricsCollector] No usage found in response. Response keys:`, Object.keys(response));
            }

            model = model || response.model;
          } catch (jsonError) {
            console.error(`[MetricsCollector] JSON parse error:`, jsonError.message);
            console.log(`[MetricsCollector] Response body preview: ${trimmedBody.substring(0, 200)}`);
            throw jsonError;
          }
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

          console.log(`[MetricsCollector] Writing delta to JSONL:`, JSON.stringify(delta, null, 2));
          await this.metricsWriter.appendDelta(delta);
          console.log(`[MetricsCollector] ✅ Successfully collected metrics: ${tokenUsage.input} in, ${tokenUsage.output} out tokens`);
        } else {
          console.log(`[MetricsCollector] No token usage found or zero tokens. tokenUsage:`, tokenUsage);
        }
      } catch (error) {
        console.error(`[MetricsCollector] Error extracting metrics:`, error);
      }

      // Clear request state
      this.requestState = null;

    } catch (error) {
      // Don't break proxy flow
      this.requestState = null;
    }
  }
}

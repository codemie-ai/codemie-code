/**
 * Request Sanitizer Plugin
 * Priority: 15 (runs after auth, before header injection)
 *
 * Strips request body parameters that upstream LLM proxies (LiteLLM/Azure)
 * may not support. Specifically targets reasoning-related params that AI SDKs
 * inject for GPT-5 and o-series "reasoning models".
 *
 * Problem: @ai-sdk/openai-compatible and @langchain/openai detect GPT-5/o-series
 * as reasoning models and inject `reasoningSummary`, `reasoning` (object), etc.
 * LiteLLM/Azure rejects these with: "Unknown parameter: 'reasoningSummary'"
 *
 * Scope: Only enabled for codemie-code and codemie-opencode agents (which use
 * AI SDKs that inject these params). Other agents (claude, gemini) handle their
 * own request formatting and don't need this sanitization.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * Parameters to strip from request bodies before forwarding to upstream.
 * These are injected by AI SDKs for "reasoning models" but may not be
 * supported by all LLM proxies (LiteLLM, Azure OpenAI, etc.)
 */
const UNSUPPORTED_PARAMS = [
  'reasoningSummary',    // @ai-sdk/openai-compatible injects this for reasoning models
  'reasoning_summary',   // Snake-case variant
  'reasoning',           // Full reasoning object from OpenAI Responses API
];

/** Agents that use AI SDKs which inject unsupported reasoning params */
const ALLOWED_AGENTS = ['codemie-code', 'codemie-opencode'];

export class RequestSanitizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-request-sanitizer';
  name = 'Request Sanitizer';
  version = '1.0.0';
  priority = 15; // After auth (10), before header injection (20)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    return new RequestSanitizerInterceptor();
  }
}

class RequestSanitizerInterceptor implements ProxyInterceptor {
  name = 'request-sanitizer';

  async onRequest(context: ProxyContext): Promise<void> {
    // Only process JSON request bodies (POST/PUT/PATCH with content)
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const bodyStr = context.requestBody.toString('utf-8');
      const body = JSON.parse(bodyStr);

      const stripped: string[] = [];
      for (const param of UNSUPPORTED_PARAMS) {
        if (param in body) {
          delete body[param];
          stripped.push(param);
        }
      }

      if (stripped.length > 0) {
        // Re-serialize and update the request body buffer
        const newBodyStr = JSON.stringify(body);
        context.requestBody = Buffer.from(newBodyStr, 'utf-8');

        // Update Content-Length header to match new body size
        context.headers['content-length'] = String(context.requestBody.length);

        logger.debug(`[${this.name}] Stripped unsupported params: ${stripped.join(', ')}`);
      }
    } catch {
      // Not valid JSON or parse error — pass through unchanged
    }
  }
}

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
 * Endpoint-aware behavior:
 * - /v1/chat/completions (and all other paths): strip `reasoning`, `reasoningSummary`,
 *   `reasoning_summary` entirely — these are invalid on Chat Completions.
 * - /v1/responses: `reasoning: { effort, summary }` is a valid field. Preserve
 *   `reasoning.effort`; strip only `reasoning.summary` (conservative — Azure
 *   supports it but it's unused today) and the camelCase top-level leakage.
 *   NOTE: stripping `reasoning.summary` can be relaxed to keep summaries once
 *   confirmed desired and accepted by the upstream deployment.
 *
 * URL discriminator: path.endsWith('/responses') — prefix-agnostic, keys on the
 * AI SDK endpoint segment not the deployment-controlled base path.
 *
 * Scope: Only enabled for codemie-code and codemie-opencode agents (which use
 * AI SDKs that inject these params). Other agents (claude, gemini) handle their
 * own request formatting and don't need this sanitization.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

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
      const body = JSON.parse(bodyStr) as Record<string, unknown>;

      const stripped: string[] = [];

      // Determine endpoint: key on the trailing segment the AI SDK controls,
      // not the deployment-controlled base prefix (avoids /v1 coupling).
      const path = context.url.split('?')[0].replace(/\/+$/, '');
      const isResponsesApi = path.endsWith('/responses');

      if (isResponsesApi) {
        // /v1/responses: reasoning: { effort, summary } is valid.
        // Strip only the camelCase top-level leakage and the nested summary field.
        for (const k of ['reasoningSummary', 'reasoning_summary'] as const) {
          if (k in body) {
            delete body[k];
            stripped.push(k);
          }
        }
        if (body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)) {
          const reasoningObj = body.reasoning as Record<string, unknown>;
          if ('summary' in reasoningObj) {
            delete reasoningObj.summary;
            stripped.push('reasoning.summary');
            // body.reasoning.effort is intentionally preserved.
            // If stripping summary leaves reasoning: {}, the object is harmless;
            // the re-serialize tail fires via 'reasoning.summary' in stripped.
          }
        } else if ('reasoning' in body) {
          // Non-object reasoning on /v1/responses — not produced by any known code path.
          // Pass through unchanged; let the upstream surface the anomaly.
          logger.debug(`[${this.name}] non-object 'reasoning' on responses path, leaving untouched: ${typeof body.reasoning}`);
        }
      } else {
        // Chat Completions and all other paths: strip all reasoning-related params.
        for (const param of ['reasoningSummary', 'reasoning_summary', 'reasoning'] as const) {
          if (param in body) {
            delete body[param];
            stripped.push(param);
          }
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

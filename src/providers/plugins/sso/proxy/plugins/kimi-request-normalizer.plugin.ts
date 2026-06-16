/**
 * Kimi Request Normalizer Plugin
 * Priority: 14 (runs before generic request sanitization)
 *
 * Kimi Code can request very large output token limits for long-context Kimi
 * models. Some CodeMie upstream routes, especially Bedrock-backed deployments,
 * reject those values before the model can respond. Cap output-token fields for
 * Kimi clients while leaving other agents untouched.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const ALLOWED_AGENTS = ['codemie-kimi', 'codemie-kimi-acp'];
const MAX_KIMI_OUTPUT_TOKENS = 64000;
const TOKEN_FIELDS = ['max_tokens', 'max_completion_tokens', 'maxTokens'];

export class KimiRequestNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-kimi-request-normalizer';
  name = 'Kimi Request Normalizer';
  version = '1.0.0';
  priority = 14;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new KimiRequestNormalizerInterceptor();
  }
}

class KimiRequestNormalizerInterceptor implements ProxyInterceptor {
  name = 'kimi-request-normalizer';

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const bodyStr = context.requestBody.toString('utf-8');
      const body = JSON.parse(bodyStr);
      const capped: string[] = [];

      for (const field of TOKEN_FIELDS) {
        if (typeof body[field] === 'number' && body[field] > MAX_KIMI_OUTPUT_TOKENS) {
          body[field] = MAX_KIMI_OUTPUT_TOKENS;
          capped.push(field);
        }
      }

      if (capped.length === 0) {
        return;
      }

      const newBodyStr = JSON.stringify(body);
      context.requestBody = Buffer.from(newBodyStr, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      logger.debug(
        `[${this.name}] Capped output token fields to ${MAX_KIMI_OUTPUT_TOKENS}: ${capped.join(', ')}`
      );
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
    }
  }
}

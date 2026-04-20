/**
 * Claude Thinking Transformer Plugin
 * Priority: 16 (runs after Request Sanitizer at 15, before header injection at 20)
 *
 * Transforms thinking parameters for Claude models that require the new adaptive
 * thinking API (e.g. claude-opus-4-7).
 *
 * Problem: Claude Code sends `thinking: { type: "enabled", budget_tokens: N }`
 * for Opus models. claude-opus-4-7 rejects this with HTTP 400:
 *   "thinking.type.enabled" is not supported for this model. Use
 *   "thinking.type.adaptive" and "output_config.effort" instead.
 *
 * Fix: When the request model matches a Claude 4.7+ pattern:
 *   - "enabled"  → thinking: { type: "adaptive" } + output_config.effort (derived
 *                  from budget_tokens; only written if not already present)
 *   - "disabled" → delete the thinking field entirely (model does not accept this value)
 *
 * Scope: Only enabled for codemie-claude agent (Claude Code via SSO proxy).
 *
 * To add support for a new model: append a pattern to ADAPTIVE_THINKING_MODEL_PATTERNS.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * Model name patterns that require the adaptive thinking API.
 * Matches claude-opus-4-7, claude-opus-4-7-20250514, and future date-tagged variants.
 * Extend this list as Anthropic migrates additional models — see EPMCDME-11821.
 */
const ADAPTIVE_THINKING_MODEL_PATTERNS: RegExp[] = [
  /claude-opus-4-[7-9](?:[^0-9]|$)/i,  // claude-opus-4-7/8/9 and date-tagged variants (e.g. claude-opus-4-7-20250514); excludes claude-opus-4-70+
];

function modelRequiresAdaptiveThinking(modelName: string): boolean {
  return ADAPTIVE_THINKING_MODEL_PATTERNS.some(p => p.test(modelName));
}

/**
 * Map legacy budget_tokens to the closest output_config.effort level.
 *
 * budget_tokens was the maximum token budget for thinking in the old API.
 * effort is a coarser control in the new API: low / medium / high.
 */
function budgetTokensToEffort(budgetTokens: unknown): 'low' | 'medium' | 'high' {
  const tokens = typeof budgetTokens === 'number' ? budgetTokens : 0;
  if (tokens <= 2048) return 'low';
  if (tokens <= 8192) return 'medium';
  return 'high';
}

/** Agent that sends Claude API requests through the codemie proxy */
const ALLOWED_AGENT = 'codemie-claude';

export class ClaudeThinkingTransformerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-claude-thinking-transformer';
  name = 'Claude Thinking Transformer';
  version = '1.0.0';
  priority = 16; // After RequestSanitizer (15), before HeaderInjection (20)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || clientType !== ALLOWED_AGENT) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    // Pass the configured model as a fallback for requests that omit body.model
    const configModel = context.config.model;
    return new ClaudeThinkingTransformerInterceptor(configModel);
  }
}

class ClaudeThinkingTransformerInterceptor implements ProxyInterceptor {
  name = 'claude-thinking-transformer';

  constructor(private readonly configModel?: string) {}

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const bodyStr = context.requestBody.toString('utf-8');
      const body = JSON.parse(bodyStr);

      const thinkingType = body.thinking?.type;
      if (thinkingType !== 'enabled' && thinkingType !== 'disabled') {
        return;
      }

      // Resolve model: prefer request body, fall back to proxy config
      const model = (typeof body.model === 'string' && body.model) || this.configModel || '';
      if (!model || !modelRequiresAdaptiveThinking(model)) {
        return;
      }

      if (thinkingType === 'enabled') {
        const effort = budgetTokensToEffort(body.thinking.budget_tokens);

        // Replace old thinking object with new adaptive format
        body.thinking = { type: 'adaptive' };

        // Set output_config.effort only if the caller hasn't already specified it
        if (!body.output_config?.effort) {
          body.output_config = { ...(body.output_config ?? {}), effort };
        }

        logger.debug(
          `[${this.name}] Transformed thinking: "enabled" → "adaptive", effort="${effort}" for model: ${model}`
        );
      } else {
        // thinking.type === 'disabled': model does not accept this value — remove the field
        delete body.thinking;

        logger.debug(
          `[${this.name}] Removed unsupported thinking.type="disabled" for model: ${model}`
        );
      }

      const newBodyStr = JSON.stringify(body);
      context.requestBody = Buffer.from(newBodyStr, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged
    }
  }
}

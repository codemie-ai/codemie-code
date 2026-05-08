/**
 * Claude Request Normalizer Plugin
 * Priority: 14 (runs before RequestSanitizer at 15)
 *
 * Normalizes Claude API requests to match model-specific requirements.
 * Handles thinking parameter variations across Claude model versions:
 *
 * 1. Models that DO NOT support thinking (e.g. claude-haiku-4-5, 4-6):
 *    → strips the thinking field entirely to prevent API errors
 *
 * 2. Models that require adaptive thinking API (e.g. claude-opus-4-7+):
 *    → "enabled"  → thinking: { type: "adaptive" } + output_config.effort
 *    → "disabled" → delete the thinking field
 *
 * Problem: Claude Code sends `thinking: { type: "enabled", budget_tokens: N }`.
 * - Haiku models reject thinking field with HTTP 400
 * - Opus 4-7+ requires adaptive thinking format with output_config.effort
 *
 * Scope: Only enabled for codemie-claude agent (Claude Code via SSO proxy).
 *
 * To add model support: update NO_THINKING_MODEL_PATTERNS or ADAPTIVE_THINKING_MODEL_PATTERNS.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * Model name patterns that DO NOT support thinking at all.
 * Matches claude-haiku-3-5, 4-5, and date-tagged variants (e.g. claude-haiku-4-5-20251001).
 */
const NO_THINKING_MODEL_PATTERNS: RegExp[] = [
  /claude-haiku-(3-5|4-5)(?:[^0-9]|$)/i,  // claude-haiku-3-5, 4-5 and date-tagged variants
];

/**
 * Model name patterns that require the adaptive thinking API.
 * Matches claude-opus-4-7, claude-opus-4-7-20250514, and future date-tagged variants.
 * Extend this list as Anthropic migrates additional models — see EPMCDME-11821.
 */
const ADAPTIVE_THINKING_MODEL_PATTERNS: RegExp[] = [
  /claude-opus-4-[7-9](?:[^0-9]|$)/i,  // claude-opus-4-7/8/9 and date-tagged variants (e.g. claude-opus-4-7-20250514); excludes claude-opus-4-70+
];

function modelDisablesThinking(modelName: string): boolean {
  return NO_THINKING_MODEL_PATTERNS.some(p => p.test(modelName));
}

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

/**
 * Handler: strips thinking field for models that don't support it.
 * Returns true if thinking was stripped (early exit), false to continue chain.
 */
function handleNoThinkingModels(body: any, model: string): boolean {
  if (!modelDisablesThinking(model)) {
    return false;
  }

  delete body.thinking;
  logger.debug(`[claude-request-normalizer] Stripped thinking field for unsupported model: ${model}`);
  return true;
}

/**
 * Handler: transforms thinking.type "enabled"/"disabled" to adaptive API format.
 * Returns true if transformation applied, false if nothing changed.
 */
function handleAdaptiveThinkingTransform(body: any, model: string): boolean {
  const thinkingType = body.thinking?.type;
  if (thinkingType !== 'enabled' && thinkingType !== 'disabled') {
    return false;
  }

  if (!modelRequiresAdaptiveThinking(model)) {
    return false;
  }

  if (thinkingType === 'enabled') {
    const effort = budgetTokensToEffort(body.thinking.budget_tokens);
    body.thinking = { type: 'adaptive' };

    if (!body.output_config?.effort) {
      body.output_config = { ...(body.output_config ?? {}), effort };
    }

    logger.debug(
      `[claude-request-normalizer] Transformed thinking: "enabled" → "adaptive", effort="${effort}" for model: ${model}`
    );
  } else {
    delete body.thinking;
    logger.debug(
      `[claude-request-normalizer] Removed unsupported thinking.type="disabled" for model: ${model}`
    );
  }

  return true;
}

/** Agent that sends Claude API requests through the codemie proxy */
const ALLOWED_AGENT = 'codemie-claude';

export class ClaudeRequestNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-claude-request-normalizer';
  name = 'Claude Request Normalizer';
  version = '1.0.0';
  priority = 14; // Before RequestSanitizer (15)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || clientType !== ALLOWED_AGENT) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    // Pass the configured model as a fallback for requests that omit body.model
    const configModel = context.config.model;
    return new ClaudeRequestNormalizerInterceptor(configModel);
  }
}

class ClaudeRequestNormalizerInterceptor implements ProxyInterceptor {
  name = 'claude-request-normalizer';

  constructor(private readonly configModel?: string) {}

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const bodyStr = context.requestBody.toString('utf-8');
      const body = JSON.parse(bodyStr);

      if (!body.thinking) {
        return;
      }

      const model = (typeof body.model === 'string' && body.model) || this.configModel || '';
      if (!model) {
        return;
      }

      // Chain handlers: first match wins and modifies body
      const modified =
        handleNoThinkingModels(body, model) ||
        handleAdaptiveThinkingTransform(body, model);

      if (modified) {
        const newBodyStr = JSON.stringify(body);
        context.requestBody = Buffer.from(newBodyStr, 'utf-8');
        context.headers['content-length'] = String(context.requestBody.length);
      }
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged
    }
  }
}

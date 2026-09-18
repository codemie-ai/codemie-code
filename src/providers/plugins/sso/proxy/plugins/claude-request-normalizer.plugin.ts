/**
 * Normalizes Claude API requests per model. Every model-specific decision reads
 * from MODEL_CAPABILITY_TABLE; add/edit a row to change support. Priority 14
 * (before RequestSanitizer at 15). See EPMCDME-14035.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

// standard = leave thinking untouched; none = strip it; adaptive = requires the
// adaptive thinking API + output_config.effort.
type ThinkingMode = 'standard' | 'none' | 'adaptive';

interface ModelCapabilities {
  thinking: ThinkingMode;
  effort: boolean;
  sampling: boolean;
  /** Adaptive models only: keep `thinking.type: "disabled"` instead of deleting it. */
  preserveDisabledThinking: boolean;
}

// Applied when no MODEL_CAPABILITY_TABLE row matches.
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  thinking: 'standard',
  effort: false,
  sampling: true,
  preserveDisabledThinking: false,
};

// Pattern → capabilities, first match wins. The `(?:[^0-9]|$)` after each version
// stops `4-7` from matching `4-70`. See EPMCDME-11821 / EPMCDME-14035.
const MODEL_CAPABILITY_TABLE: ReadonlyArray<{ pattern: RegExp; capabilities: ModelCapabilities }> = [
  {
    // claude-haiku-3-5 / 4-5 (+ date-tagged): no extended thinking at all.
    pattern: /claude-haiku-(3-5|4-5)(?:[^0-9]|$)/i,
    capabilities: { thinking: 'none', effort: false, sampling: true, preserveDisabledThinking: false },
  },
  {
    // claude-opus-4-7/8/9 (+ date-tagged; excludes 4-70+): adaptive thinking + effort.
    pattern: /claude-opus-4-[7-9](?:[^0-9]|$)/i,
    capabilities: { thinking: 'adaptive', effort: true, sampling: true, preserveDisabledThinking: false },
  },
  {
    // claude-sonnet-5 (+ date-tagged): adaptive thinking + effort; rejects manual
    // sampling params; keeps thinking.type="disabled".
    pattern: /claude-sonnet-5(?:[^0-9]|$)/i,
    capabilities: { thinking: 'adaptive', effort: true, sampling: false, preserveDisabledThinking: true },
  },
];

function capabilitiesFor(model: string): ModelCapabilities {
  for (const entry of MODEL_CAPABILITY_TABLE) {
    if (entry.pattern.test(model)) return entry.capabilities;
  }
  return DEFAULT_CAPABILITIES;
}

// Map legacy budget_tokens to the coarser new-API effort level.
function budgetTokensToEffort(budgetTokens: unknown): 'low' | 'medium' | 'high' {
  const tokens = typeof budgetTokens === 'number' ? budgetTokens : 0;
  if (tokens <= 2048) return 'low';
  if (tokens <= 8192) return 'medium';
  return 'high';
}

// Normalize the thinking field per caps.thinking. Called only when body.thinking is set.
function handleThinkingField(body: any, caps: ModelCapabilities, model: string): boolean {
  if (caps.thinking === 'none') {
    delete body.thinking;
    logger.debug(`[claude-request-normalizer] Stripped thinking field for unsupported model: ${model}`);
    return true;
  }

  if (caps.thinking === 'adaptive') {
    const thinkingType = body.thinking?.type;
    if (thinkingType !== 'enabled' && thinkingType !== 'disabled') {
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
      return true;
    }

    // thinkingType === 'disabled'
    if (caps.preserveDisabledThinking) {
      logger.debug(`[claude-request-normalizer] Preserved thinking.type="disabled" for model: ${model}`);
      return false;
    }

    delete body.thinking;
    logger.debug(`[claude-request-normalizer] Removed unsupported thinking.type="disabled" for model: ${model}`);
    return true;
  }

  // 'standard' — leave the thinking field untouched.
  return false;
}

// Strip effort for models that reject it: Claude Code's --effort flag becomes
// output_config.effort (or top-level effort) and 400s on e.g. claude-4-5-sonnet.
function handleUnsupportedEffort(body: any, caps: ModelCapabilities, model: string): boolean {
  if (caps.effort) {
    return false;
  }

  let stripped = false;

  const outputConfig = body.output_config;
  if (outputConfig && typeof outputConfig === 'object' && 'effort' in outputConfig) {
    delete outputConfig.effort;
    stripped = true;
    if (Object.keys(outputConfig).length === 0) {
      delete body.output_config;
    }
  }

  if ('effort' in body) {
    delete body.effort;
    stripped = true;
  }

  if (stripped) {
    logger.debug(`[claude-request-normalizer] Stripped unsupported effort parameter for model: ${model}`);
  }
  return stripped;
}

// Strip sampling params (temperature/top_p/top_k) for models that reject them.
function handleDeprecatedSamplingParams(body: any, caps: ModelCapabilities, model: string): boolean {
  if (caps.sampling) {
    return false;
  }

  const stripped: string[] = [];
  for (const key of ['temperature', 'top_p', 'top_k'] as const) {
    if (key in body) {
      delete body[key];
      stripped.push(key);
    }
  }

  if (stripped.length === 0) {
    return false;
  }

  logger.debug(
    `[claude-request-normalizer] Stripped deprecated sampling params for model ${model}: ${stripped.join(', ')}`
  );
  return true;
}

const ALLOWED_AGENTS = ['codemie-claude', 'codemie-copilot', 'claude-desktop'];

export class ClaudeRequestNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-claude-request-normalizer';
  name = 'Claude Request Normalizer';
  version = '1.0.0';
  priority = 14; // Before RequestSanitizer (15)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
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

      const model = (typeof body.model === 'string' && body.model) || this.configModel || '';
      if (!model) {
        return;
      }

      const caps = capabilitiesFor(model);

      const modifiedBySampling = handleDeprecatedSamplingParams(body, caps, model);

      // Not behind the thinking guard: Claude Code can send effort without thinking.
      const modifiedByEffort = handleUnsupportedEffort(body, caps, model);

      let modifiedByThinking = false;
      if (body.thinking) {
        modifiedByThinking = handleThinkingField(body, caps, model);
      }

      if (modifiedBySampling || modifiedByEffort || modifiedByThinking) {
        const newBodyStr = JSON.stringify(body);
        context.requestBody = Buffer.from(newBodyStr, 'utf-8');
        context.headers['content-length'] = String(context.requestBody.length);
      }
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged
    }
  }
}

/**
 * Dynamic model list fetcher for OpenCode / CodeMie-Code
 *
 * Every time the agent starts, this module fetches the live model catalogue
 * from the CodeMie API (/v1/llm_models?include_all=true) and converts it to
 * the OpenCodeModelConfig format used throughout the plugin layer.
 *
 * Authentication priority (first available wins):
 *   1. JWT Bearer token (env.CODEMIE_JWT_TOKEN)
 *   2. SSO stored credentials (looked up by env.CODEMIE_URL)
 *
 * On any error (network, auth, parse) the module silently falls back to the
 * static OPENCODE_MODEL_CONFIGS so agent startup is never blocked.
 */

import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import type { OpenCodeModelConfig } from './opencode-model-configs.js';
import { OPENCODE_MODEL_CONFIGS } from './opencode-model-configs.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { logger } from '../../../utils/logger.js';

// ── Responses-API detection ──────────────────────────────────────────────────
//
// The /v1/llm_models endpoint does not expose a "mode" field, so we maintain
// an explicit list of model-name patterns that require OpenAI Responses API
// (POST /v1/responses) instead of Chat Completions (POST /v1/chat/completions).
//
// Naming conventions observed in CodeMie deployments:
//   Responses API  →  gpt-5-2-*, gpt-5.2-*, gpt-5.x-codex-*, gpt-5-x-codex-*
//   Chat Completions → gpt-4*, gpt-5-<year>-*, o1/o3/o4*, gemini-*, claude-*, …
//
// Update this list whenever new Responses-API-only models are deployed.

const RESPONSES_API_MODEL_PATTERNS: RegExp[] = [
  /^gpt-5-2-/,        // gpt-5-2-2025-12-11 (and future gpt-5-2-YYYY-* variants)
  /^gpt-5\.2-/,       // gpt-5.2-chat
  /^gpt-5-1-codex/,   // gpt-5-1-codex-2025-11-13
  /^gpt-5\.1-codex/,  // gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.1-codex-max
  /^gpt-5-3-codex/,   // hyphenated variant of gpt-5.3-codex
  /^gpt-5\.3-codex/,  // gpt-5.3-codex-2026-02-24
];

function isResponsesApiModel(id: string): boolean {
  return RESPONSES_API_MODEL_PATTERNS.some(p => p.test(id));
}

// ── Family detection ─────────────────────────────────────────────────────────

function detectFamily(id: string): string {
  if (id.startsWith('claude')) return 'claude-4';
  if (id.startsWith('gemini')) return 'gemini-2';
  if (id.startsWith('gpt-4')) return 'gpt-4';
  if (id.startsWith('gpt-5')) return 'gpt-5';
  if (/^o[134]-/.test(id) || id === 'o1') return 'openai-reasoning';
  if (id.startsWith('qwen')) return 'qwen3';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('moonshotai') || id.startsWith('kimi')) return 'kimi';
  return id.split('-')[0] || id;
}

// ── Token-limit heuristics ───────────────────────────────────────────────────
//
// The /v1/llm_models endpoint does not include context/output token limits.
// We derive reasonable defaults from the model family.

function detectLimits(id: string, family: string): { context: number; output: number } {
  if (family === 'claude-4' || id.startsWith('claude')) return { context: 200000, output: 64000 };
  if (family === 'gemini-2' || id.startsWith('gemini')) return { context: 1048576, output: 65536 };
  if (id.startsWith('gpt-4.1')) return { context: 1048576, output: 32768 };
  if (id.startsWith('gpt-4o')) return { context: 128000, output: 16384 };
  if (id.startsWith('gpt-5')) return { context: 400000, output: 128000 };
  if (/^o[134]-/.test(id) || id === 'o1') return { context: 200000, output: 100000 };
  if (id.startsWith('qwen') || id.startsWith('moonshotai') || id.startsWith('kimi')) return { context: 262144, output: 131072 };
  if (id.startsWith('deepseek')) return { context: 65536, output: 65536 };
  return { context: 128000, output: 4096 };
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a raw /v1/llm_models entry to an OpenCodeModelConfig.
 *
 * Cost conversion: API uses $/token; OpenCode uses $/million tokens.
 *   e.g. 0.000003 $/token → 3.0 $/M tokens
 */
export function convertApiModelToOpenCodeConfig(model: LlmModel): OpenCodeModelConfig {
  const id = model.deployment_name;
  const family = detectFamily(id);
  const limit = detectLimits(id, family);
  const responsesApi = isResponsesApiModel(id);

  const toPerMillion = (v: number | undefined) => (v ?? 0) * 1_000_000;

  const costInput = toPerMillion(model.cost?.input);
  const costOutput = toPerMillion(model.cost?.output);
  const cacheRead = model.cost?.cache_read_input_token_cost != null
    ? toPerMillion(model.cost.cache_read_input_token_cost)
    : undefined;

  const today = new Date().toISOString().split('T')[0];

  return {
    id,
    name: model.label || id,
    displayName: model.label || id,
    family,
    tool_call: model.features?.tools ?? true,
    reasoning: true,
    attachment: model.multimodal ?? false,
    temperature: model.features?.temperature ?? true,
    structured_output: model.features?.tools ? true : undefined,
    ...(responsesApi && { use_responses_api: true }),
    modalities: {
      input: model.multimodal ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
    knowledge: today,
    release_date: today,
    last_updated: today,
    open_weights: false,
    cost: {
      input: costInput,
      output: costOutput,
      ...(cacheRead != null ? { cache_read: cacheRead } : {}),
    },
    limit,
  };
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch the live model catalogue from the CodeMie API and convert it to
 * OpenCodeModelConfig format.
 *
 * @param baseUrl    - CODEMIE_BASE_URL (authenticated proxy endpoint)
 * @param codeMieUrl - CODEMIE_URL (CodeMie org URL used for SSO credential lookup)
 * @param jwtToken   - CODEMIE_JWT_TOKEN (optional Bearer token, preferred over SSO)
 * @returns Map of modelId → OpenCodeModelConfig (dynamic) or OPENCODE_MODEL_CONFIGS (fallback)
 */
export async function fetchDynamicModelConfigs(
  baseUrl: string,
  codeMieUrl: string | undefined,
  jwtToken?: string,
): Promise<Record<string, OpenCodeModelConfig>> {
  try {
    let rawModels: LlmModel[];

    if (jwtToken) {
      rawModels = await fetchCodeMieLlmModels(baseUrl, jwtToken);
      logger.debug('[dynamic-models] Fetched model list via JWT auth');
    } else if (codeMieUrl) {
      const sso = new CodeMieSSO();
      const credentials = await sso.getStoredCredentials(codeMieUrl);
      if (!credentials) {
        logger.debug('[dynamic-models] No SSO credentials found, using static model configs');
        return OPENCODE_MODEL_CONFIGS;
      }
      rawModels = await fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
      logger.debug('[dynamic-models] Fetched model list via SSO auth');
    } else {
      logger.debug('[dynamic-models] No auth info in environment, using static model configs');
      return OPENCODE_MODEL_CONFIGS;
    }

    const result: Record<string, OpenCodeModelConfig> = {};
    for (const model of rawModels) {
      if (!model.enabled) continue;
      const config = convertApiModelToOpenCodeConfig(model);
      result[config.id] = config;
    }

    if (Object.keys(result).length === 0) {
      logger.debug('[dynamic-models] API returned no enabled models, using static model configs');
      return OPENCODE_MODEL_CONFIGS;
    }

    logger.debug(`[dynamic-models] Loaded ${Object.keys(result).length} models from API`);
    return result;
  } catch (error) {
    logger.debug('[dynamic-models] Failed to fetch dynamic models, falling back to static model configs', {
      error: error instanceof Error ? error.message : String(error),
    });
    return OPENCODE_MODEL_CONFIGS;
  }
}

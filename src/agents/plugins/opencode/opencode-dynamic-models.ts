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
//   Responses API  →  gpt-5-2-*, gpt-5.2-*, gpt-5.x-codex-*, gpt-5-x-codex-*,
//                     gpt-5.4-*, gpt-5-4-*, gpt-5.5-*, gpt-5-5-*
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
  /^gpt-5\.4-/,       // gpt-5.4-* — Azure requires /v1/responses for tools + reasoning_effort
  /^gpt-5-4-/,        // hyphenated variant of gpt-5.4-*
  /^gpt-5\.5-/,       // gpt-5.5-2026-04-24 — same Azure restriction as gpt-5.4
  /^gpt-5-5-/,        // hyphenated variant of gpt-5.5-*
];

function isResponsesApiModel(id: string): boolean {
  return RESPONSES_API_MODEL_PATTERNS.some(p => p.test(id));
}

// ── Family detection ─────────────────────────────────────────────────────────

function detectFamily(id: string): string {
  // Support vendor-prefixed model names (e.g. "anthropic.claude-...", "meta.llama-...").
  const bare = id.includes('.') ? id.split('.').slice(1).join('.') : id;
  if (bare.startsWith('claude') || id.startsWith('claude')) return 'claude-4';
  if (bare.startsWith('gemini') || id.startsWith('gemini')) return 'gemini-2';
  if (bare.startsWith('gpt-4') || id.startsWith('gpt-4')) return 'gpt-4';
  if (bare.startsWith('gpt-5') || id.startsWith('gpt-5')) return 'gpt-5';
  if (/^o[134]-/.test(bare) || bare === 'o1' || /^o[134]-/.test(id) || id === 'o1') return 'openai-reasoning';
  if (bare.startsWith('qwen') || id.startsWith('qwen')) return 'qwen3';
  if (bare.startsWith('deepseek') || id.startsWith('deepseek')) return 'deepseek';
  if (bare.startsWith('llama') || id.startsWith('llama') || id.startsWith('meta.llama')) return 'llama';
  if (bare.startsWith('mistral') || id.startsWith('mistral')) return 'mistral';
  if (id.startsWith('moonshotai') || id.startsWith('kimi')) return 'kimi';
  return id.split('.').pop()?.split('-')[0] || id.split('-')[0] || id;
}

// ── Token-limit heuristics ───────────────────────────────────────────────────
//
// The /v1/llm_models endpoint does not include context/output token limits.
// We derive reasonable defaults from the model family.

function detectLimits(id: string, family: string): { context: number; output: number } {
  if (family === 'claude-4' || id.startsWith('claude') || id.includes('.claude')) return { context: 200000, output: 64000 };
  if (family === 'gemini-2' || id.startsWith('gemini')) return { context: 1048576, output: 65536 };
  if (id.startsWith('gpt-4.1')) return { context: 1048576, output: 32768 };
  if (id.startsWith('gpt-4o')) return { context: 128000, output: 16384 };
  if (id.startsWith('gpt-5.5') || id.startsWith('gpt-5-5')) return { context: 1050000, output: 128000 }; // Azure-published window for gpt-5.5
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

// ── Ollama /api/show autodetect ──────────────────────────────────────────────

/**
 * Subset of the Ollama /api/show response we rely on.
 * See: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Note: `parameters` is a STRING in the real response (e.g. "num_ctx 32768\n..."),
 * not an object. The authoritative context length lives in `details.context_length`
 * or in `model_info[<arch>].context_length`.
 */
export interface OllamaShowResponse {
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
    embedding_length?: number;
  };
  model_info?: Record<string, { context_length?: number } & Record<string, unknown>>;
  parameters?: string;
}

export interface OllamaModelLimits {
  context: number;
  output: number;
}

/**
 * Per-family default context windows for Ollama models when /api/show
 * does not (or cannot) report a value. Tuned conservatively: most local
 * Ollama installs default to 2048/4096 unless `num_ctx` was raised.
 */
function getFamilyDefaultContext(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.startsWith('llama3') || id.startsWith('llama-3')) return 128000;
  if (id.startsWith('llama2') || id.startsWith('llama-2')) return 4096;
  if (id.startsWith('llama')) return 4096;
  if (id.startsWith('qwen2.5') || id.startsWith('qwen2-5')) return 32768;
  if (id.startsWith('qwen3')) return 32768;
  if (id.startsWith('qwen')) return 32768;
  if (id.startsWith('gemma2') || id.startsWith('gemma-2')) return 8192;
  if (id.startsWith('gemma3') || id.startsWith('gemma-3')) return 128000;
  if (id.startsWith('gemma')) return 8192;
  if (id.startsWith('codellama')) return 16384;
  if (id.startsWith('deepseek-coder')) return 16384;
  if (id.startsWith('deepseek-r1')) return 65536;
  if (id.startsWith('deepseek')) return 32768;
  if (id.startsWith('mistral') || id.startsWith('mixtral')) return 32768;
  if (id.startsWith('phi3') || id.startsWith('phi-3')) return 4096;
  if (id.startsWith('phi4') || id.startsWith('phi-4')) return 16384;
  if (id.startsWith('command-r')) return 128000;
  if (id.startsWith('yi')) return 32768;
  return 32768;
}

/**
 * Per-family default output (max_tokens) limits. Ollama does not advertise
 * a max output size in /api/show, so we approximate from common defaults.
 * Returns 4096 as a safe generic fallback.
 */
export function getOllamaFamilyOutputLimit(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.startsWith('llama3') || id.startsWith('llama-3')) return 8192;
  if (id.startsWith('llama2') || id.startsWith('llama-2')) return 4096;
  if (id.startsWith('llama')) return 4096;
  if (id.startsWith('qwen')) return 8192;
  if (id.startsWith('gemma2') || id.startsWith('gemma-2')) return 8192;
  if (id.startsWith('gemma3') || id.startsWith('gemma-3')) return 8192;
  if (id.startsWith('gemma')) return 4096;
  if (id.startsWith('codellama')) return 4096;
  if (id.startsWith('deepseek-coder')) return 8192;
  if (id.startsWith('deepseek-r1')) return 8192;
  if (id.startsWith('deepseek')) return 8192;
  if (id.startsWith('mistral') || id.startsWith('mixtral')) return 8192;
  if (id.startsWith('phi3') || id.startsWith('phi-3')) return 4096;
  if (id.startsWith('phi4') || id.startsWith('phi-4')) return 4096;
  if (id.startsWith('command-r')) return 4096;
  if (id.startsWith('yi')) return 4096;
  return 4096;
}

/**
 * Fetch /api/show for a single model and extract its context length.
 * Returns `undefined` on any failure so the caller can chain fallbacks.
 *
 * Cached per-process via {@link ollamaShowCache} so the same model is
 * only fetched once per discovery run, even when looked up by both
 * its full tag and its normalized (tag-stripped) name.
 */
async function fetchOllamaContextLength(
  ollamaApiUrl: string,
  modelName: string,
): Promise<OllamaShowResponse | undefined> {
  if (ollamaShowCache.has(modelName)) {
    return ollamaShowCache.get(modelName);
  }
  try {
    const showResp = await fetch(`${ollamaApiUrl}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ name: modelName }),
    });
    if (!showResp.ok) {
      ollamaShowCache.set(modelName, undefined as unknown as OllamaShowResponse);
      return undefined;
    }
    const data = (await showResp.json()) as OllamaShowResponse;
    ollamaShowCache.set(modelName, data);
    return data;
  } catch {
    logger.debug(`[dynamic-models] [ollama] Failed to fetch /api/show for ${modelName}`);
    ollamaShowCache.set(modelName, undefined as unknown as OllamaShowResponse);
    return undefined;
  }
}

const ollamaShowCache: Map<string, OllamaShowResponse | undefined> = new Map();

/**
 * Resolve the effective context window for an Ollama model using a
 * 5-step fallback chain. The first source that yields a positive
 * integer wins.
 */
function resolveOllamaContext(
  modelId: string,
  showData: OllamaShowResponse | undefined,
  profileConfig: { contextWindow?: number; maxPhysicalContext?: number } | undefined,
): number {
  // 1. Explicit profile override (absolute control).
  if (profileConfig?.contextWindow && profileConfig.contextWindow > 0) {
    return profileConfig.contextWindow;
  }

  let resolvedContext = 32768; // Default fallback

  if (showData) {
    // 2. details.context_length (set when the model was created with an explicit num_ctx).
    const detailsCtx = showData.details?.context_length;
    if (detailsCtx && detailsCtx > 0) {
      resolvedContext = detailsCtx;
    } else {
      // 3. model_info[<arch>].context_length. 
      // Note: Ollama sometimes prefixes keys with the family name (e.g. "gemma4.context_length")
      // or uses "general.architecture" as the key.
      const arch = showData.details?.family || (showData.model_info?.['general.architecture'] as string | undefined);
      if (arch && showData.model_info) {
        // Try specific family-prefixed key first (e.g. "gemma4.context_length")
        const familyKey = `${arch}.context_length`;
        const familyVal = showData.model_info[familyKey];
        if (familyVal && typeof familyVal === 'number' && familyVal > 0) {
          resolvedContext = familyVal;
        } else {
          // Fallback to architecture-based entry
          const archEntry = showData.model_info[arch];
          const archCtx = archEntry?.context_length;
          if (archCtx && archCtx > 0) {
            resolvedContext = archCtx;
          }
        }
      }

      // Special case: check all keys for anything ending in ".context_length"
      if (resolvedContext === 32768 && showData.model_info) {
        for (const key of Object.keys(showData.model_info)) {
          if (key.endsWith('.context_length')) {
            const val = showData.model_info[key];
            if (typeof val === 'number' && val > 0) {
              resolvedContext = val;
              break;
            }
          }
        }
      }
    }
  } else {
    // 4. Family-based heuristic.
    const familyCtx = getFamilyDefaultContext(modelId);
    if (familyCtx > 0) {
      resolvedContext = familyCtx;
    }
  }

  // 5. Physical RAM Limit (maxPhysicalContext).
  // We use the minimum of the model's support and the physical limit to avoid OOM.
  if (profileConfig?.maxPhysicalContext && profileConfig.maxPhysicalContext > 0) {
    resolvedContext = Math.min(resolvedContext, profileConfig.maxPhysicalContext);
  }

  return resolvedContext;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch the dynamic model catalogue for any provider. Supports Ollama dynamic discovery.
 *
 * @param baseUrl          - Provider base URL (Ollama: http://localhost:11434, ...)
 * @param codeMieUrl       - CODEMIE_URL (for SSO providers)
 * @param jwtToken         - JWT token if available
 * @param providerOverride - Provider name override (e.g. "ollama")
 * @param profileConfig    - Profile config (used for `contextWindow` override on Ollama)
 * @returns Map of modelId → OpenCodeModelConfig (dynamic) or OPENCODE_MODEL_CONFIGS (fallback)
 */
export async function fetchDynamicModelConfigs(
  baseUrl: string,
  codeMieUrl: string | undefined,
  jwtToken?: string,
  providerOverride?: string,
  profileConfig?: { contextWindow?: number; maxPhysicalContext?: number } & Record<string, unknown>,
): Promise<Record<string, OpenCodeModelConfig>> {
  // === Dynamic Ollama discovery ===
  if ((providerOverride && providerOverride === 'ollama') || (baseUrl && /11434/.test(baseUrl))) {
    try {
      const ollamaApiUrl = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
      const resp = await fetch(`${ollamaApiUrl}/api/tags`);
      const data = await resp.json();
      const ollamaModels: Record<string, OpenCodeModelConfig> = {};
      for (const { name } of (Array.isArray((data as any).models) ? (data as any).models : [])) {
        const exactId = name;
        const normalizedId = name.replace(/:.*$/, ''); // "qwen3.6:latest" -> "qwen3.6"

        // Fetch /api/show once and reuse the cached result for both
        // the tag-suffixed and the normalized (tag-stripped) lookups.
        const showData = await fetchOllamaContextLength(ollamaApiUrl, exactId);
        const context = resolveOllamaContext(normalizedId, showData, profileConfig);
        const output = getOllamaFamilyOutputLimit(normalizedId);

        const config: OpenCodeModelConfig = {
          id: normalizedId,
          name: normalizedId,
          family: normalizedId.split('.')[0],
          displayName: normalizedId,
          tool_call: true,
          reasoning: true,
          attachment: false,
          temperature: true,
          structured_output: false,
          use_responses_api: false,
          modalities: { input: ['text'], output: ['text'] },
          knowledge: new Date().toISOString().split('T')[0],
          release_date: new Date().toISOString().split('T')[0],
          last_updated: new Date().toISOString().split('T')[0],
          open_weights: true,
          cost: { input: 0, output: 0 },
          limit: { context, output }
        };
        ollamaModels[normalizedId] = config;
        ollamaModels[exactId] = { ...config, id: exactId, name: exactId, displayName: exactId };
      }
      logger.debug(`[dynamic-models] [ollama] Loaded ${Object.keys(ollamaModels).length} models from /api/tags`);
      if (Object.keys(ollamaModels).length > 0) return ollamaModels;
    } catch (err) {
      logger.debug(`[dynamic-models] [ollama] Dynamic model fetch failed, falling back.`, { error: err instanceof Error ? err.message : String(err) });
    }
    // Continue to fallback model loading logic below...
  }

  let rawModels: LlmModel[];

  try {
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

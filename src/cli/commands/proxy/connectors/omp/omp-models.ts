/**
 * Maps the CodeMie catalog (`GET /v1/llm_models?include_all=true`, the same source as
 * `codemie models list`) onto oh-my-pi (omp) provider model rows.
 *
 * Bundled into the omp extension (see codemie-models.extension.ts), so it must stay free of
 * runtime imports beyond other dependency-free modules.
 */
import type { LlmModel } from '@/providers/plugins/sso/sso.http-client.js';
import { isResponsesApiModel } from '@/utils/responses-api-models.js';

export type OmpApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

/** omp `ProviderModelConfig` subset this integration fills. `cost` is USD per million tokens. */
export interface OmpModelRow {
  id: string;
  name: string;
  api: OmpApi;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/**
 * Claude deployments speak the Anthropic Messages wire through the proxy, everything else the
 * OpenAI wire; omp keeps a provider-level base URL per wire, hence two rosters.
 */
export interface OmpModelRoster {
  openai: OmpModelRow[];
  anthropic: OmpModelRow[];
}

// Catalog rows without a reported window (older backends, static-config catalogs) or without an
// output cap (virtual routers) still need concrete limits; these match common chat deployments.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const TOKENS_PER_MILLION = 1_000_000;

/** Catalog $/token → omp $/M tokens, rounded to drop float noise (1e-7 × 1e6 = 0.09999999999999999). */
function perMillion(usdPerToken: number | undefined): number {
  return Math.round((usdPerToken ?? 0) * TOKENS_PER_MILLION * 1e6) / 1e6;
}

export function buildOmpModelRoster(models: readonly LlmModel[]): OmpModelRoster {
  const roster: OmpModelRoster = { openai: [], anthropic: [] };
  const seen = new Set<string>();

  for (const model of models) {
    const id = model.deployment_name || model.base_name;
    // Image-generation deployments cannot serve a chat turn, so they never belong in a chat roster.
    if (!id || model.enabled === false || model.supports_image_generation === true || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const anthropic = id.startsWith('claude');
    const api: OmpApi = anthropic
      ? 'anthropic-messages'
      : isResponsesApiModel(id) ? 'openai-responses' : 'openai-completions';

    (anthropic ? roster.anthropic : roster.openai).push({
      id,
      name: model.label || id,
      api,
      // The catalog carries no reasoning flag; every current family except GPT-4.x reasons, and omp's
      // own catalog policy narrows the effort levels per model id.
      reasoning: !id.startsWith('gpt-4'),
      input: model.multimodal ? ['text', 'image'] : ['text'],
      cost: {
        input: perMillion(model.cost?.input),
        output: perMillion(model.cost?.output),
        cacheRead: perMillion(model.cost?.cache_read_input_token_cost),
        cacheWrite: perMillion(model.cost?.cache_creation_input_token_cost),
      },
      contextWindow: model.max_input_tokens || DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.max_output_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
    });
  }

  return roster;
}

/**
 * Maps the CodeMie catalog (`GET /v1/llm_models?include_all=true`, the same source as
 * `codemie models list`) onto oh-my-pi (omp) provider model rows.
 *
 * Bundled into the omp extension (see codemie-models.extension.ts), so it must stay free of
 * runtime imports beyond other dependency-free modules.
 */
import type { LlmModel, RouterTier } from '@/providers/plugins/sso/sso.http-client.js';
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
 * omp binds one base URL, API and auth mode per provider. Keep two rosters: OpenAI wire models
 * use `<daemon>/v1` with a Bearer key; Anthropic Messages models use the `<daemon>` root with
 * `authHeader`. Per-model API overrides within one provider are unverified against omp v18.12.3.
 */
export interface OmpModelRoster {
  openai: OmpModelRow[];
  anthropic: OmpModelRow[];
}

// Catalog rows without a reported window still need a concrete context limit.
const DEFAULT_CONTEXT_WINDOW = 128_000;
// Routers use the minimum known tier cap before this fallback is considered.
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const TOKENS_PER_MILLION = 1_000_000;

const CLAUDE_FAMILY = /claude|anthropic/i;
const NON_CHAT = /embedding/i;
// Unknown families default to false: only these families are known to accept reasoning effort.
const REASONING_FAMILIES = [
  CLAUDE_FAMILY,
  /(?:^|[./])gpt-(?:[5-9]|[1-9]\d)/i,
  /(?:^|[./])o[134](?:-|$)/i,
  /gemini/i,
];

const isClaudeFamily = (id: string): boolean => CLAUDE_FAMILY.test(id);
const isReasoningFamily = (id: string): boolean => REASONING_FAMILIES.some(pattern => pattern.test(id));

/** Distinct tier target ids of a Switchyard or LiteLLM router; `[]` for a plain model. */
function tierTargets(model: LlmModel): string[] {
  const tiers = model.tiers ?? model.litellm_router?.tiers;
  if (!tiers) return [];
  const ids = (Object.values(tiers) as (RouterTier | undefined)[])
    .map(tier => tier?.model)
    .filter((target): target is string => Boolean(target));
  return [...new Set(ids)];
}

/** Lowest known output cap across a router's tier targets; `undefined` when none is known. */
function routerOutputCap(targets: readonly string[], caps: ReadonlyMap<string, number>): number | undefined {
  const known = targets.map(target => caps.get(target)).filter((cap): cap is number => cap !== undefined);
  return known.length ? Math.min(...known) : undefined;
}

/** Catalog $/token → omp $/M tokens, rounded to drop float noise (1e-7 × 1e6 = 0.09999999999999999). */
function perMillion(usdPerToken: number | undefined): number {
  return Math.round((usdPerToken ?? 0) * TOKENS_PER_MILLION * 1e6) / 1e6;
}

/**
 * Split the CodeMie catalog into omp rosters: `openai` (OpenAI-wire `codemie`) and `anthropic`
 * (Anthropic-wire `codemie-claude`). Rows are skipped when nameless, disabled, image-generation,
 * embedding (deployment or base name) or duplicated by id (deployment_name, else base_name).
 * A row is Anthropic only when its id, or every router tier target, is a Claude family; likewise for
 * reasoning. maxTokens is the lowest `max_output_tokens` among a router's tier targets, falling back
 * to the row's own cap and then the default.
 */
export function buildOmpModelRoster(models: readonly LlmModel[]): OmpModelRoster {
  const caps = new Map<string, number>();
  for (const model of models) {
    if (model.max_output_tokens === undefined) continue;
    for (const id of [model.deployment_name, model.base_name]) {
      if (id) caps.set(id, model.max_output_tokens);
    }
  }

  const roster: OmpModelRoster = { openai: [], anthropic: [] };
  const seen = new Set<string>();
  for (const model of models) {
    const id = model.deployment_name || model.base_name;
    const nonChat = [model.deployment_name, model.base_name].some(name => !!name && NON_CHAT.test(name));
    if (!id || model.enabled === false || model.supports_image_generation === true || nonChat || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const targets = tierTargets(model);
    const anthropic = targets.length ? targets.every(isClaudeFamily) : isClaudeFamily(id);
    const reasoning = targets.length ? targets.every(isReasoningFamily) : isReasoningFamily(id);
    const api: OmpApi = anthropic
      ? 'anthropic-messages'
      : isResponsesApiModel(id) ? 'openai-responses' : 'openai-completions';

    (anthropic ? roster.anthropic : roster.openai).push({
      id,
      name: model.label || id,
      api,
      reasoning,
      input: model.multimodal ? ['text', 'image'] : ['text'],
      cost: {
        input: perMillion(model.cost?.input),
        output: perMillion(model.cost?.output),
        cacheRead: perMillion(model.cost?.cache_read_input_token_cost),
        cacheWrite: perMillion(model.cost?.cache_creation_input_token_cost),
      },
      contextWindow: model.max_input_tokens || DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.max_output_tokens || routerOutputCap(targets, caps) || DEFAULT_MAX_OUTPUT_TOKENS,
    });
  }

  return roster;
}

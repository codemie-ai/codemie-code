import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels, buildModelLabelIndex, describeRouter } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { resolveHomeDir } from '../../../utils/paths.js';

interface CodexCatalogReasoningLevel {
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  description: string;
}

interface CodexCatalogModel {
  slug: string;
  display_name: string;
  description: string;
  default_reasoning_level: 'medium';
  supported_reasoning_levels: CodexCatalogReasoningLevel[];
  shell_type: 'shell_command';
  visibility: 'list';
  supported_in_api: true;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: string[];
  availability_nux: null;
  upgrade: null;
  base_instructions: string;
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: 'none';
  support_verbosity: boolean;
  default_verbosity: 'medium';
  apply_patch_tool_type: 'freeform';
  web_search_tool_type: 'text_and_image';
  truncation_policy: {
    mode: 'tokens';
    limit: number;
  };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: boolean;
  context_window: number;
  max_context_window: number;
  effective_context_window_percent: number;
  experimental_supported_tools: string[];
  input_modalities: string[];
  supports_search_tool: boolean;
}

interface CodexModelCatalog {
  models: CodexCatalogModel[];
}

export interface CodexModelResolution {
  selectedModel: string;
  catalogPath?: string;
  availableModels: string[];
}

interface RankedModel {
  model: LlmModel;
  id: string;
  score: number[];
}

const INCOMPATIBLE_MODEL_PATTERNS: RegExp[] = [
  /claude/i,
  /sonnet/i,
  /opus/i,
  /haiku/i,
  /anthropic/i,
  /gemini/i,
  /qwen/i,
  /deepseek/i,
  /llama/i,
  /mistral/i,
  /grok/i,
];

const COMPATIBLE_CODEX_MODEL_PATTERNS: RegExp[] = [
  /codex/i,
  /^gpt[-.]?5(?:[-.]|\b)/i,
  /^gpt[-.]?6(?:[-.]|\b)/i,
  // Fallback for router/switchyard aliases that don't carry the catalog's `is_router` flag
  // (e.g. a plain LiteLLM alias): `gpt-smart-router`, `gpt-fast-router`. Real Switchyard
  // routers are matched via isRouterCatalogEntry below instead, since their names don't
  // follow any fixed convention (e.g. `sy-signal-gpt-terra-luna`). Anchored to a `gpt-`
  // prefix on purpose: a provider-agnostic router could pick a Claude model, which the
  // Responses API wire format cannot drive. Claude-named routers stay rejected by
  // INCOMPATIBLE_MODEL_PATTERNS above.
  /^gpt[-._](?:[a-z0-9]+[-._])*router\b/i,
];

// CODEMIE_MODEL_SOURCE values that mean the user picked this model (`--model`, or the
// environment) rather than it coming from a saved profile. Set by AgentCLI.
const EXPLICIT_MODEL_SOURCES = new Set(['cli', 'env']);

function isExplicitModelChoice(env: NodeJS.ProcessEnv): boolean {
  return EXPLICIT_MODEL_SOURCES.has(env.CODEMIE_MODEL_SOURCE ?? '');
}

/**
 * Build a catalog entry for a model the CodeMie catalog does not enumerate.
 *
 * Router aliases are commonly served by the gateway without being listed as deployments, so
 * an explicitly requested one has to be injected: `availableModels` gates our own assertion
 * and the generated models.json gates Codex's `--model` validation, and a model missing from
 * either is rejected before a single request is made.
 */
function syntheticRankedModel(id: string): RankedModel {
  return {
    id,
    model: { base_name: id, deployment_name: id, label: id, enabled: true },
    // Ranks ahead of every catalog entry so it becomes the default selection.
    score: [Number.MAX_SAFE_INTEGER],
  };
}

const REASONING_LEVELS: CodexCatalogReasoningLevel[] = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
];

function getModelId(model: LlmModel): string {
  return model.deployment_name || model.base_name || model.label;
}

function getSearchText(model: LlmModel): string {
  return [
    model.deployment_name,
    model.base_name,
    model.label,
    model.provider,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function isCodexCompatibleModelName(modelName: string | undefined): modelName is string {
  if (!modelName) return false;
  if (INCOMPATIBLE_MODEL_PATTERNS.some(pattern => pattern.test(modelName))) return false;
  return COMPATIBLE_CODEX_MODEL_PATTERNS.some(pattern => pattern.test(modelName));
}

/**
 * Present (`is_router`) on a Switchyard virtual router entry, or nested (`litellm_router.is_router`)
 * on a declared LiteLLM auto-router — see LlmModel's own field docs. Mirrors
 * claude.models.ts's isRouterCatalogEntry: router alias names follow no fixed convention
 * (e.g. `sy-signal-gpt-terra-luna`), so membership must be read from this catalog flag
 * rather than guessed from the id.
 */
function isRouterCatalogEntry(model: LlmModel): boolean {
  return model.is_router === true || model.litellm_router?.is_router === true;
}

function isCodexCompatibleModel(model: LlmModel): boolean {
  if (!model.enabled) return false;

  const id = getModelId(model);
  if (!id) return false;

  // A LiteLLM auto-router's own alias name is family-agnostic by convention
  // (`claude-smart-router` and `gpt-smart-router` are both named like routers, not like
  // their target), so name-sniffing it is unreliable — a differently-named Claude router
  // could slip past INCOMPATIBLE_MODEL_PATTERNS below. `counterfactual_model` names the
  // concrete deployment the router currently resolves to, which is a deterministic signal:
  // judge the router by what it actually dispatches to instead of by its own name.
  const counterfactual = model.litellm_router?.counterfactual_model;
  if (counterfactual) {
    return isCodexCompatibleModelName(counterfactual);
  }

  const searchText = getSearchText(model);
  if (INCOMPATIBLE_MODEL_PATTERNS.some(pattern => pattern.test(searchText))) {
    return false;
  }

  // A Switchyard virtual router (top-level `is_router`) carries no target-model field to
  // check deterministically — CodeMie's own naming convention embeds the constituent model
  // families directly in base_name/label instead (e.g. `sy-signal-gpt-terra-luna` / "SY
  // Signal Terra/Luna" vs. `sy-signal-claude-sonnet-haiku` / "SY Signal Sonnet/Haiku"), so
  // the incompatible-name check above — already run — is the most precise signal available
  // for this shape, and is trusted here.
  if (isRouterCatalogEntry(model)) return true;

  return COMPATIBLE_CODEX_MODEL_PATTERNS.some(pattern => pattern.test(searchText));
}

function extractVersionParts(text: string): number[] {
  const lower = text.toLowerCase();
  const gptMatch = lower.match(/gpt[-.]?(\d+)(?:[-.](\d+))?(?:[-.](\d+))?/);
  const dateMatch = lower.match(/(20\d{2})[-.]?(\d{2})[-.]?(\d{2})/);

  const version = [
    gptMatch?.[1],
    gptMatch?.[2],
    gptMatch?.[3],
  ].map(part => part ? Number(part) : 0);

  if (dateMatch) {
    version.push(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
  } else {
    version.push(0, 0, 0);
  }

  return version;
}

function rankModel(model: LlmModel): RankedModel {
  const id = getModelId(model);
  const searchText = getSearchText(model);
  const preferredDefaultBonus = /gpt[-.]?5[-.]?4(?:[-.]|\b)/i.test(searchText) ? 1 : 0;
  const codexBonus = /codex/i.test(searchText) ? 1 : 0;
  const defaultBonus = model.default ? 1 : 0;
  const toolBonus = model.features?.tools === false ? 0 : 1;
  const streamingBonus = model.features?.streaming === false ? 0 : 1;

  return {
    model,
    id,
    score: [
      preferredDefaultBonus,
      ...extractVersionParts(searchText),
      codexBonus,
      toolBonus,
      streamingBonus,
      defaultBonus,
    ],
  };
}

/**
 * Release date embedded in a CodeMie deployment name, e.g. `-2026-07-09`.
 *
 * Not anchored to end-of-string: a deployment may carry a suffix after the date
 * (`gpt-5-2025-08-07-preview`), and anchoring would fail the match there, making
 * the version reader take `2025` as the minor version.
 */
const DEPLOYMENT_DATE_PATTERN = /[-._](20\d{2})[-._](\d{2})[-._](\d{2})/;

/**
 * Split a deployment id into its generation version and its release date.
 *
 * The date must be removed BEFORE the version is read. `extractVersionParts`
 * (used by the CLI ranking path) reads them from the same string, so
 * `gpt-5-2025-08-07` parses as version [5, 2025, 8] and outranks
 * `gpt-5.6-luna-2026-07-09`'s [5, 6, 0] — the date masquerades as a minor
 * version. That inversion is why the CLI path needs a hardcoded gpt-5.4 bonus
 * to compensate; this function avoids needing one.
 */
function splitDeploymentVersion(id: string): { version: number[]; date: number[] } {
  const lower = id.toLowerCase();
  const dateMatch = lower.match(DEPLOYMENT_DATE_PATTERN);
  const date = dateMatch
    ? [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])]
    : [0, 0, 0];

  const withoutDate = dateMatch ? lower.slice(0, dateMatch.index) : lower;
  const versionMatch = withoutDate.match(/gpt[-._]?(\d+)(?:[-._](\d+))?/);

  return {
    version: [Number(versionMatch?.[1] ?? 0), Number(versionMatch?.[2] ?? 0)],
    date,
  };
}

/**
 * Rank Codex-compatible deployment ids newest-first.
 *
 * Shares the compatibility predicate with the CLI path but not its scoring: a
 * surface that shows the model name to the user should default to the newest
 * deployment the gateway actually offers, so there is no pinned-generation
 * bonus, and reduced-capacity variants sort below full models of the same
 * generation. Callers wanting a specific model pass it explicitly instead.
 */
export function rankCodexModelIdsByRecency(models: LlmModel[]): string[] {
  return models
    .filter(isCodexCompatibleModel)
    .map((model) => {
      const id = getModelId(model);
      const searchText = getSearchText(model);
      const { version, date } = splitDeploymentVersion(id);

      return {
        id,
        score: [
          ...version,
          /mini|nano/i.test(searchText) ? 0 : 1,
          ...date,
          /codex/i.test(searchText) ? 1 : 0,
          model.features?.tools === false ? 0 : 1,
          model.features?.streaming === false ? 0 : 1,
          model.default ? 1 : 0,
        ],
      };
    })
    .sort((a, b) => {
      const max = Math.max(a.score.length, b.score.length);
      for (let i = 0; i < max; i++) {
        const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return a.id.localeCompare(b.id);
    })
    .map((entry) => entry.id);
}

function compareRankedModels(a: RankedModel, b: RankedModel): number {
  const max = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < max; i++) {
    const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Codex's own model picker (as of codex-cli 0.154.0) ignores a catalog entry's
 * `display_name` entirely — see https://github.com/openai/codex/issues/46183 — and renders
 * only `slug` and `description`. Until that upstream fix (already merged, not yet in the
 * version codemie-code targets) reaches the pinned Codex version, `description` is the only
 * field that actually reaches the picker, so a router's per-tier routing — the one thing the
 * slug itself doesn't reveal — is folded into it as a workaround via `describeRouter`.
 * Everything else (a plain model, or a router the backend hasn't populated a tier map for)
 * has nothing more specific to add beyond its already-shown slug, so its description is left
 * empty rather than filled with a guess. `display_name` is left set correctly regardless, so
 * nothing needs to change here once Codex picks it up.
 *
 * `labelIndex` is built from the FULL raw catalog, not just the Codex-compatible subset — a
 * router's classifier model can belong to a different family (a Claude classifier gating a
 * GPT router) and still needs its label resolved.
 */
function buildCodexCatalog(models: RankedModel[], labelIndex: Map<string, string>): CodexModelCatalog {
  return {
    models: models.map((entry, index) => ({
      slug: entry.id,
      display_name: entry.model.label || entry.id,
      description: describeRouter(entry.model, labelIndex),
      default_reasoning_level: 'medium',
      supported_reasoning_levels: REASONING_LEVELS,
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: index,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: '',
      supports_reasoning_summaries: true,
      default_reasoning_summary: 'none',
      support_verbosity: true,
      default_verbosity: 'medium',
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text_and_image',
      truncation_policy: {
        mode: 'tokens',
        limit: 10000,
      },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: 400000,
      max_context_window: 400000,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: entry.model.multimodal ? ['text', 'image'] : ['text'],
      supports_search_tool: true,
    })),
  };
}

async function fetchCodeMieModelsForCodex(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;

  if (jwtToken && baseUrl) {
    logger.debug('[codex-models] Fetching CodeMie model list via JWT auth');
    return fetchCodeMieLlmModels(baseUrl, jwtToken);
  }

  const codeMieUrl = env.CODEMIE_URL;
  if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      throw new ConfigurationError(
        `SSO credentials not found for ${codeMieUrl}. Run: codemie profile login --url ${codeMieUrl}`
      );
    }

    logger.debug('[codex-models] Fetching CodeMie model list via SSO auth');
    return fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  }

  return [];
}

async function writeCatalogFile(catalog: CodexModelCatalog): Promise<string> {
  const dir = resolveHomeDir('.codex/codemie');
  await mkdir(dir, { recursive: true });

  const catalogPath = join(dir, 'models.json');
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
  return catalogPath;
}

function formatAvailableModelIds(modelIds: string[]): string {
  return modelIds.join(', ');
}

export async function resolveCodexModel(env: NodeJS.ProcessEnv): Promise<CodexModelResolution> {
  const currentModel = env.CODEMIE_MODEL;

  let rawModels: LlmModel[] = [];
  try {
    rawModels = await fetchCodeMieModelsForCodex(env);
  } catch (error) {
    if (isCodexCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[codex-models] Failed to fetch CodeMie models; keeping compatible configured model', {
        error: error instanceof Error ? error.message : String(error),
        model: configuredModel,
      });
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }
    throw error;
  }

  const rankedModels = rawModels
    .filter(isCodexCompatibleModel)
    .map(rankModel)
    .sort(compareRankedModels);

  if (rankedModels.length === 0) {
    if (isCodexCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[codex-models] CodeMie returned no compatible Codex models; keeping configured GPT/Codex model');
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }

    throw new ConfigurationError(
      'No CodeMie GPT/Codex model is available for codemie-codex. ' +
      'Enable a GPT-5/Codex deployment in CodeMie before running Codex.'
    );
  }

  let catalogModels = rankedModels;
  let rankedIds = rankedModels.map(entry => entry.id);

  // A compatible model the user asked for by name is honoured even when the catalog does not
  // list it. Router aliases are the motivating case: the gateway resolves them per request
  // and does not necessarily publish them as deployments, so requiring catalog membership
  // would make them permanently unusable. Restricted to an explicit choice — a stale profile
  // value still gets re-resolved against the live catalog as before.
  if (
    isCodexCompatibleModelName(currentModel) &&
    !rankedIds.includes(currentModel) &&
    isExplicitModelChoice(env)
  ) {
    catalogModels = [syntheticRankedModel(currentModel), ...rankedModels];
    rankedIds = catalogModels.map(entry => entry.id);
    console.error(
      `[codemie-codex] Model "${currentModel}" is not listed in the CodeMie catalog; using it anyway because it was requested explicitly.`
    );
    logger.info(`[codex-models] Honouring explicitly requested uncatalogued model ${currentModel}`);
  }

  // Catalog membership (rankedIds) is authoritative here — it already reflects
  // isCodexCompatibleModel, which trusts a flagged router regardless of its name (see
  // isRouterCatalogEntry). Re-checking isCodexCompatibleModelName on top would reject a
  // router whose name doesn't match the name-based fallback pattern even though the
  // catalog just vouched for it.
  const selectedModel =
    currentModel && rankedIds.includes(currentModel)
      ? currentModel
      : catalogModels[0].id;
  const catalogPath = await writeCatalogFile(buildCodexCatalog(catalogModels, buildModelLabelIndex(rawModels)));

  if (isCodexCompatibleModelName(currentModel) && currentModel !== selectedModel) {
    console.error(`[codemie-codex] Requested model "${currentModel}" is not available; using ${selectedModel} instead.`);
    logger.info(
      `[codex-models] Using ${selectedModel} for Codex instead of requested model ${currentModel}`
    );
  }

  return {
    selectedModel,
    catalogPath,
    availableModels: rankedIds,
  };
}

export function assertExplicitCodexModelAllowed(model: string, availableModels: string[]): void {
  // A model the live catalog already vouches for (resolveCodexModel's availableModels,
  // which trusts a flagged router regardless of its name — see isRouterCatalogEntry) needs
  // no further name-pattern validation. Without this, a router like
  // `sy-signal-gpt-terra-luna` — correctly listed as available — would still be rejected
  // here by the name-based fallback pattern, which only recognizes `gpt-*-router` aliases.
  if (availableModels.length > 0 && availableModels.includes(model)) {
    return;
  }

  if (!isCodexCompatibleModelName(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not compatible with codemie-codex. ` +
      `Use a GPT/Codex model${availableModels.length ? ` such as: ${formatAvailableModelIds(availableModels)}` : '.'}`
    );
  }

  if (availableModels.length > 0 && !availableModels.includes(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not available in CodeMie for codemie-codex. ` +
      `Available models: ${availableModels.join(', ')}`
    );
  }
}

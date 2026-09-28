import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels, buildModelLabelIndex, describeRouter } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

export type ClaudeModelTier = 'model' | 'haiku' | 'sonnet' | 'opus';

export interface ClaudeModelResolution {
  selectedModel: string;
  availableModels: string[];
}

interface RankedClaudeModel {
  id: string;
  score: number[];
}

// CODEMIE_MODEL_SOURCE values that mean "the user picked this", as opposed to 'default'
// (read from a saved profile), which is the only case auto-resolution may override.
const EXPLICIT_MODEL_SOURCES = new Set(['cli', 'env']);

const TIER_ENV_VAR: Record<ClaudeModelTier, string> = {
  model: 'CODEMIE_MODEL',
  haiku: 'CODEMIE_HAIKU_MODEL',
  sonnet: 'CODEMIE_SONNET_MODEL',
  opus: 'CODEMIE_OPUS_MODEL',
};

const CLAUDE_INCOMPATIBLE_MODEL_PATTERNS: RegExp[] = [
  /embedding/i,
  /rerank/i,
  /whisper/i,
  /tts/i,
  /moderation/i,
  /image/i,
  /vision-only/i,
];

const CLAUDE_FAMILY_PATTERNS: RegExp[] = [
  /claude/i,
  /anthropic/i,
  /sonnet/i,
  /opus/i,
  /haiku/i,
];

// `model` (the default tier) accepts any Claude-family model; the other tiers
// must additionally match their own name.
const TIER_PATTERN: Record<ClaudeModelTier, RegExp | null> = {
  model: null,
  haiku: /haiku/i,
  sonnet: /sonnet/i,
  opus: /opus/i,
};

function getModelId(model: LlmModel): string | undefined {
  return model.deployment_name || model.base_name || model.label;
}

function getSearchText(model: LlmModel): string {
  return [model.deployment_name, model.base_name, model.label, model.provider]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Every id the catalog may expose an entry under. A gateway or router deployment is usually
 * addressed by its deployment name while the catalog also carries a base name and a display
 * label, so a configured id has to be matched against all three.
 */
function modelIdentifiers(model: LlmModel): string[] {
  return [model.deployment_name, model.base_name, model.label].filter(
    (value): value is string => Boolean(value)
  );
}

/**
 * Whether a deployment can serve an agent session at all: enabled, tool- and stream-capable,
 * and not an embedding/rerank/audio endpoint. Says nothing about model family on purpose —
 * `isClaudeCompatibleModel` layers the family check on top, and only for auto-selection.
 */
function isServableModel(model: LlmModel): boolean {
  if (!model.enabled) return false;
  if (model.features?.tools === false || model.features?.streaming === false) return false;
  return !CLAUDE_INCOMPATIBLE_MODEL_PATTERNS.some((pattern) => pattern.test(getSearchText(model)));
}

function isClaudeCompatibleModel(model: LlmModel, tier: ClaudeModelTier): boolean {
  if (!isServableModel(model)) return false;

  const searchText = getSearchText(model);
  if (!CLAUDE_FAMILY_PATTERNS.some((pattern) => pattern.test(searchText))) {
    return false;
  }

  const tierPattern = TIER_PATTERN[tier];
  return tierPattern ? tierPattern.test(searchText) : true;
}

function extractVersionParts(text: string): number[] {
  const lower = text.toLowerCase();
  const dateMatch = lower.match(/(20\d{2})[-.]?(\d{2})[-.]?(\d{2})/);
  // Skip an optional tier word between "claude" and the version digits —
  // real ids are shaped like claude-sonnet-4-6, claude-opus-4-7, not claude-4-6.
  const genMatch = lower.match(/claude(?:-(?:sonnet|opus|haiku))?[-_.]?(\d+)(?:[-_.](\d+))?/);

  return [
    genMatch?.[1] ? Number(genMatch[1]) : 0,
    genMatch?.[2] ? Number(genMatch[2]) : 0,
    dateMatch ? Number(dateMatch[1]) : 0,
    dateMatch ? Number(dateMatch[2]) : 0,
    dateMatch ? Number(dateMatch[3]) : 0,
  ];
}

function rankModel(model: LlmModel): RankedClaudeModel {
  const id = getModelId(model);
  if (!id) {
    throw new ConfigurationError('Cannot rank Claude model without a model identifier');
  }

  const searchText = getSearchText(model);
  const defaultBonus = model.default ? 1 : 0;

  return {
    id,
    score: [defaultBonus, ...extractVersionParts(searchText)],
  };
}

function compareRankedModels(a: RankedClaudeModel, b: RankedClaudeModel): number {
  const max = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < max; i++) {
    const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id.localeCompare(b.id);
}

// Module-level TTL cache: one live-catalog fetch serves all four tiers within a
// run and across a short window, so a normal CLI invocation doesn't pay a
// network round-trip per tier.
const CATALOG_TTL_MS = 5 * 60 * 1000;
let cachedCatalog: { key: string; fetchedAt: number; models: LlmModel[] } | null = null;

async function fetchCatalog(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;
  const codeMieUrl = env.CODEMIE_URL;
  const cacheKey = jwtToken && baseUrl ? `jwt:${baseUrl}` : `sso:${codeMieUrl ?? ''}`;

  if (
    cachedCatalog &&
    cachedCatalog.key === cacheKey &&
    Date.now() - cachedCatalog.fetchedAt < CATALOG_TTL_MS
  ) {
    return cachedCatalog.models;
  }

  let models: LlmModel[];
  if (jwtToken && baseUrl) {
    logger.debug('[claude-models] Fetching CodeMie model list via JWT auth');
    models = await fetchCodeMieLlmModels(baseUrl, jwtToken);
  } else if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      throw new ConfigurationError(
        `SSO credentials not found for ${codeMieUrl}. Run: codemie setup or codemie profile login --url ${codeMieUrl}`
      );
    }
    logger.debug('[claude-models] Fetching CodeMie model list via SSO auth');
    models = await fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  } else {
    models = [];
  }

  cachedCatalog = { key: cacheKey, fetchedAt: Date.now(), models };
  return models;
}

function isRouterCatalogEntry(model: LlmModel): boolean {
  return model.is_router === true || model.litellm_router?.is_router === true;
}

/**
 * Every id the live catalog addresses a router by — a Switchyard virtual router (`is_router` on
 * the catalog entry) or a declared LiteLLM auto-router (`litellm_router.is_router`) — rather than
 * a concrete deployment. Only a router can dispatch a turn to a different backend model than the
 * one it was addressed as, so membership in this list is the signal that gates the statusline's
 * "routed to" widget (see statusline.mjs's `resolveActualModel`): showing it for a non-router
 * model would misread ordinary provider aliasing (e.g. a Bedrock region snapshot) as routing.
 *
 * A full list rather than a single boolean for the session's starting model, because the
 * statusline must keep gating correctly after a mid-session `/model` switch — Claude Code's own
 * `/model` command changes the live model without re-running this process's `beforeRun` hook, so
 * whichever model id the statusline currently reports has to be checked against this list on
 * every render rather than against a value baked in once at session start.
 *
 * Returns `[]` — never throws — when the catalog cannot be fetched, the same conservative default
 * `resolveClaudeModel` uses: the widget should stay off rather than risk showing it on uncertainty.
 */
export async function listRouterModelIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const catalog = await fetchCatalog(env);
    const ids = new Set<string>();
    for (const model of catalog) {
      if (!isRouterCatalogEntry(model)) continue;
      for (const id of modelIdentifiers(model)) ids.add(id);
    }
    return [...ids];
  } catch (error) {
    logger.debug('[claude-models] Could not list router model ids', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Maps every id the live catalog addresses a model by (deployment name, base name, and label —
 * see {@link modelIdentifiers}) to that model's own `label`. Entries with no label are omitted:
 * there is nothing better to show than the id already displayed, so a lookup miss just means
 * "keep today's behavior" for the caller.
 *
 * Built for the statusline (see statusline.mjs's `parseModelLabels`/`resolveActualModel`), which
 * runs detached and cannot query the catalog itself. Claude Code's own `display_name` for an id
 * it does not recognize — a Switchyard router's custom `base_name`, for instance — is a best
 * guess derived from the id string and can be misleading (e.g. showing a capable-tier family
 * name for a router alias that only happens to embed it); the routed-to model id is even less
 * readable, being an id/base_name rather than a display label. The catalog's own `label` is the
 * one name CodeMie actually configured for the model, so it takes precedence over both wherever
 * a lookup succeeds.
 *
 * Returns `{}` — never throws — when the catalog cannot be fetched, so a lookup miss degrades to
 * exactly today's behavior (Claude Code's own display, or the raw routed-to id) rather than
 * blocking the statusline.
 */
export async function buildModelLabelMap(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  try {
    const catalog = await fetchCatalog(env);
    const labels: Record<string, string> = {};
    for (const model of catalog) {
      if (!model.label) continue;
      for (const id of modelIdentifiers(model)) {
        labels[id] = model.label;
      }
    }
    return labels;
  } catch (error) {
    logger.debug('[claude-models] Could not build model label map', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export interface ModelPickerOption {
  model: string;
  label: string;
  description?: string;
}

/**
 * Whether a catalog entry — plain model or router — resolves to a Claude-family backend, for
 * the model picker. Mirrors codex-models.ts's `isCodexCompatibleModel`: a LiteLLM auto-router's
 * own alias name is family-agnostic by convention (`claude-smart-router` and `gpt-smart-router`
 * are both named like routers, not like their target), so `counterfactual_model` — the concrete
 * deployment it currently resolves to — is the deterministic signal to judge it by when present.
 * A Switchyard virtual router carries no target-model field to check deterministically, so
 * CodeMie's own naming convention (base_name/label embedding the constituent families, e.g.
 * `sy-signal-claude-sonnet-haiku` vs `sy-signal-gpt-terra-luna`) is trusted instead — the same
 * name check already used for a plain model.
 */
function isClaudeFamilyPickerEntry(model: LlmModel): boolean {
  const counterfactual = model.litellm_router?.counterfactual_model;
  if (counterfactual) {
    return CLAUDE_FAMILY_PATTERNS.some((pattern) => pattern.test(counterfactual));
  }
  return CLAUDE_FAMILY_PATTERNS.some((pattern) => pattern.test(getSearchText(model)));
}

/**
 * Builds the option list for Claude Code's `modelPicker` settings key (v2.1.243+) from the live
 * CodeMie catalog: every enabled, servable model that resolves to a Claude-family backend —
 * a plain Claude-named deployment, or a router (Switchyard virtual router / LiteLLM auto-router
 * — see `isRouterCatalogEntry`) whose target is Claude-family (see `isClaudeFamilyPickerEntry`).
 * A router targeting a different family (e.g. a GPT auto-router) is excluded — Claude Code can't
 * drive it anyway, so listing it would just be catalog noise.
 *
 * Ranked with the same `rankModel`/`compareRankedModels` ordering already used for tier
 * auto-resolution, so the picker's top rows match what auto-resolution would have picked.
 *
 * Returns `[]` — never throws — when the catalog is unavailable; the caller must treat an
 * empty result as "leave the picker alone" rather than writing an empty lineup.
 */
export async function buildModelPickerOptions(env: NodeJS.ProcessEnv): Promise<ModelPickerOption[]> {
  try {
    const catalog = await fetchCatalog(env);
    const ranked = catalog
      .filter((model) => isServableModel(model) && isClaudeFamilyPickerEntry(model))
      .map((model) => {
        try {
          return { ranked: rankModel(model), model };
        } catch {
          // A malformed catalog entry (no usable id) must not abort the whole list.
          return null;
        }
      })
      .filter((entry): entry is { ranked: RankedClaudeModel; model: LlmModel } => entry !== null)
      .sort((a, b) => compareRankedModels(a.ranked, b.ranked));

    // Built from the FULL catalog, not just `ranked` — a router's classifier model can
    // belong to a family this picker otherwise filters out (a Claude classifier gating a
    // GPT-targeting router still needs its label resolved).
    const labelIndex = buildModelLabelIndex(catalog);

    const seen = new Set<string>();
    const options: ModelPickerOption[] = [];
    for (const { ranked: rankedModel, model } of ranked) {
      if (seen.has(rankedModel.id)) continue; // a model may rank under >1 identifier
      seen.add(rankedModel.id);
      const description = describeRouter(model, labelIndex) || undefined;
      options.push({ model: rankedModel.id, label: model.label || rankedModel.id, description });
    }
    return options;
  } catch (error) {
    logger.debug('[claude-models] Could not build model picker options', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Resolves the live CodeMie model id for a Claude tier, or `null` when the
 * currently configured model is still present in the live catalog (nothing to
 * change) — never overrides an explicit, still-valid choice.
 */
export async function resolveClaudeModel(
  env: NodeJS.ProcessEnv,
  tier: ClaudeModelTier,
): Promise<ClaudeModelResolution | null> {
  const currentModel = env[TIER_ENV_VAR[tier]] || undefined;

  // A model the user just chose is never stale. CODEMIE_MODEL_SOURCE (set by AgentCLI, and by
  // bin/codemie-copilot.js before it) marks a value that arrived from `--model` or the
  // environment rather than from a saved profile. Only the default `model` tier is reachable
  // that way, so haiku/sonnet/opus keep resolving against the live catalog as before.
  if (currentModel && tier === 'model' && EXPLICIT_MODEL_SOURCES.has(env.CODEMIE_MODEL_SOURCE ?? '')) {
    logger.debug(
      `[claude-models] Model "${currentModel}" was set explicitly (source: ${env.CODEMIE_MODEL_SOURCE}); skipping catalog resolution`
    );
    return null;
  }

  let catalog: LlmModel[];
  try {
    catalog = await fetchCatalog(env);
  } catch (error) {
    logger.debug(`[claude-models] Catalog fetch failed for tier "${tier}"; keeping configured model`, {
      error: error instanceof Error ? error.message : String(error),
    });
    if (currentModel) return null;

    // No live catalog and nothing currently configured — guessing a static
    // model id here would just be another hardcoded value that goes stale.
    // Fail clearly instead and tell the user how to set one explicitly.
    throw new ConfigurationError(
      `Could not resolve a CodeMie model for Claude tier "${tier}": the model catalog is unavailable and no model is configured. Run "codemie setup" or set the ${TIER_ENV_VAR[tier]} environment variable explicitly.`
    );
  }

  const ranked = catalog
    .filter((model) => isClaudeCompatibleModel(model, tier))
    .map((model) => {
      try {
        return rankModel(model);
      } catch {
        // A malformed catalog entry (no usable id) must not abort ranking for
        // every other otherwise-valid candidate in this tier.
        return null;
      }
    })
    .filter((entry): entry is RankedClaudeModel => entry !== null)
    .sort(compareRankedModels);
  const availableModels = ranked.map((entry) => entry.id);

  if (currentModel && availableModels.includes(currentModel)) {
    // Beyond the explicit CLI-flag override above, there's no signal that an
    // implicit (profile-sourced) value was deliberately chosen. So it's left
    // untouched as long as it's still in the catalog, even if a better-ranked
    // model now exists — it only gets re-resolved once fully retired.
    return null;
  }

  // CLAUDE_FAMILY_PATTERNS is a heuristic over the model id whose job is picking a sensible
  // Claude model automatically. It cannot see through a gateway or router alias whose id says
  // nothing about the family behind it (`gpt-smart-router`, an internal deployment name), so
  // using it to *validate* an already-configured id silently replaces working models. Check
  // the unfiltered catalog first: if the deployment is still there and can serve a session,
  // keep what is configured.
  //
  // Deliberately NOT narrowed to `tier === 'model'` the way the explicit-source skip above is.
  // A tier var legitimately holds an out-of-family id: pinning a router alias as the haiku tier
  // (`CODEMIE_HAIKU_MODEL=claude-smart-router`) matches CLAUDE_FAMILY_PATTERNS but not TIER_PATTERN
  // /haiku/i, so it is filtered out of `ranked` and reaches here. Re-resolving it would replace the
  // router with a literal haiku model and defeat the routing it was configured for. The cost is the
  // same tradeoff already accepted above for in-family ids: a stale or mis-tiered value survives
  // until it is fully retired from the catalog, rather than being silently swapped.
  if (
    currentModel &&
    catalog.some((model) => isServableModel(model) && modelIdentifiers(model).includes(currentModel))
  ) {
    logger.debug(
      `[claude-models] Model "${currentModel}" for tier "${tier}" is outside the Claude family but live in the catalog; keeping it`
    );
    return null;
  }

  if (ranked.length === 0) {
    if (currentModel) {
      logger.debug(`[claude-models] No compatible CodeMie models found for tier "${tier}"; keeping configured model`);
      return null;
    }
    throw new ConfigurationError(`No CodeMie model compatible with Claude tier "${tier}" is available.`);
  }

  if (currentModel) {
    logger.notice(`[claude-models] Model "${currentModel}" for tier "${tier}" is no longer available; switching to ${ranked[0].id}`);
  }

  return { selectedModel: ranked[0].id, availableModels };
}

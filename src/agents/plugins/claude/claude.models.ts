import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
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
    // Deliberate tradeoff: there is no generic "was this explicitly chosen by
    // the user" signal available for Claude (unlike Copilot's CODEMIE_MODEL_SOURCE,
    // which only bin/codemie-copilot.js populates and adding equivalent tracking
    // here would mean touching shared CLI/config code, out of scope for this
    // Claude-plugin-local change). So any currently configured value still
    // present in the catalog is left untouched, even if a newer/better-ranked
    // model now exists — a still-enabled-but-superseded model only gets
    // re-resolved once it is fully retired from the catalog. This favors never
    // silently swapping a model a user may have deliberately pinned over always
    // resolving to the single best-ranked entry.
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
    logger.info(`[claude-models] Model "${currentModel}" for tier "${tier}" is no longer available; switching to ${ranked[0].id}`);
  }

  return { selectedModel: ranked[0].id, availableModels };
}

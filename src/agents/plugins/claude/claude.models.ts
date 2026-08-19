import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { ClaudePluginMetadata } from './claude.plugin.js';

export type ClaudeModelTier = 'model' | 'haiku' | 'sonnet' | 'opus';

export interface ClaudeModelResolution {
  selectedModel: string;
  availableModels: string[];
}

interface RankedClaudeModel {
  id: string;
  score: number[];
}

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

function isClaudeCompatibleModel(model: LlmModel, tier: ClaudeModelTier): boolean {
  if (!model.enabled) return false;
  if (model.features?.tools === false || model.features?.streaming === false) return false;

  const searchText = getSearchText(model);
  if (CLAUDE_INCOMPATIBLE_MODEL_PATTERNS.some((pattern) => pattern.test(searchText))) {
    return false;
  }
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

function staticFallback(tier: ClaudeModelTier): string | undefined {
  const recommended = ClaudePluginMetadata.recommendedModels ?? [];
  const tierPattern = TIER_PATTERN[tier];
  if (!tierPattern) return recommended[0];
  return recommended.find((id) => tierPattern.test(id));
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

  let catalog: LlmModel[];
  try {
    catalog = await fetchCatalog(env);
  } catch (error) {
    logger.debug(`[claude-models] Catalog fetch failed for tier "${tier}"; keeping configured model`, {
      error: error instanceof Error ? error.message : String(error),
    });
    if (currentModel) return null;

    const fallback = staticFallback(tier);
    if (!fallback) {
      throw new ConfigurationError(
        `Could not resolve a CodeMie model for Claude tier "${tier}": catalog fetch failed and no static fallback is configured.`
      );
    }
    return { selectedModel: fallback, availableModels: [] };
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

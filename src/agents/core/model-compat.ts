/**
 * Harness/model compatibility helper (EPMCDME-15641).
 *
 * Reads the optional `AgentMetadata.classifyModel` hook through AgentRegistry so CLI code and
 * AgentCLI never import `agents/plugins/*` (CLI -> Registry -> Plugin).
 *
 * Plugins must import from `model-classify.ts` (a leaf), never from here: this module imports
 * AgentRegistry, which imports the plugins.
 */
import { AgentRegistry } from '../registry.js';
import type { ModelCompat } from './model-classify.js';

export { classifyWithPredicate } from './model-classify.js';
export type { ModelCompat, ModelClassifyContext } from './model-classify.js';

export interface ModelCompatOptions {
  /** Catalog router hint: a boolean, or a per-id lookup for multi-model helpers. */
  isRouter?: boolean | ((modelId: string) => boolean);
  /** Ids the user confirmed despite a name-rule mismatch (reported as `unverified`). */
  confirmedModels?: string[];
  /** Profile provider; outside the agent's non-empty `supportedProviders` means incompatible. */
  provider?: string;
}

function baseAgentName(agent: string): string {
  return agent.endsWith('-acp') ? agent.slice(0, -'-acp'.length) : agent;
}

function resolveAgent(agent: string) {
  return AgentRegistry.getAgent(baseAgentName(agent)) ?? AgentRegistry.getAgent(agent);
}

/** Offered agents without a `classifyModel` hook: any model is used as-is (provider limits aside). */
export function getModelRuleFreeAgents(): HarnessChoice[] {
  const withRules = new Set(getClassifierAgents());
  return getOfferedHarnesses().filter((h) => !withRules.has(h.name));
}

/** Base agent names (no `-acp`) that define a `classifyModel` hook. */
export function getClassifierAgents(): string[] {
  return AgentRegistry.getAllAgents()
    .filter((a) => typeof a.metadata.classifyModel === 'function' && !a.metadata.name.endsWith('-acp'))
    .map((a) => a.metadata.name);
}

export function classifyModelForAgent(agent: string, id: string, opts: ModelCompatOptions = {}): ModelCompat {
  const metadata = resolveAgent(agent)?.metadata;
  if (!metadata?.classifyModel) return 'compatible';

  const supported = metadata.supportedProviders;
  if (opts.provider && supported?.length && !supported.includes(opts.provider)) {
    return 'incompatible';
  }
  if (opts.confirmedModels?.includes(id)) return 'unverified';

  const isRouter = typeof opts.isRouter === 'function' ? opts.isRouter(id) : opts.isRouter;
  return metadata.classifyModel(id, { isRouter });
}

/** Harnesses (from the given list) on which `id` is not `incompatible`. */
export function compatibleHarnesses(harnesses: string[], id: string, opts: ModelCompatOptions = {}): string[] {
  return harnesses.filter((h) => classifyModelForAgent(h, id, opts) !== 'incompatible');
}

/** Coverage gate: every harness with no non-`incompatible` model among `models`. */
export function uncoveredHarnesses(
  harnesses: string[],
  models: string[],
  opts: ModelCompatOptions = {}
): string[] {
  return harnesses.filter(
    (h) => !models.some((m) => classifyModelForAgent(h, m, opts) !== 'incompatible')
  );
}

/** Coverage gate: first harness with no non-`incompatible` model among `models`, if any. */
export function uncoveredHarness(
  harnesses: string[],
  models: string[],
  opts: ModelCompatOptions = {}
): string | undefined {
  return uncoveredHarnesses(harnesses, models, opts)[0];
}

/**
 * Harnesses whose non-empty `supportedProviders` excludes `provider`, classifier or not.
 * No model id can ever make such a harness work on this provider.
 */
export function unsupportedProviderHarnesses(harnesses: string[], provider: string | undefined): string[] {
  if (!provider) return [];
  return harnesses.filter((h) => {
    const metadata = resolveAgent(h)?.metadata;
    const supported = metadata?.supportedProviders;
    return Boolean(supported?.length && !supported.includes(provider));
  });
}

/** First harness from {@link unsupportedProviderHarnesses}, if any. */
export function unsupportedProviderHarness(harnesses: string[], provider: string | undefined): string | undefined {
  return unsupportedProviderHarnesses(harnesses, provider)[0];
}

/**
 * Models accepted only because the catalog flags them as routers/aliases: `incompatible` for some
 * harness by name alone, not `incompatible` once the router hint is applied. Launch has no catalog,
 * so setup persists these ids in `confirmedModels` and launch then reports them `unverified`.
 */
export function routerAcceptedModels(
  harnesses: string[],
  models: string[],
  opts: Pick<ModelCompatOptions, 'provider' | 'isRouter'>
): string[] {
  const { isRouter, provider } = opts;
  if (!isRouter) return [];
  return models.filter((id) =>
    harnesses.some(
      (h) =>
        classifyModelForAgent(h, id, { provider }) === 'incompatible' &&
        classifyModelForAgent(h, id, { provider, isRouter }) !== 'incompatible'
    )
  );
}

export interface HarnessProfileInfo {
  harnesses?: string[];
  provider?: string;
  confirmedModels?: string[];
}

/**
 * Per-model list of the profile's harnesses each model works with, for display. Undefined for a
 * legacy profile (no `harnesses`), so callers render nothing and output stays unchanged.
 */
export function harnessAnnotations(
  profile: HarnessProfileInfo,
  ids: string[],
  isRouter?: (modelId: string) => boolean
): Record<string, string[]> | undefined {
  if (!profile.harnesses?.length) return undefined;
  const opts: ModelCompatOptions = {
    provider: profile.provider,
    confirmedModels: profile.confirmedModels,
    isRouter,
  };
  const result: Record<string, string[]> = {};
  for (const id of ids) {
    result[id] = compatibleHarnesses(profile.harnesses, id, opts);
  }
  return result;
}

export interface HarnessChoice {
  name: string;
  displayName: string;
}

// Agents a user actually runs with a profile, in display order. Anything else registered is
// appended, except ACP variants (folded into their base) and analytics-only agents.
const HARNESS_ORDER = ['claude', 'codex', 'gemini', 'kimi', 'copilot-cli', 'opencode', 'pi', 'codemie-code', 'openwiki'];

/** Agents offered by the setup harness step, derived from AgentRegistry metadata. */
export function getOfferedHarnesses(): HarnessChoice[] {
  const candidates = AgentRegistry.getAllAgents()
    .map((a) => a.metadata)
    .filter((m) => !m.name.endsWith('-acp') && !m.analyticsOnly);
  const rank = (name: string): number => {
    const i = HARNESS_ORDER.indexOf(name);
    return i === -1 ? HARNESS_ORDER.length : i;
  };
  return candidates
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((m) => ({ name: m.name, displayName: m.displayName }));
}

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

/** Coverage gate: first harness with no non-`incompatible` model among `models`, if any. */
export function uncoveredHarness(
  harnesses: string[],
  models: string[],
  opts: ModelCompatOptions = {}
): string | undefined {
  return harnesses.find(
    (h) => !models.some((m) => classifyModelForAgent(h, m, opts) !== 'incompatible')
  );
}

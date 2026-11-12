/**
 * Which model family a CodeMie catalog entry belongs to.
 *
 * Dependency-free on purpose: the omp extension bundles it (see
 * `src/cli/commands/proxy/connectors/omp/omp-models.ts`).
 */
import type { LlmModel, RouterTier } from '../providers/plugins/sso/sso.http-client.js';

/** The catalog entry fields {@link isClaudeFamilyModel} reads. */
export type ModelFamilyFields = Partial<Pick<
  LlmModel,
  'base_name' | 'deployment_name' | 'label' | 'provider' | 'is_router' | 'tiers' | 'litellm_router'
>>;

const CLAUDE_FAMILY_NAME = /claude|anthropic|sonnet|opus|haiku/i;

/** Whether a catalog entry is a router: a Switchyard virtual router or a declared LiteLLM auto-router. */
export function isRouterModel(model: Pick<ModelFamilyFields, 'is_router' | 'litellm_router'>): boolean {
  return model.is_router === true || model.litellm_router?.is_router === true;
}

/** Whether a model name or id names a Claude-family model. */
export function isClaudeFamilyName(name: string): boolean {
  return CLAUDE_FAMILY_NAME.test(name);
}

/** Distinct tier target ids of a Switchyard or LiteLLM router; `[]` for a plain model. */
export function routerTierTargets(model: Pick<ModelFamilyFields, 'tiers' | 'litellm_router'>): string[] {
  const tiers = model.tiers ?? model.litellm_router?.tiers;
  if (!tiers) return [];
  const ids = (Object.values(tiers) as (RouterTier | undefined)[])
    .map((tier) => tier?.model)
    .filter((target): target is string => Boolean(target));
  return [...new Set(ids)];
}

/**
 * Whether a catalog entry — plain model or router — runs on Claude: the one answer every
 * Claude client shares (Claude Code, Copilot CLI, Claude Desktop, omp's Anthropic roster).
 *
 * A router is judged by what it routes to, not by its alias, which is family-agnostic by
 * convention (`claude-smart-router`, `sy-signal-v2`): Claude-family only when every tier
 * target is. Without tiers, a LiteLLM auto-router's `counterfactual_model` (the deployment it
 * resolves to by default) decides. A plain model, or a router with neither, is judged by its
 * names and provider.
 */
export function isClaudeFamilyModel(model: ModelFamilyFields): boolean {
  if (isRouterModel(model)) {
    const targets = routerTierTargets(model);
    if (targets.length > 0) return targets.every(isClaudeFamilyName);
    const counterfactual = model.litellm_router?.counterfactual_model;
    if (counterfactual) return isClaudeFamilyName(counterfactual);
  }
  return isClaudeFamilyName(
    [model.deployment_name, model.base_name, model.label, model.provider].filter(Boolean).join(' ')
  );
}

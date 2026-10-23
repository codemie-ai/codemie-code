/**
 * Pure row builders for the per-agent model setup wizard: which agents and models each screen
 * offers, and how one agent's draft becomes its saved model set.
 */

import chalk from 'chalk';
import type { AgentModelSet } from '@/env/types.js';
import {
  classifyModelForAgent,
  getAgentDisplayName,
  getClassifierAgents,
  getModelRuleFreeAgents,
  getOfferedHarnesses,
  isActiveModelOnly,
  routerAcceptedModels,
  uncoveredHarnesses,
  unsupportedProviderHarnesses,
} from '@/agents/core/model-compat.js';
import { getAllModelChoices } from '@/providers/integration/setup-ui.js';
import type { AgentDraft, AgentModelsWizardInput, ListRow } from './types.js';
import { SEARCH_ROW_ID, WIZARD_TEXT } from './constants.js';

const unverifiedTag = (): string => chalk.dim(` · ${WIZARD_TEXT.UNVERIFIED_TAG}`);

/** Offered agents; those the provider cannot serve are disabled with the reason. */
export function buildAgentRows(input: AgentModelsWizardInput): ListRow[] {
  const offered = getOfferedHarnesses();
  const names = offered.map(agent => agent.name);
  const unsupported = unsupportedProviderHarnesses(names, input.provider);
  // Without a catalog only an unsupported provider is known to be a dead end.
  const noModel = input.models.length > 0
    ? uncoveredHarnesses(names, input.models, { provider: input.provider, isRouter: input.isRouter })
    : [];

  return offered.map(agent => ({
    id: agent.name,
    label: agent.displayName,
    disabled: unsupported.includes(agent.name)
      ? WIZARD_TEXT.NOT_SUPPORTED(input.provider)
      : noModel.includes(agent.name)
        ? WIZARD_TEXT.NO_COMPATIBLE_MODEL(input.provider)
        : undefined,
  }));
}

/** Note naming the offered agents that have no model rules, or undefined when there are none. */
export function ruleFreeAgentsNote(): string | undefined {
  const ruleFree = getModelRuleFreeAgents();
  return ruleFree.length > 0
    ? WIZARD_TEXT.RULE_FREE_AGENTS(ruleFree.map(agent => agent.displayName).join(', '))
    : undefined;
}

/** True when the agent defines model-name rules (a `classifyModel` hook). */
export function hasModelRules(agent: string): boolean {
  return getClassifierAgents().includes(agent);
}

/**
 * The agent's model rows: catalog ids plus ids typed for it, keeping only those the agent can use
 * (rule-free agents keep all). Recommended ids come first; unverified ids are tagged. A provider
 * with a model search gets a trailing action row.
 */
export function buildModelRows(agent: string, input: AgentModelsWizardInput, draft: AgentDraft): ListRow[] {
  const opts = { provider: input.provider, isRouter: input.isRouter, confirmedModels: [...draft.confirmed] };
  const ids = [...input.models, ...draft.extra.filter(id => !input.models.includes(id))];
  const usable = ids.filter(id => classifyModelForAgent(agent, id, opts) !== 'incompatible');

  const rows: ListRow[] = getAllModelChoices(usable, input.providerTemplate, input.recommendedIds).map(choice => ({
    id: choice.value,
    label: choice.name + (classifyModelForAgent(agent, choice.value, opts) === 'unverified' ? unverifiedTag() : ''),
    disabled: typeof choice.disabled === 'string' ? choice.disabled : choice.disabled ? 'unavailable' : undefined,
  }));

  if (input.searchModel) {
    rows.push({ id: SEARCH_ROW_ID, label: WIZARD_TEXT.SEARCH_ROW, kind: 'action' });
  }
  return rows;
}

/**
 * Row offered for a typed model name. A name the agent's rules reject can still be used: it is
 * saved as unverified (in the agent's `confirmedModels`).
 */
export function buildCustomRow(agent: string, input: AgentModelsWizardInput, query: string): ListRow | undefined {
  const id = query.trim();
  if (!id) return undefined;

  const compat = classifyModelForAgent(agent, id, { provider: input.provider });
  return {
    id,
    label: chalk.cyan(WIZARD_TEXT.USE_CUSTOM(id)),
    detail: compat === 'incompatible' ? WIZARD_TEXT.USE_CUSTOM_UNVERIFIED(getAgentDisplayName(agent)) : undefined,
    addAs: { id, label: id + (compat === 'compatible' ? '' : unverifiedTag()) },
  };
}

/** Records ids added on the models screen (typed or searched) in the agent's draft. */
export function addExtraModels(agent: string, input: AgentModelsWizardInput, draft: AgentDraft, ids: string[]): void {
  for (const id of ids) {
    if (!draft.extra.includes(id) && !input.models.includes(id)) draft.extra.push(id);
    if (classifyModelForAgent(agent, id, { provider: input.provider }) === 'incompatible') {
      draft.confirmed.add(id);
    }
  }
}

/** Single-choice rows for the agent's active model: its own picked models. */
export function buildActiveRows(agent: string, input: AgentModelsWizardInput, draft: AgentDraft): ListRow[] {
  const opts = { provider: input.provider, isRouter: input.isRouter, confirmedModels: [...draft.confirmed] };
  return draft.models
    .filter(id => classifyModelForAgent(agent, id, opts) !== 'incompatible')
    .map(id => ({
      id,
      label: id + (classifyModelForAgent(agent, id, opts) === 'unverified' ? unverifiedTag() : ''),
    }));
}

/**
 * Initial draft: the existing per-agent set, or the legacy active model when this agent can use it.
 * Saved models are reused only when the profile keeps its provider: another provider's ids would
 * otherwise come back as typed models, even with an empty catalog.
 */
export function createDraft(agent: string, input: AgentModelsWizardInput): AgentDraft {
  const sameProvider = input.existing?.provider === input.provider;
  if (!sameProvider) {
    return { models: [], extra: [], confirmed: new Set() };
  }

  const existing = input.existing?.agentModels?.[agent];
  if (existing) {
    // An agent that always runs on its active model keeps only that model.
    const models = isActiveModelOnly(agent) && existing.models.includes(existing.model)
      ? [existing.model]
      : [...existing.models];
    return {
      models,
      model: existing.model,
      extra: models.filter(id => !input.models.includes(id)),
      confirmed: new Set((existing.confirmedModels ?? []).filter(id => models.includes(id))),
    };
  }

  const legacy = input.existing?.model;
  const usable = legacy && input.models.includes(legacy)
    && classifyModelForAgent(agent, legacy, { provider: input.provider, isRouter: input.isRouter }) !== 'incompatible';
  return { models: usable ? [legacy] : [], model: usable ? legacy : undefined, extra: [], confirmed: new Set() };
}

/**
 * The saved set for one agent. Catalog routers the name rule alone would reject are recorded as
 * confirmed: launch has no catalog and would otherwise call them incompatible.
 */
export function finalizeDraft(agent: string, input: AgentModelsWizardInput, draft: AgentDraft): AgentModelSet {
  const models = [...draft.models];
  const model = draft.model && models.includes(draft.model) ? draft.model : models[0];
  const routerAccepted = routerAcceptedModels([agent], models, { provider: input.provider, isRouter: input.isRouter });
  const confirmed = [...new Set([...draft.confirmed, ...routerAccepted])].filter(id => models.includes(id));
  return confirmed.length > 0 ? { models, model, confirmedModels: confirmed } : { models, model };
}

/** Review lines: one per agent, its active model first. */
export function buildReviewLines(agents: string[], drafts: Map<string, AgentDraft>): string[] {
  const names = agents.map(agent => getAgentDisplayName(agent));
  const width = Math.max(0, ...names.map(name => name.length)) + 2;
  return agents.map((agent, index) => {
    const draft = drafts.get(agent);
    const models = draft?.models ?? [];
    const active = draft?.model && models.includes(draft.model) ? draft.model : models[0];
    const others = models.filter(id => id !== active);
    return chalk.white(names[index].padEnd(width)) +
      [chalk.green(`${active} ${WIZARD_TEXT.ACTIVE_TAG}`), ...others].join(chalk.dim(', '));
  });
}

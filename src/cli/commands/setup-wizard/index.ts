/**
 * Per-agent model setup wizard (EPMCDME-15641).
 *
 * Flow: select agents → for each agent: select its models (only those it supports), then its
 * active model → review. An agent with no in-session model menu (`activeModelOnly`) gets one
 * screen instead: its active model, which is also its only model. Full-screen raw-mode screens in the style of `codemie setup assistants`;
 * Esc steps back one screen, Ctrl+C (or Cancel) leaves without saving.
 */

import { getAgentDisplayName, getOfferedHarnesses, isActiveModelOnly } from '@/agents/core/model-compat.js';
import type { AgentDraft, AgentModelsResult, AgentModelsWizardInput, ListScreenResult, ListScreenSpec } from './types.js';
import { runListScreen } from './list-screen.js';
import { SEARCH_ROW_ID, WIZARD_TEXT } from './constants.js';
import {
  addExtraModels,
  buildActiveRows,
  buildAgentRows,
  buildCustomRow,
  buildModelRows,
  buildReviewLines,
  createDraft,
  finalizeDraft,
  hasModelRules,
  ruleFreeAgentsNote,
} from './rows.js';

export type { AgentModelsResult, AgentModelsWizardInput } from './types.js';

type WizardStep =
  | { kind: 'agents' }
  | { kind: 'models'; agent: string }
  | { kind: 'active'; agent: string }
  /** Active model of an `activeModelOnly` agent: picked straight from the catalog. */
  | { kind: 'single'; agent: string }
  | { kind: 'review' };

/** Shows one screen; injectable so the flow can be tested without a TTY. */
export type ScreenRunner = (spec: ListScreenSpec) => Promise<ListScreenResult>;

function buildSteps(agents: string[]): WizardStep[] {
  return [
    { kind: 'agents' },
    ...agents.flatMap((agent): WizardStep[] => isActiveModelOnly(agent)
      ? [{ kind: 'single', agent }]
      : [{ kind: 'models', agent }, { kind: 'active', agent }]),
    { kind: 'review' },
  ];
}

/** An active-model step with fewer than two models has nothing to choose and is skipped. */
function isSkipped(step: WizardStep, drafts: Map<string, AgentDraft>): boolean {
  return step.kind === 'active' && (drafts.get(step.agent)?.models.length ?? 0) < 2;
}

/**
 * Runs the wizard. Resolves to the chosen models per agent (in offered order), or null when the
 * user cancels or steps back out of the first screen.
 */
export async function runAgentModelsWizard(
  input: AgentModelsWizardInput,
  screen: ScreenRunner = runListScreen
): Promise<AgentModelsResult | null> {
  const offeredOrder = getOfferedHarnesses().map(agent => agent.name);
  const agentRows = buildAgentRows(input);
  const selectable = new Set(agentRows.filter(row => !row.disabled).map(row => row.id));

  let agents = Object.keys(input.existing?.agentModels ?? {}).filter(agent => selectable.has(agent));
  const drafts = new Map<string, AgentDraft>();
  const draftFor = (agent: string): AgentDraft => {
    let draft = drafts.get(agent);
    if (!draft) {
      draft = createDraft(agent, input);
      drafts.set(agent, draft);
    }
    return draft;
  };

  let index = 0;
  for (;;) {
    const steps = buildSteps(agents);
    const step = steps[index];
    const stages = [WIZARD_TEXT.STAGE_AGENTS, ...agents.map(getAgentDisplayName), WIZARD_TEXT.STAGE_REVIEW];
    const stageIndex = step.kind === 'agents' ? 0
      : step.kind === 'review' ? stages.length - 1
        : agents.indexOf(step.agent) + 1;

    const result = await screen(specFor(step, { input, agents, agentRows, draftFor, drafts, stages, stageIndex }));

    if (result.action === 'cancel') return null;

    if (result.action === 'back') {
      do {
        index -= 1;
      } while (index > 0 && isSkipped(steps[index], drafts));
      if (index < 0) return null;
      continue;
    }

    if (step.kind === 'agents') {
      agents = offeredOrder.filter(agent => result.selected.includes(agent));
      agents.forEach(draftFor);
    } else if (step.kind === 'models') {
      const draft = draftFor(step.agent);
      addExtraModels(step.agent, input, draft, result.added);
      // Keep the list in row order (recommended first), not in the order the user checked it.
      const rowOrder = buildModelRows(step.agent, input, draft).map(row => row.id);
      const rank = (id: string): number => (rowOrder.includes(id) ? rowOrder.indexOf(id) : rowOrder.length);
      draft.models = [...result.selected].sort((a, b) => rank(a) - rank(b));

      if (result.action === 'row' && result.id === SEARCH_ROW_ID) {
        const found = await input.searchModel?.();
        if (found) {
          addExtraModels(step.agent, input, draft, [found]);
          if (!draft.models.includes(found)) draft.models = [...draft.models, found];
        }
        continue;
      }
      if (draft.model && !draft.models.includes(draft.model)) draft.model = undefined;
      if (draft.models.length === 1) draft.model = draft.models[0];
    } else if (step.kind === 'active') {
      draftFor(step.agent).model = result.selected[0];
    } else if (step.kind === 'single') {
      const draft = draftFor(step.agent);
      addExtraModels(step.agent, input, draft, result.added);
      let chosen = result.selected[0];
      if (result.action === 'row' && result.id === SEARCH_ROW_ID) {
        const found = await input.searchModel?.();
        if (found) addExtraModels(step.agent, input, draft, [found]);
        chosen = found ?? chosen;
      }
      draft.models = chosen ? [chosen] : [];
      draft.model = chosen;
      if (result.action === 'row') continue;
    } else {
      return Object.fromEntries(agents.map(agent => [agent, finalizeDraft(agent, input, draftFor(agent))]));
    }

    const nextSteps = buildSteps(agents);
    do {
      index += 1;
    } while (index < nextSteps.length - 1 && isSkipped(nextSteps[index], drafts));
  }
}

interface SpecContext {
  input: AgentModelsWizardInput;
  agents: string[];
  agentRows: ReturnType<typeof buildAgentRows>;
  draftFor: (agent: string) => AgentDraft;
  drafts: Map<string, AgentDraft>;
  stages: string[];
  stageIndex: number;
}

function specFor(step: WizardStep, ctx: SpecContext): ListScreenSpec {
  const { input, agents, stages, stageIndex } = ctx;

  if (step.kind === 'agents') {
    const ruleFree = ruleFreeAgentsNote();
    return {
      stages,
      stageIndex,
      title: WIZARD_TEXT.AGENTS_TITLE,
      notes: [WIZARD_TEXT.AGENTS_NOTE, ...(ruleFree ? [ruleFree] : [])],
      mode: 'multi',
      rows: ctx.agentRows,
      selected: agents,
      validate: selected => (selected.length > 0 ? undefined : WIZARD_TEXT.AGENTS_REQUIRED),
      status: selected => WIZARD_TEXT.SELECTED_COUNT(selected.length),
    };
  }

  if (step.kind === 'models') {
    const name = getAgentDisplayName(step.agent);
    const draft = ctx.draftFor(step.agent);
    return {
      stages,
      stageIndex,
      title: WIZARD_TEXT.MODELS_TITLE(name),
      notes: [
        hasModelRules(step.agent) ? WIZARD_TEXT.MODELS_NOTE(name) : WIZARD_TEXT.MODELS_RULE_FREE_NOTE(name),
        ...(input.models.length === 0 ? [WIZARD_TEXT.MODELS_EMPTY_CATALOG_NOTE] : []),
      ],
      mode: 'multi',
      rows: buildModelRows(step.agent, input, draft),
      selected: draft.models,
      searchable: true,
      customRow: query => buildCustomRow(step.agent, input, query),
      validate: selected => (selected.length > 0 ? undefined : WIZARD_TEXT.MODELS_REQUIRED(name)),
      status: selected => WIZARD_TEXT.SELECTED_COUNT(selected.length),
    };
  }

  if (step.kind === 'single') {
    const name = getAgentDisplayName(step.agent);
    const draft = ctx.draftFor(step.agent);
    return {
      stages,
      stageIndex,
      title: WIZARD_TEXT.ACTIVE_TITLE(name),
      notes: [
        WIZARD_TEXT.ACTIVE_ONLY_NOTE(step.agent, name),
        ...(input.models.length === 0 ? [WIZARD_TEXT.MODELS_EMPTY_CATALOG_NOTE] : []),
      ],
      mode: 'single',
      rows: buildModelRows(step.agent, input, draft),
      selected: draft.model ? [draft.model] : [],
      searchable: true,
      customRow: query => buildCustomRow(step.agent, input, query),
      validate: selected => (selected.length > 0 ? undefined : WIZARD_TEXT.ACTIVE_REQUIRED(name)),
    };
  }

  if (step.kind === 'active') {
    const name = getAgentDisplayName(step.agent);
    const draft = ctx.draftFor(step.agent);
    return {
      stages,
      stageIndex,
      title: WIZARD_TEXT.ACTIVE_TITLE(name),
      notes: [WIZARD_TEXT.ACTIVE_NOTE(name)],
      mode: 'single',
      rows: buildActiveRows(step.agent, input, draft),
      selected: [draft.model ?? draft.models[0]],
    };
  }

  return {
    stages,
    stageIndex,
    title: WIZARD_TEXT.REVIEW_TITLE,
    notes: [WIZARD_TEXT.REVIEW_NOTE],
    body: buildReviewLines(agents, ctx.drafts),
    mode: 'single',
    rows: [],
    selected: [],
    continueLabel: WIZARD_TEXT.SAVE_BUTTON,
  };
}

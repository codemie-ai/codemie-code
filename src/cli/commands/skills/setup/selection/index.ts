import type { CodeMieClient } from 'codemie-sdk';
import type { CodemieSkill } from '@/env/types.js';
import type { SelectionState } from './types.js';
import { PANEL_ID, ANSI } from './constants.js';
import { ACTION_TYPE, type ActionType } from '../constants.js';
import { createSkillDataFetcher } from '../data.js';
import { createInteractivePrompt, type InteractivePrompt } from './interactive-prompt.js';
import { createActionHandlers } from './actions.js';
import { renderUI } from './ui.js';
import { logger } from '@/utils/logger.js';
import ora from 'ora';

export interface SelectionOptions {
  registeredIds: Set<string>;
  registeredSkills: CodemieSkill[];
  client: CodeMieClient;
}

const DEFAULT_PANEL_PARAMS = {
  isActive: false,
  data: null,
  filteredData: [],
  isFetching: false,
  error: null,
  currentPage: 0,
  totalItems: 0,
  totalPages: 0,
};

function initializeState(registeredSkills: CodemieSkill[]): SelectionState {
  const registeredIds = new Set(registeredSkills.map(s => s.id));
  const hasRegisteredSkills = registeredIds.size > 0;
  const defaultPanelId = hasRegisteredSkills
    ? PANEL_ID.REGISTERED
    : PANEL_ID.PROJECT;

  return {
    panels: [
      {
        id: PANEL_ID.REGISTERED,
        label: 'Registered',
        ...DEFAULT_PANEL_PARAMS,
        isActive: defaultPanelId === PANEL_ID.REGISTERED,
      },
      {
        id: PANEL_ID.PROJECT,
        label: 'Project',
        ...DEFAULT_PANEL_PARAMS,
        isActive: defaultPanelId === PANEL_ID.PROJECT,
      },
      {
        id: PANEL_ID.MARKETPLACE,
        label: 'Marketplace',
        ...DEFAULT_PANEL_PARAMS,
      },
    ],
    activePanelId: defaultPanelId,
    searchQuery: '',
    selectedIds: new Set(registeredIds),
    registeredIds: registeredIds,
    registeredSkills: registeredSkills,
    isSearchFocused: false,
    isPaginationFocused: null,
    areNavigationButtonsFocused: false,
    focusedButton: 'continue',
  };
}

export async function promptSkillSelection(
  registeredSkills: CodemieSkill[],
  client: CodeMieClient
): Promise<{ selectedIds: string[]; action: ActionType }> {
  const state = initializeState(registeredSkills);
  const fetcher = createSkillDataFetcher({ client, registeredSkills });

  let prompt: InteractivePrompt | null = null;
  let isCancelled = false;

  const actionHandlers = createActionHandlers({
    state,
    fetchItems: (params) => fetcher.fetchSkills(params),
    entityLabel: 'Skill',
    prompt: () => prompt,
    setPrompt: (p) => { prompt = p; },
    setCancelled: (cancelled) => { isCancelled = cancelled; },
  });

  const spinner = ora('Loading skills...').start();
  const activePanel = state.panels.find(p => p.id === state.activePanelId);
  if (!activePanel) {
    spinner.fail('Failed to initialize panel');
    return { selectedIds: [], action: ACTION_TYPE.CANCEL };
  }
  try {
    const result = await fetcher.fetchSkills({
      scope: state.activePanelId,
      searchQuery: state.searchQuery,
      page: 0,
    });
    activePanel.data = result.data;
    activePanel.filteredData = result.data;
    activePanel.totalItems = result.total;
    activePanel.totalPages = result.pages;
    spinner.succeed('Skills loaded');
  } catch (error) {
    spinner.fail('Failed to load skills');
    activePanel.error = error instanceof Error ? error.message : 'Unknown error';
    activePanel.totalItems = 0;
    activePanel.totalPages = 0;
  }

  process.stdout.write(ANSI.CLEAR_LINE_ABOVE);

  prompt = createInteractivePrompt({
    state,
    actions: actionHandlers,
    renderFn: (s, cursor) => renderUI(s as SelectionState, cursor),
  });

  await prompt.start();

  if (isCancelled) {
    logger.debug('[SkillSelection] Selection cancelled');
    return { selectedIds: [], action: ACTION_TYPE.CANCEL };
  }

  const selectedIdsArray = Array.from(state.selectedIds);
  logger.debug('[SkillSelection] Returning selection', {
    totalSelected: selectedIdsArray.length,
    selectedIds: selectedIdsArray,
    registeredCount: state.registeredIds.size,
    registeredIds: Array.from(state.registeredIds),
  });

  return { selectedIds: selectedIdsArray, action: ACTION_TYPE.UPDATE };
}

/**
 * Selection UI Module
 *
 * Main orchestration for assistant selection with panel interface
 */

import type { CodeMieClient } from 'codemie-sdk';
import { ACTIONS } from '@/cli/commands/assistants/constants.js';

type ActionType = typeof ACTIONS.UPDATE | typeof ACTIONS.CANCEL;
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';
import type { SelectionState } from './types.js';
import { PANEL_ID, ANSI } from './constants.js';
import { createDataFetcher } from '../data.js';
import { createInteractivePrompt, type InteractivePrompt } from './interactive-prompt.js';
import { createActionHandlers } from './actions.js';
import { logger } from '@/utils/logger.js';
import ora from 'ora';

export interface SelectionOptions {
  registeredIds: Set<string>;
  config: ProviderProfile;
  options: SetupCommandOptions;
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
}
/**
 * Initialize state with 3 panels (Registered, Project, Marketplace)
 * Smart default: Project tab if no registered assistants exist
 */
function initializeState(registeredIds: Set<string>): SelectionState {
  const hasRegisteredAssistants = registeredIds.size > 0;
  const defaultPanelId = hasRegisteredAssistants
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
        ...DEFAULT_PANEL_PARAMS
      }
    ],
    activePanelId: defaultPanelId,
    searchQuery: '',
    selectedIds: new Set(registeredIds),
    registeredIds: registeredIds,
    isSearchFocused: false,
    isPaginationFocused: null,
    areNavigationButtonsFocused: false,
    focusedButton: 'continue'
  };
}

/**
 * Prompt user to select assistants with panel interface
 */
export async function promptAssistantSelection(
  registeredIds: Set<string>,
  config: ProviderProfile,
  options: SetupCommandOptions,
  client: CodeMieClient
): Promise<{ selectedIds: string[]; action: ActionType }> {
  const state = initializeState(registeredIds);
  const fetcher = createDataFetcher({
    config,
    client,
    options
  });

  let prompt: InteractivePrompt | null = null;
  let isCancelled = false;

  const actionHandlers = createActionHandlers({
    state,
    fetcher,
    prompt: () => prompt,
    setPrompt: (p) => { prompt = p; },
    setCancelled: (cancelled) => { isCancelled = cancelled; }
  });

  const spinner = ora('Loading assistants...').start();
  const activePanel = state.panels.find(p => p.id === state.activePanelId)!;
  try {
    const result = await fetcher.fetchAssistants({
      scope: state.activePanelId,
      searchQuery: state.searchQuery,
      page: 0
    });
    activePanel.data = result.data;
    activePanel.filteredData = result.data;
    activePanel.totalItems = result.total;
    activePanel.totalPages = result.pages;
    spinner.succeed('Assistants loaded');
  } catch (error) {
    spinner.fail('Failed to load assistants');
    activePanel.error = error instanceof Error ? error.message : 'Unknown error';
    activePanel.totalItems = 0;
    activePanel.totalPages = 0;
  }

  // Clear spinner output before starting interactive mode
  process.stdout.write(ANSI.CLEAR_LINE_ABOVE);

  prompt = createInteractivePrompt({
    state,
    actions: actionHandlers
  });

  await prompt.start();

  if (isCancelled) {
    logger.debug('[AssistantSelection] Selection cancelled');
    return {
      selectedIds: [],
      action: ACTIONS.CANCEL
    };
  }

  const selectedIdsArray = Array.from(state.selectedIds);
  logger.debug('[AssistantSelection] Returning selection', {
    totalSelected: selectedIdsArray.length,
    selectedIds: selectedIdsArray,
    registeredCount: state.registeredIds.size,
    registeredIds: Array.from(state.registeredIds)
  });

  return {
    selectedIds: selectedIdsArray,
    action: ACTIONS.UPDATE
  };
}

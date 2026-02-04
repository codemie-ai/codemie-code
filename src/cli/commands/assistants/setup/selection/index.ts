/**
 * Selection UI Module
 *
 * Main orchestration for assistant selection with panel interface
 */

import type { CodeMieClient } from 'codemie-sdk';
import type { ActionType } from '@/cli/commands/assistants/constants.js';
import { ACTIONS } from '@/cli/commands/assistants/constants.js';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';
import type { SelectionState } from './types.js';
import { PANEL_ID } from './constants.js';
import { createDataFetcher } from './data.js';
import { createInteractivePrompt, type InteractivePrompt } from './interactive-prompt.js';
import { createActionHandlers } from './actions.js';

export interface SelectionOptions {
  registeredIds: Set<string>;
  config: ProviderProfile;
  options: SetupCommandOptions;
  client: CodeMieClient;
}

/**
 * Initialize state with 3 panels (Registered, Project, Marketplace)
 */
function initializeState(registeredIds: Set<string>): SelectionState {
  return {
    panels: [
      {
        id: PANEL_ID.REGISTERED,
        label: 'Registered',
        isActive: true,
        data: null,
        filteredData: [],
        isFetching: false,
        error: null
      },
      {
        id: PANEL_ID.PROJECT,
        label: 'Project Assistants',
        isActive: false,
        data: null,
        filteredData: [],
        isFetching: false,
        error: null
      },
      {
        id: PANEL_ID.MARKETPLACE,
        label: 'Marketplace',
        isActive: false,
        data: null,
        filteredData: [],
        isFetching: false,
        error: null
      }
    ],
    activePanelId: PANEL_ID.REGISTERED,
    searchQuery: '',
    selectedIds: new Set(registeredIds),
    registeredIds: registeredIds,
    isSearchFocused: false
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

  // Create action handlers
  const actionHandlers = createActionHandlers({
    state,
    fetcher,
    prompt: () => prompt,
    setPrompt: (p) => { prompt = p; },
    setCancelled: (cancelled) => { isCancelled = cancelled; }
  });

  // Fetch initial data for registered panel
  const registeredPanel = state.panels.find(p => p.id === PANEL_ID.REGISTERED)!;
  registeredPanel.data = await fetcher.fetchAssistants({
    scope: PANEL_ID.REGISTERED,
    searchQuery: state.searchQuery,
    page: 1
  });
  registeredPanel.filteredData = registeredPanel.data;

  // Create interactive prompt
  prompt = createInteractivePrompt({
    state,
    actions: actionHandlers
  });

  // Start interactive prompt and wait for completion
  await prompt.start();

  // Return result
  if (isCancelled) {
    return {
      selectedIds: [],
      action: ACTIONS.CANCEL
    };
  }

  return {
    selectedIds: Array.from(state.selectedIds),
    action: ACTIONS.UPDATE
  };
}

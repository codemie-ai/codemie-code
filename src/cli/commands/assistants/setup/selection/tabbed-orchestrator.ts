import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { ActionType } from '@/cli/commands/assistants/constants.js';
import { ACTIONS } from '@/cli/commands/assistants/constants.js';
import type {
  OrchestratorOptions,
  SelectionState,
  TabId
} from './tab-types.js';
import { createDataFetcher } from './data-fetcher.js';
import { filterAssistants } from './search-filter.js';
import { createInteractivePrompt, type InteractivePrompt } from './interactive-prompt.js';

export function createTabbedSelectionOrchestrator(options: OrchestratorOptions) {
  // Private state (closure variables)
  const state = initializeState();
  const fetcher = createDataFetcher({
    config: options.config,
    client: options.client,
    options: options.options
  });
  let prompt: InteractivePrompt | null = null;
  let isCancelled = false;

  /**
   * Initialize state with 3 tabs (Registered, Project, Marketplace)
   */
  function initializeState(): SelectionState {
    return {
      tabs: [
        {
          id: 'registered',
          label: 'Registered',
          isActive: true,
          data: null, // Will fetch on first render
          filteredData: [],
          isFetching: false,
          error: null
        },
        {
          id: 'project',
          label: 'Project Assistants',
          isActive: false,
          data: null,
          filteredData: [],
          isFetching: false,
          error: null
        },
        {
          id: 'marketplace',
          label: 'Marketplace',
          isActive: false,
          data: null,
          filteredData: [],
          isFetching: false,
          error: null
        }
      ],
      activeTabId: 'registered',
      searchQuery: '',
      selectedIds: new Set(options.registeredIds), // Pre-select registered assistants
      registeredIds: options.registeredIds
    };
  }

  /**
   * Main interaction loop with interactive prompt
   */
  async function run(): Promise<{ selectedIds: string[]; action: ActionType }> {
    // Fetch registered tab data immediately (instant - no API call)
    // This ensures registered assistants show up on first render
    const registeredTab = state.tabs.find(t => t.id === 'registered')!;
    registeredTab.data = await fetcher.fetchRegistered(state.registeredIds);
    registeredTab.filteredData = registeredTab.data;
    applySearchFilter();

    // Create interactive prompt
    prompt = createInteractivePrompt({
      state,
      onTabSwitch: () => handleTabSwitchSync(),
      onSearchUpdate: (query: string) => handleSearchUpdate(query),
      onCursorMove: (direction: 'up' | 'down') => handleCursorMove(direction),
      onToggleSelection: () => handleToggleSelection(),
      onConfirm: () => handleConfirm(),
      onCancel: () => handleCancel()
    });

    // Start interactive prompt
    const promptPromise = prompt.start();

    // Wait for prompt to finish
    await promptPromise;

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

  /**
   * Handle tab switch (Tab key)
   * SYNCHRONOUS - no blocking, no await
   */
  function handleTabSwitchSync(): void {
    const tabIds: TabId[] = ['registered', 'project', 'marketplace'];
    const currentIndex = tabIds.indexOf(state.activeTabId);
    const nextIndex = (currentIndex + 1) % tabIds.length;

    // Update state immediately (synchronous)
    state.activeTabId = tabIds[nextIndex];
    state.tabs.forEach(tab => {
      tab.isActive = tab.id === state.activeTabId;
    });

    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;

    // If already cached, apply filter immediately
    if (activeTab.data !== null) {
      applySearchFilter();
      return;
    }

    // Kick off fetch in background using setTimeout (deferred to next tick)
    setTimeout(() => {
      fetchActiveTabDataBackground();
    }, 0);
  }

  /**
   * Fetch data in background without blocking
   */
  function fetchActiveTabDataBackground(): void {
    fetchActiveTabData()
      .then(() => {
        applySearchFilter();
        // Re-render after data loads
        if (prompt) {
          prompt.render();
        }
      })
      .catch((error) => {
        console.error('Error fetching tab data:', error);
        // Re-render to show error
        if (prompt) {
          prompt.render();
        }
      });
  }

  /**
   * Handle search update (live typing)
   */
  function handleSearchUpdate(query: string): void {
    state.searchQuery = query;
    applySearchFilter();
  }

  /**
   * Handle cursor movement (Up/Down arrows)
   */
  function handleCursorMove(direction: 'up' | 'down'): void {
    if (!prompt) return;

    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;
    const maxIndex = Math.min(5, activeTab.filteredData.length) - 1;
    const currentIndex = prompt.getCursorIndex();

    if (direction === 'up') {
      const newIndex = Math.max(0, currentIndex - 1);
      prompt.setCursorIndex(newIndex);
    } else {
      const newIndex = Math.min(maxIndex, currentIndex + 1);
      prompt.setCursorIndex(newIndex);
    }
  }

  /**
   * Handle selection toggle (Space key)
   */
  function handleToggleSelection(): void {
    if (!prompt) return;

    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;
    const cursorIndex = prompt.getCursorIndex();
    const displayAssistants = activeTab.filteredData.slice(0, 5);

    if (cursorIndex >= 0 && cursorIndex < displayAssistants.length) {
      const assistant = displayAssistants[cursorIndex];

      if (state.selectedIds.has(assistant.id)) {
        state.selectedIds.delete(assistant.id);
      } else {
        state.selectedIds.add(assistant.id);
      }
    }
  }

  /**
   * Handle confirm (Enter key)
   */
  function handleConfirm(): void {
    isCancelled = false;
    if (prompt) {
      prompt.stop();
    }
  }

  /**
   * Handle cancel (Esc key)
   */
  function handleCancel(): void {
    isCancelled = true;
    if (prompt) {
      prompt.stop();
    }
  }

  /**
   * Fetch data for active tab if not already fetched
   * Uses lazy loading - only fetches on first visit
   */
  async function fetchActiveTabData(): Promise<void> {
    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;

    // Skip if already fetched
    if (activeTab.data !== null) {
      return;
    }

    activeTab.isFetching = true;
    activeTab.error = null;

    try {
      let data: (Assistant | AssistantBase)[];

      // Add timeout to prevent hanging
      const fetchPromise = (async () => {
        switch (state.activeTabId) {
          case 'registered':
            return await fetcher.fetchRegistered(state.registeredIds);
          case 'project':
            return await fetcher.fetchProjectAssistants();
          case 'marketplace':
            return await fetcher.fetchMarketplace();
        }
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Fetch timeout after 10 seconds')), 10000);
      });

      data = await Promise.race([fetchPromise, timeoutPromise]);

      activeTab.data = data;
      activeTab.filteredData = data;
    } catch (error) {
      activeTab.error = error instanceof Error ? error.message : 'Unknown error';
      activeTab.data = []; // Set to empty array to prevent retry
      activeTab.filteredData = [];
    } finally {
      activeTab.isFetching = false;
    }
  }

  /**
   * Apply search filter to active tab data
   */
  function applySearchFilter(): void {
    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;

    if (!activeTab.data) {
      activeTab.filteredData = [];
      return;
    }

    activeTab.filteredData = filterAssistants(
      activeTab.data,
      state.searchQuery
    );
  }

  // Return public interface
  return {
    run
  };
}

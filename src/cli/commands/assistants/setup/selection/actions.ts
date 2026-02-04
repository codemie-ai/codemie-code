/**
 * Action Handlers
 *
 * All user interaction handlers for the selection UI
 */

import type { SelectionState } from './types.js';
import type { DataFetcher } from './data.js';
import type { InteractivePrompt } from './interactive-prompt.js';
import { PANEL_IDS, CONFIG, type PanelId } from './constants.js';

export interface ActionHandlers {
  handlePanelSwitch: (direction: 'next' | 'prev') => void;
  handleSearchUpdate: (query: string) => void;
  handleFocusSearch: () => void;
  handleFocusList: () => void;
  handleCursorMove: (direction: 'up' | 'down') => void;
  handleToggleSelection: () => void;
  handleConfirm: () => void;
  handleCancel: () => void;
}

export interface ActionHandlerDependencies {
  state: SelectionState;
  fetcher: DataFetcher;
  prompt: () => InteractivePrompt | null;
  setPrompt: (p: InteractivePrompt | null) => void;
  setCancelled: (cancelled: boolean) => void;
}

export function createActionHandlers(deps: ActionHandlerDependencies): ActionHandlers {
  /**
   * Rotate panel index in the given direction
   */
  function rotatePanelIndex(direction: 'next' | 'prev'): PanelId {
    const currentIndex = PANEL_IDS.indexOf(deps.state.activePanelId);
    const offset = direction === 'next' ? 1 : -1;
    const nextIndex = (currentIndex + offset + PANEL_IDS.length) % PANEL_IDS.length;
    return PANEL_IDS[nextIndex];
  }

  /**
   * Set active panel and update all panel states
   */
  function setActivePanel(panelId: PanelId): void {
    deps.state.activePanelId = panelId;
    deps.state.panels.forEach(panel => {
      panel.isActive = panel.id === deps.state.activePanelId;
    });
  }

  /**
   * Fetch data for active panel with current search query
   */
  async function fetchActivePanelData(): Promise<void> {
    const activePanel = deps.state.panels.find(p => p.id === deps.state.activePanelId)!;

    activePanel.isFetching = true;
    activePanel.error = null;

    try {
      const fetchPromise = deps.fetcher.fetchAssistants({
        scope: deps.state.activePanelId,
        searchQuery: deps.state.searchQuery,
        page: 0
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Fetch timeout after ${CONFIG.FETCH_TIMEOUT_MS / 1000} seconds`)), CONFIG.FETCH_TIMEOUT_MS);
      });

      const data = await Promise.race([fetchPromise, timeoutPromise]);

      activePanel.data = data;
      activePanel.filteredData = data;
    } catch (error) {
      activePanel.error = error instanceof Error ? error.message : 'Unknown error';
      activePanel.data = [];
      activePanel.filteredData = [];
    } finally {
      activePanel.isFetching = false;
    }
  }

  /**
   * Fetch data in background without blocking
   */
  function fetchActivePanelDataBackground(): void {
    fetchActivePanelData()
      .then(() => {
        const prompt = deps.prompt();
        if (prompt) {
          prompt.render();
        }
      })
      .catch((error) => {
        console.error('Error fetching panel data:', error);
        const prompt = deps.prompt();
        if (prompt) {
          prompt.render();
        }
      });
  }

  /**
   * Handle panel switch (Tab/Shift+Tab or arrow keys)
   */
  function handlePanelSwitch(direction: 'next' | 'prev'): void {
    const newPanelId = rotatePanelIndex(direction);
    setActivePanel(newPanelId);

    setTimeout(() => fetchActivePanelDataBackground(), 0);
  }

  /**
   * Handle search update (live typing)
   */
  function handleSearchUpdate(query: string): void {
    deps.state.searchQuery = query;
    setTimeout(() => fetchActivePanelDataBackground(), 0);
  }

  /**
   * Handle focus moving to search box
   */
  function handleFocusSearch(): void {
    deps.state.isSearchFocused = true;
  }

  /**
   * Handle focus moving to list
   */
  function handleFocusList(): void {
    deps.state.isSearchFocused = false;
  }

  /**
   * Handle cursor movement (Up/Down arrows)
   */
  function handleCursorMove(direction: 'up' | 'down'): void {
    const prompt = deps.prompt();
    if (!prompt) return;

    const activePanel = deps.state.panels.find(p => p.id === deps.state.activePanelId)!;
    const maxIndex = Math.min(CONFIG.MAX_DISPLAY_ITEMS, activePanel.filteredData.length) - 1;
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
    const prompt = deps.prompt();
    if (!prompt) return;

    const activePanel = deps.state.panels.find(p => p.id === deps.state.activePanelId)!;
    const cursorIndex = prompt.getCursorIndex();
    const displayAssistants = activePanel.filteredData.slice(0, CONFIG.MAX_DISPLAY_ITEMS);

    if (cursorIndex >= 0 && cursorIndex < displayAssistants.length) {
      const assistant = displayAssistants[cursorIndex];

      if (deps.state.selectedIds.has(assistant.id)) {
        deps.state.selectedIds.delete(assistant.id);
      } else {
        deps.state.selectedIds.add(assistant.id);
      }
    }
  }

  /**
   * Handle confirm (Enter key)
   */
  function handleConfirm(): void {
    deps.setCancelled(false);
    const prompt = deps.prompt();
    if (prompt) {
      prompt.stop();
    }
  }

  /**
   * Handle cancel (Esc key)
   */
  function handleCancel(): void {
    deps.setCancelled(true);
    const prompt = deps.prompt();
    if (prompt) {
      prompt.stop();
    }
  }

  return {
    handlePanelSwitch,
    handleSearchUpdate,
    handleFocusSearch,
    handleFocusList,
    handleCursorMove,
    handleToggleSelection,
    handleConfirm,
    handleCancel
  };
}

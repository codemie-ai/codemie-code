import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { ActionType } from '@/cli/commands/assistants/constants.js';
import { ACTIONS } from '@/cli/commands/assistants/constants.js';
import type {
  OrchestratorOptions,
  SelectionState,
  TabId
} from './tab-types.js';
import { DataFetcher } from './data-fetcher.js';
import { SearchFilter } from './search-filter.js';
import { InteractivePrompt } from './interactive-prompt.js';

export class TabbedSelectionOrchestrator {
  private state: SelectionState;
  private fetcher: DataFetcher;
  private filter: SearchFilter;
  private prompt: InteractivePrompt | null = null;
  private shouldExit = false;
  private isCancelled = false;

  constructor(private options: OrchestratorOptions) {
    this.state = this.initializeState();
    this.fetcher = new DataFetcher({
      config: options.config,
      client: options.client,
      options: options.options
    });
    this.filter = new SearchFilter();
  }

  /**
   * Initialize state with 3 tabs (Registered, Project, Marketplace)
   */
  private initializeState(): SelectionState {
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
      selectedIds: new Set(),
      registeredIds: this.options.registeredIds
    };
  }

  /**
   * Main interaction loop with interactive prompt
   */
  async run(): Promise<{ selectedIds: string[]; action: ActionType }> {
    // Create interactive prompt FIRST (don't wait for fetch)
    this.prompt = new InteractivePrompt({
      state: this.state,
      onTabSwitch: () => this.handleTabSwitchSync(),
      onSearchUpdate: (query: string) => this.handleSearchUpdate(query),
      onCursorMove: (direction: 'up' | 'down') => this.handleCursorMove(direction),
      onToggleSelection: () => this.handleToggleSelection(),
      onConfirm: () => this.handleConfirm(),
      onCancel: () => this.handleCancel()
    });

    // Start interactive prompt immediately
    const promptPromise = this.prompt.start();

    // Fetch initial tab data in background
    setTimeout(() => {
      this.fetchActiveTabData()
        .then(() => {
          this.applySearchFilter();
          if (this.prompt) {
            this.prompt.render();
          }
        })
        .catch((error) => {
          console.error('Error fetching initial data:', error);
        });
    }, 0);

    // Wait for prompt to finish
    await promptPromise;

    // Return result
    if (this.isCancelled) {
      return {
        selectedIds: [],
        action: ACTIONS.CANCEL
      };
    }

    return {
      selectedIds: Array.from(this.state.selectedIds),
      action: ACTIONS.UPDATE
    };
  }

  /**
   * Handle tab switch (Tab key)
   * SYNCHRONOUS - no blocking, no await
   */
  private handleTabSwitchSync(): void {
    const tabIds: TabId[] = ['registered', 'project', 'marketplace'];
    const currentIndex = tabIds.indexOf(this.state.activeTabId);
    const nextIndex = (currentIndex + 1) % tabIds.length;

    // Update state immediately (synchronous)
    this.state.activeTabId = tabIds[nextIndex];
    this.state.tabs.forEach(tab => {
      tab.isActive = tab.id === this.state.activeTabId;
    });

    const activeTab = this.state.tabs.find(t => t.id === this.state.activeTabId)!;

    // If already cached, apply filter immediately
    if (activeTab.data !== null) {
      this.applySearchFilter();
      return;
    }

    // Kick off fetch in background using setTimeout (deferred to next tick)
    setTimeout(() => {
      this.fetchActiveTabDataBackground();
    }, 0);
  }

  /**
   * Fetch data in background without blocking
   */
  private fetchActiveTabDataBackground(): void {
    this.fetchActiveTabData()
      .then(() => {
        this.applySearchFilter();
        // Re-render after data loads
        if (this.prompt) {
          this.prompt.render();
        }
      })
      .catch((error) => {
        console.error('Error fetching tab data:', error);
        // Re-render to show error
        if (this.prompt) {
          this.prompt.render();
        }
      });
  }

  /**
   * Handle search update (live typing)
   */
  private handleSearchUpdate(query: string): void {
    this.state.searchQuery = query;
    this.applySearchFilter();
  }

  /**
   * Handle cursor movement (Up/Down arrows)
   */
  private handleCursorMove(direction: 'up' | 'down'): void {
    if (!this.prompt) return;

    const activeTab = this.state.tabs.find(t => t.id === this.state.activeTabId)!;
    const maxIndex = Math.min(5, activeTab.filteredData.length) - 1;
    const currentIndex = this.prompt.getCursorIndex();

    if (direction === 'up') {
      const newIndex = Math.max(0, currentIndex - 1);
      this.prompt.setCursorIndex(newIndex);
    } else {
      const newIndex = Math.min(maxIndex, currentIndex + 1);
      this.prompt.setCursorIndex(newIndex);
    }
  }

  /**
   * Handle selection toggle (Space key)
   */
  private handleToggleSelection(): void {
    if (!this.prompt) return;

    const activeTab = this.state.tabs.find(t => t.id === this.state.activeTabId)!;
    const cursorIndex = this.prompt.getCursorIndex();
    const displayAssistants = activeTab.filteredData.slice(0, 5);

    if (cursorIndex >= 0 && cursorIndex < displayAssistants.length) {
      const assistant = displayAssistants[cursorIndex];

      if (this.state.selectedIds.has(assistant.id)) {
        this.state.selectedIds.delete(assistant.id);
      } else {
        this.state.selectedIds.add(assistant.id);
      }
    }
  }

  /**
   * Handle confirm (Enter key)
   */
  private handleConfirm(): void {
    this.shouldExit = true;
    this.isCancelled = false;
    if (this.prompt) {
      this.prompt.stop();
    }
  }

  /**
   * Handle cancel (Esc key)
   */
  private handleCancel(): void {
    this.shouldExit = true;
    this.isCancelled = true;
    if (this.prompt) {
      this.prompt.stop();
    }
  }

  /**
   * Fetch data for active tab if not already fetched
   * Uses lazy loading - only fetches on first visit
   */
  private async fetchActiveTabData(): Promise<void> {
    const activeTab = this.state.tabs.find(t => t.id === this.state.activeTabId)!;

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
        switch (this.state.activeTabId) {
          case 'registered':
            return await this.fetcher.fetchRegistered(this.state.registeredIds);
          case 'project':
            return await this.fetcher.fetchProjectAssistants();
          case 'marketplace':
            return await this.fetcher.fetchMarketplace();
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
  private applySearchFilter(): void {
    const activeTab = this.state.tabs.find(t => t.id === this.state.activeTabId)!;

    if (!activeTab.data) {
      activeTab.filteredData = [];
      return;
    }

    activeTab.filteredData = this.filter.filter(
      activeTab.data,
      this.state.searchQuery
    );
  }
}

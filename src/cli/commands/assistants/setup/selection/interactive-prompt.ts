import chalk from 'chalk';
import type { TabId, TabState, SelectionState } from './tab-types.js';

interface InteractivePromptOptions {
  state: SelectionState;
  onTabSwitch: () => void;
  onSearchUpdate: (query: string) => void;
  onCursorMove: (direction: 'up' | 'down') => void;
  onToggleSelection: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface InteractivePrompt {
  start: () => Promise<void>;
  stop: () => void;
  render: () => void;
  getCursorIndex: () => number;
  setCursorIndex: (index: number) => void;
}

export function createInteractivePrompt(options: InteractivePromptOptions): InteractivePrompt {
  // Private state (closure variables)
  let cursorIndex = 0;
  let isActive = false;
  let resolvePromise: (() => void) | null = null;
  let dataHandler: ((data: Buffer) => void) | null = null;
  let keepAliveTimer: NodeJS.Timeout | null = null;

  /**
   * Start the interactive prompt
   */
  async function start(): Promise<void> {
    isActive = true;

    // CRITICAL: Keep event loop alive during async operations
    keepAliveTimer = setInterval(() => {
      // Empty timer to prevent event loop from exiting
    }, 1000);

    // Resume stdin first
    process.stdin.resume();

    // Enable raw mode for keypress events
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    // Prevent stdin from ending
    process.stdin.setEncoding('utf8');

    setupKeyHandlers();
    render();

    return new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
  }

  /**
   * Stop the interactive prompt
   */
  function stop(): void {
    isActive = false;

    // Clear keep-alive timer
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    // Remove data handler
    if (dataHandler) {
      process.stdin.removeListener('data', dataHandler);
      dataHandler = null;
    }

    // Disable raw mode
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    // Pause stdin
    process.stdin.pause();

    // Resolve the promise
    if (resolvePromise) {
      resolvePromise();
      resolvePromise = null;
    }
  }

  /**
   * Get current cursor index
   */
  function getCursorIndex(): number {
    return cursorIndex;
  }

  /**
   * Set cursor index
   */
  function setCursorIndex(index: number): void {
    cursorIndex = index;
  }

  /**
   * Setup keyboard event handlers
   */
  function setupKeyHandlers(): void {
    dataHandler = (data: Buffer) => {
      if (!isActive) return;

      const key = data.toString();
      // Always read fresh state reference (not snapshot)
      const getState = () => options.state;

      // Handle Ctrl+C (exit)
      if (key === '\u0003') {
        options.onCancel();
        return;
      }

      // Handle Esc
      if (key === '\u001b') {
        options.onCancel();
        return;
      }

      // Handle Tab (switch tabs)
      if (key === '\t') {
        cursorIndex = 0; // Reset cursor when switching tabs

        // Execute tab switch SYNCHRONOUSLY
        options.onTabSwitch();

        // Render immediately with new state
        render();
        return;
      }

      // Handle Enter (confirm)
      if (key === '\r' || key === '\n') {
        options.onConfirm();
        return;
      }

      // Handle Up arrow
      if (key === '\u001b[A') {
        options.onCursorMove('up');
        render();
        return;
      }

      // Handle Down arrow
      if (key === '\u001b[B') {
        options.onCursorMove('down');
        render();
        return;
      }

      // Handle Space (toggle selection)
      if (key === ' ') {
        options.onToggleSelection();
        render();
        return;
      }

      // Handle Backspace
      if (key === '\u007f' || key === '\b') {
        const currentSearch = getState().searchQuery;
        if (currentSearch.length > 0) {
          options.onSearchUpdate(currentSearch.slice(0, -1));
          cursorIndex = 0; // Reset cursor on search change
          render();
        }
        return;
      }

      // Handle regular typing (add to search)
      // Filter out control characters
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) {
        const currentSearch = getState().searchQuery;
        options.onSearchUpdate(currentSearch + key);
        cursorIndex = 0; // Reset cursor on search change
        render();
        return;
      }
    };

    process.stdin.on('data', dataHandler);
  }

  /**
   * Render the UI (public method - can be called by orchestrator)
   */
  function render(): void {
    if (!isActive) return;

    const state = options.state;
    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;

    // Clear screen
    console.clear();

    // Render tab header
    renderTabHeader(state.tabs, state.activeTabId);

    // Render search input
    renderSearchInput(state.searchQuery);

    // Render instructions
    renderInstructions();

    // Render assistants list
    renderAssistantsList(activeTab, state.selectedIds);

    // Render status line
    renderStatusLine(activeTab);
  }

  /**
   * Render tab navigation header
   */
  function renderTabHeader(tabs: TabState[], activeId: TabId): void {
    const tabStrings = tabs.map(tab => {
      if (tab.id === activeId) {
        return chalk.cyan.bold(`[${tab.label}]`);
      }
      return chalk.dim(`[${tab.label}]`);
    });

    console.log('\n' + tabStrings.join('  '));
    console.log(chalk.dim('Tab: Switch tabs\n'));
  }

  /**
   * Render search input display
   */
  function renderSearchInput(query: string): void {
    const display = query || chalk.dim('(type to search)');
    console.log(chalk.white('Search: ') + display + chalk.cyan('█') + '\n');
  }

  /**
   * Render keyboard instructions
   */
  function renderInstructions(): void {
    console.log(chalk.dim('↑↓: Navigate • Space: Select • Enter: Done • Esc: Cancel\n'));
  }

  /**
   * Render assistants list with cursor and selections
   */
  function renderAssistantsList(
    activeTab: TabState,
    selectedIds: Set<string>
  ): void {
    if (activeTab.isFetching) {
      console.log(chalk.yellow('Loading...\n'));
      return;
    }

    if (activeTab.error) {
      console.log(chalk.red(`Error: ${activeTab.error}\n`));
      return;
    }

    if (activeTab.filteredData.length === 0) {
      console.log(chalk.yellow('No assistants found.\n'));
      return;
    }

    // Show max 5 assistants
    const displayAssistants = activeTab.filteredData.slice(0, 5);

    // Ensure cursor is within bounds
    if (cursorIndex >= displayAssistants.length) {
      cursorIndex = displayAssistants.length - 1;
    }
    if (cursorIndex < 0) {
      cursorIndex = 0;
    }

    displayAssistants.forEach((assistant, index) => {
      const isSelected = selectedIds.has(assistant.id);
      const isCursor = index === cursorIndex;

      // Checkbox
      const checkbox = isSelected ? chalk.green('[x]') : '[ ]';

      // Cursor indicator
      const cursor = isCursor ? chalk.cyan('›') : ' ';

      // Name
      const name = isCursor ? chalk.cyan.bold(assistant.name) : assistant.name;

      // Description
      const description = assistant.description
        ? chalk.dim(`    ${assistant.description}`)
        : '';

      console.log(`${cursor} ${checkbox} ${name}`);
      if (description) {
        console.log(description);
      }
      console.log(); // Empty line between items
    });
  }

  /**
   * Render status line
   */
  function renderStatusLine(activeTab: TabState): void {
    const showing = Math.min(5, activeTab.filteredData.length);
    const total = activeTab.data?.length || 0;

    console.log(chalk.dim(`Showing ${showing} of ${total}`));
    if (activeTab.filteredData.length > 5) {
      console.log(chalk.dim('Use search to filter results'));
    }
  }

  // Return public interface
  return {
    start,
    stop,
    render,
    getCursorIndex,
    setCursorIndex
  };
}

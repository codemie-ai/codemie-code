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

export class InteractivePrompt {
  private cursorIndex = 0;
  private isActive = false;
  private resolvePromise: (() => void) | null = null;
  private dataHandler: ((data: Buffer) => void) | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(private options: InteractivePromptOptions) {}

  /**
   * Start the interactive prompt
   */
  async start(): Promise<void> {
    this.isActive = true;

    // CRITICAL: Keep event loop alive during async operations
    this.keepAliveTimer = setInterval(() => {
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

    this.setupKeyHandlers();
    this.render();

    return new Promise<void>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  /**
   * Stop the interactive prompt
   */
  stop(): void {
    this.isActive = false;

    // Clear keep-alive timer
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    // Remove data handler
    if (this.dataHandler) {
      process.stdin.removeListener('data', this.dataHandler);
      this.dataHandler = null;
    }

    // Disable raw mode
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    // Pause stdin
    process.stdin.pause();

    // Resolve the promise
    if (this.resolvePromise) {
      this.resolvePromise();
      this.resolvePromise = null;
    }
  }

  /**
   * Get current cursor index
   */
  getCursorIndex(): number {
    return this.cursorIndex;
  }

  /**
   * Set cursor index
   */
  setCursorIndex(index: number): void {
    this.cursorIndex = index;
  }

  /**
   * Setup keyboard event handlers
   */
  private setupKeyHandlers(): void {
    this.dataHandler = (data: Buffer) => {
      if (!this.isActive) return;

      const key = data.toString();
      const state = this.options.state;

      // Handle Ctrl+C (exit)
      if (key === '\u0003') {
        this.options.onCancel();
        return;
      }

      // Handle Esc
      if (key === '\u001b') {
        this.options.onCancel();
        return;
      }

      // Handle Tab (switch tabs)
      if (key === '\t') {
        this.cursorIndex = 0; // Reset cursor when switching tabs

        // Execute tab switch SYNCHRONOUSLY
        this.options.onTabSwitch();

        // Render immediately with new state
        this.render();
        return;
      }

      // Handle Enter (confirm)
      if (key === '\r' || key === '\n') {
        this.options.onConfirm();
        return;
      }

      // Handle Up arrow
      if (key === '\u001b[A') {
        this.options.onCursorMove('up');
        this.render();
        return;
      }

      // Handle Down arrow
      if (key === '\u001b[B') {
        this.options.onCursorMove('down');
        this.render();
        return;
      }

      // Handle Space (toggle selection)
      if (key === ' ') {
        this.options.onToggleSelection();
        this.render();
        return;
      }

      // Handle Backspace
      if (key === '\u007f' || key === '\b') {
        const currentSearch = state.searchQuery;
        if (currentSearch.length > 0) {
          this.options.onSearchUpdate(currentSearch.slice(0, -1));
          this.cursorIndex = 0; // Reset cursor on search change
          this.render();
        }
        return;
      }

      // Handle regular typing (add to search)
      // Filter out control characters
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) {
        this.options.onSearchUpdate(state.searchQuery + key);
        this.cursorIndex = 0; // Reset cursor on search change
        this.render();
        return;
      }
    };

    process.stdin.on('data', this.dataHandler);
  }

  /**
   * Render the UI (public method - can be called by orchestrator)
   */
  render(): void {
    if (!this.isActive) return;

    const state = this.options.state;
    const activeTab = state.tabs.find(t => t.id === state.activeTabId)!;

    // Clear screen
    console.clear();

    // Render tab header
    this.renderTabHeader(state.tabs, state.activeTabId);

    // Render search input
    this.renderSearchInput(state.searchQuery);

    // Render instructions
    this.renderInstructions();

    // Render assistants list
    this.renderAssistantsList(activeTab, state.selectedIds);

    // Render status line
    this.renderStatusLine(activeTab);
  }

  /**
   * Render tab navigation header
   */
  private renderTabHeader(tabs: TabState[], activeId: TabId): void {
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
  private renderSearchInput(query: string): void {
    const display = query || chalk.dim('(type to search)');
    console.log(chalk.white('Search: ') + display + chalk.cyan('█') + '\n');
  }

  /**
   * Render keyboard instructions
   */
  private renderInstructions(): void {
    console.log(chalk.dim('↑↓: Navigate • Space: Select • Enter: Done • Esc: Cancel\n'));
  }

  /**
   * Render assistants list with cursor and selections
   */
  private renderAssistantsList(
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
    if (this.cursorIndex >= displayAssistants.length) {
      this.cursorIndex = displayAssistants.length - 1;
    }
    if (this.cursorIndex < 0) {
      this.cursorIndex = 0;
    }

    displayAssistants.forEach((assistant, index) => {
      const isSelected = selectedIds.has(assistant.id);
      const isCursor = index === this.cursorIndex;

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
  private renderStatusLine(activeTab: TabState): void {
    const showing = Math.min(5, activeTab.filteredData.length);
    const total = activeTab.data?.length || 0;

    console.log(chalk.dim(`Showing ${showing} of ${total}`));
    if (activeTab.filteredData.length > 5) {
      console.log(chalk.dim('Use search to filter results'));
    }
  }
}

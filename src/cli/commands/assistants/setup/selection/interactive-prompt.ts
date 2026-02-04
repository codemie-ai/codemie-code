import chalk from 'chalk';
import type { TabId, TabState, SelectionState } from './tab-types.js';

interface InteractivePromptOptions {
  state: SelectionState;
  onTabSwitch: () => void;
  onTabSwitchPrev: () => void;
  onSearchUpdate: (query: string) => void;
  onCursorMove: (direction: 'up' | 'down') => void;
  onToggleSelection: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onFocusSearch: () => void;
  onFocusList: () => void;
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

      // Handle Tab (switch tabs - next)
      if (key === '\t') {
        cursorIndex = 0; // Reset cursor when switching tabs

        // Execute tab switch SYNCHRONOUSLY
        options.onTabSwitch();

        // Render immediately with new state
        render();
        return;
      }

      // Handle Shift+Tab (switch tabs - previous)
      if (key === '\u001b[Z') {
        cursorIndex = 0; // Reset cursor when switching tabs

        // Execute previous tab switch
        options.onTabSwitchPrev();

        // Render immediately with new state
        render();
        return;
      }

      // Handle Right arrow (switch to next tab)
      if (key === '\u001b[C') {
        cursorIndex = 0; // Reset cursor when switching tabs

        // Execute tab switch SYNCHRONOUSLY
        options.onTabSwitch();

        // Render immediately with new state
        render();
        return;
      }

      // Handle Left arrow (switch to previous tab)
      if (key === '\u001b[D') {
        cursorIndex = 0; // Reset cursor when switching tabs

        // Execute previous tab switch
        options.onTabSwitchPrev();

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
        const state = getState();
        if (state.isSearchFocused) {
          // Already at search, do nothing
          return;
        } else {
          // If at top of list, move focus back to search
          if (cursorIndex === 0) {
            options.onFocusSearch();
            render();
            return;
          }
          // Navigate up in list
          options.onCursorMove('up');
        }
        render();
        return;
      }

      // Handle Down arrow
      if (key === '\u001b[B') {
        const state = getState();
        if (state.isSearchFocused) {
          // Move focus from search to list
          options.onFocusList();
          cursorIndex = 0;
        } else {
          // Navigate down in list
          options.onCursorMove('down');
        }
        render();
        return;
      }

      // Handle Space
      if (key === ' ') {
        const state = getState();
        if (!state.isSearchFocused) {
          // Toggle selection only when list is focused
          options.onToggleSelection();
          render();
        }
        // If search is focused, ignore space (or add to search if you want)
        return;
      }

      // Handle Backspace
      if (key === '\u007f' || key === '\b') {
        const currentSearch = getState().searchQuery;
        if (currentSearch.length > 0) {
          // Focus search if not already focused
          if (!getState().isSearchFocused) {
            options.onFocusSearch();
          }
          options.onSearchUpdate(currentSearch.slice(0, -1));
          cursorIndex = 0; // Reset cursor on search change
          render();
        }
        return;
      }

      // Handle regular typing (add to search)
      // Filter out control characters
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) {
        const state = getState();

        // If list is focused, focus search first
        if (!state.isSearchFocused) {
          options.onFocusSearch();
        }

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

    // Render top line
    renderTopLine();

    // Render tab header (without hint)
    renderTabHeader(state.tabs, state.activeTabId);

    // Render count above search box
    renderCount(activeTab);

    // Render search input with focus state
    renderSearchInput(state.searchQuery, state.isSearchFocused);

    // Render assistants list with focus state
    renderAssistantsList(activeTab, state.selectedIds, state.isSearchFocused);

    // Render instructions at bottom
    renderInstructions();
  }

  /**
   * Render top line spanning terminal width
   */
  function renderTopLine(): void {
    const purple = { r: 177, g: 185, b: 249 } as const;
    const width = process.stdout.columns || 80;
    const line = '─'.repeat(width);
    console.log(chalk.rgb(purple.r, purple.g, purple.b)(line));
  }

  /**
   * Render tab navigation header with hint
   */
  function renderTabHeader(tabs: TabState[], activeId: TabId): void {
    const purple = { r: 177, g: 185, b: 249 } as const;

    const tabStrings = tabs.map(tab => {
      if (tab.id === activeId) {
        // Inverted colors for active tab (purple background, black text)
        return chalk.bgRgb(purple.r, purple.g, purple.b).black(` ${tab.label} `);
      }
      return chalk.white(tab.label);
    });

    const label = chalk.rgb(purple.r, purple.g, purple.b).bold('Assistants');
    const tabsLine = tabStrings.join('   ');
    const hint = chalk.dim('(←/→, tab/shift+tab to cycle)');

    console.log(`${label}   ${tabsLine}   ${hint}\n`);
  }

  /**
   * Render search input display with box
   */
  function renderSearchInput(query: string, isFocused: boolean): void {
    const purple = { r: 177, g: 185, b: 249 } as const;
    const width = process.stdout.columns || 80;

    // Box drawing characters
    const topLeft = '╭';
    const topRight = '╮';
    const bottomLeft = '╰';
    const bottomRight = '╯';
    const horizontal = '─';
    const vertical = '│';

    // Calculate inner width (total width - 2 borders)
    const innerWidth = width - 2;

    // Search icon and content
    const searchIcon = '⌕';
    const cursor = '█';
    const placeholderText = 'Search…';

    // Build content without formatting first to calculate visual length
    const prefix = ` ${searchIcon} `;
    const contentText = query ? query + cursor : placeholderText;
    const visualLength = prefix.length + contentText.length;
    const paddingNeeded = innerWidth - visualLength;

    // Now apply formatting for display
    const styledCursor = chalk.rgb(purple.r, purple.g, purple.b)(cursor);
    const styledPlaceholder = chalk.dim(placeholderText);
    const displayText = query ? query + styledCursor : styledPlaceholder;

    const contentLine = prefix + displayText + ' '.repeat(Math.max(0, paddingNeeded));

    // Border color - purple when focused, white when not
    const borderColor = isFocused
      ? chalk.rgb(purple.r, purple.g, purple.b)
      : chalk.white;

    // Render the box
    console.log(borderColor(topLeft + horizontal.repeat(innerWidth) + topRight));
    console.log(borderColor(vertical) + contentLine + borderColor(vertical));
    console.log(borderColor(bottomLeft + horizontal.repeat(innerWidth) + bottomRight) + '\n');
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
    selectedIds: Set<string>,
    isSearchFocused: boolean
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

    const purple = { r: 177, g: 185, b: 249 } as const;

    displayAssistants.forEach((assistant, index) => {
      const isSelected = selectedIds.has(assistant.id);
      const isCursor = index === cursorIndex && !isSearchFocused; // Only show cursor if list is focused

      // Circle indicator: filled (◉) in purple if selected, empty (◯) if not
      const circle = isSelected
        ? chalk.rgb(purple.r, purple.g, purple.b)('◉')
        : '◯';

      // Cursor indicator (purple) - only shown when list is focused
      const cursor = isCursor ? chalk.rgb(purple.r, purple.g, purple.b)('› ') : '  ';

      // Name (purple and bold when cursor is on it)
      const name = isCursor ? chalk.rgb(purple.r, purple.g, purple.b).bold(assistant.name) : assistant.name;

      // Project name (dimmed) - handle optional project
      const project = 'project' in assistant && assistant.project
        ? chalk.dim(` · ${assistant.project}`)
        : '';

      // First line: cursor + circle + name + project
      console.log(`${cursor}${circle} ${name}${project}`);

      // Description - truncate to 40 characters with 4 spaces indentation
      if (assistant.description) {
        const desc = assistant.description.length > 40
          ? assistant.description.substring(0, 40) + '...'
          : assistant.description;
        console.log(chalk.dim(`    ${desc}`));
      }

      console.log(); // Empty line between items
    });
  }

  /**
   * Render count above search box
   */
  function renderCount(activeTab: TabState): void {
    const showing = Math.min(5, activeTab.filteredData.length);
    const total = activeTab.data?.length || 0;

    console.log(chalk.dim(`Showing ${showing} of ${total}`));
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

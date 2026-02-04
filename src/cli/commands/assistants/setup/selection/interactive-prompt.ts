/**
 * Interactive Prompt
 *
 * Handles prompt lifecycle (setup, keyboard handling, teardown)
 */

import type { SelectionState } from './types.js';
import type { ActionHandlers } from './actions.js';
import { KEY, CONFIG } from './constants.js';
import { renderUI } from './ui.js';

export interface InteractivePromptOptions {
  state: SelectionState;
  actions: ActionHandlers;
}

export interface InteractivePrompt {
  start: () => Promise<void>;
  stop: () => void;
  render: () => void;
  getCursorIndex: () => number;
  setCursorIndex: (index: number) => void;
}

export function createInteractivePrompt(options: InteractivePromptOptions): InteractivePrompt {
  let cursorIndex = 0;
  let isActive = false;
  let resolvePromise: (() => void) | null = null;
  let dataHandler: ((data: Buffer) => void) | null = null;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let searchDebounceTimer: NodeJS.Timeout | null = null;

  /**
   * Start the interactive prompt
   */
  async function start(): Promise<void> {
    isActive = true;

    // CRITICAL: Keep event loop alive during async operations
    keepAliveTimer = setInterval(() => {}, CONFIG.KEEP_ALIVE_INTERVAL_MS);

    process.stdin.resume();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

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

    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }

    if (dataHandler) {
      process.stdin.removeListener('data', dataHandler);
      dataHandler = null;
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    process.stdin.pause();

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
   * Render the UI
   */
  function render(): void {
    if (!isActive) return;

    const output = renderUI(options.state, cursorIndex);
    process.stdout.write(output);
  }

  /**
   * Check if character is printable (for search input)
   */
  function isPrintableChar(key: string): boolean {
    return key.length === 1 &&
           key.charCodeAt(0) >= CONFIG.PRINTABLE_CHAR_MIN &&
           key.charCodeAt(0) <= CONFIG.PRINTABLE_CHAR_MAX;
  }

  /**
   * Handle exit (Ctrl+C or Esc)
   */
  function handleExit(): void {
    options.actions.handleCancel();
  }

  /**
   * Handle next panel (Tab or Right arrow)
   */
  function handleNextPanel(): void {
    cursorIndex = 0;
    options.actions.handlePanelSwitch('next');
    render();
  }

  /**
   * Handle previous panel (Shift+Tab or Left arrow)
   */
  function handlePrevPanel(): void {
    cursorIndex = 0;
    options.actions.handlePanelSwitch('prev');
    render();
  }

  /**
   * Handle confirm (Enter)
   */
  function handleConfirm(): void {
    options.actions.handleConfirm();
  }

  /**
   * Handle arrow up
   */
  function handleArrowUp(): void {
    const state = options.state;
    if (state.isSearchFocused) {
      return;
    }

    if (cursorIndex === 0) {
      options.actions.handleFocusSearch();
      render();
      return;
    }

    options.actions.handleCursorMove('up');
    render();
  }

  /**
   * Handle arrow down
   */
  function handleArrowDown(): void {
    const state = options.state;
    if (state.isSearchFocused) {
      options.actions.handleFocusList();
      cursorIndex = 0;
    } else {
      options.actions.handleCursorMove('down');
    }
    render();
  }

  /**
   * Handle toggle selection (Space)
   */
  function handleToggleSelection(): void {
    const state = options.state;
    if (!state.isSearchFocused) {
      options.actions.handleToggleSelection();
      render();
    }
  }

  /**
   * Update search query with debounce
   */
  function updateSearchQuery(newQuery: string): void {
    options.state.searchQuery = newQuery;
    cursorIndex = 0;
    render();

    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }

    searchDebounceTimer = setTimeout(() => {
      options.actions.handleSearchUpdate(newQuery);
    }, CONFIG.SEARCH_DEBOUNCE_MS);
  }

  /**
   * Handle backspace
   */
  function handleBackspace(): void {
    const currentSearch = options.state.searchQuery;
    if (currentSearch.length > 0) {
      if (!options.state.isSearchFocused) {
        options.actions.handleFocusSearch();
      }
      updateSearchQuery(currentSearch.slice(0, -1));
    }
  }

  /**
   * Handle regular character input (for search)
   */
  function handleRegularInput(key: string): void {
    if (!options.state.isSearchFocused) {
      options.actions.handleFocusSearch();
    }
    const currentSearch = options.state.searchQuery;
    updateSearchQuery(currentSearch + key);
  }

  /**
   * Setup keyboard event handlers
   */
  function setupKeyHandlers(): void {
    type KeyHandler = () => void;

    const keyHandlers: Record<string, KeyHandler> = {
      [KEY.CTRL_C]: handleExit,
      [KEY.ESC]: handleExit,
      [KEY.TAB]: handleNextPanel,
      [KEY.SHIFT_TAB]: handlePrevPanel,
      [KEY.ARROW_RIGHT]: handleNextPanel,
      [KEY.ARROW_LEFT]: handlePrevPanel,
      [KEY.ENTER]: handleConfirm,
      [KEY.NEWLINE]: handleConfirm,
      [KEY.ARROW_UP]: handleArrowUp,
      [KEY.ARROW_DOWN]: handleArrowDown,
      [KEY.SPACE]: handleToggleSelection,
      [KEY.BACKSPACE]: handleBackspace,
      [KEY.BACKSPACE_ALT]: handleBackspace,
    };

    dataHandler = (data: Buffer) => {
      if (!isActive) return;

      const key = data.toString();
      const handler = keyHandlers[key];

      if (handler) {
        handler();
        return;
      }

      if (isPrintableChar(key)) {
        handleRegularInput(key);
      }
    };

    process.stdin.on('data', dataHandler);
  }

  return {
    start,
    stop,
    render,
    getCursorIndex,
    setCursorIndex
  };
}

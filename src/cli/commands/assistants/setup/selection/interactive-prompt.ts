/**
 * Interactive Prompt
 *
 * Handles prompt lifecycle (setup, keyboard handling, teardown)
 */

import type { SelectionState } from './types.js';
import type { ActionHandlers } from './actions.js';
import { KEY, CONFIG, PAGINATION_CONTROL } from './constants.js';
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

    keepAliveTimer = setInterval(() => {}, CONFIG.KEEP_ALIVE_INTERVAL_MS); // keep event loop running

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
    process.stdin.unref();

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

  function handleEsc(): void {
    const state = options.state;

    if (state.isSearchFocused && state.searchQuery.length > 0) {
      updateSearchQuery('');
      return;
    }

    if (state.isSearchFocused) {
      options.actions.handleFocusList();
      render();
      return;
    }

    options.actions.handleCancel();
  }

  /**
   * Handle next panel (Tab only, not Right arrow when on pagination controls)
   */
  function handleNextPanel(): void {
    const state = options.state;

    // If on buttons, cycle back to list
    if (state.areNavigationButtonsFocused) {
      options.actions.handleButtonToggle();
      render();
      return;
    }

    cursorIndex = 0;
    state.isPaginationFocused = null;
    options.actions.handlePanelSwitch('next');
    render();
  }

  /**
   * Handle previous panel (Shift+Tab only, not Left arrow when on pagination controls)
   */
  function handlePrevPanel(): void {
    const state = options.state;

    // If on buttons, cycle back to list
    if (state.areNavigationButtonsFocused) {
      options.actions.handleButtonToggle();
      render();
      return;
    }

    cursorIndex = 0;
    state.isPaginationFocused = null;
    options.actions.handlePanelSwitch('prev');
    render();
  }

  function handleArrowRight(): void {
    const state = options.state;

    // If buttons are focused, switch between them
    if (state.areNavigationButtonsFocused) {
      options.actions.handleButtonSwitch('right');
      render();
      return;
    }

    if (state.isPaginationFocused === PAGINATION_CONTROL.PREV) {
      state.isPaginationFocused = PAGINATION_CONTROL.NEXT;
      render();
      return;
    }

    if (state.isPaginationFocused === null) {
      handleNextPanel();
    }
  }

  function handleArrowLeft(): void {
    const state = options.state;

    if (state.areNavigationButtonsFocused) {
      options.actions.handleButtonSwitch('left');
      render();
      return;
    }

    if (state.isPaginationFocused === PAGINATION_CONTROL.NEXT) {
      state.isPaginationFocused = PAGINATION_CONTROL.PREV;
      render();
      return;
    }

    if (state.isPaginationFocused === null) {
      handlePrevPanel();
    }
  }

  function handleConfirm(): void {
    const state = options.state;

    // Handle button confirmation first
    if (state.areNavigationButtonsFocused) {
      options.actions.handleConfirm();
      return;
    }

    if (state.isSearchFocused) {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }

      options.actions.handleSearchUpdate(state.searchQuery);
      options.actions.handleFocusList();

      render();
      return;
    }

    if (state.isPaginationFocused === PAGINATION_CONTROL.PREV) {
      options.actions.handlePagePrev();
      return;
    }

    if (state.isPaginationFocused === PAGINATION_CONTROL.NEXT) {
      options.actions.handlePageNext();
      return;
    }
  }

  /**
   * Handle arrow up
   */
  function handleArrowUp(): void {
    const state = options.state;
    if (state.isSearchFocused) {
      return;
    }

    if (cursorIndex === 0 && state.isPaginationFocused === null) {
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
   * Handle Ctrl+] (next page)
   */
  function handleCtrlBracketRight(): void {
    const state = options.state;
    if (state.isSearchFocused) {
      return; // Ignore pagination when search is focused
    }
    options.actions.handlePageNext();
    render();
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
      [KEY.ESC]: handleEsc,
      [KEY.TAB]: handleNextPanel,
      [KEY.SHIFT_TAB]: handlePrevPanel,
      [KEY.ARROW_RIGHT]: handleArrowRight,
      [KEY.ARROW_LEFT]: handleArrowLeft,
      [KEY.ENTER]: handleConfirm,
      [KEY.NEWLINE]: handleConfirm,
      [KEY.ARROW_UP]: handleArrowUp,
      [KEY.ARROW_DOWN]: handleArrowDown,
      [KEY.SPACE]: handleToggleSelection,
      [KEY.BACKSPACE]: handleBackspace,
      [KEY.BACKSPACE_ALT]: handleBackspace,
      [KEY.CTRL_BRACKET_RIGHT]: handleCtrlBracketRight,
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

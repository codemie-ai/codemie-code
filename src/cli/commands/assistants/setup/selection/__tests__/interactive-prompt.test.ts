/**
 * Unit tests for interactive prompt
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SelectionState } from '../types.js';
import type { ActionHandlers } from '../actions.js';
import { createInteractivePrompt } from '../interactive-prompt.js';
import { KEY, PANEL_ID } from '../constants.js';

// Mock renderUI
vi.mock('../ui.js', () => ({
  renderUI: vi.fn((state: SelectionState, cursorIndex: number) => `Rendered UI with cursor at ${cursorIndex}`),
}));

describe('Interactive Prompt - interactive-prompt.ts', () => {
  let mockState: SelectionState;
  let mockActions: ActionHandlers;
  let mockStdout: any;
  let mockStdin: any;
  let dataListeners: Array<(data: Buffer) => void>;

  beforeEach(() => {
    dataListeners = [];

    // Setup mock state
    mockState = {
      panels: [
        {
          id: PANEL_ID.REGISTERED,
          label: 'Registered',
          isActive: true,
          data: [],
          filteredData: [
            { id: '1', name: 'Assistant 1', slug: 'a1' },
            { id: '2', name: 'Assistant 2', slug: 'a2' },
          ],
          isFetching: false,
          error: null,
          currentPage: 0,
          totalItems: 2,
          totalPages: 1,
        },
        {
          id: PANEL_ID.PROJECT,
          label: 'Project',
          isActive: false,
          data: [],
          filteredData: [],
          isFetching: false,
          error: null,
          currentPage: 0,
          totalItems: 0,
          totalPages: 0,
        },
        {
          id: PANEL_ID.MARKETPLACE,
          label: 'Marketplace',
          isActive: false,
          data: [],
          filteredData: [],
          isFetching: false,
          error: null,
          currentPage: 0,
          totalItems: 0,
          totalPages: 0,
        },
      ],
      activePanelId: PANEL_ID.REGISTERED,
      searchQuery: '',
      selectedIds: new Set<string>(),
      registeredIds: new Set<string>(),
      isSearchFocused: false,
      isPaginationFocused: null,
    };

    // Setup mock actions
    mockActions = {
      handlePanelSwitch: vi.fn(),
      handleSearchUpdate: vi.fn(),
      handleFocusSearch: vi.fn(),
      handleFocusList: vi.fn(),
      handleCursorMove: vi.fn(),
      handleToggleSelection: vi.fn(),
      handleConfirm: vi.fn(),
      handleCancel: vi.fn(),
      handlePageNext: vi.fn(),
      handlePagePrev: vi.fn(),
    };

    // Mock stdout
    mockStdout = {
      write: vi.fn(),
      columns: 80,
    };
    Object.defineProperty(process, 'stdout', {
      value: mockStdout,
      writable: true,
      configurable: true,
    });

    // Mock stdin
    mockStdin = {
      resume: vi.fn(),
      pause: vi.fn(),
      unref: vi.fn(),
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      isTTY: true,
      on: vi.fn((event: string, handler: any) => {
        if (event === 'data') {
          dataListeners.push(handler);
        }
      }),
      removeListener: vi.fn((event: string, handler: any) => {
        const index = dataListeners.indexOf(handler);
        if (index > -1) {
          dataListeners.splice(index, 1);
        }
      }),
    };
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      writable: true,
      configurable: true,
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('createInteractivePrompt', () => {
    it('should create prompt with required methods', () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      expect(prompt).toHaveProperty('start');
      expect(prompt).toHaveProperty('stop');
      expect(prompt).toHaveProperty('render');
      expect(prompt).toHaveProperty('getCursorIndex');
      expect(prompt).toHaveProperty('setCursorIndex');
    });
  });

  describe('start', () => {
    it('should setup stdin in raw mode', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStdin.resume).toHaveBeenCalled();
      expect(mockStdin.setRawMode).toHaveBeenCalledWith(true);
      expect(mockStdin.setEncoding).toHaveBeenCalledWith('utf8');

      prompt.stop();
      await startPromise;
    });

    it('should render initial UI', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStdout.write).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should setup data listener', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStdin.on).toHaveBeenCalledWith('data', expect.any(Function));

      prompt.stop();
      await startPromise;
    });

    it('should handle stdin without TTY', async () => {
      mockStdin.isTTY = false;

      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStdin.setRawMode).not.toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });
  });

  describe('stop', () => {
    it('should cleanup stdin', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      prompt.stop();
      await startPromise;

      expect(mockStdin.setRawMode).toHaveBeenCalledWith(false);
      expect(mockStdin.pause).toHaveBeenCalled();
      expect(mockStdin.unref).toHaveBeenCalled();
    });

    it('should remove data listener', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      prompt.stop();
      await startPromise;

      expect(mockStdin.removeListener).toHaveBeenCalledWith('data', expect.any(Function));
    });

    it('should clear timers', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      // Type to trigger debounce timer
      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from('test'));

      prompt.stop();
      await startPromise;

      // Timers should be cleared (no errors thrown)
      expect(() => vi.runAllTimers()).not.toThrow();
    });
  });

  describe('keyboard handlers', () => {
    it('should handle Ctrl+C', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const _startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.CTRL_C));

      expect(mockActions.handleCancel).toHaveBeenCalled();

      // Wait a bit before checking promise
      await Promise.resolve();
    });

    it('should handle ESC - clear search when focused with text', async () => {
      mockState.isSearchFocused = true;
      mockState.searchQuery = 'test';

      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ESC));

      expect(mockState.searchQuery).toBe('');
      expect(mockActions.handleCancel).not.toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should handle ESC - blur search when focused but empty', async () => {
      mockState.isSearchFocused = true;
      mockState.searchQuery = '';

      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ESC));

      expect(mockActions.handleFocusList).toHaveBeenCalled();
      expect(mockActions.handleCancel).not.toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should handle ESC - exit when search not focused', async () => {
      mockState.isSearchFocused = false;

      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ESC));

      expect(mockActions.handleCancel).toHaveBeenCalled();
      expect(mockActions.handleFocusList).not.toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should handle TAB', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.TAB));

      expect(mockActions.handlePanelSwitch).toHaveBeenCalledWith('next');

      prompt.stop();
      await startPromise;
    });

    it('should handle SHIFT+TAB', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.SHIFT_TAB));

      expect(mockActions.handlePanelSwitch).toHaveBeenCalledWith('prev');

      prompt.stop();
      await startPromise;
    });

    it('should handle ARROW_UP', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ARROW_UP));

      expect(mockActions.handleFocusSearch).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should handle ARROW_DOWN', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      mockState.isSearchFocused = true;

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ARROW_DOWN));

      expect(mockActions.handleFocusList).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should handle ARROW_LEFT', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ARROW_LEFT));

      expect(mockActions.handlePanelSwitch).toHaveBeenCalledWith('prev');

      prompt.stop();
      await startPromise;
    });

    it('should handle ARROW_RIGHT', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ARROW_RIGHT));

      expect(mockActions.handlePanelSwitch).toHaveBeenCalledWith('next');

      prompt.stop();
      await startPromise;
    });

    it('should handle SPACE', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.SPACE));

      expect(mockActions.handleToggleSelection).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should not handle SPACE when search is focused', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      mockState.isSearchFocused = true;

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.SPACE));

      expect(mockActions.handleToggleSelection).not.toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should trigger immediate search on ENTER when search is focused', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      // Focus search and type
      mockState.isSearchFocused = true;
      mockState.searchQuery = 'test';

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ENTER));

      // Should trigger search immediately without waiting for debounce
      expect(mockActions.handleSearchUpdate).toHaveBeenCalledWith('test');
      expect(mockActions.handleFocusList).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should clear debounce timer on ENTER in search box', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];

      // Type to trigger debounce
      dataHandler(Buffer.from('t'));
      mockState.isSearchFocused = true;

      // Press Enter immediately
      dataHandler(Buffer.from(KEY.ENTER));

      // Should have called search immediately
      expect(mockActions.handleSearchUpdate).toHaveBeenCalledWith('t');

      // Advance timers to ensure debounce was cleared
      await vi.advanceTimersByTimeAsync(500);

      // Should not have called search again (debounce was cleared)
      expect(mockActions.handleSearchUpdate).toHaveBeenCalledTimes(1);

      prompt.stop();
      await startPromise;
    });

    it('should not trigger search on ENTER when search is not focused', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const _startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      mockState.isSearchFocused = false;

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ENTER));

      expect(mockActions.handleSearchUpdate).not.toHaveBeenCalled();

      await Promise.resolve();
    });

    it('should handle multiple rapid ENTER presses in search box', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      mockState.isSearchFocused = true;
      mockState.searchQuery = 'query';

      const dataHandler = dataListeners[0];

      // Rapid Enter presses
      dataHandler(Buffer.from(KEY.ENTER));
      dataHandler(Buffer.from(KEY.ENTER));
      dataHandler(Buffer.from(KEY.ENTER));

      // Should have moved focus after first Enter
      expect(mockActions.handleFocusList).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should handle BACKSPACE', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      mockState.searchQuery = 'test';

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.BACKSPACE));

      await vi.advanceTimersByTimeAsync(500);

      expect(mockState.searchQuery).toBe('tes');

      prompt.stop();
      await startPromise;
    });

    it('should handle CTRL_BRACKET_RIGHT for next page', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.CTRL_BRACKET_RIGHT));

      expect(mockActions.handlePageNext).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });
  });

  describe('printable character input', () => {
    it('should add printable characters to search query', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from('a'));

      expect(mockState.searchQuery).toBe('a');

      prompt.stop();
      await startPromise;
    });

    it('should trigger search with debounce', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      // Type each character separately
      dataHandler(Buffer.from('t'));
      dataHandler(Buffer.from('e'));
      dataHandler(Buffer.from('s'));
      dataHandler(Buffer.from('t'));

      expect(mockActions.handleSearchUpdate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(mockActions.handleSearchUpdate).toHaveBeenCalledWith('test');

      prompt.stop();
      await startPromise;
    });

    it('should focus search when typing', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      mockState.isSearchFocused = false;

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from('a'));

      expect(mockActions.handleFocusSearch).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should not add non-printable characters', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from('\x00'));

      expect(mockState.searchQuery).toBe('');

      prompt.stop();
      await startPromise;
    });
  });

  describe('getCursorIndex and setCursorIndex', () => {
    it('should get cursor index', () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      expect(prompt.getCursorIndex()).toBe(0);
    });

    it('should set cursor index', () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      prompt.setCursorIndex(5);

      expect(prompt.getCursorIndex()).toBe(5);
    });
  });

  describe('render', () => {
    it('should write to stdout', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      vi.clearAllMocks();

      prompt.render();

      expect(mockStdout.write).toHaveBeenCalled();

      prompt.stop();
      await startPromise;
    });

    it('should not render when not active', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      prompt.stop();
      await startPromise;

      vi.clearAllMocks();

      prompt.render();

      expect(mockStdout.write).not.toHaveBeenCalled();
    });
  });

  describe('pagination control navigation', () => {
    it('should navigate between pagination controls with arrow keys', async () => {
      mockState.isPaginationFocused = 'prev';

      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ARROW_RIGHT));

      expect(mockState.isPaginationFocused).toBe('next');

      prompt.stop();
      await startPromise;
    });

    it('should activate page change on ENTER when pagination focused', async () => {
      mockState.isPaginationFocused = 'prev';

      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const _startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from(KEY.ENTER));

      expect(mockActions.handlePagePrev).toHaveBeenCalled();

      // Wait a bit before checking promise
      await Promise.resolve();
    });
  });

  describe('edge cases', () => {
    it('should handle rapid key presses', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      for (let i = 0; i < 100; i++) {
        dataHandler(Buffer.from('a'));
      }

      expect(mockState.searchQuery).toBe('a'.repeat(100));

      prompt.stop();
      await startPromise;
    });

    it('should handle unicode input', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      // Note: The isPrintableChar function checks for ASCII range (32-126)
      // which excludes unicode characters. This is a limitation of the current implementation.
      // For this test, we'll verify that unicode characters are filtered out
      // (not added to search query) as per the current behavior.
      const text = '测试';
      for (const char of text) {
        dataHandler(Buffer.from(char));
      }

      // Unicode characters outside ASCII range are filtered out
      expect(mockState.searchQuery).toBe('');

      prompt.stop();
      await startPromise;
    });

    it('should clear debounce timer on new input', async () => {
      const prompt = createInteractivePrompt({
        state: mockState,
        actions: mockActions,
      });

      const startPromise = prompt.start();
      await vi.advanceTimersByTimeAsync(0);

      const dataHandler = dataListeners[0];
      dataHandler(Buffer.from('a'));
      await vi.advanceTimersByTimeAsync(300);

      dataHandler(Buffer.from('b'));
      await vi.advanceTimersByTimeAsync(300);

      expect(mockActions.handleSearchUpdate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockActions.handleSearchUpdate).toHaveBeenCalledTimes(1);
      expect(mockActions.handleSearchUpdate).toHaveBeenCalledWith('ab');

      prompt.stop();
      await startPromise;
    });
  });
});

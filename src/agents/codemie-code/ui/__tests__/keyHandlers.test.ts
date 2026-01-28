/**
 * Unit tests for key handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleEscapeSequences,
  handleBackspace,
  handlePrintableText,
  handleCtrlC,
  handleShiftEnter,
  handleEnter,
  handleCtrlP,
  handleCtrlH,
  handleCtrlT,
  handleCtrlS,
  handleAltM,
  processKeyInput,
  type InputState,
} from '../keyHandlers.js';
import { CONTROL, NEWLINE, ESC, KEYS } from '../terminalCodes.js';
import type { AssistantSuggestion } from '../autocomplete.js';

// Mock process.stdout.write and process.env
const mockStdoutWrite = vi.fn();
vi.stubGlobal('process', {
  stdout: {
    write: mockStdoutWrite,
  },
  env: {
    CODEMIE_DEBUG: 'false',
  },
});

// Mock console.log
const mockConsoleLog = vi.fn();
vi.stubGlobal('console', {
  log: mockConsoleLog,
});

describe('keyHandlers', () => {
  let mockUI: any;
  let baseState: InputState;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock UI instance
    mockUI = {
      handleHotkey: vi.fn(),
      showHotkeyHelp: vi.fn(),
      showModeStatus: vi.fn(),
      assistantSuggestions: [],
    };

    // Base state
    baseState = {
      currentLine: '',
      lines: [],
      isFirstLine: true,
      autocompleteActive: false,
      autocompleteList: [],
      autocompleteIndex: 0,
      autocompleteStartPos: -1,
      escapeSequence: '',
      images: [],
      ui: mockUI,
    };
  });

  describe('handleCtrlC', () => {
    it('should cancel input and return null', () => {
      const state = { ...baseState };
      const result = handleCtrlC(CONTROL.CTRL_C, state);

      expect(result.handled).toBe(true);
      expect(result.shouldReturn).toBe(true);
      expect(result.value).toBe(null);
      expect(mockStdoutWrite).toHaveBeenCalledWith('\n');
    });

    it('should clear autocomplete if active', () => {
      const state = {
        ...baseState,
        autocompleteActive: true,
        autocompleteList: [{ slug: 'test', name: 'Test' }],
        currentLine: '@test',
      };

      const result = handleCtrlC(CONTROL.CTRL_C, state);

      expect(result.handled).toBe(true);
      expect(mockStdoutWrite).toHaveBeenCalled();
    });
  });

  describe('handleShiftEnter', () => {
    it('should add current line to lines array', () => {
      const state = {
        ...baseState,
        currentLine: 'Hello world',
      };

      const result = handleShiftEnter(NEWLINE.CRLF, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(state.lines).toEqual(['Hello world']);
      expect(state.currentLine).toBe('');
      expect(state.isFirstLine).toBe(false);
      expect(mockStdoutWrite).toHaveBeenCalledWith('\n');
    });

    it('should clear escape sequence', () => {
      const state = {
        ...baseState,
        currentLine: 'Test',
        escapeSequence: ESC,
      };

      handleShiftEnter(NEWLINE.CRLF, state);

      expect(state.escapeSequence).toBe('');
    });
  });

  describe('handleEnter', () => {
    it('should submit message with text', () => {
      const state = {
        ...baseState,
        currentLine: 'Hello',
        lines: ['Line 1'],
      };

      const result = handleEnter(NEWLINE.CR, state);

      expect(result.handled).toBe(true);
      expect(result.shouldReturn).toBe(true);
      expect(result.value).toEqual({
        text: 'Line 1\nHello',
        images: [],
      });
      expect(mockStdoutWrite).toHaveBeenCalledWith('\n');
    });

    it('should return empty string for empty input', () => {
      const state = {
        ...baseState,
        currentLine: '',
        lines: [],
      };

      const result = handleEnter(NEWLINE.CR, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
    });

    it('should select autocomplete when active', () => {
      const assistants: AssistantSuggestion[] = [
        { slug: 'assistant1', name: 'Assistant 1' },
        { slug: 'assistant2', name: 'Assistant 2' },
      ];

      const state = {
        ...baseState,
        currentLine: '@ass',
        autocompleteActive: true,
        autocompleteList: assistants,
        autocompleteIndex: 0,
        autocompleteStartPos: 0,
      };

      const result = handleEnter(NEWLINE.CR, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(state.autocompleteActive).toBe(false);
      expect(state.currentLine).toContain('assistant1');
    });
  });

  describe('handleBackspace', () => {
    it('should remove last character', () => {
      const state = {
        ...baseState,
        currentLine: 'Hello',
      };

      const result = handleBackspace(CONTROL.BACKSPACE, state);

      expect(result.handled).toBe(true);
      expect(state.currentLine).toBe('Hell');
      expect(mockStdoutWrite).toHaveBeenCalledWith('\b \b');
    });

    it('should do nothing on empty line', () => {
      const state = {
        ...baseState,
        currentLine: '',
      };

      const result = handleBackspace(CONTROL.BACKSPACE, state);

      expect(result.handled).toBe(true);
      expect(state.currentLine).toBe('');
    });

    it('should deactivate autocomplete if backspaced to @ position', () => {
      const state = {
        ...baseState,
        currentLine: '@t',
        autocompleteActive: true,
        autocompleteList: [{ slug: 'test', name: 'Test' }],
        autocompleteStartPos: 0,
      };

      // Backspace once - should deactivate because currentLine.length - 1 = 0, which is <= autocompleteStartPos
      handleBackspace(CONTROL.BACKSPACE, state);
      expect(state.currentLine).toBe('@');
      expect(state.autocompleteActive).toBe(false);
    });
  });

  describe('handleCtrlP', () => {
    it('should toggle plan mode', () => {
      const state = { ...baseState };
      const result = handleCtrlP(CONTROL.CTRL_P, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(mockUI.handleHotkey).toHaveBeenCalledWith('toggle-plan-mode');
    });
  });

  describe('handleCtrlH', () => {
    it('should show hotkey help', () => {
      const state = { ...baseState };
      const result = handleCtrlH(CONTROL.CTRL_H, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(mockUI.showHotkeyHelp).toHaveBeenCalled();
    });
  });

  describe('handleCtrlT', () => {
    it('should show todos', () => {
      const state = { ...baseState };
      const result = handleCtrlT(CONTROL.CTRL_T, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(mockUI.handleHotkey).toHaveBeenCalledWith('show-todos');
    });
  });

  describe('handleCtrlS', () => {
    it('should show mode status', () => {
      const state = { ...baseState };
      const result = handleCtrlS(CONTROL.CTRL_S, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(mockUI.showModeStatus).toHaveBeenCalled();
    });
  });

  describe('handleAltM', () => {
    it('should show mode status and clear escape sequence', () => {
      const state = {
        ...baseState,
        escapeSequence: ESC,
      };

      const result = handleAltM('m', state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(state.escapeSequence).toBe('');
      expect(mockUI.showModeStatus).toHaveBeenCalled();
    });
  });

  describe('handleEscapeSequences', () => {
    it('should handle arrow up', () => {
      const state = {
        ...baseState,
        escapeSequence: KEYS.ARROW_UP,
        autocompleteActive: true,
        autocompleteList: [
          { slug: 'test1', name: 'Test 1' },
          { slug: 'test2', name: 'Test 2' },
        ],
        autocompleteIndex: 1,
      };

      const result = handleEscapeSequences('', state);

      expect(result.handled).toBe(true);
      expect(state.escapeSequence).toBe('');
      expect(state.autocompleteIndex).toBe(0); // Moved up from 1 to 0
    });

    it('should handle arrow down', () => {
      const state = {
        ...baseState,
        escapeSequence: KEYS.ARROW_DOWN,
        autocompleteActive: true,
        autocompleteList: [
          { slug: 'test1', name: 'Test 1' },
          { slug: 'test2', name: 'Test 2' },
        ],
        autocompleteIndex: 0,
      };

      const result = handleEscapeSequences('', state);

      expect(result.handled).toBe(true);
      expect(state.escapeSequence).toBe('');
      expect(state.autocompleteIndex).toBe(1); // Moved down from 0 to 1
    });

    it('should handle plain escape key with timeout', async () => {
      const state = {
        ...baseState,
        escapeSequence: ESC,
        autocompleteActive: true,
        autocompleteList: [{ slug: 'test', name: 'Test' }],
      };

      const resultPromise = handleEscapeSequences('', state);

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 60));
      const result = await resultPromise;

      expect(result.handled).toBe(true);
      expect(state.escapeSequence).toBe('');
      expect(state.autocompleteActive).toBe(false);
    });

    it('should return unhandled for no matching sequence', () => {
      const state = {
        ...baseState,
        escapeSequence: '',
      };

      const result = handleEscapeSequences('', state);

      expect(result.handled).toBe(false);
    });
  });

  describe('handlePrintableText', () => {
    it('should add text to current line', () => {
      const state = { ...baseState };
      const result = handlePrintableText('Hello', state);

      expect(result.handled).toBe(true);
      expect(state.currentLine).toBe('Hello');
      expect(mockStdoutWrite).toHaveBeenCalledWith('Hello');
    });

    it('should filter non-printable characters', () => {
      const state = { ...baseState };
      const result = handlePrintableText('Hello\x00\x01World', state);

      expect(result.handled).toBe(true);
      expect(state.currentLine).toBe('HelloWorld');
    });

    it('should allow tabs', () => {
      const state = { ...baseState };
      const result = handlePrintableText('Hello\tWorld', state);

      expect(result.handled).toBe(true);
      expect(state.currentLine).toBe('Hello\tWorld');
    });

    it('should activate autocomplete on @ at word boundary', () => {
      mockUI.assistantSuggestions = [
        { slug: 'assistant1', name: 'Assistant 1' },
        { slug: 'assistant2', name: 'Assistant 2' },
      ];

      const state = { ...baseState };
      handlePrintableText('@', state);

      expect(state.autocompleteActive).toBe(true);
      expect(state.autocompleteList.length).toBeGreaterThan(0);
    });

    it('should not activate autocomplete on @ mid-word', () => {
      const state = {
        ...baseState,
        currentLine: 'email',
      };

      handlePrintableText('@', state);

      expect(state.autocompleteActive).toBe(false);
    });

    it('should deactivate autocomplete on space', () => {
      const state = {
        ...baseState,
        currentLine: '@test',
        autocompleteActive: true,
        autocompleteList: [{ slug: 'test', name: 'Test' }],
      };

      handlePrintableText(' ', state);

      expect(state.autocompleteActive).toBe(false);
    });

    it('should update autocomplete filtering as user types', () => {
      mockUI.assistantSuggestions = [
        { slug: 'alice', name: 'Alice' },
        { slug: 'bob', name: 'Bob' },
        { slug: 'alex', name: 'Alex' },
      ];

      const state = {
        ...baseState,
        currentLine: '@al',
        autocompleteActive: true,
        autocompleteList: mockUI.assistantSuggestions,
        autocompleteStartPos: 0,
      };

      handlePrintableText('i', state); // Now @ali

      // Should filter to only 'alice'
      expect(state.autocompleteList.some(a => a.slug === 'alice')).toBe(true);
      expect(state.autocompleteList.some(a => a.slug === 'bob')).toBe(false);
    });

    it('should return unhandled for empty printable data', () => {
      const state = { ...baseState };
      const result = handlePrintableText('\x00\x01', state);

      expect(result.handled).toBe(false);
      expect(state.currentLine).toBe('');
    });
  });

  describe('processKeyInput', () => {
    it('should process escape sequences first (highest priority)', async () => {
      const state = {
        ...baseState,
        escapeSequence: KEYS.ARROW_UP,
        autocompleteActive: true,
        autocompleteList: [
          { slug: 'test1', name: 'Test 1' },
          { slug: 'test2', name: 'Test 2' },
        ],
        autocompleteIndex: 1,
      };

      const result = await processKeyInput('', state);

      expect(result.handled).toBe(true);
      expect(state.autocompleteIndex).toBe(0);
    });

    it('should process critical keys (Ctrl+C)', async () => {
      const state = { ...baseState };
      const result = await processKeyInput(CONTROL.CTRL_C, state);

      expect(result.handled).toBe(true);
      expect(result.shouldReturn).toBe(true);
      expect(result.value).toBe(null);
    });

    it('should process medium priority keys (Ctrl+P)', async () => {
      const state = { ...baseState };
      const result = await processKeyInput(CONTROL.CTRL_P, state);

      expect(result.handled).toBe(true);
      expect(result.shouldRewritePrompt).toBe(true);
      expect(mockUI.handleHotkey).toHaveBeenCalledWith('toggle-plan-mode');
    });

    it('should process fallback (printable text)', async () => {
      const state = { ...baseState };
      const result = await processKeyInput('Hello', state);

      expect(result.handled).toBe(true);
      expect(state.currentLine).toBe('Hello');
    });

    it('should return unhandled for unmatched input', async () => {
      const state = {
        ...baseState,
        escapeSequence: '', // No escape sequence
      };

      // Non-printable, non-control character
      const result = await processKeyInput('\x00', state);

      expect(result.handled).toBe(false);
    });

    it('should respect priority order (CRITICAL before MEDIUM)', async () => {
      // If both Ctrl+C and another handler could match, Ctrl+C wins
      const state = { ...baseState };
      const result = await processKeyInput(CONTROL.CTRL_C, state);

      expect(result.handled).toBe(true);
      expect(result.value).toBe(null); // Ctrl+C behavior
      expect(mockUI.handleHotkey).not.toHaveBeenCalled(); // Medium priority not reached
    });
  });

  describe('integration scenarios', () => {
    it('should handle full autocomplete flow', async () => {
      mockUI.assistantSuggestions = [
        { slug: 'assistant1', name: 'Assistant 1' },
        { slug: 'assistant2', name: 'Assistant 2' },
      ];

      const state = { ...baseState };

      // Type @
      await processKeyInput('@', state);
      expect(state.autocompleteActive).toBe(true);

      // Type 'a'
      await processKeyInput('a', state);
      expect(state.autocompleteActive).toBe(true);

      // Arrow down to select second item
      state.escapeSequence = KEYS.ARROW_DOWN;
      await processKeyInput('', state);
      expect(state.autocompleteIndex).toBe(1);

      // Press Enter to select
      await processKeyInput(NEWLINE.CR, state);
      expect(state.autocompleteActive).toBe(false);
      expect(state.currentLine).toContain('assistant2');
    });

    it('should handle multiline input', async () => {
      const state = { ...baseState };

      // Type first line
      await processKeyInput('Line 1', state);
      expect(state.currentLine).toBe('Line 1');

      // Shift+Enter
      await processKeyInput(NEWLINE.CRLF, state);
      expect(state.lines).toEqual(['Line 1']);
      expect(state.currentLine).toBe('');

      // Type second line
      await processKeyInput('Line 2', state);
      expect(state.currentLine).toBe('Line 2');

      // Regular Enter to submit
      const result = await processKeyInput(NEWLINE.CR, state);
      expect(result.value).toEqual({
        text: 'Line 1\nLine 2',
        images: [],
      });
    });

    it('should handle cancel during autocomplete', async () => {
      mockUI.assistantSuggestions = [{ slug: 'test', name: 'Test' }];

      const state = { ...baseState };

      // Activate autocomplete
      await processKeyInput('@', state);
      expect(state.autocompleteActive).toBe(true);

      // Press Ctrl+C
      const result = await processKeyInput(CONTROL.CTRL_C, state);
      expect(result.value).toBe(null);
    });
  });
});

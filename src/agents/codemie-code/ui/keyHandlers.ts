/**
 * Key Handler Registry
 *
 * Declarative key handling system using priority-based handler matching.
 * Replaces nested if-statements with a clean registry pattern.
 */

import type { ClipboardImage } from '@/utils/clipboard.js';
import { hasClipboardImage, getClipboardImage } from '@/utils/clipboard.js';
import type { CodeMieTerminalUI } from '../ui.js';
import type { AssistantSuggestion } from './autocomplete.js';
import {
  parseAutocompleteQuery,
  filterAssistants,
  renderAutocompleteUI,
  clearAutocompleteUI,
  navigateUp,
  navigateDown,
} from './autocomplete.js';
import { ESC, CONTROL, NEWLINE, startsWithEscape, isKey } from './terminalCodes.js';
import { logger } from '@/utils/logger.js';

/**
 * Input state consolidated into single object for handler access
 */
export interface InputState {
  // Current input
  currentLine: string;
  lines: string[];
  isFirstLine: boolean;

  // Autocomplete state
  autocompleteActive: boolean;
  autocompleteList: AssistantSuggestion[];
  autocompleteIndex: number;
  autocompleteStartPos: number;

  // Escape sequence tracking
  escapeSequence: string;

  // Image attachments
  images: ClipboardImage[];

  // UI reference for callbacks
  ui: CodeMieTerminalUI;
}

/**
 * Result returned by key handlers
 */
export interface HandlerResult {
  /** Whether this handler processed the key */
  handled: boolean;

  /** Whether to return from input loop (submit/cancel) */
  shouldReturn?: boolean;

  /** Value to return when shouldReturn is true */
  value?: { text: string; images: ClipboardImage[] } | null;

  /** Whether to rewrite the prompt and current line */
  shouldRewritePrompt?: boolean;
}

/**
 * Priority levels for handler execution order
 */
export type Priority = 'ESCAPE_SEQ' | 'CRITICAL' | 'MEDIUM' | 'FALLBACK';

/**
 * Key handler definition
 */
export interface KeyHandler {
  /** Handler name for debugging */
  name: string;

  /** Condition to match this handler */
  match: (data: string, state: InputState) => boolean;

  /** Action to perform when matched */
  action: (data: string, state: InputState) => HandlerResult | Promise<HandlerResult>;
}

/**
 * Handle escape sequences (arrow keys, plain escape, incomplete sequences)
 */
export function handleEscapeSequences(data: string, state: InputState): HandlerResult | Promise<HandlerResult> {
  const { escapeSequence } = state;

  // Arrow Up
  if (isKey(escapeSequence, 'ARROW_UP')) {
    state.escapeSequence = '';
    if (state.autocompleteActive && state.autocompleteList.length > 0) {
      state.autocompleteIndex = navigateUp(state.autocompleteIndex, state.autocompleteList.length);
      const output = clearAutocompleteUI(state.autocompleteList.length, state.currentLine) +
                     renderAutocompleteUI(state.autocompleteList, state.autocompleteIndex, state.currentLine);
      process.stdout.write(output);
    }
    return { handled: true };
  }

  // Arrow Down
  if (isKey(escapeSequence, 'ARROW_DOWN')) {
    state.escapeSequence = '';
    if (state.autocompleteActive && state.autocompleteList.length > 0) {
      state.autocompleteIndex = navigateDown(state.autocompleteIndex, state.autocompleteList.length);
      const output = clearAutocompleteUI(state.autocompleteList.length, state.currentLine) +
                     renderAutocompleteUI(state.autocompleteList, state.autocompleteIndex, state.currentLine);
      process.stdout.write(output);
      logger.debug('[Autocomplete] Arrow Down - new index:', state.autocompleteIndex);
    }
    return { handled: true };
  }

  // Plain Escape key (deactivate autocomplete)
  if (escapeSequence === ESC) {
    return new Promise<HandlerResult>((resolve) => {
      setTimeout(() => {
        if (state.escapeSequence === ESC) {
          state.escapeSequence = '';
          if (state.autocompleteActive) {
            const output = clearAutocompleteUI(state.autocompleteList.length, state.currentLine);
            process.stdout.write(output);
            state.autocompleteActive = false;
            state.autocompleteList = [];
          }
        }
        resolve({ handled: true });
      }, 50);
    });
  }

  // Incomplete or unrecognized escape sequences
  if (escapeSequence.length > 0 && escapeSequence.length < 5) {
    return new Promise<HandlerResult>((resolve) => {
      setTimeout(() => {
        if (state.escapeSequence.length > 0 && state.escapeSequence.length < 5) {
          state.escapeSequence = '';
        }
        resolve({ handled: true });
      }, 50);
    });
  }

  return { handled: false };
}

/**
 * Handle backspace/delete key
 */
export function handleBackspace(data: string, state: InputState): HandlerResult {
  if (state.currentLine.length > 0) {
    state.currentLine = state.currentLine.slice(0, -1);
    process.stdout.write('\b \b');

    // Update autocomplete if active
    if (state.autocompleteActive) {
      // Parse the current query
      const queryResult = parseAutocompleteQuery(state.currentLine);

      // Deactivate if we backspaced past @ or if query is empty (just @ remaining)
      if (!queryResult.hasQuery || queryResult.query.length === 0) {
        const output = clearAutocompleteUI(state.autocompleteList.length, state.currentLine);
        process.stdout.write(output);
        state.autocompleteActive = false;
        state.autocompleteList = [];
      } else {
        // Update autocomplete filtering
        const assistants = state.ui['assistantSuggestions'] || [];
        state.autocompleteList = filterAssistants(queryResult.query, assistants);
        const output = clearAutocompleteUI(state.autocompleteList.length + 1, state.currentLine) +
                       renderAutocompleteUI(state.autocompleteList, state.autocompleteIndex, state.currentLine);
        process.stdout.write(output);
      }
    }
  }

  return { handled: true };
}

/**
 * Handle Tab key (autocomplete selection or clipboard image insertion)
 */
export async function handleTab(data: string, state: InputState): Promise<HandlerResult> {
  // If autocomplete is active, select the current item
  if (state.autocompleteActive && state.autocompleteList.length > 0) {
    selectAutocomplete(state);
    return { handled: true, shouldRewritePrompt: true };
  }

  // Otherwise, handle clipboard image insertion
  const hasImage = await hasClipboardImage();
  if (hasImage) {
    const image = await getClipboardImage();
    if (image) {
      state.images.push(image);
      const imageIndicator = `[Image ${state.images.length}] `;
      state.currentLine += imageIndicator;
      process.stdout.write(imageIndicator);

      console.log(`\n📸 Image ${state.images.length} inserted from clipboard (${image.mimeType})`);
      return { handled: true, shouldRewritePrompt: true };
    }
  }

  return { handled: true };
}

/**
 * Handle Ctrl+C (cancel input)
 */
export function handleCtrlC(data: string, state: InputState): HandlerResult {
  process.stdout.write('\n');
  if (state.autocompleteActive) {
    const output = clearAutocompleteUI(state.autocompleteList.length, '');
    process.stdout.write(output);
  }
  return { handled: true, shouldReturn: true, value: null };
}

/**
 * Handle Shift+Enter (add new line)
 */
export function handleShiftEnter(data: string, state: InputState): HandlerResult {
  state.lines.push(state.currentLine);
  state.currentLine = '';
  state.isFirstLine = false;
  process.stdout.write('\n');
  state.escapeSequence = '';
  return { handled: true, shouldRewritePrompt: true };
}

/**
 * Handle Enter key (submit or autocomplete selection)
 */
export function handleEnter(data: string, state: InputState): HandlerResult {
  // If autocomplete is active, select the item
  if (state.autocompleteActive && state.autocompleteList.length > 0) {
    selectAutocomplete(state);
    return { handled: true, shouldRewritePrompt: true };
  }

  // Empty input
  if (state.currentLine.trim() === '' && state.lines.length === 0) {
    return { handled: true, shouldRewritePrompt: true };
  }

  // Send the message
  if (state.currentLine.trim() !== '') {
    state.lines.push(state.currentLine);
  }

  process.stdout.write('\n');

  const finalText = state.lines.join('\n');
  const finalImages = state.images;

  return {
    handled: true,
    shouldReturn: true,
    value: { text: finalText, images: finalImages },
  };
}

/**
 * Handle Ctrl+P (toggle plan mode)
 */
export function handleCtrlP(data: string, state: InputState): HandlerResult {
  state.ui.handleHotkey('toggle-plan-mode');
  return { handled: true, shouldRewritePrompt: true };
}

/**
 * Handle Ctrl+H (show hotkey help)
 */
export function handleCtrlH(data: string, state: InputState): HandlerResult {
  state.ui.showHotkeyHelp();
  return { handled: true, shouldRewritePrompt: true };
}

/**
 * Handle Ctrl+T (show todos)
 */
export function handleCtrlT(data: string, state: InputState): HandlerResult {
  state.ui.handleHotkey('show-todos');
  return { handled: true, shouldRewritePrompt: true };
}

/**
 * Handle Ctrl+S (show mode status)
 */
export function handleCtrlS(data: string, state: InputState): HandlerResult {
  state.ui.showModeStatus();
  return { handled: true, shouldRewritePrompt: true };
}

/**
 * Handle Alt+M (show mode status alternative)
 */
export function handleAltM(data: string, state: InputState): HandlerResult {
  state.ui.showModeStatus();
  state.escapeSequence = '';
  return { handled: true, shouldRewritePrompt: true };
}

/**
 * Check if @ character should trigger autocomplete
 */
function shouldActivateAutocomplete(currentLine: string, printableData: string): boolean {
  if (!printableData.includes('@')) {
    return false;
  }

  const atPos = currentLine.lastIndexOf('@');
  const beforeAt = atPos > 0 ? currentLine[atPos - 1] : ' ';
  const isWordBoundary = beforeAt === ' ' || beforeAt === '\n' || atPos === 0;

  return isWordBoundary;
}

/**
 * Activate autocomplete for @ mentions
 */
function activateAutocomplete(state: InputState): void {
  const queryResult = parseAutocompleteQuery(state.currentLine);
  if (!queryResult.hasQuery) {
    return;
  }

  const assistants = state.ui['assistantSuggestions'] || [];
  state.autocompleteList = filterAssistants(queryResult.query, assistants);
  state.autocompleteActive = state.autocompleteList.length > 0;
  state.autocompleteIndex = 0;
  state.autocompleteStartPos = queryResult.startPosition;

  if (state.autocompleteActive) {
    const output = renderAutocompleteUI(state.autocompleteList, state.autocompleteIndex, state.currentLine);
    process.stdout.write(output);
  }
}

/**
 * Deactivate autocomplete
 */
function deactivateAutocomplete(state: InputState): void {
  const output = clearAutocompleteUI(state.autocompleteList.length, state.currentLine);
  process.stdout.write(output);
  state.autocompleteActive = false;
  state.autocompleteList = [];
}

/**
 * Select autocomplete suggestion and update input line
 */
function selectAutocomplete(state: InputState): void {
  const selectedAssistant = state.autocompleteList[state.autocompleteIndex];

  // Calculate new line with selected suggestion
  const atPos = state.autocompleteStartPos;
  const beforeAt = state.currentLine.slice(0, atPos);
  const newLine = `${beforeAt}@${selectedAssistant.slug} `;

  // Clear autocomplete dropdown lines
  for (let i = 0; i < state.autocompleteList.length; i++) {
    process.stdout.write('\n\x1b[2K'); // Move down and clear line
  }
  // Move cursor back up
  process.stdout.write(`\x1b[${state.autocompleteList.length}A`);

  // Update state
  state.currentLine = newLine;
  state.autocompleteActive = false;
  state.autocompleteList = [];
}

/**
 * Update autocomplete filtering as user types
 */
function updateAutocompleteFiltering(state: InputState): void {
  const queryResult = parseAutocompleteQuery(state.currentLine);
  if (!queryResult.hasQuery) {
    return;
  }

  const assistants = state.ui['assistantSuggestions'] || [];
  state.autocompleteList = filterAssistants(queryResult.query, assistants);
  state.autocompleteIndex = 0;

  if (state.autocompleteList.length === 0) {
    const output = clearAutocompleteUI(1, state.currentLine);
    process.stdout.write(output);
    state.autocompleteActive = false;
  } else {
    const output = clearAutocompleteUI(state.autocompleteList.length + 1, state.currentLine) +
                   renderAutocompleteUI(state.autocompleteList, state.autocompleteIndex, state.currentLine);
    process.stdout.write(output);
  }
}

/**
 * Handle printable text input and paste
 */
export function handlePrintableText(data: string, state: InputState): HandlerResult {
  // Filter to printable characters and tabs
  const printableData = data.split('').filter(char =>
    (char.codePointAt(0) ?? 0) >= 32 || char === CONTROL.TAB
  ).join('');

  if (printableData.length === 0) {
    return { handled: false };
  }

  state.currentLine += printableData;
  process.stdout.write(printableData);

  // Handle @ character for autocomplete activation
  if (!state.autocompleteActive && shouldActivateAutocomplete(state.currentLine, printableData)) {
    activateAutocomplete(state);
    return { handled: true };
  }

  // Handle space to deactivate autocomplete
  if (state.autocompleteActive && printableData.includes(' ')) {
    deactivateAutocomplete(state);
    return { handled: true };
  }

  // Update autocomplete filtering if active
  if (state.autocompleteActive) {
    updateAutocompleteFiltering(state);
  }

  return { handled: true };
}

/**
 * Key handler registry organized by priority
 */
export const keyHandlers: Record<Priority, KeyHandler[]> = {
  // Process escape sequences first (highest priority)
  ESCAPE_SEQ: [
    {
      name: 'escape-sequences',
      match: (data, state) => state.escapeSequence.length > 0,
      action: handleEscapeSequences,
    },
  ],

  // Critical keys that must be processed before others
  CRITICAL: [
    {
      name: 'ctrl-c',
      match: (data) => data === CONTROL.CTRL_C,
      action: handleCtrlC,
    },
    {
      name: 'backspace',
      match: (data) => data === CONTROL.DELETE || data === CONTROL.BACKSPACE,
      action: handleBackspace,
    },
    {
      name: 'shift-enter',
      match: (data, state) =>
        data === NEWLINE.CRLF ||
        data === NEWLINE.LFCR ||
        (!!state.escapeSequence && data === NEWLINE.CR),
      action: handleShiftEnter,
    },
    {
      name: 'enter',
      match: (data) => data === NEWLINE.CR || data === NEWLINE.LF,
      action: handleEnter,
    },
  ],

  // Medium priority keys (hotkeys and special functions)
  MEDIUM: [
    {
      name: 'ctrl-p',
      match: (data) => data === CONTROL.CTRL_P,
      action: handleCtrlP,
    },
    {
      name: 'ctrl-h',
      match: (data) => data === CONTROL.CTRL_H,
      action: handleCtrlH,
    },
    {
      name: 'ctrl-t',
      match: (data) => data === CONTROL.CTRL_T,
      action: handleCtrlT,
    },
    {
      name: 'ctrl-s',
      match: (data) => data === CONTROL.CTRL_S,
      action: handleCtrlS,
    },
    {
      name: 'alt-m',
      match: (data, state) => data === 'm' && state.escapeSequence.includes(ESC),
      action: handleAltM,
    },
    {
      name: 'tab',
      match: (data) => data === CONTROL.CTRL_I,
      action: handleTab,
    },
  ],

  // Fallback handler for normal text input
  FALLBACK: [
    {
      name: 'printable-text',
      match: (data, state) =>
        !startsWithEscape(data) &&
        state.escapeSequence.length === 0 &&
        (data.length > 1 || (data.length === 1 && ((data.codePointAt(0) ?? 0) >= 32 || data === CONTROL.TAB))),
      action: handlePrintableText,
    },
  ],
};

/**
 * Process key input through handler registry
 */
export async function processKeyInput(data: string, state: InputState): Promise<HandlerResult> {
  const priorities: Priority[] = ['ESCAPE_SEQ', 'CRITICAL', 'MEDIUM', 'FALLBACK'];

  for (const priority of priorities) {
    const handlers = keyHandlers[priority];

    for (const handler of handlers) {
      if (handler.match(data, state)) {
        const result = await handler.action(data, state);
        if (result.handled) {
          return result;
        }
      }
    }
  }

  // No handler matched
  return { handled: false };
}

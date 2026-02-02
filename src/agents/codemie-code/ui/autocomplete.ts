/**
 * Autocomplete Utilities
 *
 * Handles assistant mention autocomplete logic including filtering, rendering,
 * and selection. Provides pure functions for testability and separation of concerns.
 */

import { highlightMention } from './mentions.js';
import { CURSOR, CLEAR, NEWLINE } from './terminalCodes.js';

/** Maximum number of suggestions to display */
export const MAX_SUGGESTIONS = 10;

/** Trigger character for autocomplete */
export const AUTOCOMPLETE_TRIGGER = '@';

/** Assistant suggestion for autocomplete */
export interface AssistantSuggestion {
  slug: string;
  name: string;
}

/** Autocomplete state */
export interface AutocompleteState {
  active: boolean;
  items: AssistantSuggestion[];
  selectedIndex: number;
  startPosition: number;
  query: string;
}

/** Result of parsing autocomplete query from input */
export interface AutocompleteQuery {
  hasQuery: boolean;
  query: string;
  startPosition: number;
}

/**
 * Parse autocomplete query from current line
 * Looks for @ symbol and extracts the query after it
 *
 * @param line - Current input line
 * @param cursorPos - Current cursor position (optional, defaults to end of line)
 * @returns Parsed query information
 */
export function parseAutocompleteQuery(line: string, cursorPos?: number): AutocompleteQuery {
  const pos = cursorPos ?? line.length;

  // Find the last @ before cursor position
  let atPos = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (line[i] === AUTOCOMPLETE_TRIGGER) {
      atPos = i;
      break;
    }
    // Stop at whitespace - @ must be in current word
    if (line[i] === ' ' || line[i] === NEWLINE.LF) {
      break;
    }
  }

  if (atPos === -1) {
    return { hasQuery: false, query: '', startPosition: -1 };
  }

  const query = line.slice(atPos + 1, pos);
  return { hasQuery: true, query, startPosition: atPos };
}

/**
 * Filter assistants based on query string
 * Uses case-insensitive substring matching on slug
 *
 * @param query - Search query (without @ prefix)
 * @param assistants - List of available assistants
 * @param maxResults - Maximum number of results (default: MAX_SUGGESTIONS)
 * @returns Filtered and limited list of assistants
 */
export function filterAssistants(
  query: string,
  assistants: AssistantSuggestion[],
  maxResults: number = MAX_SUGGESTIONS
): AssistantSuggestion[] {
  const lowerQuery = query.toLowerCase();

  const filtered = assistants.filter(a =>
    a.slug.toLowerCase().includes(lowerQuery)
  );

  return filtered.slice(0, maxResults);
}

/**
 * Render autocomplete UI as a string
 * Returns ANSI escape sequences for terminal display
 *
 * @param assistants - Assistants to display
 * @param selectedIndex - Currently selected index
 * @param currentLine - Current input line for cursor positioning
 * @returns String with ANSI codes for rendering
 */
export function renderAutocompleteUI(
  assistants: AssistantSuggestion[],
  selectedIndex: number,
  currentLine: string
): string {
  let output = '';

  // Render each assistant as a line below current position
  assistants.forEach((assistant, index) => {
    const isSelected = index === selectedIndex;
    const assistantText = isSelected
      ? highlightMention(`${assistant.slug} - ${assistant.name}`)
      : `${assistant.slug} - ${assistant.name}`;

    output += '\n  ' + assistantText + CLEAR.toEndOfLine;
  });

  // Move cursor back up to the input line
  output += CURSOR.up(assistants.length);
  // Position cursor at the end of the current input
  output += `${CURSOR.toLineStart}> ${currentLine}`;

  return output;
}

/**
 * Clear autocomplete UI display
 * Returns ANSI escape sequences to clear N lines below current line
 *
 * @param lineCount - Number of lines to clear
 * @param currentLine - Current input line for prompt restoration
 * @returns String with ANSI codes for clearing
 */
export function clearAutocompleteUI(lineCount: number, currentLine: string): string {
  if (lineCount === 0) return '';

  let output = '';

  // Move down and clear each line
  for (let i = 0; i < lineCount; i++) {
    output += '\n' + CLEAR.entireLine;
  }

  // Move cursor back up to input line
  output += CURSOR.up(lineCount);
  // Rewrite the prompt to keep it visible
  output += `${CURSOR.toLineStart}> ${currentLine}`;

  return output;
}

/**
 * Calculate text replacement for autocomplete selection
 * Returns the new line text after inserting selected suggestion
 *
 * @param selectedSlug - Slug of selected assistant
 * @param currentLine - Current input line
 * @param startPosition - Position where @ was typed
 * @returns Object with new line text and backspace count needed
 */
export function selectSuggestion(
  selectedSlug: string,
  currentLine: string,
  startPosition: number
): { newLine: string; backspaceCount: number; insertText: string } {
  // Calculate what text was after @ (the partial query)
  const afterAt = currentLine.slice(startPosition + 1);
  const backspaceCount = afterAt.length;

  // Build new line: everything up to and including @, then selected slug with space
  const beforeAt = currentLine.slice(0, startPosition + 1);
  const insertText = `${selectedSlug} `;
  const newLine = beforeAt + insertText;

  return { newLine, backspaceCount, insertText };
}

/**
 * Navigate autocomplete selection up
 *
 * @param currentIndex - Current selected index
 * @param listLength - Length of suggestions list
 * @returns New selected index
 */
export function navigateUp(currentIndex: number, listLength: number): number {
  if (listLength === 0) return 0;
  return currentIndex > 0 ? currentIndex - 1 : listLength - 1;
}

/**
 * Navigate autocomplete selection down
 *
 * @param currentIndex - Current selected index
 * @param listLength - Length of suggestions list
 * @returns New selected index
 */
export function navigateDown(currentIndex: number, listLength: number): number {
  if (listLength === 0) return 0;
  return currentIndex < listLength - 1 ? currentIndex + 1 : 0;
}

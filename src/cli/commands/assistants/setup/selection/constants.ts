/**
 * UI Constants
 *
 * All magic strings, ANSI codes, and configuration values for the selection UI
 */

// ANSI Escape Codes
export const ANSI = {
  CURSOR_HOME_CLEAR: '\x1b[H\x1b[J',
  CLEAR_LINE_ABOVE: '\x1b[1A\x1b[2K',
} as const;

// Key Codes
export const KEY = {
  CTRL_C: '\u0003',
  ESC: '\u001b',
  TAB: '\t',
  SHIFT_TAB: '\u001b[Z',
  ENTER: '\r',
  NEWLINE: '\n',
  ARROW_UP: '\u001b[A',
  ARROW_DOWN: '\u001b[B',
  ARROW_LEFT: '\u001b[D',
  ARROW_RIGHT: '\u001b[C',
  CTRL_BRACKET_LEFT: '\u001b',
  CTRL_BRACKET_RIGHT: '\u001d',
  SPACE: ' ',
  BACKSPACE: '\u007f',
  BACKSPACE_ALT: '\b',
} as const;

// Box Drawing Characters
export const BOX = {
  TOP_LEFT: '╭',
  TOP_RIGHT: '╮',
  BOTTOM_LEFT: '╰',
  BOTTOM_RIGHT: '╯',
  HORIZONTAL: '─',
  VERTICAL: '│',
} as const;

// UI Symbols
export const SYMBOL = {
  SEARCH_ICON: '⌕',
  CURSOR: '█',
  CIRCLE_FILLED: '◉',
  CIRCLE_EMPTY: '◯',
  CURSOR_INDICATOR: '› ',
  TRUNCATION: '...',
} as const;

// Pagination Controls
export const PAGINATION_CONTROL = {
  PREV: 'prev',
  NEXT: 'next',
} as const;

export type PaginationControl = typeof PAGINATION_CONTROL[keyof typeof PAGINATION_CONTROL];

// UI Text
export const TEXT = {
  LABEL: 'Assistants',
  TAB_HINT: '(←/→, tab/shift+tab to cycle)',
  SEARCH_PLACEHOLDER: 'Search…',
  INSTRUCTIONS: '↑↓ to Navigate • Space to select item • Enter to Confirm',
  INSTRUCTIONS_WITH_PAGINATION: '↑↓ to Navigate • Ctrl+[/] to change page • Space to select item • Enter to Confirm',
  NO_ASSISTANTS: 'No assistants found.',
  ERROR_PREFIX: 'Error: ',
  CONTINUE_BUTTON: 'Continue',
  CANCEL_BUTTON: 'Cancel',
} as const;

// Config Values
export const CONFIG = {
  ITEMS_PER_PAGE: 5,
  FETCH_TIMEOUT_MS: 10000,
  DESCRIPTION_MAX_LENGTH: 80,
  KEEP_ALIVE_INTERVAL_MS: 1000,
  SEARCH_DEBOUNCE_MS: 500,
  PRINTABLE_CHAR_MIN: 32,
  PRINTABLE_CHAR_MAX: 126,
} as const;

// Panel IDs
export const PANEL_ID = {
  REGISTERED: 'registered',
  PROJECT: 'project',
  MARKETPLACE: 'marketplace'
} as const;

export const PANEL_IDS = [
  PANEL_ID.REGISTERED,
  PANEL_ID.PROJECT,
  PANEL_ID.MARKETPLACE
] as const;

export type PanelId = typeof PANEL_IDS[number];

// API Scope values (from SDK)
export const API_SCOPE = {
  VISIBLE_TO_USER: 'visible_to_user',
  MARKETPLACE: 'marketplace'
} as const;

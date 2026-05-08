import chalk from 'chalk';
import type { BasePanelState, BaseSelectionState } from './types.js';
import { BOX, SYMBOL, SHARED_TEXT, PAGINATION_CONTROL, type PaginationControl } from './constants.js';
import { COLOR } from '../constants.js';

export function buildTopLine(): string {
  const width = process.stdout.columns || 80;
  const line = BOX.HORIZONTAL.repeat(width);
  return chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(line) + '\n';
}

export function buildPanelHeader(panels: BasePanelState[], activeId: string, label: string): string {
  const panelStrings = panels.map(panel => {
    if (panel.id === activeId) {
      return chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${panel.label} `);
    }
    return chalk.white(panel.label);
  });

  const styledLabel = chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(label);
  const panelsLine = panelStrings.join('   ');
  const hint = chalk.dim(SHARED_TEXT.TAB_HINT);

  return `${styledLabel}   ${panelsLine}   ${hint}\n\n`;
}

export function buildSearchInput(query: string, isFocused: boolean): string {
  const width = process.stdout.columns || 80;
  const innerWidth = width - 2;

  const prefix = ` ${SYMBOL.SEARCH_ICON} `;
  const contentText = query
    ? (isFocused ? query + SYMBOL.CURSOR : query)
    : SHARED_TEXT.SEARCH_PLACEHOLDER;
  const visualLength = prefix.length + contentText.length;
  const paddingNeeded = innerWidth - visualLength;

  const styledCursor = chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR);
  const styledPlaceholder = chalk.dim(SHARED_TEXT.SEARCH_PLACEHOLDER);
  const displayText = query
    ? (isFocused ? query + styledCursor : query)
    : styledPlaceholder;

  const contentLine = prefix + displayText + ' '.repeat(Math.max(0, paddingNeeded));

  const borderColor = isFocused
    ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)
    : chalk.white;

  let output = '';
  output += borderColor(BOX.TOP_LEFT + BOX.HORIZONTAL.repeat(innerWidth) + BOX.TOP_RIGHT) + '\n';
  output += borderColor(BOX.VERTICAL) + contentLine + borderColor(BOX.VERTICAL) + '\n';
  output += borderColor(BOX.BOTTOM_LEFT + BOX.HORIZONTAL.repeat(innerWidth) + BOX.BOTTOM_RIGHT) + '\n\n';
  return output;
}

export function buildPaginationControls(
  activePanel: BasePanelState,
  isPaginationFocused: PaginationControl | null,
  isSearchFocused: boolean
): string {
  const totalPages = activePanel.totalPages;

  if (totalPages <= 1) {
    return '';
  }

  const currentPage = activePanel.currentPage;
  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;

  const prevLabel = '[< Prev]';
  const prevCursor = isPaginationFocused === PAGINATION_CONTROL.PREV && !isSearchFocused
    ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR_INDICATOR)
    : '  ';
  const prevText = isPaginationFocused === PAGINATION_CONTROL.PREV && !isSearchFocused
    ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(prevLabel)
    : hasPrev
      ? chalk.white(prevLabel)
      : chalk.dim(prevLabel);

  const nextLabel = '[Next >]';
  const nextCursor = isPaginationFocused === PAGINATION_CONTROL.NEXT && !isSearchFocused
    ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR_INDICATOR)
    : '  ';
  const nextText = isPaginationFocused === PAGINATION_CONTROL.NEXT && !isSearchFocused
    ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(nextLabel)
    : hasNext
      ? chalk.white(nextLabel)
      : chalk.dim(nextLabel);

  const label = chalk.dim('Switch page:');
  return `${label} ${prevCursor}${prevText}    ${nextCursor}${nextText}\n\n`;
}

export function buildButtons(state: Pick<BaseSelectionState, 'areNavigationButtonsFocused' | 'focusedButton' | 'isSearchFocused' | 'isPaginationFocused'>): string {
  const { areNavigationButtonsFocused, focusedButton, isSearchFocused, isPaginationFocused } = state;
  const buttonsActive = areNavigationButtonsFocused && !isSearchFocused && isPaginationFocused === null;

  const continueButton = buttonsActive && focusedButton === 'continue'
    ? chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${SHARED_TEXT.CONTINUE_BUTTON} `)
    : chalk.dim(`[${SHARED_TEXT.CONTINUE_BUTTON}]`);

  const cancelButton = buttonsActive && focusedButton === 'cancel'
    ? chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${SHARED_TEXT.CANCEL_BUTTON} `)
    : chalk.dim(`[${SHARED_TEXT.CANCEL_BUTTON}]`);

  return `  ${continueButton}  ${cancelButton}\n\n`;
}

export function buildInstructions(activePanel: BasePanelState): string {
  const hasMultiplePages = activePanel.totalPages > 1;

  const instructionsText = hasMultiplePages
    ? SHARED_TEXT.INSTRUCTIONS_WITH_PAGINATION
    : SHARED_TEXT.INSTRUCTIONS;

  return chalk.dim(instructionsText + '\n');
}

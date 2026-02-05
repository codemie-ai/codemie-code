/**
 * UI Rendering
 *
 * All UI building and rendering functions
 */

import chalk from 'chalk';
import type { PanelState, SelectionState } from './types.js';
import { ANSI, BOX, SYMBOL, TEXT, CONFIG, PAGINATION_CONTROL, type PanelId, type PaginationControl } from './constants.js';
import { COLOR } from '../constants.js';

/**
 * Render the complete UI
 */
export function renderUI(state: SelectionState, cursorIndex: number): string {
  const activePanel = state.panels.find(p => p.id === state.activePanelId)!;

  let output = '';

  output += ANSI.CURSOR_HOME_CLEAR;
  output += buildTopLine();
  output += buildPanelHeader(state.panels, state.activePanelId);
  output += buildCount(activePanel);
  output += buildSearchInput(state.searchQuery, state.isSearchFocused);
  output += buildAssistantsList(activePanel, state.selectedIds, state.isSearchFocused, cursorIndex, state.isPaginationFocused);
  output += buildPaginationControls(activePanel, state.isPaginationFocused, state.isSearchFocused);
  output += buildButtons(state);
  output += buildInstructions(activePanel);

  return output;
}

/**
 * Build top line spanning terminal width
 */
function buildTopLine(): string {
  const width = process.stdout.columns || 80;
  const line = BOX.HORIZONTAL.repeat(width);
  return chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(line) + '\n';
}

/**
 * Build panel navigation header with hint
 */
function buildPanelHeader(panels: PanelState[], activeId: PanelId): string {
  const panelStrings = panels.map(panel => {
    if (panel.id === activeId) {
      return chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${panel.label} `);
    }
    return chalk.white(panel.label);
  });

  const label = chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(TEXT.LABEL);
  const panelsLine = panelStrings.join('   ');
  const hint = chalk.dim(TEXT.TAB_HINT);

  return `${label}   ${panelsLine}   ${hint}\n\n`;
}

/**
 * Build count above search box
 */
function buildCount(activePanel: PanelState): string {
  if (activePanel.filteredData.length === 0) {
    return chalk.dim('0 assistants total, Page 1 of 1') + '\n';
  }

  const currentPage = activePanel.currentPage + 1; // Display as 1-indexed
  const totalPages = activePanel.totalPages;
  const totalAssistants = activePanel.totalItems;

  return chalk.dim(`${totalAssistants} assistants total, Page ${currentPage} of ${totalPages}`) + '\n';
}

/**
 * Build search input display with box
 */
function buildSearchInput(query: string, isFocused: boolean): string {
  const width = process.stdout.columns || 80;
  const innerWidth = width - 2;

  const prefix = ` ${SYMBOL.SEARCH_ICON} `;
  const contentText = query
    ? (isFocused ? query + SYMBOL.CURSOR : query)
    : TEXT.SEARCH_PLACEHOLDER;
  const visualLength = prefix.length + contentText.length;
  const paddingNeeded = innerWidth - visualLength;

  const styledCursor = chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR);
  const styledPlaceholder = chalk.dim(TEXT.SEARCH_PLACEHOLDER);
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

function buildAssistantsList(
  activePanel: PanelState,
  selectedIds: Set<string>,
  isSearchFocused: boolean,
  cursorIndex: number,
  isPaginationFocused: PaginationControl | null
): string {
  const isMarketplace = activePanel.id === 'marketplace';
  if (activePanel.isFetching) {
    return chalk.cyan('Loading assistants...\n');
  }

  if (activePanel.error) {
    return chalk.red(TEXT.ERROR_PREFIX + activePanel.error + '\n');
  }

  if (activePanel.filteredData.length === 0) {
    return chalk.yellow(TEXT.NO_ASSISTANTS + '\n');
  }

  const displayAssistants = activePanel.filteredData;

  let output = '';

  displayAssistants.forEach((assistant, index) => {
    const isSelected = selectedIds.has(assistant.id);
    const isCursor = index === cursorIndex && !isSearchFocused && isPaginationFocused === null;

    const circle = isSelected
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CIRCLE_FILLED)
      : SYMBOL.CIRCLE_EMPTY;

    const cursor = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR_INDICATOR)
      : '  ';

    const name = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(assistant.name)
      : assistant.name;

    const projectValue = 'project' in assistant ? assistant.project : null;
    const projectName = projectValue
      ? (typeof projectValue === 'object' ? (projectValue as { name: string }).name : projectValue as string)
      : null;
    const project = projectName
      ? chalk.dim(` · ${projectName}`)
      : '';

    const uniqueUsers = isMarketplace && 'unique_users_count' in assistant && assistant.unique_users_count !== undefined
      ? chalk.dim(` · ⚭ ${assistant.unique_users_count} uses`)
      : '';

    output += `${cursor}${circle} ${name}${project}${uniqueUsers}\n`;

    if (assistant.description) {
      const singleLine = assistant.description.replace(/\n+/g, ' ');
      const desc = singleLine.length > CONFIG.DESCRIPTION_MAX_LENGTH
        ? singleLine.substring(0, CONFIG.DESCRIPTION_MAX_LENGTH) + SYMBOL.TRUNCATION
        : singleLine;
      output += chalk.dim(`    ${desc}`) + '\n';
    }

    output += '\n';
  });

  return output;
}

function buildPaginationControls(
  activePanel: PanelState,
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

  const prevLabel = hasPrev ? '[< Prev]' : '[< Prev]';
  const prevCursor = isPaginationFocused === PAGINATION_CONTROL.PREV && !isSearchFocused
    ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR_INDICATOR)
    : '  ';
  const prevText = isPaginationFocused === PAGINATION_CONTROL.PREV && !isSearchFocused
    ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(prevLabel)
    : hasPrev
      ? chalk.white(prevLabel)
      : chalk.dim(prevLabel);

  const nextLabel = hasNext ? '[Next >]' : '[Next >]';
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

/**
 * Build buttons (Continue / Cancel)
 */
function buildButtons(state: SelectionState): string {
  const { areNavigationButtonsFocused, focusedButton, isSearchFocused, isPaginationFocused } = state;
  const buttonsActive = areNavigationButtonsFocused && !isSearchFocused && isPaginationFocused === null;

  const continueButton = buttonsActive && focusedButton === 'continue'
    ? chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${TEXT.CONTINUE_BUTTON} `)
    : chalk.dim(`[${TEXT.CONTINUE_BUTTON}]`);

  const cancelButton = buttonsActive && focusedButton === 'cancel'
    ? chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${TEXT.CANCEL_BUTTON} `)
    : chalk.dim(`[${TEXT.CANCEL_BUTTON}]`);

  return `  ${continueButton}  ${cancelButton}\n\n`;
}

/**
 * Build keyboard instructions
 */
function buildInstructions(activePanel: PanelState): string {
  const totalPages = activePanel.totalPages;
  const hasMultiplePages = totalPages > 1;

  const instructionsText = hasMultiplePages
    ? TEXT.INSTRUCTIONS_WITH_PAGINATION
    : TEXT.INSTRUCTIONS;

  return chalk.dim(instructionsText + '\n');
}

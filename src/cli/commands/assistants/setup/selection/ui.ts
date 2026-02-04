/**
 * UI Rendering
 *
 * All UI building and rendering functions
 */

import chalk from 'chalk';
import type { PanelState, SelectionState } from './types.js';
import { ANSI, BOX, SYMBOL, TEXT, CONFIG, COLOR, type PanelId } from './constants.js';

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
  output += buildAssistantsList(activePanel, state.selectedIds, state.isSearchFocused, cursorIndex);
  output += buildInstructions();

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
  const showing = Math.min(CONFIG.MAX_DISPLAY_ITEMS, activePanel.filteredData.length);
  const total = activePanel.data?.length || 0;

  return chalk.dim(`Showing ${showing} of ${total}`) + '\n';
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

/**
 * Build assistants list with cursor and selections
 */
function buildAssistantsList(
  activePanel: PanelState,
  selectedIds: Set<string>,
  isSearchFocused: boolean,
  cursorIndex: number
): string {
  if (activePanel.isFetching) {
    return chalk.yellow(TEXT.LOADING + '\n');
  }

  if (activePanel.error) {
    return chalk.red(TEXT.ERROR_PREFIX + activePanel.error + '\n');
  }

  if (activePanel.filteredData.length === 0) {
    return chalk.yellow(TEXT.NO_ASSISTANTS + '\n');
  }

  const displayAssistants = activePanel.filteredData.slice(0, CONFIG.MAX_DISPLAY_ITEMS);

  let output = '';

  displayAssistants.forEach((assistant, index) => {
    const isSelected = selectedIds.has(assistant.id);
    const isCursor = index === cursorIndex && !isSearchFocused;

    const circle = isSelected
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CIRCLE_FILLED)
      : SYMBOL.CIRCLE_EMPTY;

    const cursor = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR_INDICATOR)
      : '  ';

    const name = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(assistant.name)
      : assistant.name;

    const project = 'project' in assistant && assistant.project
      ? chalk.dim(` · ${assistant.project}`)
      : '';

    output += `${cursor}${circle} ${name}${project}\n`;

    if (assistant.description) {
      const desc = assistant.description.length > CONFIG.DESCRIPTION_MAX_LENGTH
        ? assistant.description.substring(0, CONFIG.DESCRIPTION_MAX_LENGTH) + SYMBOL.TRUNCATION
        : assistant.description;
      output += chalk.dim(`    ${desc}`) + '\n';
    }

    output += '\n';
  });

  return output;
}

/**
 * Build keyboard instructions
 */
function buildInstructions(): string {
  return chalk.dim(TEXT.INSTRUCTIONS + '\n');
}

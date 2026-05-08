import chalk from 'chalk';
import type { SelectionState, PanelState } from './types.js';
import { TEXT, CONFIG } from './constants.js';
import { COLOR } from '../constants.js';
import { ANSI, SYMBOL } from '@/cli/commands/shared/selection/constants.js';
import {
  buildTopLine,
  buildPanelHeader,
  buildSearchInput,
  buildPaginationControls,
  buildButtons,
  buildInstructions,
} from '@/cli/commands/shared/selection/ui.js';
import { REGISTRATION_MODE } from '../manualConfiguration/constants.js';

export function renderUI(state: SelectionState, cursorIndex: number): string {
  const activePanel = state.panels.find(p => p.id === state.activePanelId)!;

  let output = ANSI.CURSOR_HOME_CLEAR;

  output += buildTopLine();
  output += buildPanelHeader(state.panels, state.activePanelId, TEXT.LABEL);
  output += buildCount(activePanel);
  output += buildSearchInput(state.searchQuery, state.isSearchFocused);
  output += buildAssistantsList(state, activePanel, cursorIndex);
  output += buildPaginationControls(activePanel, state.isPaginationFocused, state.isSearchFocused);
  output += buildButtons(state);
  output += buildInstructions(activePanel);

  return output;
}

function buildCount(activePanel: PanelState): string {
  if (activePanel.filteredData.length === 0) {
    return chalk.dim('0 assistants total, Page 1 of 1') + '\n';
  }

  const currentPage = activePanel.currentPage + 1;
  const totalPages = activePanel.totalPages;
  const totalAssistants = activePanel.totalItems;

  return chalk.dim(`${totalAssistants} assistants total, Page ${currentPage} of ${totalPages}`) + '\n';
}

function buildAssistantsList(
  state: SelectionState,
  activePanel: PanelState,
  cursorIndex: number
): string {
  const { selectedIds, isSearchFocused, isPaginationFocused, registeredAssistants, areNavigationButtonsFocused } = state;

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

  const registeredMap = new Map(
    registeredAssistants.map(a => [a.id, a.registrationMode || REGISTRATION_MODE.AGENT])
  );

  let output = '';

  activePanel.filteredData.forEach((assistant, index) => {
    const isSelected = selectedIds.has(assistant.id);
    const isCursor = index === cursorIndex && !isSearchFocused && isPaginationFocused === null && !areNavigationButtonsFocused;

    const circle = isSelected
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CIRCLE_FILLED)
      : SYMBOL.CIRCLE_EMPTY;

    const cursor = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR_INDICATOR)
      : '  ';

    const name = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(assistant.name)
      : assistant.name;

    const registrationMode = registeredMap.get(assistant.id);
    const badge = registrationMode
      ? registrationMode === REGISTRATION_MODE.AGENT
        ? chalk.dim('[Agent]')
        : chalk.dim('[Skill]')
      : '';

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

    const badgeText = badge ? ` ${badge}` : '';
    output += `${cursor}${circle} ${name}${badgeText}${project}${uniqueUsers}\n`;

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

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

export function renderUI(state: SelectionState, cursorIndex: number): string {
  const activePanel = state.panels.find(p => p.id === state.activePanelId)!;

  let output = ANSI.CURSOR_HOME_CLEAR;

  output += buildTopLine();
  output += buildPanelHeader(state.panels, state.activePanelId, TEXT.LABEL);
  output += buildCount(activePanel);
  output += buildSearchInput(state.searchQuery, state.isSearchFocused);
  output += buildSkillsList(state, activePanel, cursorIndex);
  output += buildPaginationControls(activePanel, state.isPaginationFocused, state.isSearchFocused);
  output += buildButtons(state);
  output += buildInstructions(activePanel);

  return output;
}

function buildCount(activePanel: PanelState): string {
  if (activePanel.filteredData.length === 0) {
    return chalk.dim('0 skills total, Page 1 of 1') + '\n';
  }

  const currentPage = activePanel.currentPage + 1;
  const totalPages = activePanel.totalPages;
  const totalSkills = activePanel.totalItems;

  return chalk.dim(`${totalSkills} skills total, Page ${currentPage} of ${totalPages}`) + '\n';
}

function buildSkillsList(
  state: SelectionState,
  activePanel: PanelState,
  cursorIndex: number
): string {
  const { selectedIds, isSearchFocused, isPaginationFocused, areNavigationButtonsFocused } = state;

  if (activePanel.isFetching) {
    return chalk.cyan('Loading skills...\n');
  }

  if (activePanel.error) {
    return chalk.red(TEXT.ERROR_PREFIX + activePanel.error + '\n');
  }

  if (activePanel.filteredData.length === 0) {
    return chalk.yellow(TEXT.NO_SKILLS + '\n');
  }

  let output = '';

  activePanel.filteredData.forEach((skill, index) => {
    const isSelected = selectedIds.has(skill.id);
    const isCursor = index === cursorIndex && !isSearchFocused && isPaginationFocused === null && !areNavigationButtonsFocused;

    const circle = isSelected
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CIRCLE_FILLED)
      : SYMBOL.CIRCLE_EMPTY;

    const cursor = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)(SYMBOL.CURSOR_INDICATOR)
      : '  ';

    const name = isCursor
      ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(skill.name)
      : skill.name;

    const projectName = 'project' in skill ? skill.project : null;
    const project = projectName
      ? chalk.dim(` · ${projectName}`)
      : '';

    output += `${cursor}${circle} ${name}${project}\n`;

    if (skill.description) {
      const singleLine = skill.description.replace(/\n+/g, ' ');
      const desc = singleLine.length > CONFIG.DESCRIPTION_MAX_LENGTH
        ? singleLine.substring(0, CONFIG.DESCRIPTION_MAX_LENGTH) + SYMBOL.TRUNCATION
        : singleLine;
      output += chalk.dim(`    ${desc}`) + '\n';
    }

    output += '\n';
  });

  return output;
}

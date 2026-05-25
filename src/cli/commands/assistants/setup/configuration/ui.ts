/**
 * UI Rendering for Mode Selection
 */

import chalk from 'chalk';
import type { ModeSelectionState, ConfigurationChoice } from './types.js';
import { CONFIGURATION_CHOICE, CONFIGURATION_CHOICE_LABELS, CONFIGURATION_CHOICE_DESCRIPTIONS, UI_TEXT } from './constants.js';
import { COLOR } from '../constants.js';
import { buildSingleChoiceRow } from '@/cli/commands/shared/selection/ui.js';

/**
 * Build top line (purple separator)
 */
function buildTopLine(): string {
	const width = 70;
	return chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)('─'.repeat(width));
}

/**
 * Build title section
 */
function buildTitle(): string {
	return chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(UI_TEXT.TITLE);
}

/**
 * Build subtitle section
 */
function buildSubtitle(): string {
	return chalk.dim(UI_TEXT.SUBTITLE);
}

/**
 * Build single choice option
 */
function buildChoiceOption(
	choice: ConfigurationChoice,
	isSelected: boolean,
	isCursor: boolean
): string {
	const label = CONFIGURATION_CHOICE_LABELS[choice];
	const description = CONFIGURATION_CHOICE_DESCRIPTIONS[choice];

	return buildSingleChoiceRow({
		label,
		isCursor,
		isSelected,
		description,
		formatLabel: (value, cursorActive) => cursorActive
			? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(value)
			: chalk.white(value),
	});
}

/**
 * Build choices list
 */
function buildChoicesList(state: ModeSelectionState): string {
	const choices: ConfigurationChoice[] = [
		CONFIGURATION_CHOICE.SUBAGENTS,
		CONFIGURATION_CHOICE.SKILLS,
		CONFIGURATION_CHOICE.MANUAL,
	];

	const lines = choices.map((choice) => {
		const isCursor = state.selectedChoice === choice;
		const isSelected = state.selectedChoice === choice;
		return buildChoiceOption(choice, isSelected, isCursor);
	});

	return lines.join('\n\n');
}

/**
 * Build instructions line
 */
function buildInstructions(): string {
	return chalk.dim(UI_TEXT.INSTRUCTIONS);
}

/**
 * Render full UI
 */
export function renderModeSelectionUI(state: ModeSelectionState): string {
	const parts = [
		buildTopLine(),
		buildTitle(),
		'',
		buildSubtitle(),
		'',
		buildChoicesList(state),
		'',
		buildTopLine(),
		'',
		buildInstructions(),
	];

	return parts.join('\n');
}

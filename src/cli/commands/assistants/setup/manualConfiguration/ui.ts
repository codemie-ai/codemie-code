import chalk from 'chalk';
import type { ConfigurationState, RegistrationMode } from './types.js';
import { MODE_LABELS, MODE_CYCLE_ORDER, UI_TEXT } from './constants.js';
import { COLOR, ACTION_TYPE } from '../constants.js';

/**
 * Build top line (purple separator)
 */
function buildTopLine(): string {
	const width = 60;
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
 * Build mode switch display
 * Shows: [Claude Agent] [Claude Skill]
 * Active mode is highlighted in purple
 */
function buildModeSwitch(currentMode: RegistrationMode, isCursor: boolean): string {
	const switches = MODE_CYCLE_ORDER.map((mode) => {
		const label = MODE_LABELS[mode];
		const isActive = mode === currentMode;

		if (isActive && isCursor) {
			return chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(`[${label}]`);
		} else if (isActive) {
			return chalk.bold(`[${label}]`);
		} else {
			return chalk.dim(`[${label}]`);
		}
	});

	return switches.join(' ');
}

/**
 * Build single assistant line
 */
function buildAssistantLine(
	registration: { assistant: { name: string }; mode: RegistrationMode; isAlreadyRegistered: boolean },
	isCursor: boolean
): string {
	const cursor = isCursor ? chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b)('› ') : '  ';
	const name = isCursor ? chalk.bold(registration.assistant.name) : chalk.white(registration.assistant.name);
	const badge = registration.isAlreadyRegistered ? chalk.dim(' (Already registered)') : '';
	const modeSwitch = buildModeSwitch(registration.mode, isCursor);

	return `${cursor}${name}${badge}\n  Mode: ${modeSwitch}`;
}

/**
 * Build assistants list
 */
function buildAssistantsList(state: ConfigurationState): string {
	const lines = state.registrations.map((registration, index) => {
		const isCursor = !state.areNavigationButtonsFocused && state.cursorIndex === index;
		return buildAssistantLine(registration, isCursor);
	});

	return lines.join('\n\n');
}

/**
 * Build buttons (Apply / Cancel)
 */
function buildButtons(state: ConfigurationState): string {
	const { areNavigationButtonsFocused, focusedButton } = state;

	const applyButton =
		areNavigationButtonsFocused && focusedButton === ACTION_TYPE.APPLY
			? chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${UI_TEXT.APPLY_BUTTON} `)
			: chalk.dim(`[${UI_TEXT.APPLY_BUTTON}]`);

	const cancelButton =
		areNavigationButtonsFocused && focusedButton === ACTION_TYPE.CANCEL
			? chalk.bgRgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).black(` ${UI_TEXT.CANCEL_BUTTON} `)
			: chalk.dim(`[${UI_TEXT.CANCEL_BUTTON}]`);

	return `  ${applyButton}  ${cancelButton}`;
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
export function renderUI(state: ConfigurationState): string {
	const parts = [
		buildTopLine(),
		buildTitle(),
		'',
		buildSubtitle(),
		'',
		buildAssistantsList(state),
		'',
		buildTopLine(),
		'',
		buildButtons(state),
		'',
		buildInstructions(),
	];

	return parts.join('\n');
}

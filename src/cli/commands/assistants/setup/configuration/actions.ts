/**
 * Action Handlers for Mode Selection
 */

import type { ModeSelectionState, ConfigurationChoice } from './types.js';
import { CONFIGURATION_CHOICE } from './constants.js';

/**
 * Cycle through configuration choices
 */
function cycleChoice(currentChoice: ConfigurationChoice, direction: 'up' | 'down'): ConfigurationChoice {
	const choices: ConfigurationChoice[] = [
		CONFIGURATION_CHOICE.SUBAGENTS,
		CONFIGURATION_CHOICE.SKILLS,
		CONFIGURATION_CHOICE.MANUAL,
	];

	const currentIndex = choices.indexOf(currentChoice);

	if (direction === 'up') {
		const nextIndex = currentIndex > 0 ? currentIndex - 1 : currentIndex;
		return choices[nextIndex];
	} else {
		const nextIndex = currentIndex < choices.length - 1 ? currentIndex + 1 : currentIndex;
		return choices[nextIndex];
	}
}

/**
 * Create action handlers with closure over dependencies
 */
export function createModeSelectionActions(
	state: ModeSelectionState,
	render: () => void,
	resolve: (cancelled: boolean, back?: boolean) => void
) {
	return {
		/**
		 * Handle up arrow
		 */
		handleArrowUp() {
			state.selectedChoice = cycleChoice(state.selectedChoice, 'up');
			render();
		},

		/**
		 * Handle down arrow
		 */
		handleArrowDown() {
			state.selectedChoice = cycleChoice(state.selectedChoice, 'down');
			render();
		},

		/**
		 * Handle enter key - confirm selection
		 */
		handleEnter() {
			resolve(false, false);
		},

		/**
		 * Handle back (Esc) - go back to selection
		 */
		handleBack() {
			resolve(false, true);
		},

		/**
		 * Handle cancel (Ctrl+C)
		 */
		handleCancel() {
			resolve(true, false);
		},
	};
}

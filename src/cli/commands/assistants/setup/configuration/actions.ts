import type { ConfigurationState, RegistrationMode, ConfigurationAction } from './types.js';
import { MODE_CYCLE_ORDER } from './constants.js';
import { ACTION_TYPE } from '../constants.js';

/**
 * Cycle registration mode forward or backward
 */
function cycleMode(currentMode: RegistrationMode, direction: 'forward' | 'backward'): RegistrationMode {
	const currentIndex = MODE_CYCLE_ORDER.indexOf(currentMode);
	let nextIndex: number;

	if (direction === 'forward') {
		nextIndex = (currentIndex + 1) % MODE_CYCLE_ORDER.length;
	} else {
		nextIndex = (currentIndex - 1 + MODE_CYCLE_ORDER.length) % MODE_CYCLE_ORDER.length;
	}

	return MODE_CYCLE_ORDER[nextIndex];
}

/**
 * Create action handlers with closure over dependencies
 */
export function createActionHandlers(
	state: ConfigurationState,
	render: () => void,
	resolve: (action: ConfigurationAction) => void
) {
	return {
		/**
		 * Handle up arrow
		 */
		handleArrowUp() {
			if (state.isButtonsFocused) {
				// Move to last item in list
				state.isButtonsFocused = false;
				state.cursorIndex = state.registrations.length - 1;
			} else if (state.cursorIndex > 0) {
				state.cursorIndex--;
			}
			render();
		},

		/**
		 * Handle down arrow
		 */
		handleArrowDown() {
			if (!state.isButtonsFocused) {
				if (state.cursorIndex < state.registrations.length - 1) {
					state.cursorIndex++;
				} else {
					// Move to buttons
					state.isButtonsFocused = true;
					state.focusedButton = ACTION_TYPE.APPLY;
				}
			}
			render();
		},

		/**
		 * Handle left arrow
		 */
		handleArrowLeft() {
			if (state.isButtonsFocused) {
				// Toggle between buttons
				state.focusedButton = state.focusedButton === ACTION_TYPE.APPLY ? ACTION_TYPE.CANCEL : ACTION_TYPE.APPLY;
			} else {
				// Cycle mode backward
				const registration = state.registrations[state.cursorIndex];
				registration.mode = cycleMode(registration.mode, 'backward');
			}
			render();
		},

		/**
		 * Handle right arrow
		 */
		handleArrowRight() {
			if (state.isButtonsFocused) {
				// Toggle between buttons
				state.focusedButton = state.focusedButton === ACTION_TYPE.APPLY ? ACTION_TYPE.CANCEL : ACTION_TYPE.APPLY;
			} else {
				// Cycle mode forward
				const registration = state.registrations[state.cursorIndex];
				registration.mode = cycleMode(registration.mode, 'forward');
			}
			render();
		},

		/**
		 * Handle space key
		 */
		handleSpace() {
			if (!state.isButtonsFocused) {
				// Cycle mode forward
				const registration = state.registrations[state.cursorIndex];
				registration.mode = cycleMode(registration.mode, 'forward');
				render();
			}
		},

		/**
		 * Handle tab key
		 */
		handleTab() {
			state.isButtonsFocused = !state.isButtonsFocused;
			if (state.isButtonsFocused) {
				state.focusedButton = ACTION_TYPE.APPLY;
			}
			render();
		},

		/**
		 * Handle shift+tab key
		 */
		handleShiftTab() {
			state.isButtonsFocused = !state.isButtonsFocused;
			if (state.isButtonsFocused) {
				state.focusedButton = ACTION_TYPE.CANCEL;
			}
			render();
		},

		/**
		 * Handle enter key
		 */
		handleEnter() {
			if (state.isButtonsFocused) {
				// Execute focused button
				resolve(state.focusedButton === ACTION_TYPE.APPLY ? ACTION_TYPE.APPLY : ACTION_TYPE.CANCEL);
			} else {
				// From list: move to apply button and execute
				resolve(ACTION_TYPE.APPLY);
			}
		},

		/**
		 * Handle cancel (Esc or Ctrl+C)
		 */
		handleCancel() {
			resolve(ACTION_TYPE.CANCEL);
		},
	};
}

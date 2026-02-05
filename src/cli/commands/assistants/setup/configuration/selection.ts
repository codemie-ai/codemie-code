/**
 * Mode Selection Prompt
 *
 * First screen - user chooses between Subagents, Skills, or Manual configuration
 */

import type { ModeSelectionState, ModeSelectionResult } from './types.js';
import { ANSI, KEY, KEEP_ALIVE_INTERVAL, CONFIGURATION_CHOICE } from './constants.js';
import { renderModeSelectionUI } from './ui.js';
import { createModeSelectionActions } from './actions.js';

/**
 * Initialize mode selection state
 * Default selection is 'subagents'
 */
function initializeModeSelectionState(): ModeSelectionState {
	return {
		selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS, // Default to Subagents
	};
}

/**
 * Prompt user to select configuration mode
 * Returns the selected choice and whether it was cancelled
 */
export async function promptModeSelection(): Promise<ModeSelectionResult> {
	const state = initializeModeSelectionState();

	return new Promise((resolve) => {
		let keepAliveTimer: NodeJS.Timeout | null = null;

		/**
		 * Render UI to stdout
		 */
		function render() {
			const output = ANSI.CLEAR_SCREEN + ANSI.HIDE_CURSOR + renderModeSelectionUI(state);
			process.stdout.write(output);
		}

		/**
		 * Cleanup and restore terminal
		 */
		function cleanup() {
			if (keepAliveTimer) {
				clearInterval(keepAliveTimer);
				keepAliveTimer = null;
			}

			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stdin.removeAllListeners('data');

			process.stdout.write(ANSI.SHOW_CURSOR + ANSI.CLEAR_SCREEN);
		}

		/**
		 * Resolve promise and cleanup
		 */
		function stop(cancelled: boolean, back: boolean = false) {
			cleanup();
			resolve({
				choice: state.selectedChoice,
				cancelled,
				back,
			});
		}

		/**
		 * Start interactive mode
		 */
		function start() {
			const actions = createModeSelectionActions(state, render, stop);

			process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.setEncoding('utf8');

			process.stdin.on('data', (key: string) => {
				switch (key) {
					case KEY.UP:
						actions.handleArrowUp();
						break;
					case KEY.DOWN:
						actions.handleArrowDown();
						break;
					case KEY.ENTER:
						actions.handleEnter();
						break;
					case KEY.ESC:
						actions.handleBack();
						break;
					case KEY.CTRL_C:
						actions.handleCancel();
						break;
					default:
						// Ignore other keys
						break;
				}
			});

			// Keep-alive timer to prevent process from exiting
			keepAliveTimer = setInterval(() => {}, KEEP_ALIVE_INTERVAL);

			render();
		}

		start();
	});
}

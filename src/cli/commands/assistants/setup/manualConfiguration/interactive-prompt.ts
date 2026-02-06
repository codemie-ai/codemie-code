import type { ConfigurationState, ConfigurationAction } from './types.js';
import { ANSI, KEY, KEEP_ALIVE_INTERVAL } from './constants.js';
import { renderUI } from './ui.js';
import { createActionHandlers } from './actions.js';

/**
 * Interactive prompt for configuring assistant registration modes
 */
export function createInteractivePrompt(state: ConfigurationState): Promise<ConfigurationAction> {
	return new Promise((resolve) => {
		let keepAliveTimer: NodeJS.Timeout | null = null;

		/**
		 * Render UI to stdout
		 */
		function render() {
			const output = ANSI.CLEAR_SCREEN + ANSI.HIDE_CURSOR + renderUI(state);
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
		function stop(action: ConfigurationAction) {
			cleanup();
			resolve(action);
		}

		/**
		 * Start interactive mode
		 */
		function start() {
			const actions = createActionHandlers(state, render, stop);

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
					case KEY.LEFT:
						actions.handleArrowLeft();
						break;
					case KEY.RIGHT:
						actions.handleArrowRight();
						break;
					case KEY.SPACE:
						actions.handleSpace();
						break;
					case KEY.TAB:
						actions.handleTab();
						break;
					case KEY.SHIFT_TAB:
						actions.handleShiftTab();
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
			keepAliveTimer = setInterval(() => {
			}, KEEP_ALIVE_INTERVAL);

			render();
		}

		start();
	});
}

import type { RegistrationMode } from './types.js';

/**
 * Registration mode values
 */
export const REGISTRATION_MODE = {
	AGENT: 'agent' as const,
	SKILL: 'skill' as const,
} as const;

/**
 * ANSI escape codes for terminal control
 */
export const ANSI = {
	CLEAR_SCREEN: '\x1B[2J\x1B[H',
	HIDE_CURSOR: '\x1B[?25l',
	SHOW_CURSOR: '\x1B[?25h',
	CLEAR_LINE: '\x1B[2K',
} as const;

/**
 * Key codes for keyboard input
 */
export const KEY = {
	UP: '\x1B[A',
	DOWN: '\x1B[B',
	LEFT: '\x1B[D',
	RIGHT: '\x1B[C',
	ENTER: '\r',
	SPACE: ' ',
	TAB: '\t',
	SHIFT_TAB: '\x1B[Z',
	ESC: '\x1B',
	CTRL_C: '\x03',
} as const;

/**
 * Labels for registration modes
 */
export const MODE_LABELS: Record<RegistrationMode, string> = {
	[REGISTRATION_MODE.AGENT]: 'Claude Agent',
	[REGISTRATION_MODE.SKILL]: 'Claude Skill',
} as const;

/**
 * Order for cycling through modes
 */
export const MODE_CYCLE_ORDER: RegistrationMode[] = [
	REGISTRATION_MODE.AGENT,
	REGISTRATION_MODE.SKILL,
];

/**
 * UI text strings
 */
export const UI_TEXT = {
	TITLE: 'Configure Registration',
	SUBTITLE: 'Select registration mode for each assistant:',
	INSTRUCTIONS: '↑↓: Navigate • ←→: Toggle Mode • Enter: Confirm • Esc: Cancel',
	APPLY_BUTTON: 'Apply',
	CANCEL_BUTTON: 'Cancel',
	NO_CHANGES: 'No changes made',
} as const;

/**
 * Keep-alive timer interval (ms)
 */
export const KEEP_ALIVE_INTERVAL = 60000;

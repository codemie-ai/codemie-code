import type { ConfigurationChoice } from './types.js';

/**
 * Configuration choice values
 */
export const CONFIGURATION_CHOICE = {
	SUBAGENTS: 'subagents' as const,
	SKILLS: 'skills' as const,
	MANUAL: 'manual' as const,
} as const;

/**
 * Labels for configuration choices
 */
export const CONFIGURATION_CHOICE_LABELS: Record<ConfigurationChoice, string> = {
	[CONFIGURATION_CHOICE.SUBAGENTS]: 'Claude Subagents',
	[CONFIGURATION_CHOICE.SKILLS]: 'Claude Skills',
	[CONFIGURATION_CHOICE.MANUAL]: 'Manual Configuration',
} as const;

/**
 * Descriptions for configuration choices
 */
export const CONFIGURATION_CHOICE_DESCRIPTIONS: Record<ConfigurationChoice, string> = {
	[CONFIGURATION_CHOICE.SUBAGENTS]: 'Register all as Claude agents (@slug)',
	[CONFIGURATION_CHOICE.SKILLS]: 'Register all as Claude skills (/slug)',
	[CONFIGURATION_CHOICE.MANUAL]: 'Choose individually for each assistant',
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
	ENTER: '\r',
	ESC: '\x1B',
	CTRL_C: '\x03',
} as const;

/**
 * UI text strings
 */
export const UI_TEXT = {
	TITLE: 'Configure Registration',
	SUBTITLE: 'How would you like to register assistants?',
	INSTRUCTIONS: '↑↓: Navigate • Enter: Continue • Esc: Cancel',
} as const;

/**
 * Keep-alive timer interval (ms)
 */
export const KEEP_ALIVE_INTERVAL = 60000;

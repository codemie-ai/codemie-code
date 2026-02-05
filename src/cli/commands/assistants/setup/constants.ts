/**
 * Shared constants for setup command
 *
 * Constants used across selection, configuration, and summary modules
 */

/**
 * Color palette used across all setup UI components
 */
export const COLOR = {
	PURPLE: { r: 177, g: 185, b: 249 } as const,
} as const;

/**
 * Action types for user interactions
 */
export const ACTION_TYPE = {
	CANCEL: 'cancel',
	APPLY: 'apply',
	UPDATE: 'update',
	BACK: 'back',
} as const;

export type ActionType = typeof ACTION_TYPE[keyof typeof ACTION_TYPE];

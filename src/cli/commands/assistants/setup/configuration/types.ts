/**
 * Configuration choice - determines flow
 * - subagents: Bulk register all as agents
 * - skills: Bulk register all as skills
 * - manual: Individual configuration for each assistant
 */
export type ConfigurationChoice = 'subagents' | 'skills' | 'manual';

/**
 * State for the mode selection UI
 */
export interface ModeSelectionState {
	selectedChoice: ConfigurationChoice;
}

/**
 * Result returned from the mode selection UI
 */
export interface ModeSelectionResult {
	choice: ConfigurationChoice;
	cancelled: boolean;
	back: boolean;
}

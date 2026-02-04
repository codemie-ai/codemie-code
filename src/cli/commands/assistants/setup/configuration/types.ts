import type { Assistant } from 'codemie-sdk';
import type { ACTION_TYPE } from '../constants.js';

/**
 * Registration mode for an assistant
 * - agent: Register as Claude agent only (~/.claude/agents/{slug}.md)
 * - skill: Register as Claude skill only (~/.codemie/skills/{slug}/SKILL.md)
 * - both: Register as both agent and skill
 */
export type RegistrationMode = 'agent' | 'skill' | 'both';

/**
 * Action taken by the user in the configuration UI
 */
export type ConfigurationAction = typeof ACTION_TYPE.APPLY | typeof ACTION_TYPE.CANCEL;

/**
 * Represents a single assistant with its registration mode
 */
export interface AssistantRegistration {
	assistant: Assistant;
	mode: RegistrationMode;
	isAlreadyRegistered: boolean;
}

/**
 * State for the configuration UI
 */
export interface ConfigurationState {
	registrations: AssistantRegistration[];
	cursorIndex: number;
	isButtonsFocused: boolean; // false = list, true = buttons
	focusedButton: typeof ACTION_TYPE.APPLY | typeof ACTION_TYPE.CANCEL;
}

/**
 * Result returned from the configuration UI
 */
export interface ConfigurationResult {
	registrationModes: Map<string, RegistrationMode>;
	action: ConfigurationAction;
}

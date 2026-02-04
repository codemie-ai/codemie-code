import type { Assistant } from 'codemie-sdk';

/**
 * Registration mode for an assistant
 * - agent: Register as Claude agent only (~/.claude/agents/{slug}.md)
 * - skill: Register as Claude skill only (~/.codemie/skills/{slug}/SKILL.md)
 * - both: Register as both agent and skill
 */
export type RegistrationMode = 'agent' | 'skill' | 'both';

/**
 * Action taken by the user in the applying UI
 */
export type ApplyingAction = 'apply' | 'cancel';

/**
 * Represents a single assistant with its registration mode
 */
export interface AssistantRegistration {
	assistant: Assistant;
	mode: RegistrationMode;
	isAlreadyRegistered: boolean;
}

/**
 * State for the applying UI
 */
export interface ApplyingState {
	registrations: AssistantRegistration[];
	cursorIndex: number;
	isButtonsFocused: boolean; // false = list, true = buttons
	focusedButton: 'apply' | 'cancel';
}

/**
 * Result returned from the applying UI
 */
export interface ApplyingResult {
	registrationModes: Map<string, RegistrationMode>;
	action: ApplyingAction;
}

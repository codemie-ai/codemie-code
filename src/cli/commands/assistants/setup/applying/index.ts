import type { Assistant } from 'codemie-sdk';
import type { CodemieAssistant } from '@/env/types.js';
import type { ApplyingState, ApplyingResult, RegistrationMode } from './types.js';
import { createInteractivePrompt } from './interactive-prompt.js';
import { REGISTRATION_MODE } from './constants.js';

/**
 * Initialize state with saved registration modes or default to 'agent'
 */
function initializeState(
	assistants: Assistant[],
	registeredIds: Set<string>,
	savedModes: Map<string, RegistrationMode>
): ApplyingState {
	return {
		registrations: assistants.map((assistant) => ({
			assistant,
			mode: savedModes.get(assistant.id) || REGISTRATION_MODE.AGENT,
			isAlreadyRegistered: registeredIds.has(assistant.id),
		})),
		cursorIndex: 0,
		isButtonsFocused: true,
		focusedButton: 'apply',
	};
}

/**
 * Prompt user to configure registration modes for selected assistants
 * Returns a map of assistant IDs to registration modes and the action taken
 * @param assistants - All selected assistants (both new and already registered)
 * @param registeredIds - Set of IDs of already registered assistants
 * @param registeredAssistants - Array of registered assistants with saved modes
 */
export async function promptApplyingOptions(
	assistants: Assistant[],
	registeredIds: Set<string>,
	registeredAssistants: CodemieAssistant[]
): Promise<ApplyingResult> {
	const savedModes = new Map<string, RegistrationMode>();
	for (const registered of registeredAssistants) {
		if (registered.registrationMode) {
			savedModes.set(registered.id, registered.registrationMode);
		}
	}

	const state = initializeState(assistants, registeredIds, savedModes);

	const action = await createInteractivePrompt(state);

	const registrationModes = new Map<string, RegistrationMode>();
	for (const registration of state.registrations) {
		registrationModes.set(registration.assistant.id, registration.mode);
	}

	return {
		registrationModes,
		action,
	};
}

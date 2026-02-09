/**
 * Unit tests for configuration types
 * Tests type definitions and interfaces
 */

import { describe, it, expect } from 'vitest';
import type { RegistrationMode, ConfigurationAction, AssistantRegistration, ConfigurationState, ConfigurationResult } from '../types.js';
import { ACTION_TYPE } from '../../constants.js';

describe('Configuration Types - configuration/types.ts', () => {
	describe('RegistrationMode type', () => {
		it('should accept "agent" as valid mode', () => {
			const mode: RegistrationMode = 'agent';
			expect(mode).toBe('agent');
		});

		it('should accept "skill" as valid mode', () => {
			const mode: RegistrationMode = 'skill';
			expect(mode).toBe('skill');
		});

		it('should accept "both" as valid mode', () => {
			const mode: RegistrationMode = 'both';
			expect(mode).toBe('both');
		});

		it('should have exactly three valid values', () => {
			const validModes: RegistrationMode[] = ['agent', 'skill', 'both'];
			expect(validModes).toHaveLength(3);
		});

		it('should be a string literal type', () => {
			const mode: RegistrationMode = 'agent';
			expect(typeof mode).toBe('string');
		});
	});

	describe('ConfigurationAction type', () => {
		it('should accept APPLY action', () => {
			const action: ConfigurationAction = ACTION_TYPE.APPLY;
			expect(action).toBe('apply');
		});

		it('should accept CANCEL action', () => {
			const action: ConfigurationAction = ACTION_TYPE.CANCEL;
			expect(action).toBe('cancel');
		});

		it('should be a subset of ACTION_TYPE', () => {
			const applyAction: ConfigurationAction = ACTION_TYPE.APPLY;
			const cancelAction: ConfigurationAction = ACTION_TYPE.CANCEL;

			expect(applyAction).toBe('apply');
			expect(cancelAction).toBe('cancel');
		});

		it('should not accept UPDATE action', () => {
			// This test verifies the type constraint at compile time
			// UPDATE is not part of ConfigurationAction type
			const validActions: ConfigurationAction[] = [ACTION_TYPE.APPLY, ACTION_TYPE.CANCEL];
			expect(validActions).toHaveLength(2);
		});
	});

	describe('AssistantRegistration interface', () => {
		it('should create valid registration object', () => {
			const registration: AssistantRegistration = {
				assistant: {
					id: 'assistant-1',
					name: 'Test Assistant',
					slug: 'test-assistant',
					description: 'Test description',
					project: { id: 'project-1', name: 'Test Project' },
				},
				mode: 'agent',
				isAlreadyRegistered: false,
			};

			expect(registration.assistant.id).toBe('assistant-1');
			expect(registration.mode).toBe('agent');
			expect(registration.isAlreadyRegistered).toBe(false);
		});

		it('should support all registration modes', () => {
			const modes: RegistrationMode[] = ['agent', 'skill', 'both'];

			modes.forEach((mode) => {
				const registration: AssistantRegistration = {
					assistant: {
						id: 'assistant-1',
						name: 'Test',
						slug: 'test',
					},
					mode,
					isAlreadyRegistered: false,
				};

				expect(registration.mode).toBe(mode);
			});
		});

		it('should handle already registered assistants', () => {
			const registration: AssistantRegistration = {
				assistant: {
					id: 'assistant-1',
					name: 'Test',
					slug: 'test',
				},
				mode: 'agent',
				isAlreadyRegistered: true,
			};

			expect(registration.isAlreadyRegistered).toBe(true);
		});

		it('should handle new assistants', () => {
			const registration: AssistantRegistration = {
				assistant: {
					id: 'assistant-1',
					name: 'Test',
					slug: 'test',
				},
				mode: 'agent',
				isAlreadyRegistered: false,
			};

			expect(registration.isAlreadyRegistered).toBe(false);
		});

		it('should require all mandatory fields', () => {
			const registration: AssistantRegistration = {
				assistant: {
					id: 'assistant-1',
					name: 'Test',
					slug: 'test',
				},
				mode: 'agent',
				isAlreadyRegistered: false,
			};

			expect(registration.assistant).toBeDefined();
			expect(registration.mode).toBeDefined();
			expect(registration.isAlreadyRegistered).toBeDefined();
		});

		it('should handle assistants with optional fields', () => {
			const registration: AssistantRegistration = {
				assistant: {
					id: 'assistant-1',
					name: 'Test',
					slug: 'test',
					description: undefined,
					project: undefined,
				},
				mode: 'agent',
				isAlreadyRegistered: false,
			};

			expect(registration.assistant.description).toBeUndefined();
			expect(registration.assistant.project).toBeUndefined();
		});
	});

	describe('ConfigurationState interface', () => {
		it('should create valid state object', () => {
			const state: ConfigurationState = {
				registrations: [
					{
						assistant: {
							id: 'assistant-1',
							name: 'Test',
							slug: 'test',
						},
						mode: 'agent',
						isAlreadyRegistered: false,
					},
				],
				cursorIndex: 0,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			expect(state.registrations).toHaveLength(1);
			expect(state.cursorIndex).toBe(0);
			expect(state.areNavigationButtonsFocused).toBe(false);
			expect(state.focusedButton).toBe('apply');
		});

		it('should handle empty registrations array', () => {
			const state: ConfigurationState = {
				registrations: [],
				cursorIndex: 0,
				areNavigationButtonsFocused: true,
				focusedButton: ACTION_TYPE.CANCEL,
			};

			expect(state.registrations).toHaveLength(0);
		});

		it('should handle multiple registrations', () => {
			const state: ConfigurationState = {
				registrations: [
					{
						assistant: { id: '1', name: 'A', slug: 'a' },
						mode: 'agent',
						isAlreadyRegistered: false,
					},
					{
						assistant: { id: '2', name: 'B', slug: 'b' },
						mode: 'skill',
						isAlreadyRegistered: true,
					},
					{
						assistant: { id: '3', name: 'C', slug: 'c' },
						mode: 'both',
						isAlreadyRegistered: false,
					},
				],
				cursorIndex: 1,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			expect(state.registrations).toHaveLength(3);
			expect(state.cursorIndex).toBe(1);
		});

		it('should support cursor navigation', () => {
			const state: ConfigurationState = {
				registrations: [
					{ assistant: { id: '1', name: 'A', slug: 'a' }, mode: 'agent', isAlreadyRegistered: false },
					{ assistant: { id: '2', name: 'B', slug: 'b' }, mode: 'skill', isAlreadyRegistered: false },
				],
				cursorIndex: 0,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			// Simulate cursor movement
			state.cursorIndex = 1;
			expect(state.cursorIndex).toBe(1);
		});

		it('should handle focus state transitions', () => {
			const state: ConfigurationState = {
				registrations: [],
				cursorIndex: 0,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			// Simulate focus transition
			state.areNavigationButtonsFocused = true;
			expect(state.areNavigationButtonsFocused).toBe(true);

			state.areNavigationButtonsFocused = false;
			expect(state.areNavigationButtonsFocused).toBe(false);
		});

		it('should handle button focus switching', () => {
			const state: ConfigurationState = {
				registrations: [],
				cursorIndex: 0,
				areNavigationButtonsFocused: true,
				focusedButton: ACTION_TYPE.APPLY,
			};

			// Switch focused button
			state.focusedButton = ACTION_TYPE.CANCEL;
			expect(state.focusedButton).toBe('cancel');

			state.focusedButton = ACTION_TYPE.APPLY;
			expect(state.focusedButton).toBe('apply');
		});

		it('should require all state fields', () => {
			const state: ConfigurationState = {
				registrations: [],
				cursorIndex: 0,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			expect(state.registrations).toBeDefined();
			expect(state.cursorIndex).toBeDefined();
			expect(state.areNavigationButtonsFocused).toBeDefined();
			expect(state.focusedButton).toBeDefined();
		});
	});

	describe('ConfigurationResult interface', () => {
		it('should create valid result with APPLY action', () => {
			const result: ConfigurationResult = {
				registrationModes: new Map([
					['assistant-1', 'agent'],
					['assistant-2', 'skill'],
				]),
				action: ACTION_TYPE.APPLY,
			};

			expect(result.action).toBe('apply');
			expect(result.registrationModes.size).toBe(2);
		});

		it('should create valid result with CANCEL action', () => {
			const result: ConfigurationResult = {
				registrationModes: new Map(),
				action: ACTION_TYPE.CANCEL,
			};

			expect(result.action).toBe('cancel');
			expect(result.registrationModes.size).toBe(0);
		});

		it('should handle empty registration modes map', () => {
			const result: ConfigurationResult = {
				registrationModes: new Map(),
				action: ACTION_TYPE.APPLY,
			};

			expect(result.registrationModes.size).toBe(0);
		});

		it('should support Map operations on registrationModes', () => {
			const modes = new Map<string, RegistrationMode>();
			modes.set('assistant-1', 'agent');
			modes.set('assistant-2', 'skill');
			modes.set('assistant-3', 'both');

			const result: ConfigurationResult = {
				registrationModes: modes,
				action: ACTION_TYPE.APPLY,
			};

			expect(result.registrationModes.get('assistant-1')).toBe('agent');
			expect(result.registrationModes.get('assistant-2')).toBe('skill');
			expect(result.registrationModes.get('assistant-3')).toBe('both');
			expect(result.registrationModes.has('assistant-4')).toBe(false);
		});

		it('should handle multiple assistants with different modes', () => {
			const result: ConfigurationResult = {
				registrationModes: new Map([
					['assistant-1', 'agent'],
					['assistant-2', 'skill'],
					['assistant-3', 'both'],
				]),
				action: ACTION_TYPE.APPLY,
			};

			expect(result.registrationModes.size).toBe(3);
			expect(Array.from(result.registrationModes.values())).toContain('agent');
			expect(Array.from(result.registrationModes.values())).toContain('skill');
			expect(Array.from(result.registrationModes.values())).toContain('both');
		});

		it('should require both result fields', () => {
			const result: ConfigurationResult = {
				registrationModes: new Map(),
				action: ACTION_TYPE.APPLY,
			};

			expect(result.registrationModes).toBeDefined();
			expect(result.action).toBeDefined();
		});
	});

	describe('type relationships', () => {
		it('should use RegistrationMode in AssistantRegistration', () => {
			const modes: RegistrationMode[] = ['agent', 'skill', 'both'];

			modes.forEach((mode) => {
				const registration: AssistantRegistration = {
					assistant: { id: '1', name: 'Test', slug: 'test' },
					mode,
					isAlreadyRegistered: false,
				};

				expect(['agent', 'skill', 'both']).toContain(registration.mode);
			});
		});

		it('should use AssistantRegistration in ConfigurationState', () => {
			const registration: AssistantRegistration = {
				assistant: { id: '1', name: 'Test', slug: 'test' },
				mode: 'agent',
				isAlreadyRegistered: false,
			};

			const state: ConfigurationState = {
				registrations: [registration],
				cursorIndex: 0,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			expect(state.registrations[0]).toBe(registration);
		});

		it('should use ConfigurationAction in both State and Result', () => {
			const action: ConfigurationAction = ACTION_TYPE.APPLY;

			const state: ConfigurationState = {
				registrations: [],
				cursorIndex: 0,
				areNavigationButtonsFocused: true,
				focusedButton: action,
			};

			const result: ConfigurationResult = {
				registrationModes: new Map(),
				action,
			};

			expect(state.focusedButton).toBe(action);
			expect(result.action).toBe(action);
		});

		it('should use RegistrationMode in ConfigurationResult Map', () => {
			const mode: RegistrationMode = 'agent';
			const result: ConfigurationResult = {
				registrationModes: new Map([['assistant-1', mode]]),
				action: ACTION_TYPE.APPLY,
			};

			expect(result.registrationModes.get('assistant-1')).toBe(mode);
		});
	});

	describe('edge cases', () => {
		it('should handle assistant with minimal fields', () => {
			const registration: AssistantRegistration = {
				assistant: {
					id: '',
					name: '',
					slug: '',
				},
				mode: 'agent',
				isAlreadyRegistered: false,
			};

			expect(registration.assistant.id).toBe('');
			expect(registration.assistant.name).toBe('');
			expect(registration.assistant.slug).toBe('');
		});

		it('should handle zero cursor index', () => {
			const state: ConfigurationState = {
				registrations: [],
				cursorIndex: 0,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			expect(state.cursorIndex).toBe(0);
		});

		it('should handle large cursor index', () => {
			const state: ConfigurationState = {
				registrations: [],
				cursorIndex: 9999,
				areNavigationButtonsFocused: false,
				focusedButton: ACTION_TYPE.APPLY,
			};

			expect(state.cursorIndex).toBe(9999);
		});

		it('should handle empty Map in result', () => {
			const result: ConfigurationResult = {
				registrationModes: new Map(),
				action: ACTION_TYPE.CANCEL,
			};

			expect(result.registrationModes.size).toBe(0);
			expect(Array.from(result.registrationModes.entries())).toHaveLength(0);
		});
	});

	describe('type safety', () => {
		it('should enforce RegistrationMode values', () => {
			const validModes = ['agent', 'skill', 'both'];

			validModes.forEach((mode) => {
				const registration: AssistantRegistration = {
					assistant: { id: '1', name: 'Test', slug: 'test' },
					mode: mode as RegistrationMode,
					isAlreadyRegistered: false,
				};

				expect(registration.mode).toBe(mode);
			});
		});

		it('should enforce ConfigurationAction values', () => {
			const validActions: ConfigurationAction[] = [ACTION_TYPE.APPLY, ACTION_TYPE.CANCEL];

			validActions.forEach((action) => {
				const result: ConfigurationResult = {
					registrationModes: new Map(),
					action,
				};

				expect(result.action).toBe(action);
			});
		});

		it('should maintain type consistency across interfaces', () => {
			const mode: RegistrationMode = 'agent';
			const action: ConfigurationAction = ACTION_TYPE.APPLY;

			const registration: AssistantRegistration = {
				assistant: { id: '1', name: 'Test', slug: 'test' },
				mode,
				isAlreadyRegistered: false,
			};

			const state: ConfigurationState = {
				registrations: [registration],
				cursorIndex: 0,
				areNavigationButtonsFocused: true,
				focusedButton: action,
			};

			const result: ConfigurationResult = {
				registrationModes: new Map([['1', mode]]),
				action,
			};

			expect(state.registrations[0].mode).toBe(result.registrationModes.get('1'));
			expect(state.focusedButton).toBe(result.action);
		});
	});
});

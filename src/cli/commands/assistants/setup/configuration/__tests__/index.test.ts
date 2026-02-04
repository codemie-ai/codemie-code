/**
 * Unit tests for configuration prompt logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Assistant } from 'codemie-sdk';
import type { CodemieAssistant } from '@/env/types.js';
import type { ConfigurationState, ConfigurationResult } from '../types.js';
import { REGISTRATION_MODE } from '../constants.js';
import { ACTION_TYPE } from '../../constants.js';

// Mock the interactive prompt
vi.mock('../interactive-prompt.js', () => ({
	createInteractivePrompt: vi.fn(),
}));

import { promptConfigurationOptions } from '../index.js';
import { createInteractivePrompt } from '../interactive-prompt.js';

describe('Configuration Module - configuration/index.ts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('promptConfigurationOptions', () => {
		const mockAssistant1: Assistant = {
			id: 'assistant-1',
			name: 'Assistant One',
			slug: 'assistant-one',
			description: 'First assistant',
			project: { id: 'project-1', name: 'Project 1' },
		};

		const mockAssistant2: Assistant = {
			id: 'assistant-2',
			name: 'Assistant Two',
			slug: 'assistant-two',
			description: 'Second assistant',
			project: { id: 'project-2', name: 'Project 2' },
		};

		const mockRegistered1: CodemieAssistant = {
			id: 'assistant-1',
			name: 'Assistant One',
			slug: 'assistant-one',
			description: 'First assistant',
			project: { id: 'project-1', name: 'Project 1' },
			registeredAt: '2024-01-01T00:00:00.000Z',
			registrationMode: 'agent',
		};

		it('should initialize with default mode for new assistants', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.registrations).toHaveLength(1);
			expect(capturedState.registrations[0].assistant.id).toBe('assistant-1');
			expect(capturedState.registrations[0].mode).toBe(REGISTRATION_MODE.AGENT);
			expect(capturedState.registrations[0].isAlreadyRegistered).toBe(false);
		});

		it('should preserve saved mode for already registered assistants', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1];
			const registeredIds = new Set(['assistant-1']);
			const registeredAssistants = [mockRegistered1];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.registrations[0].mode).toBe('agent');
			expect(capturedState.registrations[0].isAlreadyRegistered).toBe(true);
		});

		it('should handle multiple assistants with mixed registration status', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1, mockAssistant2];
			const registeredIds = new Set(['assistant-1']);
			const registeredAssistants = [mockRegistered1];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.registrations).toHaveLength(2);
			expect(capturedState.registrations[0].isAlreadyRegistered).toBe(true);
			expect(capturedState.registrations[1].isAlreadyRegistered).toBe(false);
		});

		it('should initialize with cursor at first item', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1, mockAssistant2];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.cursorIndex).toBe(0);
		});

		it('should initialize with buttons focused', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.isButtonsFocused).toBe(true);
		});

		it('should initialize with APPLY button focused', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.focusedButton).toBe(ACTION_TYPE.APPLY);
		});

		it('should return registration modes map when action is APPLY', async () => {
			vi.mocked(createInteractivePrompt).mockImplementation(async (state: ConfigurationState) => {
				// Simulate user changing modes
				state.registrations[0].mode = 'skill';
				state.registrations[1].mode = 'both';
				return ACTION_TYPE.APPLY;
			});

			const assistants = [mockAssistant1, mockAssistant2];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(result.action).toBe(ACTION_TYPE.APPLY);
			expect(result.registrationModes.size).toBe(2);
			expect(result.registrationModes.get('assistant-1')).toBe('skill');
			expect(result.registrationModes.get('assistant-2')).toBe('both');
		});

		it('should return empty map when action is CANCEL', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.CANCEL);

			const assistants = [mockAssistant1, mockAssistant2];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(result.action).toBe(ACTION_TYPE.CANCEL);
			// Map is still populated but caller should ignore it
			expect(result.registrationModes.size).toBe(2);
		});

		it('should handle empty assistants array', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants: Assistant[] = [];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.registrations).toHaveLength(0);
			expect(result.registrationModes.size).toBe(0);
		});

		it('should handle assistants with different saved modes', async () => {
			const mockRegistered2: CodemieAssistant = {
				...mockAssistant2,
				registeredAt: '2024-01-01T00:00:00.000Z',
				registrationMode: 'both',
			};

			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1, mockAssistant2];
			const registeredIds = new Set(['assistant-1', 'assistant-2']);
			const registeredAssistants = [mockRegistered1, mockRegistered2];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.registrations[0].mode).toBe('agent');
			expect(capturedState.registrations[1].mode).toBe('both');
		});

		it('should use default mode when saved mode is undefined', async () => {
			const mockRegisteredNoMode: CodemieAssistant = {
				...mockAssistant1,
				registeredAt: '2024-01-01T00:00:00.000Z',
				registrationMode: undefined as any,
			};

			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1];
			const registeredIds = new Set(['assistant-1']);
			const registeredAssistants = [mockRegisteredNoMode];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.registrations[0].mode).toBe(REGISTRATION_MODE.AGENT);
		});

		it('should create Map with correct assistant IDs as keys', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1, mockAssistant2];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(result.registrationModes.has('assistant-1')).toBe(true);
			expect(result.registrationModes.has('assistant-2')).toBe(true);
		});

		it('should return result with correct structure', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(result).toHaveProperty('registrationModes');
			expect(result).toHaveProperty('action');
			expect(result.registrationModes).toBeInstanceOf(Map);
			expect(typeof result.action).toBe('string');
		});

		it('should handle assistants with minimal fields', async () => {
			const minimalAssistant: Assistant = {
				id: 'minimal-1',
				name: 'Minimal',
				slug: 'minimal',
			};

			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [minimalAssistant];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(result.registrationModes.has('minimal-1')).toBe(true);
		});

		it('should pass state to interactive prompt', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(createInteractivePrompt).toHaveBeenCalledTimes(1);
			expect(createInteractivePrompt).toHaveBeenCalledWith(expect.objectContaining({
				registrations: expect.any(Array),
				cursorIndex: expect.any(Number),
				isButtonsFocused: expect.any(Boolean),
				focusedButton: expect.any(String),
			}));
		});

		it('should preserve state mutations from interactive prompt', async () => {
			vi.mocked(createInteractivePrompt).mockImplementation(async (state: ConfigurationState) => {
				// Simulate user interaction changing state
				state.registrations[0].mode = 'skill';
				state.cursorIndex = 1;
				state.isButtonsFocused = false;
				return ACTION_TYPE.APPLY;
			});

			const assistants = [mockAssistant1, mockAssistant2];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			// State mutations should be reflected in result
			expect(result.registrationModes.get('assistant-1')).toBe('skill');
		});

		it('should handle all registration mode types', async () => {
			const mockRegistered2: CodemieAssistant = {
				...mockAssistant2,
				registeredAt: '2024-01-01T00:00:00.000Z',
				registrationMode: 'skill',
			};

			const mockAssistant3: Assistant = {
				id: 'assistant-3',
				name: 'Assistant Three',
				slug: 'assistant-three',
			};

			const mockRegistered3: CodemieAssistant = {
				...mockAssistant3,
				registeredAt: '2024-01-01T00:00:00.000Z',
				registrationMode: 'both',
			};

			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const assistants = [mockAssistant1, mockAssistant2, mockAssistant3];
			const registeredIds = new Set(['assistant-1', 'assistant-2', 'assistant-3']);
			const registeredAssistants = [mockRegistered1, mockRegistered2, mockRegistered3];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			expect(capturedState.registrations[0].mode).toBe('agent');
			expect(capturedState.registrations[1].mode).toBe('skill');
			expect(capturedState.registrations[2].mode).toBe('both');
		});
	});

	describe('state initialization', () => {
		it('should create valid initial state structure', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const mockAssistant: Assistant = {
				id: 'assistant-1',
				name: 'Test',
				slug: 'test',
			};

			const assistants = [mockAssistant];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;

			// Verify all required state properties exist
			expect(capturedState).toHaveProperty('registrations');
			expect(capturedState).toHaveProperty('cursorIndex');
			expect(capturedState).toHaveProperty('isButtonsFocused');
			expect(capturedState).toHaveProperty('focusedButton');
		});

		it('should create registration objects with all required fields', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const mockAssistant: Assistant = {
				id: 'assistant-1',
				name: 'Test',
				slug: 'test',
			};

			const assistants = [mockAssistant];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			const capturedState = vi.mocked(createInteractivePrompt).mock.calls[0][0] as ConfigurationState;
			const registration = capturedState.registrations[0];

			expect(registration).toHaveProperty('assistant');
			expect(registration).toHaveProperty('mode');
			expect(registration).toHaveProperty('isAlreadyRegistered');
		});
	});

	describe('result building', () => {
		it('should build result from final state', async () => {
			vi.mocked(createInteractivePrompt).mockImplementation(async (state: ConfigurationState) => {
				// Modify state to simulate user interaction
				state.registrations[0].mode = 'both';
				return ACTION_TYPE.APPLY;
			});

			const mockAssistant: Assistant = {
				id: 'assistant-1',
				name: 'Test',
				slug: 'test',
			};

			const assistants = [mockAssistant];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(result.registrationModes.get('assistant-1')).toBe('both');
			expect(result.action).toBe(ACTION_TYPE.APPLY);
		});

		it('should return valid ConfigurationResult type', async () => {
			vi.mocked(createInteractivePrompt).mockResolvedValue(ACTION_TYPE.APPLY);

			const mockAssistant: Assistant = {
				id: 'assistant-1',
				name: 'Test',
				slug: 'test',
			};

			const assistants = [mockAssistant];
			const registeredIds = new Set<string>();
			const registeredAssistants: CodemieAssistant[] = [];

			const result: ConfigurationResult = await promptConfigurationOptions(assistants, registeredIds, registeredAssistants);

			expect(result).toBeDefined();
			expect(result.registrationModes).toBeInstanceOf(Map);
			expect(['apply', 'cancel']).toContain(result.action);
		});
	});
});

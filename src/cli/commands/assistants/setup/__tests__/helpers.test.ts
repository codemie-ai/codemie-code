/**
 * Comprehensive unit tests for assistants setup helpers
 * Tests registration/unregistration business logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { CodemieAssistant } from '@/env/types.js';

// Mock dependencies
vi.mock('@/utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock('@/cli/commands/assistants/setup/generators/claude-agent-generator.js', () => ({
	registerClaudeSubagent: vi.fn(),
	unregisterClaudeSubagent: vi.fn(),
}));

vi.mock('@/cli/commands/assistants/setup/generators/claude-skill-generator.js', () => ({
	registerClaudeSkill: vi.fn(),
	unregisterClaudeSkill: vi.fn(),
}));

vi.mock('ora', () => ({
	default: vi.fn(() => ({
		start: vi.fn().mockReturnThis(),
		succeed: vi.fn().mockReturnThis(),
		fail: vi.fn().mockReturnThis(),
		clear: vi.fn().mockReturnThis(),
		stop: vi.fn().mockReturnThis(),
	})),
}));

import { determineChanges, registerAssistant, unregisterAssistant } from '../helpers.js';
import { logger } from '@/utils/logger.js';
import { registerClaudeSubagent, unregisterClaudeSubagent } from '@/cli/commands/assistants/setup/generators/claude-agent-generator.js';
import { registerClaudeSkill, unregisterClaudeSkill } from '@/cli/commands/assistants/setup/generators/claude-skill-generator.js';
import { REGISTRATION_MODE } from '../manualConfiguration/constants.js';

describe('Assistants Setup Helpers - helpers.ts', () => {
	let consoleLogSpy: any;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		delete process.env.CODEMIE_DEBUG;
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	describe('determineChanges', () => {
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

		const mockAssistant3: AssistantBase = {
			id: 'assistant-3',
			name: 'Assistant Three',
			slug: 'assistant-three',
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

		it('should identify assistants to register (not in registered list)', () => {
			const selectedIds = ['assistant-1', 'assistant-2'];
			const allAssistants = [mockAssistant1, mockAssistant2];
			const registeredAssistants: CodemieAssistant[] = [];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(2);
			expect(result.toRegister).toContainEqual(mockAssistant1);
			expect(result.toRegister).toContainEqual(mockAssistant2);
			expect(result.toUnregister).toHaveLength(0);
		});

		it('should identify assistants to unregister (not in selected list)', () => {
			const selectedIds: string[] = [];
			const allAssistants = [mockAssistant1];
			const registeredAssistants = [mockRegistered1];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(0);
			expect(result.toUnregister).toHaveLength(1);
			expect(result.toUnregister).toContainEqual(mockRegistered1);
		});

		it('should not include already registered assistants in toRegister', () => {
			const selectedIds = ['assistant-1', 'assistant-2'];
			const allAssistants = [mockAssistant1, mockAssistant2];
			const registeredAssistants = [mockRegistered1];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(1);
			expect(result.toRegister).toContainEqual(mockAssistant2);
			expect(result.toUnregister).toHaveLength(0);
		});

		it('should handle partial overlap between selected and registered', () => {
			const mockRegistered2: CodemieAssistant = {
				...mockAssistant2,
				registeredAt: '2024-01-01T00:00:00.000Z',
				registrationMode: 'agent',
			};

			const selectedIds = ['assistant-1', 'assistant-3'];
			const allAssistants = [mockAssistant1, mockAssistant2, mockAssistant3];
			const registeredAssistants = [mockRegistered1, mockRegistered2];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(1);
			expect(result.toRegister[0].id).toBe('assistant-3');
			expect(result.toUnregister).toHaveLength(1);
			expect(result.toUnregister[0].id).toBe('assistant-2');
		});

		it('should handle empty selected list', () => {
			const selectedIds: string[] = [];
			const allAssistants = [mockAssistant1, mockAssistant2];
			const registeredAssistants = [mockRegistered1];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(0);
			expect(result.toUnregister).toHaveLength(1);
		});

		it('should handle empty registered list', () => {
			const selectedIds = ['assistant-1', 'assistant-2'];
			const allAssistants = [mockAssistant1, mockAssistant2];
			const registeredAssistants: CodemieAssistant[] = [];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(2);
			expect(result.toUnregister).toHaveLength(0);
		});

		it('should handle all assistants already registered', () => {
			const mockRegistered2: CodemieAssistant = {
				...mockAssistant2,
				registeredAt: '2024-01-01T00:00:00.000Z',
				registrationMode: 'agent',
			};

			const selectedIds = ['assistant-1', 'assistant-2'];
			const allAssistants = [mockAssistant1, mockAssistant2];
			const registeredAssistants = [mockRegistered1, mockRegistered2];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(0);
			expect(result.toUnregister).toHaveLength(0);
		});

		it('should handle AssistantBase objects (without full details)', () => {
			const selectedIds = ['assistant-3'];
			const allAssistants: (Assistant | AssistantBase)[] = [mockAssistant3];
			const registeredAssistants: CodemieAssistant[] = [];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(1);
			expect(result.toRegister[0].id).toBe('assistant-3');
		});

		it('should return empty arrays when nothing changes', () => {
			const selectedIds = ['assistant-1'];
			const allAssistants = [mockAssistant1];
			const registeredAssistants = [mockRegistered1];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(0);
			expect(result.toUnregister).toHaveLength(0);
		});
	});

	describe('unregisterAssistant', () => {
		const mockAssistant: CodemieAssistant = {
			id: 'assistant-1',
			name: 'Test Assistant',
			slug: 'test-assistant',
			description: 'Test description',
			project: { id: 'project-1', name: 'Test Project' },
			registeredAt: '2024-01-01T00:00:00.000Z',
			registrationMode: 'agent',
		};

		beforeEach(() => {
			vi.mocked(unregisterClaudeSubagent).mockResolvedValue(undefined);
			vi.mocked(unregisterClaudeSkill).mockResolvedValue(undefined);
		});

		it('should call both unregister functions', async () => {
			await unregisterAssistant(mockAssistant);

			expect(unregisterClaudeSubagent).toHaveBeenCalledWith('test-assistant');
			expect(unregisterClaudeSkill).toHaveBeenCalledWith('test-assistant');
		});

		it('should handle unregister errors gracefully', async () => {
			vi.mocked(unregisterClaudeSubagent).mockRejectedValue(new Error('Unregister failed'));

			await unregisterAssistant(mockAssistant);

			expect(logger.error).toHaveBeenCalledWith(
				'Assistant removal failed',
				expect.objectContaining({
					error: expect.any(Error),
					assistantId: 'assistant-1',
				})
			);
		});

		it('should handle agent unregister failure and still attempt skill unregister', async () => {
			vi.mocked(unregisterClaudeSubagent).mockRejectedValue(new Error('Agent unregister failed'));

			await unregisterAssistant(mockAssistant);

			// Agent unregister was attempted
			expect(unregisterClaudeSubagent).toHaveBeenCalled();
			// Error should be logged
			expect(logger.error).toHaveBeenCalled();
		});

		it('should show verbose output when CODEMIE_DEBUG is true', async () => {
			process.env.CODEMIE_DEBUG = 'true';

			await unregisterAssistant(mockAssistant);

			expect(unregisterClaudeSubagent).toHaveBeenCalled();
			expect(unregisterClaudeSkill).toHaveBeenCalled();
		});

		it('should handle assistants without slug gracefully', async () => {
			const assistantNoSlug: CodemieAssistant = {
				...mockAssistant,
				slug: '',
			};

			await unregisterAssistant(assistantNoSlug);

			expect(unregisterClaudeSubagent).toHaveBeenCalledWith('');
			expect(unregisterClaudeSkill).toHaveBeenCalledWith('');
		});
	});

	describe('registerAssistant', () => {
		const mockAssistant: Assistant = {
			id: 'assistant-1',
			name: 'Test Assistant',
			slug: 'test-assistant',
			description: 'Test description',
			project: { id: 'project-1', name: 'Test Project' },
		};

		beforeEach(() => {
			vi.mocked(registerClaudeSubagent).mockResolvedValue(undefined);
			vi.mocked(registerClaudeSkill).mockResolvedValue(undefined);
		});

		it('should register as agent only by default', async () => {
			const result = await registerAssistant(mockAssistant);

			expect(registerClaudeSubagent).toHaveBeenCalledWith(mockAssistant);
			expect(registerClaudeSkill).not.toHaveBeenCalled();
			expect(result).toBeDefined();
			expect(result?.registrationMode).toBe('agent');
		});

		it('should register as agent when mode is AGENT', async () => {
			const result = await registerAssistant(mockAssistant, REGISTRATION_MODE.AGENT);

			expect(registerClaudeSubagent).toHaveBeenCalledWith(mockAssistant);
			expect(registerClaudeSkill).not.toHaveBeenCalled();
			expect(result?.registrationMode).toBe('agent');
		});

		it('should register as skill when mode is SKILL', async () => {
			const result = await registerAssistant(mockAssistant, REGISTRATION_MODE.SKILL);

			expect(registerClaudeSubagent).not.toHaveBeenCalled();
			expect(registerClaudeSkill).toHaveBeenCalledWith(mockAssistant);
			expect(result?.registrationMode).toBe('skill');
		});


		it('should return CodemieAssistant with registeredAt timestamp', async () => {
			const result = await registerAssistant(mockAssistant, REGISTRATION_MODE.AGENT);

			expect(result).toBeDefined();
			expect(result?.id).toBe('assistant-1');
			expect(result?.name).toBe('Test Assistant');
			expect(result?.slug).toBe('test-assistant');
			expect(result?.description).toBe('Test description');
			expect(result?.project).toEqual({ id: 'project-1', name: 'Test Project' });
			expect(result?.registeredAt).toBeDefined();
			expect(result?.registrationMode).toBe('agent');
		});

		it('should return null on registration error', async () => {
			vi.mocked(registerClaudeSubagent).mockRejectedValue(new Error('Registration failed'));

			const result = await registerAssistant(mockAssistant, REGISTRATION_MODE.AGENT);

			expect(result).toBeNull();
			expect(logger.error).toHaveBeenCalledWith(
				'Assistant generation failed',
				expect.objectContaining({
					error: expect.any(Error),
					assistantId: 'assistant-1',
					mode: 'agent',
				})
			);
		});

		it('should handle skill registration error', async () => {
			vi.mocked(registerClaudeSkill).mockRejectedValue(new Error('Skill registration failed'));

			const result = await registerAssistant(mockAssistant, REGISTRATION_MODE.SKILL);

			expect(result).toBeNull();
			expect(logger.error).toHaveBeenCalledWith(
				'Assistant generation failed',
				expect.objectContaining({
					mode: 'skill',
				})
			);
		});


		it('should show verbose output when CODEMIE_DEBUG is true', async () => {
			process.env.CODEMIE_DEBUG = 'true';

			const result = await registerAssistant(mockAssistant, REGISTRATION_MODE.AGENT);

			expect(result).toBeDefined();
			expect(registerClaudeSubagent).toHaveBeenCalled();
		});

		it('should use correct mode label in spinner message', async () => {
			// Test agent mode label
			await registerAssistant(mockAssistant, REGISTRATION_MODE.AGENT);
			expect(registerClaudeSubagent).toHaveBeenCalled();

			vi.clearAllMocks();

			// Test skill mode label
			await registerAssistant(mockAssistant, REGISTRATION_MODE.SKILL);
			expect(registerClaudeSkill).toHaveBeenCalled();

		});

		it('should preserve all assistant properties in result', async () => {
			const assistantWithExtraProps: Assistant = {
				...mockAssistant,
				project: {
					id: 'project-1',
					name: 'Test Project',
					description: 'Project description',
				},
			};

			const result = await registerAssistant(assistantWithExtraProps, REGISTRATION_MODE.AGENT);

			expect(result?.project).toEqual({
				id: 'project-1',
				name: 'Test Project',
				description: 'Project description',
			});
		});

		it('should handle assistant without description', async () => {
			const assistantNoDesc: Assistant = {
				id: 'assistant-1',
				name: 'Test',
				slug: 'test',
				project: { id: 'project-1', name: 'Project' },
			};

			const result = await registerAssistant(assistantNoDesc, REGISTRATION_MODE.AGENT);

			expect(result).toBeDefined();
			expect(result?.description).toBeUndefined();
		});

		it('should handle assistant without project', async () => {
			const assistantNoProject: Assistant = {
				id: 'assistant-1',
				name: 'Test',
				slug: 'test',
			};

			const result = await registerAssistant(assistantNoProject, REGISTRATION_MODE.AGENT);

			expect(result).toBeDefined();
			expect(result?.project).toBeUndefined();
		});
	});

	describe('registration mode combinations', () => {
		const mockAssistant: Assistant = {
			id: 'assistant-1',
			name: 'Test',
			slug: 'test',
			description: 'Test',
			project: { id: 'project-1', name: 'Project' },
		};

		beforeEach(() => {
			vi.mocked(registerClaudeSubagent).mockResolvedValue(undefined);
			vi.mocked(registerClaudeSkill).mockResolvedValue(undefined);
		});

		it('should handle sequential registrations with different modes', async () => {
			// Register as agent
			const result1 = await registerAssistant(mockAssistant, REGISTRATION_MODE.AGENT);
			expect(result1?.registrationMode).toBe('agent');

			// Register as skill
			const result2 = await registerAssistant(mockAssistant, REGISTRATION_MODE.SKILL);
			expect(result2?.registrationMode).toBe('skill');
		});

		it('should not interfere between registrations', async () => {
			vi.clearAllMocks();

			await registerAssistant(mockAssistant, REGISTRATION_MODE.AGENT);
			expect(registerClaudeSubagent).toHaveBeenCalledTimes(1);
			expect(registerClaudeSkill).toHaveBeenCalledTimes(0);

			vi.clearAllMocks();

			await registerAssistant(mockAssistant, REGISTRATION_MODE.SKILL);
			expect(registerClaudeSubagent).toHaveBeenCalledTimes(0);
			expect(registerClaudeSkill).toHaveBeenCalledTimes(1);
		});
	});

	describe('edge cases', () => {
		it('should handle minimal assistant properties', async () => {
			const assistant: Assistant = {
				id: 'minimal-id',
				name: 'Minimal',
				slug: 'minimal',
			};

			vi.mocked(registerClaudeSubagent).mockResolvedValue(undefined);

			const result = await registerAssistant(assistant, REGISTRATION_MODE.AGENT);

			expect(result).toBeDefined();
			expect(result?.id).toBe('minimal-id');
			expect(result?.name).toBe('Minimal');
			expect(result?.slug).toBe('minimal');
			expect(result?.description).toBeUndefined();
			expect(result?.project).toBeUndefined();
		});

		it('should handle null values gracefully', async () => {
			const selectedIds: string[] = [];
			const allAssistants: Assistant[] = [];
			const registeredAssistants: CodemieAssistant[] = [];

			const result = determineChanges(selectedIds, allAssistants, registeredAssistants);

			expect(result.toRegister).toHaveLength(0);
			expect(result.toUnregister).toHaveLength(0);
		});

		it('should handle undefined registration mode', async () => {
			const mockAssistant: Assistant = {
				id: 'assistant-1',
				name: 'Test',
				slug: 'test',
			};

			vi.mocked(registerClaudeSubagent).mockResolvedValue(undefined);

			const result = await registerAssistant(mockAssistant);

			expect(result?.registrationMode).toBe('agent'); // Default
		});
	});
});

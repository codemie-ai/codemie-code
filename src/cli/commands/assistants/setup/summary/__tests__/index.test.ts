/**
 * Unit tests for summary display functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Assistant } from 'codemie-sdk';
import type { CodemieAssistant, ProviderProfile } from '@/env/types.js';

// Mock chalk to avoid ANSI escape codes in tests
vi.mock('chalk', () => ({
	default: {
		green: (str: string) => str,
		dim: (str: string) => str,
		bold: (str: string) => str,
		cyan: (str: string) => str,
		rgb: () => (str: string) => str,
	},
}));

import { displaySummary, displayCurrentlyRegistered } from '../index.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';
import { REGISTRATION_MODE } from '../../manualConfiguration/constants.js';

describe('Summary Display - summary/index.ts', () => {
	let consoleLogSpy: any;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	describe('displaySummary', () => {
		const mockConfig: ProviderProfile = {
			provider: 'anthropic',
			apiKey: 'test-key',
			codemieAssistants: [],
		};

		it('should display summary with total changes count', () => {
			const toRegister: Assistant[] = [
				{ id: '1', name: 'Assistant One', slug: 'assistant-one' },
				{ id: '2', name: 'Assistant Two', slug: 'assistant-two' },
			];
			const toUnregister: CodemieAssistant[] = [
				{
					id: '3',
					name: 'Assistant Three',
					slug: 'assistant-three',
					registeredAt: '2024-01-01T00:00:00.000Z',
					registrationMode: 'agent',
				},
			];

			displaySummary(toRegister, toUnregister, 'default', mockConfig);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining(MESSAGES.SETUP.SUMMARY_UPDATED(3))
			);
		});

		it('should display profile name', () => {
			displaySummary([], [], 'custom-profile', mockConfig);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining(MESSAGES.SETUP.SUMMARY_PROFILE('custom-profile'))
			);
		});

		it('should call displayCurrentlyRegistered', () => {
			const config: ProviderProfile = {
				...mockConfig,
				codemieAssistants: [
					{
						id: '1',
						name: 'Test',
						slug: 'test',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			displaySummary([], [], 'default', config);

			// Should show registered assistants section
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Registered assistants:'));
		});

		it('should handle empty changes', () => {
			displaySummary([], [], 'default', mockConfig);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining(MESSAGES.SETUP.SUMMARY_UPDATED(0))
			);
		});

		it('should handle only registrations', () => {
			const toRegister: Assistant[] = [
				{ id: '1', name: 'New Assistant', slug: 'new-assistant' },
			];

			displaySummary(toRegister, [], 'default', mockConfig);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining(MESSAGES.SETUP.SUMMARY_UPDATED(1))
			);
		});

		it('should handle only unregistrations', () => {
			const toUnregister: CodemieAssistant[] = [
				{
					id: '1',
					name: 'Removed Assistant',
					slug: 'removed-assistant',
					registeredAt: '2024-01-01T00:00:00.000Z',
					registrationMode: 'agent',
				},
			];

			displaySummary([], toUnregister, 'default', mockConfig);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining(MESSAGES.SETUP.SUMMARY_UPDATED(1))
			);
		});

		it('should calculate correct total for mixed changes', () => {
			const toRegister: Assistant[] = [
				{ id: '1', name: 'New One', slug: 'new-one' },
				{ id: '2', name: 'New Two', slug: 'new-two' },
			];
			const toUnregister: CodemieAssistant[] = [
				{
					id: '3',
					name: 'Old One',
					slug: 'old-one',
					registeredAt: '2024-01-01T00:00:00.000Z',
					registrationMode: 'agent',
				},
			];

			displaySummary(toRegister, toUnregister, 'default', mockConfig);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining(MESSAGES.SETUP.SUMMARY_UPDATED(3))
			);
		});
	});

	describe('displayCurrentlyRegistered', () => {
		it('should not display anything if no assistants registered', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Registered assistants:')
			);
		});

		it('should not display anything if codemieAssistants is undefined', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Registered assistants:')
			);
		});

		it('should display registered assistants section', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Test Assistant',
						slug: 'test-assistant',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Registered assistants:'));
		});

		it('should display assistant with agent mode', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Agent Assistant',
						slug: 'agent-assistant',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: REGISTRATION_MODE.AGENT,
					},
				],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining('@agent-assistant in code or claude')
			);
		});

		it('should display assistant with skill mode', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Skill Assistant',
						slug: 'skill-assistant',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: REGISTRATION_MODE.SKILL,
					},
				],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining('/skill-assistant in claude')
			);
			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining('@skill-assistant in code')
			);
		});

		it('should default to agent mode if registrationMode is undefined', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'No Mode Assistant',
						slug: 'no-mode',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: undefined as any,
					},
				],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining('@no-mode in code or claude')
			);
		});

		it('should display multiple assistants', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'First',
						slug: 'first',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
					{
						id: '2',
						name: 'Second',
						slug: 'second',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'skill',
					},
					{
						id: '3',
						name: 'Third',
						slug: 'third',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'both',
					},
				],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('first'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('second'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('third'));
		});

		it('should display assistant name along with slug', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'My Awesome Assistant',
						slug: 'awesome',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('awesome'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('My Awesome Assistant'));
		});

		it('should display separator lines', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Test',
						slug: 'test',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			displayCurrentlyRegistered(config);

			// Should have separator lines
			const calls = consoleLogSpy.mock.calls.map(call => call[0]);
			const separatorCalls = calls.filter((call: string) => call && call.includes('─'));
			expect(separatorCalls.length).toBeGreaterThan(0);
		});

		it('should display empty lines for spacing', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Test',
						slug: 'test',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			displayCurrentlyRegistered(config);

			// Should have empty lines for spacing
			const calls = consoleLogSpy.mock.calls.map(call => call[0]);
			const emptyCalls = calls.filter((call: string) => call === '');
			expect(emptyCalls.length).toBeGreaterThan(0);
		});

		it('should use bullet points for list items', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Test',
						slug: 'test',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			displayCurrentlyRegistered(config);

			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('•'));
		});
	});

	describe('edge cases', () => {
		it('should handle assistants with empty names', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: '',
						slug: 'test',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			expect(() => displayCurrentlyRegistered(config)).not.toThrow();
		});

		it('should handle assistants with empty slugs', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Test',
						slug: '',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			expect(() => displayCurrentlyRegistered(config)).not.toThrow();
		});

		it('should handle very long assistant names', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'A'.repeat(200),
						slug: 'test',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			expect(() => displayCurrentlyRegistered(config)).not.toThrow();
		});

		it('should handle very long slugs', () => {
			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'Test',
						slug: 'a'.repeat(200),
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			expect(() => displayCurrentlyRegistered(config)).not.toThrow();
		});

		it('should handle large number of changes in summary', () => {
			const toRegister: Assistant[] = Array.from({ length: 100 }, (_, i) => ({
				id: `id-${i}`,
				name: `Assistant ${i}`,
				slug: `assistant-${i}`,
			}));

			displaySummary(toRegister, [], 'default', {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [],
			});

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining(MESSAGES.SETUP.SUMMARY_UPDATED(100))
			);
		});

		it('should handle large number of registered assistants', () => {
			const assistants: CodemieAssistant[] = Array.from({ length: 50 }, (_, i) => ({
				id: `id-${i}`,
				name: `Assistant ${i}`,
				slug: `assistant-${i}`,
				registeredAt: '2024-01-01T00:00:00.000Z',
				registrationMode: 'agent' as const,
			}));

			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: assistants,
			};

			expect(() => displayCurrentlyRegistered(config)).not.toThrow();
		});
	});

	describe('integration with summary', () => {
		it('should show updated registrations after changes', () => {
			const toRegister: Assistant[] = [
				{ id: '1', name: 'New Assistant', slug: 'new-assistant' },
			];

			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [
					{
						id: '1',
						name: 'New Assistant',
						slug: 'new-assistant',
						registeredAt: '2024-01-01T00:00:00.000Z',
						registrationMode: 'agent',
					},
				],
			};

			displaySummary(toRegister, [], 'default', config);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining('new-assistant')
			);
		});

		it('should not show unregistered assistants', () => {
			const toUnregister: CodemieAssistant[] = [
				{
					id: '1',
					name: 'Removed Assistant',
					slug: 'removed-assistant',
					registeredAt: '2024-01-01T00:00:00.000Z',
					registrationMode: 'agent',
				},
			];

			const config: ProviderProfile = {
				provider: 'anthropic',
				apiKey: 'test-key',
				codemieAssistants: [],
			};

			displaySummary([], toUnregister, 'default', config);

			const calls = consoleLogSpy.mock.calls.map(call => call[0]);
			const hasRemovedAssistant = calls.some((call: string) =>
				call && call.includes('removed-assistant')
			);
			expect(hasRemovedAssistant).toBe(false);
		});
	});
});

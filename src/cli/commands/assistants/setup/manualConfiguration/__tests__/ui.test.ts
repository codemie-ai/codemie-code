/**
 * Unit tests for configuration UI rendering
 */

import { describe, it, expect } from 'vitest';
import { renderUI } from '../ui.js';
import { REGISTRATION_MODE } from '../constants.js';
import { ACTION_TYPE } from '../../constants.js';
import type { ConfigurationState, RegistrationAssistant } from '../types.js';

describe('Configuration UI', () => {
	const createMockAssistant = (name: string, isAlreadyRegistered = false): RegistrationAssistant => ({
		assistant: {
			id: `test-${name}`,
			name,
			description: `Test assistant ${name}`,
			slug: `test-${name}`,
			visibility: 'private' as const,
			status: 'active' as const,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		},
		mode: REGISTRATION_MODE.AGENT,
		isAlreadyRegistered,
	});

	const createMockState = (overrides?: Partial<ConfigurationState>): ConfigurationState => ({
		registrations: [
			createMockAssistant('Assistant 1'),
			createMockAssistant('Assistant 2'),
		],
		cursorIndex: 0,
		areNavigationButtonsFocused: false,
		focusedButton: ACTION_TYPE.APPLY,
		...overrides,
	});

	describe('renderUI', () => {
		it('should render complete UI with all sections', () => {
			const state = createMockState();
			const output = renderUI(state);

			// Should contain title
			expect(output).toContain('Configure Registration');

			// Should contain subtitle
			expect(output).toContain('Select registration mode for each assistant:');

			// Should contain assistant names
			expect(output).toContain('Assistant 1');
			expect(output).toContain('Assistant 2');

			// Should contain buttons
			expect(output).toContain('Apply');
			expect(output).toContain('Cancel');

			// Should contain instructions
			expect(output).toContain('↑↓: Navigate');
			expect(output).toContain('Enter: Confirm');
		});

		it('should highlight first assistant when cursor is at index 0', () => {
			const state = createMockState({ cursorIndex: 0 });
			const output = renderUI(state);

			expect(output).toBeTruthy();
			expect(output).toContain('Assistant 1');
		});

		it('should highlight second assistant when cursor is at index 1', () => {
			const state = createMockState({ cursorIndex: 1 });
			const output = renderUI(state);

			expect(output).toBeTruthy();
			expect(output).toContain('Assistant 2');
		});

		it('should show mode switches for each assistant', () => {
			const state = createMockState();
			const output = renderUI(state);

			// Should contain mode labels
			expect(output).toContain('Claude Agent');
			expect(output).toContain('Claude Skill');
		});

		it('should render when buttons are focused', () => {
			const state = createMockState({
				areNavigationButtonsFocused: true,
				focusedButton: ACTION_TYPE.APPLY,
			});
			const output = renderUI(state);

			expect(output).toContain('Apply');
			expect(output).toContain('Cancel');
		});

		it('should render Cancel button when focused', () => {
			const state = createMockState({
				areNavigationButtonsFocused: true,
				focusedButton: ACTION_TYPE.CANCEL,
			});
			const output = renderUI(state);

			expect(output).toContain('Cancel');
		});

		it('should show "Already registered" badge for registered assistants', () => {
			const state = createMockState({
				registrations: [
					createMockAssistant('Registered Assistant', true),
				],
			});
			const output = renderUI(state);

			expect(output).toContain('Registered Assistant');
			expect(output).toContain('Already registered');
		});

		it('should render multiple assistants', () => {
			const state = createMockState({
				registrations: [
					createMockAssistant('Assistant A'),
					createMockAssistant('Assistant B'),
					createMockAssistant('Assistant C'),
				],
			});
			const output = renderUI(state);

			expect(output).toContain('Assistant A');
			expect(output).toContain('Assistant B');
			expect(output).toContain('Assistant C');
		});

		it('should render with different registration modes', () => {
			const assistant1 = createMockAssistant('Agent Assistant');
			assistant1.mode = REGISTRATION_MODE.AGENT;

			const assistant2 = createMockAssistant('Skill Assistant');
			assistant2.mode = REGISTRATION_MODE.SKILL;

			const assistant3 = createMockAssistant('Both Assistant');
			assistant3.mode = REGISTRATION_MODE.BOTH;

			const state = createMockState({
				registrations: [assistant1, assistant2, assistant3],
			});
			const output = renderUI(state);

			expect(output).toContain('Agent Assistant');
			expect(output).toContain('Skill Assistant');
			expect(output).toContain('Both Assistant');
		});

		it('should render with cursor at last item', () => {
			const state = createMockState({
				registrations: [
					createMockAssistant('Assistant 1'),
					createMockAssistant('Assistant 2'),
					createMockAssistant('Assistant 3'),
				],
				cursorIndex: 2,
			});
			const output = renderUI(state);

			expect(output).toContain('Assistant 3');
		});

		it('should render separator lines', () => {
			const state = createMockState();
			const output = renderUI(state);

			// Should contain separator characters
			expect(output).toContain('─');
		});

		it('should handle empty registrations array gracefully', () => {
			const state = createMockState({
				registrations: [],
			});

			expect(() => renderUI(state)).not.toThrow();
		});

		it('should render instructions with all key hints', () => {
			const state = createMockState();
			const output = renderUI(state);

			expect(output).toContain('↑↓');
			expect(output).toContain('←→');
			expect(output).toContain('Enter');
			expect(output).toContain('Esc');
		});

		it('should maintain consistent structure', () => {
			const state = createMockState();
			const output = renderUI(state);

			// Check that output has multiple lines
			const lines = output.split('\n');
			expect(lines.length).toBeGreaterThan(10);
		});

		it('should render with all button states', () => {
			const applyFocusedState = createMockState({
				areNavigationButtonsFocused: true,
				focusedButton: ACTION_TYPE.APPLY,
			});
			const applyOutput = renderUI(applyFocusedState);

			const cancelFocusedState = createMockState({
				areNavigationButtonsFocused: true,
				focusedButton: ACTION_TYPE.CANCEL,
			});
			const cancelOutput = renderUI(cancelFocusedState);

			const noButtonsState = createMockState({
				areNavigationButtonsFocused: false,
			});
			const noButtonsOutput = renderUI(noButtonsState);

			expect(applyOutput).toBeTruthy();
			expect(cancelOutput).toBeTruthy();
			expect(noButtonsOutput).toBeTruthy();
		});
	});
});

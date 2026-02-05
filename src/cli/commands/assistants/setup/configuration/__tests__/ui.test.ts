/**
 * Unit tests for configuration UI rendering
 */

import { describe, it, expect } from 'vitest';
import { renderModeSelectionUI } from '../ui.js';
import type { ModeSelectionState } from '../types.js';
import { CONFIGURATION_CHOICE } from '../constants.js';

describe('Configuration UI', () => {
	describe('renderModeSelectionUI', () => {
		it('should render complete UI with all sections', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
			};
			const output = renderModeSelectionUI(state);

			// Should contain title
			expect(output).toContain('Configure Registration');

			// Should contain subtitle
			expect(output).toContain('How would you like to register assistants?');

			// Should contain all choice labels
			expect(output).toContain('Claude Subagents');
			expect(output).toContain('Claude Skills');
			expect(output).toContain('Manual Configuration');

			// Should contain instructions
			expect(output).toContain('↑↓: Navigate');
			expect(output).toContain('Enter: Continue');
			expect(output).toContain('Esc: Cancel');
		});

		it('should render with subagents selected', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
			};
			const output = renderModeSelectionUI(state);

			expect(output).toBeTruthy();
			expect(output).toContain('Claude Subagents');
		});

		it('should render with skills selected', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SKILLS,
			};
			const output = renderModeSelectionUI(state);

			expect(output).toBeTruthy();
			expect(output).toContain('Claude Skills');
		});

		it('should render with manual selected', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.MANUAL,
			};
			const output = renderModeSelectionUI(state);

			expect(output).toBeTruthy();
			expect(output).toContain('Manual Configuration');
		});

		it('should show descriptions for all choices', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
			};
			const output = renderModeSelectionUI(state);

			expect(output).toContain('Register all as Claude agents (@slug)');
			expect(output).toContain('Register all as Claude skills (/slug)');
			expect(output).toContain('Choose individually for each assistant');
		});

		it('should render separator lines', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
			};
			const output = renderModeSelectionUI(state);

			// Should contain separator characters
			expect(output).toContain('─');
		});

		it('should maintain consistent structure', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
			};
			const output = renderModeSelectionUI(state);

			// Check that output has multiple lines
			const lines = output.split('\n');
			expect(lines.length).toBeGreaterThan(10);
		});

		it('should render different states consistently', () => {
			const states: ModeSelectionState[] = [
				{ selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS },
				{ selectedChoice: CONFIGURATION_CHOICE.SKILLS },
				{ selectedChoice: CONFIGURATION_CHOICE.MANUAL },
			];

			const outputs = states.map((state) => renderModeSelectionUI(state));

			// All outputs should have similar structure
			outputs.forEach((output) => {
				expect(output).toContain('Configure Registration');
				expect(output).toContain('Claude Subagents');
				expect(output).toContain('Claude Skills');
				expect(output).toContain('Manual Configuration');
			});

			// All outputs should have similar length (within 100 chars)
			const lengths = outputs.map((o) => o.length);
			const maxLength = Math.max(...lengths);
			const minLength = Math.min(...lengths);
			expect(maxLength - minLength).toBeLessThan(100);
		});

		it('should include radio button indicators', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
			};
			const output = renderModeSelectionUI(state);

			// Should contain radio button characters
			expect(output).toMatch(/[●○]/);
		});

		it('should include cursor indicator', () => {
			const state: ModeSelectionState = {
				selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
			};
			const output = renderModeSelectionUI(state);

			// Should contain cursor indicator
			expect(output).toContain('›');
		});
	});
});

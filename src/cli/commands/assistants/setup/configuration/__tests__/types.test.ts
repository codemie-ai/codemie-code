/**
 * Unit tests for configuration types
 */

import { describe, it, expect } from 'vitest';
import type { ConfigurationChoice, ModeSelectionState, ModeSelectionResult } from '../types.js';

describe('Configuration Types', () => {
	describe('ConfigurationChoice', () => {
		it('should accept valid choice values', () => {
			const subagents: ConfigurationChoice = 'subagents';
			const skills: ConfigurationChoice = 'skills';
			const manual: ConfigurationChoice = 'manual';

			expect(subagents).toBe('subagents');
			expect(skills).toBe('skills');
			expect(manual).toBe('manual');
		});
	});

	describe('ModeSelectionState', () => {
		it('should create state with subagents choice', () => {
			const state: ModeSelectionState = {
				selectedChoice: 'subagents',
			};

			expect(state.selectedChoice).toBe('subagents');
		});

		it('should create state with skills choice', () => {
			const state: ModeSelectionState = {
				selectedChoice: 'skills',
			};

			expect(state.selectedChoice).toBe('skills');
		});

		it('should create state with manual choice', () => {
			const state: ModeSelectionState = {
				selectedChoice: 'manual',
			};

			expect(state.selectedChoice).toBe('manual');
		});

		it('should allow updating choice', () => {
			const state: ModeSelectionState = {
				selectedChoice: 'subagents',
			};

			state.selectedChoice = 'skills';
			expect(state.selectedChoice).toBe('skills');

			state.selectedChoice = 'manual';
			expect(state.selectedChoice).toBe('manual');
		});
	});

	describe('ModeSelectionResult', () => {
		it('should create result with choice and not cancelled', () => {
			const result: ModeSelectionResult = {
				choice: 'subagents',
				cancelled: false,
			};

			expect(result.choice).toBe('subagents');
			expect(result.cancelled).toBe(false);
		});

		it('should create result with choice and cancelled', () => {
			const result: ModeSelectionResult = {
				choice: 'manual',
				cancelled: true,
			};

			expect(result.choice).toBe('manual');
			expect(result.cancelled).toBe(true);
		});

		it('should support all choice values', () => {
			const result1: ModeSelectionResult = { choice: 'subagents', cancelled: false };
			const result2: ModeSelectionResult = { choice: 'skills', cancelled: false };
			const result3: ModeSelectionResult = { choice: 'manual', cancelled: false };

			expect(result1.choice).toBe('subagents');
			expect(result2.choice).toBe('skills');
			expect(result3.choice).toBe('manual');
		});
	});
});

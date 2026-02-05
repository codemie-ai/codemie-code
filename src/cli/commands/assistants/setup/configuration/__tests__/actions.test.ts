/**
 * Unit tests for configuration action handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModeSelectionActions } from '../actions.js';
import type { ModeSelectionState } from '../types.js';
import { CONFIGURATION_CHOICE } from '../constants.js';

describe('Configuration Actions', () => {
	let state: ModeSelectionState;
	let render: ReturnType<typeof vi.fn>;
	let resolve: ReturnType<typeof vi.fn>;
	let actions: ReturnType<typeof createModeSelectionActions>;

	beforeEach(() => {
		state = {
			selectedChoice: CONFIGURATION_CHOICE.SUBAGENTS,
		};
		render = vi.fn();
		resolve = vi.fn();
		actions = createModeSelectionActions(state, render, resolve);
	});

	describe('createModeSelectionActions', () => {
		it('should return all required handlers', () => {
			expect(actions).toHaveProperty('handleArrowUp');
			expect(actions).toHaveProperty('handleArrowDown');
			expect(actions).toHaveProperty('handleEnter');
			expect(actions).toHaveProperty('handleCancel');
		});

		it('should have all handlers as functions', () => {
			expect(typeof actions.handleArrowUp).toBe('function');
			expect(typeof actions.handleArrowDown).toBe('function');
			expect(typeof actions.handleEnter).toBe('function');
			expect(typeof actions.handleCancel).toBe('function');
		});
	});

	describe('handleArrowUp', () => {
		it('should stay at first choice when already at top', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SUBAGENTS;
			actions.handleArrowUp();

			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SUBAGENTS);
			expect(render).toHaveBeenCalled();
		});

		it('should move from skills to subagents', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SKILLS;
			actions.handleArrowUp();

			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SUBAGENTS);
			expect(render).toHaveBeenCalled();
		});

		it('should move from manual to skills', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.MANUAL;
			actions.handleArrowUp();

			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SKILLS);
			expect(render).toHaveBeenCalled();
		});
	});

	describe('handleArrowDown', () => {
		it('should move from subagents to skills', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SUBAGENTS;
			actions.handleArrowDown();

			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SKILLS);
			expect(render).toHaveBeenCalled();
		});

		it('should move from skills to manual', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SKILLS;
			actions.handleArrowDown();

			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.MANUAL);
			expect(render).toHaveBeenCalled();
		});

		it('should stay at last choice when already at bottom', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.MANUAL;
			actions.handleArrowDown();

			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.MANUAL);
			expect(render).toHaveBeenCalled();
		});
	});

	describe('handleEnter', () => {
		it('should resolve with not cancelled and not back', () => {
			actions.handleEnter();

			expect(resolve).toHaveBeenCalledWith(false, false);
		});

		it('should resolve regardless of selected choice', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SUBAGENTS;
			actions.handleEnter();
			expect(resolve).toHaveBeenCalledWith(false, false);

			resolve.mockClear();

			state.selectedChoice = CONFIGURATION_CHOICE.SKILLS;
			actions.handleEnter();
			expect(resolve).toHaveBeenCalledWith(false, false);

			resolve.mockClear();

			state.selectedChoice = CONFIGURATION_CHOICE.MANUAL;
			actions.handleEnter();
			expect(resolve).toHaveBeenCalledWith(false, false);
		});
	});

	describe('handleBack', () => {
		it('should resolve with back flag set', () => {
			actions.handleBack();

			expect(resolve).toHaveBeenCalledWith(false, true);
		});
	});

	describe('handleCancel', () => {
		it('should resolve with cancelled', () => {
			actions.handleCancel();

			expect(resolve).toHaveBeenCalledWith(true, false);
		});

		it('should resolve with cancelled regardless of state', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SUBAGENTS;
			actions.handleCancel();
			expect(resolve).toHaveBeenCalledWith(true, false);

			resolve.mockClear();

			state.selectedChoice = CONFIGURATION_CHOICE.SKILLS;
			actions.handleCancel();
			expect(resolve).toHaveBeenCalledWith(true, false);

			resolve.mockClear();

			state.selectedChoice = CONFIGURATION_CHOICE.MANUAL;
			actions.handleCancel();
			expect(resolve).toHaveBeenCalledWith(true, false);
		});
	});

	describe('Navigation', () => {
		it('should navigate through all choices in order', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SUBAGENTS;

			actions.handleArrowDown();
			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SKILLS);

			actions.handleArrowDown();
			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.MANUAL);
		});

		it('should navigate backwards through choices', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.MANUAL;

			actions.handleArrowUp();
			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SKILLS);

			actions.handleArrowUp();
			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SUBAGENTS);
		});

		it('should not wrap around at boundaries', () => {
			state.selectedChoice = CONFIGURATION_CHOICE.SUBAGENTS;
			actions.handleArrowUp();
			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.SUBAGENTS);

			state.selectedChoice = CONFIGURATION_CHOICE.MANUAL;
			actions.handleArrowDown();
			expect(state.selectedChoice).toBe(CONFIGURATION_CHOICE.MANUAL);
		});
	});
});

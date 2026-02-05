/**
 * Unit tests for configuration action handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActionHandlers } from '../actions.js';
import { REGISTRATION_MODE } from '../constants.js';
import { ACTION_TYPE } from '../../constants.js';
import type { ConfigurationState, RegistrationAssistant } from '../types.js';

describe('Configuration Actions', () => {
	const createMockAssistant = (name: string): RegistrationAssistant => ({
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
		isAlreadyRegistered: false,
	});

	const createMockState = (overrides?: Partial<ConfigurationState>): ConfigurationState => ({
		registrations: [
			createMockAssistant('Assistant 1'),
			createMockAssistant('Assistant 2'),
			createMockAssistant('Assistant 3'),
		],
		cursorIndex: 0,
		areNavigationButtonsFocused: false,
		focusedButton: ACTION_TYPE.APPLY,
		...overrides,
	});

	let state: ConfigurationState;
	let render: ReturnType<typeof vi.fn>;
	let resolve: ReturnType<typeof vi.fn>;
	let handlers: ReturnType<typeof createActionHandlers>;

	beforeEach(() => {
		state = createMockState();
		render = vi.fn();
		resolve = vi.fn();
		handlers = createActionHandlers(state, render, resolve);
	});

	describe('createActionHandlers', () => {
		it('should return all required handlers', () => {
			expect(handlers).toHaveProperty('handleArrowUp');
			expect(handlers).toHaveProperty('handleArrowDown');
			expect(handlers).toHaveProperty('handleArrowLeft');
			expect(handlers).toHaveProperty('handleArrowRight');
			expect(handlers).toHaveProperty('handleSpace');
			expect(handlers).toHaveProperty('handleTab');
			expect(handlers).toHaveProperty('handleShiftTab');
			expect(handlers).toHaveProperty('handleEnter');
			expect(handlers).toHaveProperty('handleCancel');
		});

		it('should have all handlers as functions', () => {
			Object.values(handlers).forEach(handler => {
				expect(typeof handler).toBe('function');
			});
		});
	});

	describe('handleArrowUp', () => {
		it('should move cursor up when not at first item', () => {
			state.cursorIndex = 2;
			handlers.handleArrowUp();

			expect(state.cursorIndex).toBe(1);
			expect(render).toHaveBeenCalled();
		});

		it('should stay at first item when already at top', () => {
			state.cursorIndex = 0;
			handlers.handleArrowUp();

			expect(state.cursorIndex).toBe(0);
			expect(render).toHaveBeenCalled();
		});

		it('should move from buttons to last item', () => {
			state.areNavigationButtonsFocused = true;
			state.cursorIndex = 0;
			handlers.handleArrowUp();

			expect(state.areNavigationButtonsFocused).toBe(false);
			expect(state.cursorIndex).toBe(2); // Last item
			expect(render).toHaveBeenCalled();
		});
	});

	describe('handleArrowDown', () => {
		it('should move cursor down when not at last item', () => {
			state.cursorIndex = 0;
			handlers.handleArrowDown();

			expect(state.cursorIndex).toBe(1);
			expect(render).toHaveBeenCalled();
		});

		it('should move to buttons when at last item', () => {
			state.cursorIndex = 2; // Last item
			handlers.handleArrowDown();

			expect(state.areNavigationButtonsFocused).toBe(true);
			expect(state.focusedButton).toBe(ACTION_TYPE.APPLY);
			expect(render).toHaveBeenCalled();
		});

		it('should stay on buttons when already focused', () => {
			state.areNavigationButtonsFocused = true;
			handlers.handleArrowDown();

			expect(state.areNavigationButtonsFocused).toBe(true);
			expect(render).toHaveBeenCalled();
		});
	});

	describe('handleArrowLeft', () => {
		it('should cycle mode backward when on assistant', () => {
			state.cursorIndex = 0;
			state.registrations[0].mode = REGISTRATION_MODE.SKILL;
			handlers.handleArrowLeft();

			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.AGENT);
			expect(render).toHaveBeenCalled();
		});

		it('should toggle to Cancel when on Apply button', () => {
			state.areNavigationButtonsFocused = true;
			state.focusedButton = ACTION_TYPE.APPLY;
			handlers.handleArrowLeft();

			expect(state.focusedButton).toBe(ACTION_TYPE.CANCEL);
			expect(render).toHaveBeenCalled();
		});

		it('should toggle to Apply when on Cancel button', () => {
			state.areNavigationButtonsFocused = true;
			state.focusedButton = ACTION_TYPE.CANCEL;
			handlers.handleArrowLeft();

			expect(state.focusedButton).toBe(ACTION_TYPE.APPLY);
			expect(render).toHaveBeenCalled();
		});

		it('should cycle through all modes backward', () => {
			state.cursorIndex = 0;

			// Start at AGENT, go backward to SKILL
			state.registrations[0].mode = REGISTRATION_MODE.AGENT;
			handlers.handleArrowLeft();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.SKILL);

			// SKILL backward to AGENT (wraps around)
			handlers.handleArrowLeft();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.AGENT);
		});
	});

	describe('handleArrowRight', () => {
		it('should cycle mode forward when on assistant', () => {
			state.cursorIndex = 0;
			state.registrations[0].mode = REGISTRATION_MODE.AGENT;
			handlers.handleArrowRight();

			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.SKILL);
			expect(render).toHaveBeenCalled();
		});

		it('should toggle to Cancel when on Apply button', () => {
			state.areNavigationButtonsFocused = true;
			state.focusedButton = ACTION_TYPE.APPLY;
			handlers.handleArrowRight();

			expect(state.focusedButton).toBe(ACTION_TYPE.CANCEL);
			expect(render).toHaveBeenCalled();
		});

		it('should toggle to Apply when on Cancel button', () => {
			state.areNavigationButtonsFocused = true;
			state.focusedButton = ACTION_TYPE.CANCEL;
			handlers.handleArrowRight();

			expect(state.focusedButton).toBe(ACTION_TYPE.APPLY);
			expect(render).toHaveBeenCalled();
		});

		it('should cycle through all modes forward', () => {
			state.cursorIndex = 0;

			// Start at AGENT, go forward to SKILL
			state.registrations[0].mode = REGISTRATION_MODE.AGENT;
			handlers.handleArrowRight();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.SKILL);

			// SKILL forward to AGENT (wraps around)
			handlers.handleArrowRight();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.AGENT);
		});
	});

	describe('handleSpace', () => {
		it('should cycle mode forward when on assistant', () => {
			state.cursorIndex = 0;
			state.registrations[0].mode = REGISTRATION_MODE.AGENT;
			handlers.handleSpace();

			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.SKILL);
			expect(render).toHaveBeenCalled();
		});

		it('should do nothing when on buttons', () => {
			state.areNavigationButtonsFocused = true;
			const initialMode = state.registrations[0].mode;
			handlers.handleSpace();

			expect(state.registrations[0].mode).toBe(initialMode);
			expect(render).not.toHaveBeenCalled();
		});
	});

	describe('handleTab', () => {
		it('should move to buttons when on assistant list', () => {
			state.areNavigationButtonsFocused = false;
			handlers.handleTab();

			expect(state.areNavigationButtonsFocused).toBe(true);
			expect(state.focusedButton).toBe(ACTION_TYPE.APPLY);
			expect(render).toHaveBeenCalled();
		});

		it('should move to list when on buttons', () => {
			state.areNavigationButtonsFocused = true;
			handlers.handleTab();

			expect(state.areNavigationButtonsFocused).toBe(false);
			expect(render).toHaveBeenCalled();
		});

		it('should toggle button focus back and forth', () => {
			handlers.handleTab();
			expect(state.areNavigationButtonsFocused).toBe(true);

			handlers.handleTab();
			expect(state.areNavigationButtonsFocused).toBe(false);
		});
	});

	describe('handleShiftTab', () => {
		it('should move to buttons with Cancel focused when on list', () => {
			state.areNavigationButtonsFocused = false;
			handlers.handleShiftTab();

			expect(state.areNavigationButtonsFocused).toBe(true);
			expect(state.focusedButton).toBe(ACTION_TYPE.CANCEL);
			expect(render).toHaveBeenCalled();
		});

		it('should move to list when on buttons', () => {
			state.areNavigationButtonsFocused = true;
			handlers.handleShiftTab();

			expect(state.areNavigationButtonsFocused).toBe(false);
			expect(render).toHaveBeenCalled();
		});

		it('should toggle button focus back and forth', () => {
			handlers.handleShiftTab();
			expect(state.areNavigationButtonsFocused).toBe(true);
			expect(state.focusedButton).toBe(ACTION_TYPE.CANCEL);

			handlers.handleShiftTab();
			expect(state.areNavigationButtonsFocused).toBe(false);
		});
	});

	describe('handleEnter', () => {
		it('should resolve with APPLY when on list', () => {
			state.areNavigationButtonsFocused = false;
			handlers.handleEnter();

			expect(resolve).toHaveBeenCalledWith(ACTION_TYPE.APPLY);
		});

		it('should resolve with APPLY when Apply button is focused', () => {
			state.areNavigationButtonsFocused = true;
			state.focusedButton = ACTION_TYPE.APPLY;
			handlers.handleEnter();

			expect(resolve).toHaveBeenCalledWith(ACTION_TYPE.APPLY);
		});

		it('should resolve with CANCEL when Cancel button is focused', () => {
			state.areNavigationButtonsFocused = true;
			state.focusedButton = ACTION_TYPE.CANCEL;
			handlers.handleEnter();

			expect(resolve).toHaveBeenCalledWith(ACTION_TYPE.CANCEL);
		});
	});

	describe('handleCancel', () => {
		it('should resolve with CANCEL', () => {
			handlers.handleCancel();

			expect(resolve).toHaveBeenCalledWith(ACTION_TYPE.CANCEL);
		});

		it('should resolve with CANCEL regardless of state', () => {
			state.areNavigationButtonsFocused = true;
			handlers.handleCancel();
			expect(resolve).toHaveBeenCalledWith(ACTION_TYPE.CANCEL);

			resolve.mockClear();

			state.areNavigationButtonsFocused = false;
			handlers.handleCancel();
			expect(resolve).toHaveBeenCalledWith(ACTION_TYPE.CANCEL);
		});
	});

	describe('Mode Cycling', () => {
		it('should support all modes', () => {
			state.cursorIndex = 0;

			state.registrations[0].mode = REGISTRATION_MODE.AGENT;
			handlers.handleArrowRight();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.SKILL);

			handlers.handleArrowRight();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.AGENT);
		});

		it('should wrap around in both directions', () => {
			state.cursorIndex = 0;

			// Forward wrap
			state.registrations[0].mode = REGISTRATION_MODE.SKILL;
			handlers.handleArrowRight();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.AGENT);

			// Backward wrap
			handlers.handleArrowLeft();
			expect(state.registrations[0].mode).toBe(REGISTRATION_MODE.SKILL);
		});
	});
});

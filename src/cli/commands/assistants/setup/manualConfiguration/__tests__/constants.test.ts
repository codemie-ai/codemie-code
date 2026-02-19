/**
 * Unit tests for configuration constants
 */

import { describe, it, expect } from 'vitest';
import {
	REGISTRATION_MODE,
	ANSI,
	KEY,
	MODE_LABELS,
	MODE_CYCLE_ORDER,
	UI_TEXT,
	KEEP_ALIVE_INTERVAL,
} from '../constants.js';

describe('Configuration Constants', () => {
	describe('REGISTRATION_MODE', () => {
		it('should have correct mode values', () => {
			expect(REGISTRATION_MODE.AGENT).toBe('agent');
			expect(REGISTRATION_MODE.SKILL).toBe('skill');
		});

		it('should have exactly 2 modes', () => {
			const modes = Object.keys(REGISTRATION_MODE);
			expect(modes).toHaveLength(2);
		});

		it('should have all modes as const', () => {
			const agentMode = REGISTRATION_MODE.AGENT;
			const skillMode = REGISTRATION_MODE.SKILL;

			expect(typeof agentMode).toBe('string');
			expect(typeof skillMode).toBe('string');
		});
	});

	describe('ANSI', () => {
		it('should have correct escape codes', () => {
			expect(ANSI.CLEAR_SCREEN).toBe('\x1B[2J\x1B[H');
			expect(ANSI.HIDE_CURSOR).toBe('\x1B[?25l');
			expect(ANSI.SHOW_CURSOR).toBe('\x1B[?25h');
			expect(ANSI.CLEAR_LINE).toBe('\x1B[2K');
		});

		it('should have all required ANSI codes', () => {
			const codes = Object.keys(ANSI);
			expect(codes).toContain('CLEAR_SCREEN');
			expect(codes).toContain('HIDE_CURSOR');
			expect(codes).toContain('SHOW_CURSOR');
			expect(codes).toContain('CLEAR_LINE');
		});

		it('should have valid escape sequences', () => {
			expect(ANSI.CLEAR_SCREEN).toContain('\x1B');
			expect(ANSI.HIDE_CURSOR).toContain('\x1B');
			expect(ANSI.SHOW_CURSOR).toContain('\x1B');
			expect(ANSI.CLEAR_LINE).toContain('\x1B');
		});
	});

	describe('KEY', () => {
		it('should have correct key codes', () => {
			expect(KEY.UP).toBe('\x1B[A');
			expect(KEY.DOWN).toBe('\x1B[B');
			expect(KEY.LEFT).toBe('\x1B[D');
			expect(KEY.RIGHT).toBe('\x1B[C');
			expect(KEY.ENTER).toBe('\r');
			expect(KEY.SPACE).toBe(' ');
			expect(KEY.TAB).toBe('\t');
			expect(KEY.SHIFT_TAB).toBe('\x1B[Z');
			expect(KEY.ESC).toBe('\x1B');
			expect(KEY.CTRL_C).toBe('\x03');
		});

		it('should have all required keys', () => {
			const keys = Object.keys(KEY);
			expect(keys).toContain('UP');
			expect(keys).toContain('DOWN');
			expect(keys).toContain('LEFT');
			expect(keys).toContain('RIGHT');
			expect(keys).toContain('ENTER');
			expect(keys).toContain('SPACE');
			expect(keys).toContain('TAB');
			expect(keys).toContain('SHIFT_TAB');
			expect(keys).toContain('ESC');
			expect(keys).toContain('CTRL_C');
		});

		it('should have unique key codes', () => {
			const values = Object.values(KEY);
			const uniqueValues = new Set(values);
			expect(values.length).toBe(uniqueValues.size);
		});
	});

	describe('MODE_LABELS', () => {
		it('should have labels for all registration modes', () => {
			expect(MODE_LABELS[REGISTRATION_MODE.AGENT]).toBe('Claude Agent');
			expect(MODE_LABELS[REGISTRATION_MODE.SKILL]).toBe('Claude Skill');
		});

		it('should have exactly 2 labels', () => {
			const labels = Object.keys(MODE_LABELS);
			expect(labels).toHaveLength(2);
		});

		it('should have human-readable labels', () => {
			const labels = Object.values(MODE_LABELS);
			labels.forEach(label => {
				expect(label).toMatch(/^[A-Z]/); // Starts with uppercase
				expect(label.length).toBeGreaterThan(0);
			});
		});
	});

	describe('MODE_CYCLE_ORDER', () => {
		it('should have correct order', () => {
			expect(MODE_CYCLE_ORDER).toEqual([
				REGISTRATION_MODE.AGENT,
				REGISTRATION_MODE.SKILL,
			]);
		});

		it('should contain all registration modes', () => {
			expect(MODE_CYCLE_ORDER).toContain(REGISTRATION_MODE.AGENT);
			expect(MODE_CYCLE_ORDER).toContain(REGISTRATION_MODE.SKILL);
		});

		it('should have exactly 2 modes', () => {
			expect(MODE_CYCLE_ORDER).toHaveLength(2);
		});

		it('should be an array', () => {
			expect(Array.isArray(MODE_CYCLE_ORDER)).toBe(true);
		});
	});

	describe('UI_TEXT', () => {
		it('should have all required text strings', () => {
			expect(UI_TEXT.TITLE).toBe('Configure Registration');
			expect(UI_TEXT.SUBTITLE).toBe('Select registration mode for each assistant:');
			expect(UI_TEXT.INSTRUCTIONS).toBe('↑↓: Navigate • ←→: Toggle Mode • Enter: Confirm • Esc: Cancel');
			expect(UI_TEXT.APPLY_BUTTON).toBe('Apply');
			expect(UI_TEXT.CANCEL_BUTTON).toBe('Cancel');
			expect(UI_TEXT.NO_CHANGES).toBe('No changes made');
		});

		it('should have exactly 6 text fields', () => {
			const fields = Object.keys(UI_TEXT);
			expect(fields).toHaveLength(6);
		});

		it('should have non-empty strings', () => {
			Object.values(UI_TEXT).forEach(text => {
				expect(text.length).toBeGreaterThan(0);
			});
		});

		it('should have properly formatted instructions', () => {
			expect(UI_TEXT.INSTRUCTIONS).toContain('↑↓');
			expect(UI_TEXT.INSTRUCTIONS).toContain('←→');
			expect(UI_TEXT.INSTRUCTIONS).toContain('Enter');
			expect(UI_TEXT.INSTRUCTIONS).toContain('Esc');
		});
	});

	describe('KEEP_ALIVE_INTERVAL', () => {
		it('should be 60 seconds', () => {
			expect(KEEP_ALIVE_INTERVAL).toBe(60000);
		});

		it('should be a positive number', () => {
			expect(KEEP_ALIVE_INTERVAL).toBeGreaterThan(0);
		});

		it('should be in milliseconds', () => {
			const oneMinuteInMs = 60 * 1000;
			expect(KEEP_ALIVE_INTERVAL).toBe(oneMinuteInMs);
		});
	});

	describe('Type Integrity', () => {
		it('should have MODE_LABELS as object', () => {
			expect(typeof MODE_LABELS).toBe('object');
			expect(MODE_LABELS).not.toBeNull();
		});

		it('should have MODE_CYCLE_ORDER as array', () => {
			expect(Array.isArray(MODE_CYCLE_ORDER)).toBe(true);
		});

		it('should have all constants as non-null objects', () => {
			expect(REGISTRATION_MODE).toBeTruthy();
			expect(ANSI).toBeTruthy();
			expect(KEY).toBeTruthy();
			expect(UI_TEXT).toBeTruthy();
		});
	});
});

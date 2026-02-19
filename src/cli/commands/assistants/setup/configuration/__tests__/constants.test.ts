/**
 * Unit tests for configuration constants
 */

import { describe, it, expect } from 'vitest';
import {
	CONFIGURATION_CHOICE,
	CONFIGURATION_CHOICE_LABELS,
	CONFIGURATION_CHOICE_DESCRIPTIONS,
	ANSI,
	KEY,
	UI_TEXT,
	KEEP_ALIVE_INTERVAL,
} from '../constants.js';

describe('Configuration Constants', () => {
	describe('CONFIGURATION_CHOICE', () => {
		it('should have all choice values', () => {
			expect(CONFIGURATION_CHOICE.SUBAGENTS).toBe('subagents');
			expect(CONFIGURATION_CHOICE.SKILLS).toBe('skills');
			expect(CONFIGURATION_CHOICE.MANUAL).toBe('manual');
		});

		it('should have exactly 3 choices', () => {
			expect(Object.keys(CONFIGURATION_CHOICE)).toHaveLength(3);
		});
	});

	describe('CONFIGURATION_CHOICE_LABELS', () => {
		it('should have labels for all choices', () => {
			expect(CONFIGURATION_CHOICE_LABELS.subagents).toBe('Claude Subagents');
			expect(CONFIGURATION_CHOICE_LABELS.skills).toBe('Claude Skills');
			expect(CONFIGURATION_CHOICE_LABELS.manual).toBe('Manual Configuration');
		});

		it('should have exactly 3 labels', () => {
			expect(Object.keys(CONFIGURATION_CHOICE_LABELS)).toHaveLength(3);
		});

		it('should have non-empty labels', () => {
			Object.values(CONFIGURATION_CHOICE_LABELS).forEach((label) => {
				expect(label).toBeTruthy();
				expect(label.length).toBeGreaterThan(0);
			});
		});
	});

	describe('CONFIGURATION_CHOICE_DESCRIPTIONS', () => {
		it('should have descriptions for all choices', () => {
			expect(CONFIGURATION_CHOICE_DESCRIPTIONS.subagents).toBe('Register all as Claude agents (@slug)');
			expect(CONFIGURATION_CHOICE_DESCRIPTIONS.skills).toBe('Register all as Claude skills (/slug)');
			expect(CONFIGURATION_CHOICE_DESCRIPTIONS.manual).toBe('Choose individually for each assistant');
		});

		it('should have exactly 3 descriptions', () => {
			expect(Object.keys(CONFIGURATION_CHOICE_DESCRIPTIONS)).toHaveLength(3);
		});

		it('should have non-empty descriptions', () => {
			Object.values(CONFIGURATION_CHOICE_DESCRIPTIONS).forEach((description) => {
				expect(description).toBeTruthy();
				expect(description.length).toBeGreaterThan(0);
			});
		});
	});

	describe('ANSI codes', () => {
		it('should have all required ANSI codes', () => {
			expect(ANSI.CLEAR_SCREEN).toBe('\x1B[2J\x1B[H');
			expect(ANSI.HIDE_CURSOR).toBe('\x1B[?25l');
			expect(ANSI.SHOW_CURSOR).toBe('\x1B[?25h');
			expect(ANSI.CLEAR_LINE).toBe('\x1B[2K');
		});

		it('should have exactly 4 ANSI codes', () => {
			expect(Object.keys(ANSI)).toHaveLength(4);
		});
	});

	describe('KEY codes', () => {
		it('should have all required key codes', () => {
			expect(KEY.UP).toBe('\x1B[A');
			expect(KEY.DOWN).toBe('\x1B[B');
			expect(KEY.ENTER).toBe('\r');
			expect(KEY.ESC).toBe('\x1B');
			expect(KEY.CTRL_C).toBe('\x03');
		});

		it('should have exactly 5 key codes', () => {
			expect(Object.keys(KEY)).toHaveLength(5);
		});
	});

	describe('UI_TEXT', () => {
		it('should have all required UI text', () => {
			expect(UI_TEXT.TITLE).toBe('Configure Registration');
			expect(UI_TEXT.SUBTITLE).toBe('How would you like to register assistants?');
			expect(UI_TEXT.INSTRUCTIONS).toBe('↑↓: Navigate • Enter: Continue • Esc: Cancel');
		});

		it('should have exactly 3 UI text strings', () => {
			expect(Object.keys(UI_TEXT)).toHaveLength(3);
		});

		it('should have non-empty UI text strings', () => {
			Object.values(UI_TEXT).forEach((text) => {
				expect(text).toBeTruthy();
				expect(text.length).toBeGreaterThan(0);
			});
		});
	});

	describe('KEEP_ALIVE_INTERVAL', () => {
		it('should be 60 seconds', () => {
			expect(KEEP_ALIVE_INTERVAL).toBe(60000);
		});

		it('should be a positive number', () => {
			expect(KEEP_ALIVE_INTERVAL).toBeGreaterThan(0);
		});
	});
});

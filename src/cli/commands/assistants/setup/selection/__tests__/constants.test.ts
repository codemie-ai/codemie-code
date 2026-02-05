/**
 * Unit tests for selection constants
 */

import { describe, it, expect } from 'vitest';
import {
  ANSI,
  KEY,
  BOX,
  SYMBOL,
  TEXT,
  CONFIG,
  PAGINATION_CONTROL,
  PANEL_ID,
  PANEL_IDS,
  API_SCOPE,
  type PanelId,
  type PaginationControl,
} from '../constants.js';

describe('Selection Constants - constants.ts', () => {
  describe('ANSI', () => {
    it('should define cursor home and clear sequence', () => {
      expect(ANSI.CURSOR_HOME_CLEAR).toBe('\x1b[H\x1b[J');
    });

    it('should define clear line above sequence', () => {
      expect(ANSI.CLEAR_LINE_ABOVE).toBe('\x1b[1A\x1b[2K');
    });
  });

  describe('KEY', () => {
    it('should define Ctrl+C key code', () => {
      expect(KEY.CTRL_C).toBe('\u0003');
    });

    it('should define ESC key code', () => {
      expect(KEY.ESC).toBe('\u001b');
    });

    it('should define TAB key code', () => {
      expect(KEY.TAB).toBe('\t');
    });

    it('should define SHIFT_TAB key code', () => {
      expect(KEY.SHIFT_TAB).toBe('\u001b[Z');
    });

    it('should define ENTER key codes', () => {
      expect(KEY.ENTER).toBe('\r');
      expect(KEY.NEWLINE).toBe('\n');
    });

    it('should define arrow key codes', () => {
      expect(KEY.ARROW_UP).toBe('\u001b[A');
      expect(KEY.ARROW_DOWN).toBe('\u001b[B');
      expect(KEY.ARROW_LEFT).toBe('\u001b[D');
      expect(KEY.ARROW_RIGHT).toBe('\u001b[C');
    });

    it('should define SPACE key code', () => {
      expect(KEY.SPACE).toBe(' ');
    });

    it('should define backspace key codes', () => {
      expect(KEY.BACKSPACE).toBe('\u007f');
      expect(KEY.BACKSPACE_ALT).toBe('\b');
    });

    it('should define pagination key codes', () => {
      expect(KEY.CTRL_BRACKET_LEFT).toBe('\u001b'); // ESC
      expect(KEY.CTRL_BRACKET_RIGHT).toBe('\u001d');
    });
  });

  describe('BOX', () => {
    it('should define box drawing characters', () => {
      expect(BOX.TOP_LEFT).toBe('╭');
      expect(BOX.TOP_RIGHT).toBe('╮');
      expect(BOX.BOTTOM_LEFT).toBe('╰');
      expect(BOX.BOTTOM_RIGHT).toBe('╯');
      expect(BOX.HORIZONTAL).toBe('─');
      expect(BOX.VERTICAL).toBe('│');
    });
  });

  describe('SYMBOL', () => {
    it('should define UI symbols', () => {
      expect(SYMBOL.SEARCH_ICON).toBe('⌕');
      expect(SYMBOL.CURSOR).toBe('█');
      expect(SYMBOL.CIRCLE_FILLED).toBe('◉');
      expect(SYMBOL.CIRCLE_EMPTY).toBe('◯');
      expect(SYMBOL.CURSOR_INDICATOR).toBe('› ');
      expect(SYMBOL.TRUNCATION).toBe('...');
    });
  });

  describe('PAGINATION_CONTROL', () => {
    it('should define pagination control values', () => {
      expect(PAGINATION_CONTROL.PREV).toBe('prev');
      expect(PAGINATION_CONTROL.NEXT).toBe('next');
    });

    it('should type PaginationControl correctly', () => {
      const prev: PaginationControl = 'prev';
      const next: PaginationControl = 'next';
      expect(prev).toBe('prev');
      expect(next).toBe('next');
    });
  });

  describe('TEXT', () => {
    it('should define label text', () => {
      expect(TEXT.LABEL).toBe('Assistants');
    });

    it('should define tab hint text', () => {
      expect(TEXT.TAB_HINT).toBe('(←/→, tab/shift+tab to cycle)');
    });

    it('should define search placeholder', () => {
      expect(TEXT.SEARCH_PLACEHOLDER).toBe('Search…');
    });

    it('should define instruction text', () => {
      expect(TEXT.INSTRUCTIONS).toBe('↑↓ to Navigate • Space to select item • Enter to Confirm');
    });

    it('should define pagination instruction text', () => {
      expect(TEXT.INSTRUCTIONS_WITH_PAGINATION).toBe('↑↓ to Navigate • Ctrl+[/] to change page • Space to select item • Enter to Confirm');
    });

    it('should define button text', () => {
      expect(TEXT.CONTINUE_BUTTON).toBe('Continue');
      expect(TEXT.CANCEL_BUTTON).toBe('Cancel');
    });

    it('should define no assistants message', () => {
      expect(TEXT.NO_ASSISTANTS).toBe('No assistants found.');
    });

    it('should define error prefix', () => {
      expect(TEXT.ERROR_PREFIX).toBe('Error: ');
    });
  });

  describe('CONFIG', () => {
    it('should define items per page', () => {
      expect(CONFIG.ITEMS_PER_PAGE).toBe(5);
    });

    it('should define fetch timeout', () => {
      expect(CONFIG.FETCH_TIMEOUT_MS).toBe(10000);
    });

    it('should define description max length', () => {
      expect(CONFIG.DESCRIPTION_MAX_LENGTH).toBe(80);
    });

    it('should define keep alive interval', () => {
      expect(CONFIG.KEEP_ALIVE_INTERVAL_MS).toBe(1000);
    });

    it('should define search debounce delay', () => {
      expect(CONFIG.SEARCH_DEBOUNCE_MS).toBe(500);
    });

    it('should define printable character range', () => {
      expect(CONFIG.PRINTABLE_CHAR_MIN).toBe(32);
      expect(CONFIG.PRINTABLE_CHAR_MAX).toBe(126);
    });
  });

  describe('PANEL_ID', () => {
    it('should define panel ID values', () => {
      expect(PANEL_ID.REGISTERED).toBe('registered');
      expect(PANEL_ID.PROJECT).toBe('project');
      expect(PANEL_ID.MARKETPLACE).toBe('marketplace');
    });

    it('should define PANEL_IDS array', () => {
      expect(PANEL_IDS).toHaveLength(3);
      expect(PANEL_IDS).toContain('registered');
      expect(PANEL_IDS).toContain('project');
      expect(PANEL_IDS).toContain('marketplace');
    });

    it('should type PanelId correctly', () => {
      const registered: PanelId = 'registered';
      const project: PanelId = 'project';
      const marketplace: PanelId = 'marketplace';
      expect(registered).toBe('registered');
      expect(project).toBe('project');
      expect(marketplace).toBe('marketplace');
    });
  });

  describe('API_SCOPE', () => {
    it('should define API scope values', () => {
      expect(API_SCOPE.VISIBLE_TO_USER).toBe('visible_to_user');
      expect(API_SCOPE.MARKETPLACE).toBe('marketplace');
    });
  });

  describe('config value ranges', () => {
    it('should have positive timeout values', () => {
      expect(CONFIG.FETCH_TIMEOUT_MS).toBeGreaterThan(0);
      expect(CONFIG.KEEP_ALIVE_INTERVAL_MS).toBeGreaterThan(0);
      expect(CONFIG.SEARCH_DEBOUNCE_MS).toBeGreaterThan(0);
    });

    it('should have reasonable items per page', () => {
      expect(CONFIG.ITEMS_PER_PAGE).toBeGreaterThan(0);
      expect(CONFIG.ITEMS_PER_PAGE).toBeLessThanOrEqual(50);
    });

    it('should have valid printable character range', () => {
      expect(CONFIG.PRINTABLE_CHAR_MIN).toBeLessThan(CONFIG.PRINTABLE_CHAR_MAX);
      expect(CONFIG.PRINTABLE_CHAR_MIN).toBeGreaterThanOrEqual(0);
      expect(CONFIG.PRINTABLE_CHAR_MAX).toBeLessThanOrEqual(127);
    });
  });
});

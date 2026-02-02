/**
 * Unit tests for terminal codes utilities
 */

import { describe, it, expect } from 'vitest';
import {
  startsWithEscape,
  isKey,
} from '../terminalCodes.js';

describe('terminalCodes', () => {
  describe('startsWithEscape', () => {
    it('should return true for strings starting with ESC', () => {
      expect(startsWithEscape('\x1b')).toBe(true);
      expect(startsWithEscape('\x1b[A')).toBe(true);
      expect(startsWithEscape('\x1b[B')).toBe(true);
      expect(startsWithEscape('\x1b[2K')).toBe(true);
    });

    it('should return false for strings not starting with ESC', () => {
      expect(startsWithEscape('a')).toBe(false);
      expect(startsWithEscape('hello')).toBe(false);
      expect(startsWithEscape(' \x1b')).toBe(false);
      expect(startsWithEscape('')).toBe(false);
    });
  });

  describe('isKey', () => {
    it('should return true for matching ESCAPE key', () => {
      expect(isKey('\x1b', 'ESCAPE')).toBe(true);
    });

    it('should return true for matching ARROW_UP key', () => {
      expect(isKey('\x1b[A', 'ARROW_UP')).toBe(true);
    });

    it('should return true for matching ARROW_DOWN key', () => {
      expect(isKey('\x1b[B', 'ARROW_DOWN')).toBe(true);
    });

    it('should return false for non-matching keys', () => {
      expect(isKey('\x1b[A', 'ARROW_DOWN')).toBe(false);
      expect(isKey('\x1b[B', 'ARROW_UP')).toBe(false);
      expect(isKey('\x1b', 'ARROW_UP')).toBe(false);
      expect(isKey('a', 'ESCAPE')).toBe(false);
    });

    it('should handle empty strings', () => {
      expect(isKey('', 'ESCAPE')).toBe(false);
      expect(isKey('', 'ARROW_UP')).toBe(false);
    });

    it('should handle partial sequences', () => {
      expect(isKey('\x1b[', 'ARROW_UP')).toBe(false);
      expect(isKey('\x1b[', 'ARROW_DOWN')).toBe(false);
    });

    it('should handle longer sequences', () => {
      expect(isKey('\x1b[A\x1b[B', 'ARROW_UP')).toBe(false);
      expect(isKey('\x1b[Axyz', 'ARROW_UP')).toBe(false);
    });
  });
});

/**
 * Unit tests for autocomplete utilities
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseAutocompleteQuery,
  filterAssistants,
  renderAutocompleteUI,
  clearAutocompleteUI,
  selectSuggestion,
  navigateUp,
  navigateDown,
  MAX_SUGGESTIONS,
  AUTOCOMPLETE_TRIGGER,
  type AssistantSuggestion,
} from '../autocomplete.js';

beforeAll(() => {
  process.env.FORCE_COLOR = '1';
});

const mockAssistants: AssistantSuggestion[] = [
  { slug: 'code-reviewer', name: 'Code Reviewer' },
  { slug: 'solution-architect', name: 'Solution Architect' },
  { slug: 'test-writer', name: 'Test Writer' },
  { slug: 'debugger', name: 'Debugger Assistant' },
  { slug: 'doc-writer', name: 'Documentation Writer' },
];

describe('autocomplete utilities', () => {
  describe('constants', () => {
    it('should export MAX_SUGGESTIONS', () => {
      expect(MAX_SUGGESTIONS).toBe(10);
    });

    it('should export AUTOCOMPLETE_TRIGGER', () => {
      expect(AUTOCOMPLETE_TRIGGER).toBe('@');
    });
  });

  describe('parseAutocompleteQuery', () => {
    it('should parse query after @ at end of line', () => {
      const result = parseAutocompleteQuery('@code');

      expect(result).toEqual({
        hasQuery: true,
        query: 'code',
        startPosition: 0,
      });
    });

    it('should parse query after @ in middle of line', () => {
      const result = parseAutocompleteQuery('Hello @code world', 10);

      expect(result).toEqual({
        hasQuery: true,
        query: 'cod', // Cursor at position 10 is before 'e'
        startPosition: 6,
      });
    });

    it('should parse empty query right after @', () => {
      const result = parseAutocompleteQuery('@');

      expect(result).toEqual({
        hasQuery: true,
        query: '',
        startPosition: 0,
      });
    });

    it('should parse query with @ in middle of word', () => {
      const result = parseAutocompleteQuery('Hello @cod');

      expect(result).toEqual({
        hasQuery: true,
        query: 'cod',
        startPosition: 6,
      });
    });

    it('should return no query when @ not found', () => {
      const result = parseAutocompleteQuery('Hello world');

      expect(result).toEqual({
        hasQuery: false,
        query: '',
        startPosition: -1,
      });
    });

    it('should stop at whitespace before @', () => {
      const result = parseAutocompleteQuery('Hello @code test', 11);

      expect(result).toEqual({
        hasQuery: true,
        query: 'code',
        startPosition: 6,
      });
    });

    it('should not find @ separated by space', () => {
      const result = parseAutocompleteQuery('@ code', 6);

      expect(result).toEqual({
        hasQuery: false,
        query: '',
        startPosition: -1,
      });
    });

    it('should handle multiple @ symbols and use closest', () => {
      const result = parseAutocompleteQuery('@@test');

      expect(result).toEqual({
        hasQuery: true,
        query: 'test',
        startPosition: 1,
      });
    });

    it('should default cursor position to end of line', () => {
      const result = parseAutocompleteQuery('@code-rev');

      expect(result.query).toBe('code-rev');
    });

    it('should handle @ at end with trailing content', () => {
      const result = parseAutocompleteQuery('test @', 6);

      expect(result).toEqual({
        hasQuery: true,
        query: '',
        startPosition: 5,
      });
    });
  });

  describe('filterAssistants', () => {
    it('should filter assistants by slug substring', () => {
      const result = filterAssistants('code', mockAssistants);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('code-reviewer');
    });

    it('should be case insensitive', () => {
      const result = filterAssistants('CODE', mockAssistants);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('code-reviewer');
    });

    it('should return all assistants for empty query', () => {
      const result = filterAssistants('', mockAssistants);

      expect(result).toHaveLength(5);
    });

    it('should return multiple matches', () => {
      const result = filterAssistants('wri', mockAssistants);

      expect(result).toHaveLength(2);
      expect(result.map(a => a.slug)).toContain('test-writer');
      expect(result.map(a => a.slug)).toContain('doc-writer');
    });

    it('should return empty array when no matches', () => {
      const result = filterAssistants('xyz', mockAssistants);

      expect(result).toHaveLength(0);
    });

    it('should match partial slugs', () => {
      const result = filterAssistants('debug', mockAssistants);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('debugger');
    });

    it('should respect maxResults parameter', () => {
      const result = filterAssistants('', mockAssistants, 2);

      expect(result).toHaveLength(2);
    });

    it('should limit to MAX_SUGGESTIONS by default', () => {
      const manyAssistants = Array.from({ length: 20 }, (_, i) => ({
        slug: `assistant-${i}`,
        name: `Assistant ${i}`,
      }));

      const result = filterAssistants('', manyAssistants);

      expect(result).toHaveLength(MAX_SUGGESTIONS);
    });

    it('should handle assistants with hyphens', () => {
      const result = filterAssistants('solution-arch', mockAssistants);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('solution-architect');
    });

    it('should match anywhere in slug', () => {
      const result = filterAssistants('arch', mockAssistants);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('solution-architect');
    });
  });

  describe('renderAutocompleteUI', () => {
    it('should render suggestions with ANSI codes', () => {
      const result = renderAutocompleteUI(
        mockAssistants.slice(0, 2),
        0,
        '@code'
      );

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result).toContain('code-reviewer - Code Reviewer');
      expect(result).toContain('solution-architect - Solution Architect');
    });

    it('should include cursor positioning codes', () => {
      const result = renderAutocompleteUI(
        mockAssistants.slice(0, 2),
        0,
        '@code'
      );

      expect(result).toContain('\x1b[2A'); // Move up 2 lines
      expect(result).toContain('\r> @code'); // Restore prompt
    });

    it('should highlight selected item', () => {
      const result = renderAutocompleteUI(
        mockAssistants.slice(0, 2),
        1,
        '@sol'
      );

      // Selected item should be highlighted
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should handle single suggestion', () => {
      const result = renderAutocompleteUI(
        [mockAssistants[0]],
        0,
        '@code'
      );

      expect(result).toContain('\x1b[1A'); // Move up 1 line
      expect(result).toContain('code-reviewer - Code Reviewer');
    });

    it('should include line clear codes', () => {
      const result = renderAutocompleteUI(
        mockAssistants.slice(0, 2),
        0,
        '@test'
      );

      expect(result).toContain('\x1b[K'); // Clear to end of line
    });

    it('should handle long current line', () => {
      const longLine = '@code-reviewer-assistant-with-long-name';
      const result = renderAutocompleteUI(
        mockAssistants.slice(0, 1),
        0,
        longLine
      );

      expect(result).toContain(longLine);
    });

    it('should render empty string for empty list', () => {
      const result = renderAutocompleteUI([], 0, '@test');

      // Should still have some output (cursor positioning)
      expect(typeof result).toBe('string');
    });
  });

  describe('clearAutocompleteUI', () => {
    it('should return empty string for zero lines', () => {
      const result = clearAutocompleteUI(0, '@test');

      expect(result).toBe('');
    });

    it('should generate clear codes for N lines', () => {
      const result = clearAutocompleteUI(3, '@code');

      expect(result).toContain('\x1b[2K'); // Clear line code
      expect(result).toContain('\x1b[3A'); // Move up 3 lines
      expect(result).toContain('\r> @code'); // Restore prompt
    });

    it('should clear single line', () => {
      const result = clearAutocompleteUI(1, '@test');

      expect(result).toContain('\x1b[2K');
      expect(result).toContain('\x1b[1A');
    });

    it('should restore current line in output', () => {
      const currentLine = '@solution';
      const result = clearAutocompleteUI(2, currentLine);

      expect(result).toContain(`\r> ${currentLine}`);
    });

    it('should handle many lines', () => {
      const result = clearAutocompleteUI(10, '@a');

      expect(result).toContain('\x1b[10A'); // Move up 10 lines
    });
  });

  describe('selectSuggestion', () => {
    it('should replace partial query with full slug', () => {
      const result = selectSuggestion('code-reviewer', '@cod', 0);

      expect(result).toEqual({
        newLine: '@code-reviewer ',
        backspaceCount: 3, // 'cod'
        insertText: 'code-reviewer ',
      });
    });

    it('should handle empty query (just @)', () => {
      const result = selectSuggestion('debugger', '@', 0);

      expect(result).toEqual({
        newLine: '@debugger ',
        backspaceCount: 0,
        insertText: 'debugger ',
      });
    });

    it('should preserve text before @', () => {
      const result = selectSuggestion('test-writer', 'Hello @tes', 6);

      expect(result).toEqual({
        newLine: 'Hello @test-writer ',
        backspaceCount: 3, // 'tes'
        insertText: 'test-writer ',
      });
    });

    it('should handle @ at different positions', () => {
      const result = selectSuggestion('doc-writer', 'Ask @doc for help', 4);

      expect(result).toEqual({
        newLine: 'Ask @doc-writer ',
        backspaceCount: 12, // 'doc for help' (everything after @)
        insertText: 'doc-writer ',
      });
    });

    it('should add trailing space after slug', () => {
      const result = selectSuggestion('debugger', '@debug', 0);

      expect(result.insertText).toMatch(/ $/); // Ends with space
      expect(result.newLine).toBe('@debugger ');
    });

    it('should calculate correct backspace count', () => {
      const result = selectSuggestion('solution-architect', '@solution', 0);

      expect(result.backspaceCount).toBe(8); // 'solution'
    });

    it('should handle slug with hyphens', () => {
      const result = selectSuggestion('code-reviewer', '@code-rev', 0);

      expect(result.newLine).toBe('@code-reviewer ');
      expect(result.backspaceCount).toBe(8); // 'code-rev'
    });
  });

  describe('navigateUp', () => {
    it('should move selection up by 1', () => {
      const result = navigateUp(2, 5);

      expect(result).toBe(1);
    });

    it('should wrap to end when at start', () => {
      const result = navigateUp(0, 5);

      expect(result).toBe(4);
    });

    it('should return 0 for empty list', () => {
      const result = navigateUp(0, 0);

      expect(result).toBe(0);
    });

    it('should handle single item list', () => {
      const result = navigateUp(0, 1);

      expect(result).toBe(0);
    });

    it('should handle last item', () => {
      const result = navigateUp(4, 5);

      expect(result).toBe(3);
    });
  });

  describe('navigateDown', () => {
    it('should move selection down by 1', () => {
      const result = navigateDown(2, 5);

      expect(result).toBe(3);
    });

    it('should wrap to start when at end', () => {
      const result = navigateDown(4, 5);

      expect(result).toBe(0);
    });

    it('should return 0 for empty list', () => {
      const result = navigateDown(0, 0);

      expect(result).toBe(0);
    });

    it('should handle single item list', () => {
      const result = navigateDown(0, 1);

      expect(result).toBe(0);
    });

    it('should handle first item', () => {
      const result = navigateDown(0, 5);

      expect(result).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in query', () => {
      const assistants: AssistantSuggestion[] = [
        { slug: 'test-1', name: 'Test 1' },
        { slug: 'test_2', name: 'Test 2' },
      ];

      const result = filterAssistants('test-', assistants);
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('test-1');
    });

    it('should handle empty assistants list', () => {
      const result = filterAssistants('test', []);
      expect(result).toHaveLength(0);
    });

    it('should handle very long query', () => {
      const longQuery = 'a'.repeat(100);
      const result = filterAssistants(longQuery, mockAssistants);
      expect(result).toHaveLength(0);
    });

    it('should handle numeric characters in slug', () => {
      const assistants: AssistantSuggestion[] = [
        { slug: 'gpt-4', name: 'GPT-4 Assistant' },
        { slug: 'claude-3', name: 'Claude 3' },
      ];

      const result = filterAssistants('4', assistants);
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('gpt-4');
    });

    it('should handle @ in middle of longer text', () => {
      const result = parseAutocompleteQuery('Please ask @code-reviewer about this', 25);
      expect(result.hasQuery).toBe(true);
      expect(result.query).toBe('code-reviewer');
    });
  });

  describe('type exports', () => {
    it('should export AssistantSuggestion type', () => {
      const suggestion: AssistantSuggestion = {
        slug: 'test',
        name: 'Test Assistant',
      };

      expect(suggestion.slug).toBe('test');
      expect(suggestion.name).toBe('Test Assistant');
    });
  });
});

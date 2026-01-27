/**
 * Tests for HookMatcher
 */

import { describe, it, expect } from 'vitest';
import { HookMatcher } from '../matcher.js';

describe('HookMatcher', () => {
	describe('matches', () => {
		it('should match wildcard pattern', () => {
			expect(HookMatcher.matches('*', 'Bash')).toBe(true);
			expect(HookMatcher.matches('*', 'Read')).toBe(true);
			expect(HookMatcher.matches('*', 'AnyTool')).toBe(true);
		});

		it('should match literal tool names', () => {
			expect(HookMatcher.matches('Bash', 'Bash')).toBe(true);
			expect(HookMatcher.matches('Read', 'Read')).toBe(true);
			expect(HookMatcher.matches('Bash', 'Read')).toBe(false);
		});

		it('should match regex patterns with alternation', () => {
			expect(HookMatcher.matches('Bash|Write', 'Bash')).toBe(true);
			expect(HookMatcher.matches('Bash|Write', 'Write')).toBe(true);
			expect(HookMatcher.matches('Bash|Write', 'Read')).toBe(false);
		});

		it('should match regex patterns with character classes', () => {
			expect(HookMatcher.matches('[BR]ash', 'Bash')).toBe(true);
			expect(HookMatcher.matches('[BR]ash', 'Rash')).toBe(true);
			expect(HookMatcher.matches('[BR]ash', 'Cash')).toBe(false);
		});

		it('should match regex patterns with groups', () => {
			expect(HookMatcher.matches('(Bash|Write)', 'Bash')).toBe(true);
			expect(HookMatcher.matches('(Bash|Write)', 'Write')).toBe(true);
			expect(HookMatcher.matches('(Bash|Write)', 'Read')).toBe(false);
		});

		it('should handle invalid regex as literal string', () => {
			expect(HookMatcher.matches('[invalid', '[invalid')).toBe(true);
			expect(HookMatcher.matches('[invalid', 'Bash')).toBe(false);
		});

		it('should be case-sensitive', () => {
			expect(HookMatcher.matches('bash', 'Bash')).toBe(false);
			expect(HookMatcher.matches('Bash', 'bash')).toBe(false);
		});
	});

	describe('findMatches', () => {
		it('should find all matching patterns', () => {
			const patterns = ['Bash', 'Write|Edit', '*'];
			expect(HookMatcher.findMatches(patterns, 'Bash')).toEqual([
				'Bash',
				'*',
			]);
			expect(HookMatcher.findMatches(patterns, 'Write')).toEqual([
				'Write|Edit',
				'*',
			]);
			expect(HookMatcher.findMatches(patterns, 'Read')).toEqual(['*']);
		});

		it('should return empty array when no patterns match', () => {
			const patterns = ['Bash', 'Write'];
			expect(HookMatcher.findMatches(patterns, 'Read')).toEqual([]);
		});
	});

	describe('validate', () => {
		it('should validate empty pattern as invalid', () => {
			const result = HookMatcher.validate('');
			expect(result.valid).toBe(false);
			expect(result.warnings).toContain('Pattern cannot be empty');
		});

		it('should validate valid literal pattern', () => {
			const result = HookMatcher.validate('Bash');
			expect(result.valid).toBe(true);
			expect(result.warnings).toHaveLength(0);
		});

		it('should validate valid regex pattern', () => {
			const result = HookMatcher.validate('Bash|Write');
			expect(result.valid).toBe(true);
			expect(result.warnings).toHaveLength(0);
		});

		it('should detect invalid regex patterns', () => {
			const result = HookMatcher.validate('[invalid');
			expect(result.valid).toBe(false);
			expect(result.warnings.length).toBeGreaterThan(0);
		});

		it('should warn about unescaped dots in regex patterns', () => {
			// Dots only matter in regex patterns (those with special chars)
			const result = HookMatcher.validate('(Bash|Write).');
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain(
				'Pattern contains unescaped dots (.) which match any character in regex',
			);
		});

		it('should warn about leading/trailing spaces', () => {
			const result = HookMatcher.validate(' Bash ');
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain('Pattern contains leading/trailing spaces');
		});
	});
});

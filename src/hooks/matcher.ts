/**
 * Hook Matcher
 *
 * Provides pattern matching logic for determining which hooks should execute
 * for a given tool name. Supports literal matches, wildcards, and regex patterns.
 */

import { logger } from '../utils/logger.js';

export class HookMatcher {
	/**
	 * Check if a pattern matches a tool name
	 *
	 * @param pattern - Pattern to match (regex, wildcard *, or literal string)
	 * @param toolName - Tool name to test against pattern
	 * @returns true if pattern matches tool name
	 *
	 * @example
	 * HookMatcher.matches('*', 'Bash') // true (wildcard)
	 * HookMatcher.matches('Bash|Write', 'Bash') // true (regex)
	 * HookMatcher.matches('Bash', 'Bash') // true (literal)
	 * HookMatcher.matches('Bash', 'Read') // false
	 */
	static matches(pattern: string, toolName: string): boolean {
		try {
			// Handle wildcard - matches everything
			if (pattern === '*') {
				return true;
			}

			// Handle regex patterns (contains special regex characters)
			// Common regex chars: | (alternation), [] (character class), {} (quantifier), () (group)
			if (/[|[\]{}()]/.test(pattern)) {
				try {
					// Wrap pattern with anchors to match full tool name
					const regex = new RegExp(`^(${pattern})$`);
					return regex.test(toolName);
				} catch (error) {
					// Invalid regex, treat as literal string
					logger.warn(`Invalid regex pattern "${pattern}", treating as literal: ${error}`);
					return pattern === toolName;
				}
			}

			// Literal string match
			return pattern === toolName;
		} catch (error) {
			logger.error(`Error matching pattern "${pattern}" against "${toolName}": ${error}`);
			return false;
		}
	}

	/**
	 * Find all patterns that match a tool name
	 *
	 * @param patterns - Array of patterns to test
	 * @param toolName - Tool name to match against
	 * @returns Array of matching patterns
	 */
	static findMatches(patterns: string[], toolName: string): string[] {
		return patterns.filter((pattern) => this.matches(pattern, toolName));
	}

	/**
	 * Validate a pattern for common mistakes
	 *
	 * @param pattern - Pattern to validate
	 * @returns Validation result with any warnings
	 */
	static validate(pattern: string): { valid: boolean; warnings: string[] } {
		const warnings: string[] = [];

		// Check for empty pattern
		if (!pattern || pattern.trim() === '') {
			return { valid: false, warnings: ['Pattern cannot be empty'] };
		}

		// Check for potential regex mistakes
		if (/[|[\]{}()]/.test(pattern)) {
			try {
				new RegExp(`^(${pattern})$`);
			} catch (error) {
				warnings.push(`Pattern appears to be regex but is invalid: ${error}`);
				return { valid: false, warnings };
			}

			// Warn about unescaped dots (likely mistake)
			if (/(?<!\\)\./.test(pattern)) {
				warnings.push('Pattern contains unescaped dots (.) which match any character in regex');
			}
		}

		// Warn about trailing/leading spaces
		if (pattern !== pattern.trim()) {
			warnings.push('Pattern contains leading/trailing spaces');
		}

		return { valid: true, warnings };
	}
}

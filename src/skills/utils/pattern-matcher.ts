/**
 * Pattern matcher for skill invocation detection
 *
 * Detects /skill-name patterns in user messages and extracts skill names.
 * Excludes URLs and built-in CLI commands.
 */

/**
 * Skill pattern detected in a message
 */
export interface SkillPattern {
  /** Skill name (e.g., 'mr', 'commit') */
  name: string;
  /** Position in message where pattern starts */
  position: number;
  /** Optional arguments after skill name */
  args?: string;
  /** Full matched pattern (e.g., '/mr', '/commit -m "fix"') */
  raw: string;
}

/**
 * Result of pattern matching
 */
export interface PatternMatchResult {
  /** Detected skill patterns */
  patterns: SkillPattern[];
  /** Original message */
  originalMessage: string;
  /** Whether any patterns were found */
  hasPatterns: boolean;
}

/**
 * Built-in CLI commands that should NOT be treated as skills
 */
const BUILT_IN_COMMANDS = new Set([
  'help',
  'clear',
  'exit',
  'quit',
  'stats',
  'todos',
  'config',
  'health',
]);

/**
 * Regex pattern for skill invocation
 *
 * Matches: /skill-name with optional arguments
 * Excludes: URLs (negative lookbehind for : or alphanumeric before /)
 * Format: /[a-z][a-z0-9-]{0,49} (lowercase, alphanumeric + hyphens, 1-50 chars)
 */
const SKILL_PATTERN = /(?<![:\w])\/([a-z][a-z0-9-]{0,49})(?:\s+([^\n/]+))?/g;

/**
 * Extract skill patterns from a user message
 *
 * @param message - User message to scan
 * @returns Pattern match result with detected skills
 *
 * @example
 * ```typescript
 * const result = extractSkillPatterns('/mr');
 * // result.patterns = [{ name: 'mr', position: 0, raw: '/mr' }]
 *
 * const result2 = extractSkillPatterns('ensure you can /commit this');
 * // result2.patterns = [{ name: 'commit', position: 15, args: 'this', raw: '/commit this' }]
 * ```
 */
export function extractSkillPatterns(message: string): PatternMatchResult {
  const patterns: SkillPattern[] = [];
  const seenNames = new Set<string>();

  // Reset regex state
  SKILL_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SKILL_PATTERN.exec(message)) !== null) {
    const [fullMatch, skillName, args] = match;
    const position = match.index;

    // Skip if this is part of a URL
    // Check if there's http:// or https:// within the last 100 chars before this position
    const lookback = Math.min(100, position);
    const beforeMatch = message.slice(position - lookback, position);

    // If we find a protocol and no whitespace between it and this slash, it's part of a URL
    if (/https?:\/\/[^\s]*$/.test(beforeMatch)) {
      continue;
    }

    // Skip built-in commands
    if (BUILT_IN_COMMANDS.has(skillName)) {
      continue;
    }

    // Deduplicate by skill name (keep first occurrence)
    if (seenNames.has(skillName)) {
      continue;
    }
    seenNames.add(skillName);

    patterns.push({
      name: skillName,
      position,
      args: args?.trim(),
      raw: fullMatch,
    });
  }

  return {
    patterns,
    originalMessage: message,
    hasPatterns: patterns.length > 0,
  };
}

/**
 * Validate a skill name
 *
 * @param name - Skill name to validate
 * @returns True if valid, false otherwise
 *
 * Rules:
 * - Lowercase letters only
 * - Can include digits and hyphens
 * - Must start with a letter
 * - 1-50 characters
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,49}$/.test(name);
}

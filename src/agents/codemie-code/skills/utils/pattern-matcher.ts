/**
 * Pattern matcher for skill invocation detection
 *
 * Detects /skill-name patterns in user messages and extracts skill names.
 * Supports namespaced skills: /plugin-name:skill-name
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
  /** Plugin namespace (e.g., 'gitlab-tools' in '/gitlab-tools:mr') */
  namespace?: string;
  /** Full namespaced name (e.g., 'gitlab-tools:mr' or just 'mr' if no namespace) */
  fullName: string;
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
 * Matches:
 * - /skill-name with optional arguments
 * - /plugin-name:skill-name with optional arguments (namespaced)
 *
 * Excludes: URLs (negative lookbehind for : or alphanumeric before /)
 *
 * Format:
 * - Simple: /[a-z][a-z0-9-]{0,49}
 * - Namespaced: /[a-z][a-z0-9-]{0,49}:[a-z][a-z0-9-]{0,49}
 *
 * Groups:
 * 1. First part (plugin name or skill name)
 * 2. Second part after colon (skill name if namespaced)
 * 3. Arguments
 */
const SKILL_PATTERN =
  /(?<![:\w])\/([a-z][a-z0-9-]{0,49})(?::([a-z][a-z0-9-]{0,49}))?(?:\s+([^\n/]+))?/g;

/**
 * Extract skill patterns from a user message
 *
 * @param message - User message to scan
 * @returns Pattern match result with detected skills
 *
 * @example
 * ```typescript
 * // Simple skill invocation
 * const result = extractSkillPatterns('/mr');
 * // result.patterns = [{ name: 'mr', fullName: 'mr', position: 0, raw: '/mr' }]
 *
 * // With arguments
 * const result2 = extractSkillPatterns('ensure you can /commit this');
 * // result2.patterns = [{ name: 'commit', fullName: 'commit', position: 15, args: 'this', raw: '/commit this' }]
 *
 * // Namespaced skill (plugin)
 * const result3 = extractSkillPatterns('/gitlab-tools:mr');
 * // result3.patterns = [{
 * //   name: 'mr',
 * //   namespace: 'gitlab-tools',
 * //   fullName: 'gitlab-tools:mr',
 * //   position: 0,
 * //   raw: '/gitlab-tools:mr'
 * // }]
 * ```
 */
export function extractSkillPatterns(message: string): PatternMatchResult {
  const patterns: SkillPattern[] = [];
  const seenFullNames = new Set<string>();

  // Reset regex state
  SKILL_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SKILL_PATTERN.exec(message)) !== null) {
    const [fullMatch, firstPart, secondPart, args] = match;
    const position = match.index;

    // Skip if this is part of a URL
    // Check if there's http:// or https:// within the last 100 chars before this position
    const lookback = Math.min(100, position);
    const beforeMatch = message.slice(position - lookback, position);

    // If we find a protocol and no whitespace between it and this slash, it's part of a URL
    if (/https?:\/\/[^\s]*$/.test(beforeMatch)) {
      continue;
    }

    // Determine if namespaced or simple
    const isNamespaced = secondPart !== undefined;
    const namespace = isNamespaced ? firstPart : undefined;
    const name = isNamespaced ? secondPart : firstPart;
    const fullName = isNamespaced ? `${firstPart}:${secondPart}` : firstPart;

    // Skip built-in commands (only if not namespaced)
    if (!isNamespaced && BUILT_IN_COMMANDS.has(name)) {
      continue;
    }

    // Deduplicate by full name (keep first occurrence)
    if (seenFullNames.has(fullName)) {
      continue;
    }
    seenFullNames.add(fullName);

    patterns.push({
      name,
      namespace,
      fullName,
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

/**
 * Validate a namespaced skill name (plugin:skill)
 *
 * @param fullName - Full skill name (can be 'skill' or 'plugin:skill')
 * @returns True if valid, false otherwise
 */
export function isValidNamespacedSkillName(fullName: string): boolean {
  // Check for namespaced format
  if (fullName.includes(':')) {
    const parts = fullName.split(':');
    if (parts.length !== 2) {
      return false;
    }
    return isValidSkillName(parts[0]) && isValidSkillName(parts[1]);
  }

  // Simple skill name
  return isValidSkillName(fullName);
}

/**
 * Parse a namespaced skill name
 *
 * @param fullName - Full skill name (can be 'skill' or 'plugin:skill')
 * @returns Parsed namespace and skill name
 */
export function parseNamespacedSkillName(fullName: string): {
  namespace?: string;
  name: string;
} {
  if (fullName.includes(':')) {
    const [namespace, name] = fullName.split(':');
    return { namespace, name };
  }

  return { name: fullName };
}

/**
 * Path Utilities
 *
 * Consolidated path operations including:
 * - Cross-platform path normalization
 * - Path structure validation
 * - Security checks (directory traversal prevention)
 * - UUID validation for session files
 * - CodeMie home directory resolution
 * - ESM module path utilities
 */

import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ============================================================================
// Path Normalization and Manipulation
// ============================================================================

/**
 * Normalize path separators to forward slashes for cross-platform consistency
 *
 * This function converts all backslashes to forward slashes, allowing the code
 * to handle both Windows (C:\path\to\file) and Unix (/path/to/file) paths
 * uniformly on any platform.
 *
 * @param filePath - Path with either forward slashes or backslashes
 * @returns Path with only forward slashes
 *
 * @example
 * normalizePathSeparators('C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl')
 * // Returns: 'C:/Users/john/.claude/projects/abc/file.jsonl'
 *
 * @example
 * normalizePathSeparators('/home/user/.claude/projects/abc/file.jsonl')
 * // Returns: '/home/user/.claude/projects/abc/file.jsonl' (unchanged)
 */
export function normalizePathSeparators(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/**
 * Split path into parts using forward slash as separator
 *
 * Works consistently across all platforms by first normalizing separators.
 *
 * @param filePath - Path with either forward slashes or backslashes
 * @returns Array of path segments
 *
 * @example
 * splitPath('C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl')
 * // Returns: ['C:', 'Users', 'john', '.claude', 'projects', 'abc', 'file.jsonl']
 *
 * @example
 * splitPath('/home/user/.claude/projects/abc/file.jsonl')
 * // Returns: ['', 'home', 'user', '.claude', 'projects', 'abc', 'file.jsonl']
 */
export function splitPath(filePath: string): string[] {
  const normalized = normalizePathSeparators(filePath);
  return normalized.split('/');
}

/**
 * Get the filename from a path (last segment)
 *
 * @param filePath - Full path
 * @returns Filename with extension
 *
 * @example
 * getFilename('C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl')
 * // Returns: 'file.jsonl'
 */
export function getFilename(filePath: string): string {
  const parts = splitPath(filePath);
  return parts.at(-1) || '';
}

/**
 * Find the index of a base directory in a path (internal helper)
 *
 * @param parts - Path segments from splitPath()
 * @param baseDirName - Base directory name to find
 * @returns Index of the directory, or -1 if not found
 * @internal
 */
function findBaseIndex(parts: string[], baseDirName: string): number {
  return parts.findIndex(part => part === baseDirName);
}

// ============================================================================
// Path Structure Validation
// ============================================================================

/**
 * Check if a path matches a specific structure
 *
 * Validates that a path follows the pattern: {prefix}/{dir1}/{dir2}/{...}/{filename}
 * where the structure is relative to a base directory.
 *
 * @param filePath - Path to validate
 * @param baseDirName - Base directory name to find (e.g., '.claude')
 * @param expectedStructure - Array of directory names that should follow the base directory
 * @returns true if path matches structure, false otherwise
 *
 * @example
 * matchesPathStructure(
 *   'C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl',
 *   '.claude',
 *   ['projects'] // expects: .claude/projects/{hash}/{file}
 * )
 * // Returns: true (has .claude/projects structure)
 *
 * @example
 * matchesPathStructure(
 *   '/home/user/.claude/sessions/abc/file.jsonl',
 *   '.claude',
 *   ['projects']
 * )
 * // Returns: false (has 'sessions' instead of 'projects')
 */
export function matchesPathStructure(
  filePath: string,
  baseDirName: string,
  expectedStructure: string[]
): boolean {
  const parts = splitPath(filePath);
  const baseIndex = findBaseIndex(parts, baseDirName);

  if (baseIndex === -1) {
    return false;
  }

  // Check if expected directories follow the base directory
  for (let i = 0; i < expectedStructure.length; i++) {
    const expectedIndex = baseIndex + 1 + i;
    if (expectedIndex >= parts.length || parts[expectedIndex] !== expectedStructure[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Validate path depth relative to a base directory
 *
 * Checks that there are exactly N segments after the base directory.
 *
 * @param filePath - Path to validate
 * @param baseDirName - Base directory name
 * @param expectedDepth - Number of segments expected after base directory
 * @returns true if depth matches, false otherwise
 *
 * @example
 * validatePathDepth(
 *   'C:\\Users\\john\\.claude\\projects\\abc\\file.jsonl',
 *   '.claude',
 *   3 // expects: .claude/{dir1}/{dir2}/{file}
 * )
 * // Returns: true (has 'projects', 'abc', 'file.jsonl' = 3 segments after .claude)
 */
export function validatePathDepth(
  filePath: string,
  baseDirName: string,
  expectedDepth: number
): boolean {
  const parts = splitPath(filePath);
  const baseIndex = findBaseIndex(parts, baseDirName);

  if (baseIndex === -1) {
    return false;
  }

  const actualDepth = parts.length - baseIndex - 1;
  return actualDepth === expectedDepth;
}

// ============================================================================
// Security Utilities
// ============================================================================

/**
 * Check if a resolved path is within a working directory boundary
 *
 * Uses path.relative() to prevent directory traversal attacks.
 * This is safer than simple string prefix matching which can be bypassed
 * by paths like: /home/user/project-attacker when checking /home/user/project
 *
 * @param workingDir - The working directory boundary
 * @param resolvedPath - The resolved absolute path to check
 * @returns true if path is within workingDir, false otherwise
 *
 * @example
 * isPathWithinDirectory('/home/user/project', '/home/user/project/file.txt')
 * // Returns: true
 *
 * @example
 * isPathWithinDirectory('/home/user/project', '/home/user/project-other/file.txt')
 * // Returns: false (prevented directory traversal)
 *
 * @example
 * isPathWithinDirectory('C:\\Users\\project', 'C:\\Users\\project\\..\\..\\etc\\passwd')
 * // Returns: false (prevented traversal attack)
 */
export function isPathWithinDirectory(workingDir: string, resolvedPath: string): boolean {
  const relative = path.relative(workingDir, resolvedPath);
  // If path starts with '..' or is an absolute path, it's outside workingDir
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// ============================================================================
// UUID Validation Utilities
// ============================================================================

/**
 * UUID regex pattern (any version)
 * Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 * where x is any hexadecimal digit
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate if a string matches UUID format (any version)
 *
 * Supports all UUID versions (v1, v2, v3, v4, v5) with case-insensitive matching.
 *
 * @param str - String to validate
 * @returns true if valid UUID, false otherwise
 *
 * @example
 * isValidUuid('f52d1386-9d4c-4671-a31e-62dd6600a759')
 * // Returns: true
 *
 * @example
 * isValidUuid('F52D1386-9D4C-4671-A31E-62DD6600A759')
 * // Returns: true (case-insensitive)
 *
 * @example
 * isValidUuid('not-a-uuid')
 * // Returns: false
 */
export function isValidUuid(str: string): boolean {
  return UUID_PATTERN.test(str);
}

/**
 * Validate if a filename has a valid UUID format with specific extension
 *
 * Checks that the filename (without extension) is a valid UUID.
 *
 * @param filename - Filename to validate (e.g., 'abc123.jsonl')
 * @param extension - Required extension (e.g., '.jsonl')
 * @returns true if filename is UUID with correct extension, false otherwise
 *
 * @example
 * isValidUuidFilename('f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl', '.jsonl')
 * // Returns: true
 *
 * @example
 * isValidUuidFilename('f52d1386-9d4c-4671-a31e-62dd6600a759.json', '.jsonl')
 * // Returns: false (wrong extension)
 *
 * @example
 * isValidUuidFilename('not-a-uuid.jsonl', '.jsonl')
 * // Returns: false (invalid UUID)
 */
export function isValidUuidFilename(filename: string, extension: string): boolean {
  if (!filename.endsWith(extension)) {
    return false;
  }
  const nameWithoutExt = filename.slice(0, -extension.length);
  return isValidUuid(nameWithoutExt);
}

// ============================================================================
// Home Directory Utilities
// ============================================================================

/**
 * Resolve a path relative to the user's home directory
 *
 * Joins the user's home directory with the provided relative path.
 * Useful for agent data directories like '.claude', '.codex', '.gemini', etc.
 *
 * @param relativePath - Relative path from home directory (e.g., '.claude', '.codex')
 * @returns Absolute path in user's home directory
 *
 * @example
 * resolveHomeDir('.claude')
 * // Returns: '/Users/john/.claude' (on macOS)
 * // Returns: 'C:\\Users\\john\\.claude' (on Windows)
 * // Returns: '/home/user/.claude' (on Linux)
 *
 * @example
 * resolveHomeDir('.codex/auth.json')
 * // Returns: '/Users/john/.codex/auth.json'
 */
export function resolveHomeDir(relativePath: string): string {
  return path.join(homedir(), relativePath);
}

// ============================================================================
// CodeMie Home Directory Resolution
// ============================================================================

/**
 * Get CodeMie home directory
 *
 * Respects CODEMIE_HOME environment variable for custom locations.
 * This enables:
 * - Test isolation (each test gets unique temp directory)
 * - Power user customization (relocate data/config)
 * - Multiple instances (development, staging, production)
 *
 * Precedent: CARGO_HOME, POETRY_HOME, NVM_DIR, PYENV_ROOT
 *
 * Priority:
 * 1. CODEMIE_HOME environment variable
 * 2. ~/.codemie (default)
 *
 * @returns Absolute path to CodeMie home directory
 *
 * @example
 * // Default
 * getCodemieHome() // => '/Users/john/.codemie'
 *
 * // Custom location
 * process.env.CODEMIE_HOME = '/data/codemie';
 * getCodemieHome() // => '/data/codemie'
 *
 * // Test isolation
 * process.env.CODEMIE_HOME = '/tmp/codemie-test-12345';
 * getCodemieHome() // => '/tmp/codemie-test-12345'
 */
export function getCodemieHome(): string {
  if (process.env.CODEMIE_HOME) {
    return process.env.CODEMIE_HOME;
  }

  return path.join(homedir(), '.codemie');
}

/**
 * Get path within CodeMie home directory
 *
 * @param paths Path segments to join with home directory
 * @returns Absolute path within CodeMie home
 *
 * @example
 * getCodemiePath('logs') // => '/Users/john/.codemie/logs'
 * getCodemiePath('metrics', 'sessions') // => '/Users/john/.codemie/metrics/sessions'
 */
export function getCodemiePath(...paths: string[]): string {
  return path.join(getCodemieHome(), ...paths);
}

// ============================================================================
// ESM Module Path Utilities
// ============================================================================

/**
 * Get the directory name of the current module (ESM equivalent of __dirname)
 *
 * @param importMetaUrl - Pass import.meta.url from the calling module
 * @returns The directory path
 *
 * @example
 * // In an ES module:
 * const __dirname = getDirname(import.meta.url);
 */
export function getDirname(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

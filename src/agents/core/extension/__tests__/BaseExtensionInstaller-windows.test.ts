/**
 * Tests for BaseExtensionInstaller - Windows Path Handling
 *
 * Tests Windows-specific path separator issues that prevented
 * template files from being copied to .codemie folder.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import { normalizePathSeparators } from '../../../../utils/paths.js';

/**
 * Simple glob matcher implementation for testing
 * Mirrors the implementation in BaseExtensionInstaller.shouldIncludeFile()
 */
const matchesPattern = (path: string, pattern: string): boolean => {
  const regexPattern = pattern
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`).test(path);
};

describe('BaseExtensionInstaller - Windows Path Handling', () => {
  describe('Path Normalization for Pattern Matching', () => {
    it('should normalize Windows backslashes to forward slashes', () => {
      const windowsPath = 'claude-templates\\README.md';
      const normalized = normalizePathSeparators(windowsPath);
      expect(normalized).toBe('claude-templates/README.md');
    });

    it('should normalize nested Windows paths', () => {
      const windowsPath = 'claude-templates\\guides\\testing\\patterns.md';
      const normalized = normalizePathSeparators(windowsPath);
      expect(normalized).toBe('claude-templates/guides/testing/patterns.md');
    });

    it('should leave Unix paths unchanged', () => {
      const unixPath = 'claude-templates/README.md';
      const normalized = normalizePathSeparators(unixPath);
      expect(normalized).toBe('claude-templates/README.md');
    });

    it('should handle mixed separators', () => {
      const mixedPath = 'claude-templates\\guides/testing\\patterns.md';
      const normalized = normalizePathSeparators(mixedPath);
      expect(normalized).toBe('claude-templates/guides/testing/patterns.md');
    });
  });

  describe('Glob Pattern Matching', () => {
    describe('Windows Path Scenarios', () => {
      it('should match Windows path after normalization', () => {
        const windowsPath = 'claude-templates\\README.md';
        const normalized = normalizePathSeparators(windowsPath);
        const pattern = 'claude-templates/**';

        expect(matchesPattern(normalized, pattern)).toBe(true);
      });

      it('should match nested Windows paths after normalization', () => {
        const windowsPath = 'claude-templates\\guides\\testing\\patterns.md';
        const normalized = normalizePathSeparators(windowsPath);
        const pattern = 'claude-templates/**';

        expect(matchesPattern(normalized, pattern)).toBe(true);
      });

      it('should not match Windows path WITHOUT normalization (bug scenario)', () => {
        const windowsPath = 'claude-templates\\README.md'; // Backslashes
        const pattern = 'claude-templates/**'; // Forward slashes

        // This was the bug: Windows paths don't match forward-slash patterns
        expect(matchesPattern(windowsPath, pattern)).toBe(false);
      });

      it('should match Windows path WITH normalization (fix scenario)', () => {
        const windowsPath = 'claude-templates\\README.md';
        const normalized = normalizePathSeparators(windowsPath);
        const pattern = 'claude-templates/**';

        // After normalization, pattern matching works
        expect(matchesPattern(normalized, pattern)).toBe(true);
      });
    });

    describe('Unix Path Scenarios', () => {
      it('should match Unix paths (already use forward slashes)', () => {
        const unixPath = 'claude-templates/README.md';
        const pattern = 'claude-templates/**';

        expect(matchesPattern(unixPath, pattern)).toBe(true);
      });

      it('should match nested Unix paths', () => {
        const unixPath = 'claude-templates/guides/testing/patterns.md';
        const pattern = 'claude-templates/**';

        expect(matchesPattern(unixPath, pattern)).toBe(true);
      });
    });

    describe('Pattern Variations', () => {
      it('should match single wildcard', () => {
        const path = 'claude-templates/README.md';
        const pattern = 'claude-templates/*.md';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should match double wildcard (recursive)', () => {
        const path = 'claude-templates/guides/security/patterns.md';
        const pattern = 'claude-templates/**/*.md';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should match question mark wildcard', () => {
        const path = 'claude-templates/test1.md';
        const pattern = 'claude-templates/test?.md';

        expect(matchesPattern(path, pattern)).toBe(true);
      });
    });

    describe('Exclusion Patterns', () => {
      it('should exclude DS_Store files', () => {
        const path = 'claude-templates/.DS_Store';
        const pattern = '**/.DS_Store';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should exclude test files', () => {
        const path = 'claude-templates/utils.test.js';
        const pattern = '**/*.test.js';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should exclude node_modules', () => {
        const path = 'claude-templates/node_modules/package.json';
        const pattern = '**/node_modules/**';

        expect(matchesPattern(path, pattern)).toBe(true);
      });
    });
  });

  describe('Real-World Windows Scenarios', () => {
    it('should handle typical Claude templates structure on Windows', () => {
      const windowsPaths = [
        'claude-templates\\README.md',
        'claude-templates\\templates\\CLAUDE.md.template',
        'claude-templates\\templates\\guides\\testing\\testing-patterns.md.template',
        'claude-templates\\templates\\guides\\security\\security-practices.md.template',
      ];

      const pattern = 'claude-templates/**';

      // All paths should match after normalization
      windowsPaths.forEach(path => {
        const normalized = normalizePathSeparators(path);
        expect(matchesPattern(normalized, pattern)).toBe(true);
      });
    });

    it('should exclude unwanted files even with Windows paths', () => {
      const windowsPaths = [
        'claude-templates\\.DS_Store',
        'claude-templates\\node_modules\\package.json',
        'claude-templates\\utils.test.js',
      ];

      const excludePatterns = ['**/.DS_Store', '**/node_modules/**', '**/*.test.js'];

      windowsPaths.forEach(path => {
        const normalized = normalizePathSeparators(path);
        // At least one exclude pattern should match
        const isExcluded = excludePatterns.some(pattern =>
          matchesPattern(normalized, pattern)
        );
        expect(isExcluded).toBe(true);
      });
    });
  });

  describe('Hybrid Strategy (Include + Exclude)', () => {
    const includes = ['claude-templates/**'];
    const excludes = ['**/.DS_Store', '**/node_modules/**', '**/*.test.js'];

    const shouldInclude = (path: string): boolean => {
      const normalized = normalizePathSeparators(path);

      const matchesPattern = (p: string, pattern: string): boolean => {
        const regexPattern = pattern
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        return new RegExp(`^${regexPattern}$`).test(p);
      };

      // Check includes
      const included = includes.some(pattern => matchesPattern(normalized, pattern));
      if (!included) return false;

      // Check excludes
      const excluded = excludes.some(pattern => matchesPattern(normalized, pattern));
      return !excluded;
    };

    it('should include valid template files', () => {
      expect(shouldInclude('claude-templates\\README.md')).toBe(true);
      expect(shouldInclude('claude-templates\\templates\\CLAUDE.md.template')).toBe(true);
    });

    it('should exclude DS_Store files', () => {
      expect(shouldInclude('claude-templates\\.DS_Store')).toBe(false);
    });

    it('should exclude test files', () => {
      expect(shouldInclude('claude-templates\\utils.test.js')).toBe(false);
    });

    it('should exclude node_modules', () => {
      expect(shouldInclude('claude-templates\\node_modules\\package.json')).toBe(false);
    });
  });
});

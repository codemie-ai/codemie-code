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
        const windowsPath = 'sound\\notify.mp3';
        const normalized = normalizePathSeparators(windowsPath);
        const pattern = 'sound/**';

        expect(matchesPattern(normalized, pattern)).toBe(true);
      });

      it('should match nested Windows paths after normalization', () => {
        const windowsPath = 'sound\\themes\\dark\\complete.mp3';
        const normalized = normalizePathSeparators(windowsPath);
        const pattern = 'sound/**';

        expect(matchesPattern(normalized, pattern)).toBe(true);
      });

      it('should not match Windows path WITHOUT normalization (bug scenario)', () => {
        const windowsPath = 'sound\\notify.mp3'; // Backslashes
        const pattern = 'sound/**'; // Forward slashes

        // This was the bug: Windows paths don't match forward-slash patterns
        expect(matchesPattern(windowsPath, pattern)).toBe(false);
      });

      it('should match Windows path WITH normalization (fix scenario)', () => {
        const windowsPath = 'sound\\notify.mp3';
        const normalized = normalizePathSeparators(windowsPath);
        const pattern = 'sound/**';

        // After normalization, pattern matching works
        expect(matchesPattern(normalized, pattern)).toBe(true);
      });
    });

    describe('Unix Path Scenarios', () => {
      it('should match Unix paths (already use forward slashes)', () => {
        const unixPath = 'sound/notify.mp3';
        const pattern = 'sound/**';

        expect(matchesPattern(unixPath, pattern)).toBe(true);
      });

      it('should match nested Unix paths', () => {
        const unixPath = 'sound/themes/dark/complete.mp3';
        const pattern = 'sound/**';

        expect(matchesPattern(unixPath, pattern)).toBe(true);
      });
    });

    describe('Pattern Variations', () => {
      it('should match single wildcard', () => {
        const path = 'sound/notify.mp3';
        const pattern = 'sound/*.mp3';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should match double wildcard (recursive)', () => {
        const path = 'sound/themes/dark/complete.mp3';
        const pattern = 'sound/**/*.mp3';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should match question mark wildcard', () => {
        const path = 'sound/alert1.mp3';
        const pattern = 'sound/alert?.mp3';

        expect(matchesPattern(path, pattern)).toBe(true);
      });
    });

    describe('Exclusion Patterns', () => {
      it('should exclude DS_Store files', () => {
        const path = 'sound/.DS_Store';
        const pattern = '**/.DS_Store';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should exclude test files', () => {
        const path = 'sound/utils.test.js';
        const pattern = '**/*.test.js';

        expect(matchesPattern(path, pattern)).toBe(true);
      });

      it('should exclude node_modules', () => {
        const path = 'sound/node_modules/package.json';
        const pattern = '**/node_modules/**';

        expect(matchesPattern(path, pattern)).toBe(true);
      });
    });
  });

  describe('Real-World Windows Scenarios', () => {
    it('should handle typical sound assets structure on Windows', () => {
      const windowsPaths = [
        'sound\\notify.mp3',
        'sound\\alert.wav',
        'sound\\themes\\dark\\complete.mp3',
        'sound\\themes\\light\\error.wav',
      ];

      const pattern = 'sound/**';

      // All paths should match after normalization
      windowsPaths.forEach(path => {
        const normalized = normalizePathSeparators(path);
        expect(matchesPattern(normalized, pattern)).toBe(true);
      });
    });

    it('should exclude unwanted files even with Windows paths', () => {
      const windowsPaths = [
        'sound\\.DS_Store',
        'sound\\node_modules\\package.json',
        'sound\\utils.test.js',
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
    const includes = ['sound/**'];
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

    it('should include valid sound files', () => {
      expect(shouldInclude('sound\\notify.mp3')).toBe(true);
      expect(shouldInclude('sound\\themes\\dark\\complete.mp3')).toBe(true);
    });

    it('should exclude DS_Store files', () => {
      expect(shouldInclude('sound\\.DS_Store')).toBe(false);
    });

    it('should exclude test files', () => {
      expect(shouldInclude('sound\\utils.test.js')).toBe(false);
    });

    it('should exclude node_modules', () => {
      expect(shouldInclude('sound\\node_modules\\package.json')).toBe(false);
    });
  });
});

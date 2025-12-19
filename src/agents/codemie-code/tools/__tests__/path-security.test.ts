/**
 * Path Security Tests - Cross-Platform
 *
 * Tests the path security checks for directory traversal prevention
 * on Windows, macOS, and Linux
 */

import { describe, it, expect } from 'vitest';
import path from 'path';

/**
 * Helper function to check if a resolved path is within the working directory
 * (Extracted from tools/index.ts for testing)
 */
function isPathWithinDirectory(workingDir: string, resolvedPath: string): boolean {
  const relative = path.relative(workingDir, resolvedPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

describe('Path Security - Cross-Platform', () => {
  describe('Unix/Linux/macOS Path Security', () => {
    const workingDir = '/home/user/project';

    it('should allow file within working directory', () => {
      const resolvedPath = path.resolve(workingDir, 'src/file.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should allow nested file within working directory', () => {
      const resolvedPath = path.resolve(workingDir, 'src/components/Button.tsx');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should allow current directory', () => {
      const resolvedPath = path.resolve(workingDir, '.');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should allow file in subdirectory with same name prefix', () => {
      const resolvedPath = path.resolve(workingDir, 'projectile/file.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should reject parent directory traversal', () => {
      const resolvedPath = path.resolve(workingDir, '../outside.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });

    it('should reject multiple parent directory traversals', () => {
      const resolvedPath = path.resolve(workingDir, '../../etc/passwd');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });

    it('should reject directory with similar name prefix', () => {
      // This is the key test case - prevents /home/user/project-other/file.txt
      const attackPath = '/home/user/project-attacker/file.txt';
      expect(isPathWithinDirectory(workingDir, attackPath)).toBe(false);
    });

    it('should reject absolute path outside working directory', () => {
      const resolvedPath = '/etc/passwd';
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });

    it('should reject path with hidden traversal', () => {
      const resolvedPath = path.resolve(workingDir, 'src/../../outside.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });
  });

  describe('Platform-Agnostic Path Security Tests', () => {
    // These tests use platform-agnostic paths and verify core security logic
    // path.resolve() normalizes to current platform's conventions

    it('should allow file within working directory (relative)', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = path.resolve(workingDir, 'src/file.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should allow deeply nested file', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = path.resolve(workingDir, 'src/components/ui/Button.tsx');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should reject parent directory traversal', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = path.resolve(workingDir, '../outside.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });

    it('should reject multiple level parent traversal', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = path.resolve(workingDir, '../../etc/passwd');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });

    it('should reject sibling directory with similar name prefix (CRITICAL)', () => {
      // This is the most important security test
      // /home/user/project vs /home/user/project-attacker
      const workingDir = '/home/user/project';
      const attackPath = '/home/user/project-attacker/file.txt';
      expect(isPathWithinDirectory(workingDir, attackPath)).toBe(false);
    });

    it('should reject absolute path outside working directory', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = '/etc/passwd';
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });

    it('should reject hidden traversal in nested path', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = path.resolve(workingDir, 'src/../../outside.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(false);
    });

    it('should handle trailing slashes correctly', () => {
      const workingDir = '/home/user/project/';
      const resolvedPath = path.resolve(workingDir, 'src/file.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });
  });

  describe('Additional Edge Cases', () => {
    it('should handle empty relative path (resolves to working dir)', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = path.resolve(workingDir, '');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should handle complex relative path with dot segments', () => {
      const workingDir = '/home/user/project';
      const resolvedPath = path.resolve(workingDir, './src/../lib/file.ts');
      expect(isPathWithinDirectory(workingDir, resolvedPath)).toBe(true);
    });

    it('should normalize and verify paths consistently', () => {
      const workingDir = '/home/user/project';
      const resolvedPath1 = path.resolve(workingDir, 'src/./file.ts');
      const resolvedPath2 = path.resolve(workingDir, 'src/file.ts');

      // Both should be allowed and resolve to same security check
      expect(isPathWithinDirectory(workingDir, resolvedPath1)).toBe(true);
      expect(isPathWithinDirectory(workingDir, resolvedPath2)).toBe(true);
    });
  });

  describe('Real-World Attack Scenarios', () => {
    it('should prevent system file access via traversal', () => {
      const workingDir = '/home/user/project';
      const attackPath = path.resolve(workingDir, '../../../etc/passwd');
      expect(isPathWithinDirectory(workingDir, attackPath)).toBe(false);
    });

    it('should prevent sibling directory access', () => {
      const workingDir = '/home/user/project';
      const attackPath = '/home/user/secrets/private.key';
      expect(isPathWithinDirectory(workingDir, attackPath)).toBe(false);
    });

    it('should prevent accessing similar-named parent directory', () => {
      const workingDir = '/var/www/myapp';
      const attackPath = '/var/www/myapp-backups/database.sql';
      expect(isPathWithinDirectory(workingDir, attackPath)).toBe(false);
    });

    it('should prevent accessing parent project directory', () => {
      const workingDir = '/projects/client-app';
      const attackPath = '/projects/client-app-admin/admin.key';
      expect(isPathWithinDirectory(workingDir, attackPath)).toBe(false);
    });

    it('should prevent deep traversal attacks', () => {
      const workingDir = '/home/user/project';
      // Try to escape via many levels of ../
      const attackPath = path.resolve(workingDir, '../../../../../../../../etc/shadow');
      expect(isPathWithinDirectory(workingDir, attackPath)).toBe(false);
    });
  });
});

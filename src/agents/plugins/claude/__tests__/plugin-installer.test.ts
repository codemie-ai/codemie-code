/**
 * Tests for Claude Plugin Installer
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';

// Mock fs/promises before any imports
vi.mock('fs/promises');

// Now import the module and mocks
const { ClaudePluginInstaller } = await import('../claude.plugin-installer.js');
const fsp = await import('fs/promises');

describe('ClaudePluginInstaller', () => {
  const expectedTargetPath = join(homedir(), '.codemie', 'claude-plugin');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getTargetPath', () => {
    it('should return correct target path in ~/.codemie/', () => {
      const targetPath = ClaudePluginInstaller.getTargetPath();
      expect(targetPath).toBe(expectedTargetPath);
      expect(targetPath).toContain('.codemie');
      expect(targetPath).toContain('claude-plugin');
    });

    it('should return absolute path', () => {
      const targetPath = ClaudePluginInstaller.getTargetPath();
      expect(targetPath.startsWith('/')).toBe(true);
    });
  });


  describe('install - Error Handling', () => {
    it('should handle source directory not found', async () => {
      // Mock: plugin not installed
      vi.spyOn(fsp, 'access')
        .mockRejectedValueOnce(new Error('Target not found'))
        .mockRejectedValueOnce(new Error('Target not found'))
        .mockRejectedValueOnce(new Error('Target not found'))
        .mockRejectedValueOnce(new Error('Source not found')); // Source check fails

      vi.spyOn(fsp, 'cp');

      const result = await ClaudePluginInstaller.install();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toContain('Source plugin directory not found');
      expect(fsp.cp).not.toHaveBeenCalled();
    });
  });

  describe('Cross-Platform Path Handling', () => {
    it('should use platform-appropriate path separators', () => {
      const targetPath = ClaudePluginInstaller.getTargetPath();

      // Path should use platform's separator
      expect(targetPath).toMatch(/[/\\]/);

      // Should contain both components
      expect(targetPath.includes('.codemie')).toBe(true);
      expect(targetPath.includes('claude-plugin')).toBe(true);
    });

    it('should return absolute path on all platforms', () => {
      const targetPath = ClaudePluginInstaller.getTargetPath();

      // Unix/Linux/Mac: starts with /
      // Windows: starts with C:\ or similar
      const isAbsolute = targetPath.startsWith('/') || /^[A-Z]:[/\\]/.test(targetPath);
      expect(isAbsolute).toBe(true);
    });
  });

  describe('Installation Result Contract', () => {
    it('should return error result with correct structure', async () => {
      // Mock failed installation
      vi.spyOn(fsp, 'access')
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Source not found'));

      const result = await ClaudePluginInstaller.install();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });
});

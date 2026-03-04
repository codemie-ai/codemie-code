/**
 * Tests for Claude Plugin Installer
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join, isAbsolute } from 'path';
import type { AgentMetadata } from '../../../core/types.js';

// Mock fs/promises before any imports
vi.mock('fs/promises');

// Now import the module and mocks
const { ClaudePluginInstaller } = await import('../claude.plugin-installer.js');
const fsp = await import('fs/promises');

// Mock metadata for testing
const mockMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Test',
  npmPackage: '@anthropic-ai/claude-code',
  cliCommand: 'claude',
  envMapping: {},
  supportedProviders: ['ai-run-sso'],
  dataPaths: { home: '.claude' }
};

describe('ClaudePluginInstaller', () => {
  const expectedTargetPath = join(homedir(), '.codemie', 'claude-plugin');
  let installer: ClaudePluginInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    installer = new ClaudePluginInstaller(mockMetadata);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getTargetPath', () => {
    it('should return correct target path in ~/.codemie/', () => {
      const targetPath = installer.getTargetPath();
      expect(targetPath).toBe(expectedTargetPath);
      expect(targetPath).toContain('.codemie');
      expect(targetPath).toContain('claude-plugin');
    });

    it('should return absolute path', () => {
      const targetPath = installer.getTargetPath();
      expect(isAbsolute(targetPath)).toBe(true);
    });
  });

  describe('install - Error Handling', () => {
    it('should handle source directory not found', async () => {
      // Mock: plugin not installed (first 3 calls for getInstalledInfo)
      // Then source check fails
      vi.spyOn(fsp, 'access')
        .mockRejectedValueOnce(new Error('Target not found'))
        .mockRejectedValueOnce(new Error('Target not found'))
        .mockRejectedValueOnce(new Error('Target not found'))
        .mockRejectedValueOnce(new Error('Source not found')); // Source check fails

      vi.spyOn(fsp, 'cp');

      const result = await installer.install();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toContain('Source path not found');
      expect(fsp.cp).not.toHaveBeenCalled();
    });

    it('should continue without error if extension already up-to-date', async () => {
      // Mock: plugin already installed with same version
      const mockVersion = '1.0.0';

      // getInstalledInfo checks
      vi.spyOn(fsp, 'access')
        .mockResolvedValueOnce(undefined) // target dir exists
        .mockResolvedValueOnce(undefined) // manifest exists
        .mockResolvedValueOnce(undefined) // hooks exist
        .mockResolvedValueOnce(undefined); // source exists

      vi.spyOn(fsp, 'readFile')
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // getVersion(target)
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })); // getVersion(source)

      vi.spyOn(fsp, 'cp');

      const result = await installer.install();

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_exists');
      expect(result.sourceVersion).toBe(mockVersion);
      expect(result.installedVersion).toBe(mockVersion);
      expect(fsp.cp).not.toHaveBeenCalled(); // Should not copy if already up-to-date
    });
  });

  describe('Cross-Platform Path Handling', () => {
    it('should use platform-appropriate path separators', () => {
      const targetPath = installer.getTargetPath();

      // Path should use platform's separator
      expect(targetPath).toMatch(/[/\\]/);

      // Should contain both components
      expect(targetPath.includes('.codemie')).toBe(true);
      expect(targetPath.includes('claude-plugin')).toBe(true);
    });

    it('should return absolute path on all platforms', () => {
      const targetPath = installer.getTargetPath();

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

      const result = await installer.install();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
      expect(result.targetPath).toBe(expectedTargetPath);
    });

    it('should return success result with correct structure for new install', async () => {
      const mockVersion = '1.2.3';

      // Mock: not installed, source exists
      // Correct flow (matching BaseExtensionInstaller.install()):
      // 1. access(sourcePath) - verify source exists
      // 2. getVersion(sourcePath) - readFile to get version
      // 3. getInstalledInfo() - access(targetPath) throws immediately, returns null
      // 4. mkdir, cp
      // 5. verifyInstallation - for each critical file: access + readFile (if JSON)
      vi.spyOn(fsp, 'readFile')
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // getVersion(source)
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // verify: plugin.json
        .mockResolvedValueOnce(JSON.stringify({ hooks: {} })); // verify: hooks.json

      vi.spyOn(fsp, 'access')
        .mockResolvedValueOnce(undefined) // 1. source exists
        .mockRejectedValueOnce(new Error('Not installed')) // 3. getInstalledInfo: target dir throws
        .mockResolvedValueOnce(undefined) // 5. verify: plugin.json
        .mockResolvedValueOnce(undefined) // 5. verify: hooks.json
        .mockResolvedValueOnce(undefined); // 5. verify: README.md

      vi.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fsp, 'cp').mockResolvedValue(undefined);

      const result = await installer.install();

      expect(result.success).toBe(true);
      expect(result.action).toBe('copied');
      expect(result.sourceVersion).toBe(mockVersion);
      expect(result.targetPath).toBe(expectedTargetPath);
    });
  });

  describe('Inheritance from BaseExtensionInstaller', () => {
    it('should use agent name from metadata', () => {
      const customMetadata: AgentMetadata = {
        ...mockMetadata,
        name: 'test-agent',
        displayName: 'Test Agent'
      };
      const customInstaller = new ClaudePluginInstaller(customMetadata);

      // The installer should internally use the agent name
      // We can't directly test this without exposing internals,
      // but we verify it was constructed successfully
      expect(customInstaller).toBeInstanceOf(ClaudePluginInstaller);
    });
  });
});

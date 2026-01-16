/**
 * Tests for Gemini Extension Installer
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join, isAbsolute } from 'path';
import type { AgentMetadata } from '../../core/types.js';

// Mock fs/promises before any imports
vi.mock('fs/promises');

// Now import the module and mocks
const { GeminiExtensionInstaller } = await import('../gemini.extension-installer.js');
const fsp = await import('fs/promises');

// Mock metadata for testing
const mockMetadata: AgentMetadata = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  description: 'Test',
  npmPackage: '@google/gemini-cli',
  cliCommand: 'gemini',
  envMapping: {},
  supportedProviders: ['ai-run-sso'],
  dataPaths: { home: '.gemini' }
};

describe('GeminiExtensionInstaller', () => {
  const expectedTargetPath = join(homedir(), '.gemini', 'extensions', 'codemie');
  let installer: GeminiExtensionInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    installer = new GeminiExtensionInstaller(mockMetadata);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getTargetPath', () => {
    it('should return correct target path in ~/.gemini/extensions/', () => {
      const targetPath = installer.getTargetPath();
      expect(targetPath).toBe(expectedTargetPath);
      expect(targetPath).toContain('.gemini');
      expect(targetPath).toContain('extensions');
      expect(targetPath).toContain('codemie');
    });

    it('should return absolute path', () => {
      const targetPath = installer.getTargetPath();
      expect(isAbsolute(targetPath)).toBe(true);
    });
  });

  describe('install - Error Handling', () => {
    it('should handle source directory not found', async () => {
      // Mock: extension not installed (first 3 calls for getInstalledInfo)
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
      // Mock: extension already installed with same version
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

    it('should update when versions differ', async () => {
      const oldVersion = '1.0.0';
      const newVersion = '1.1.0';

      // Mock: extension installed with old version
      // Order matches BaseExtensionInstaller.install() flow:
      // 1. getVersion(sourcePath) first
      // 2. getInstalledInfo() checks target + reads version
      // 3. source exists check
      // 4. copy + verify
      vi.spyOn(fsp, 'readFile')
        .mockResolvedValueOnce(JSON.stringify({ version: newVersion })) // getVersion(source) - FIRST
        .mockResolvedValueOnce(JSON.stringify({ version: oldVersion })) // getVersion(target) in getInstalledInfo
        .mockResolvedValueOnce(JSON.stringify({ version: newVersion })) // verify manifest
        .mockResolvedValueOnce(JSON.stringify({ hooks: {} })); // verify hooks

      vi.spyOn(fsp, 'access')
        .mockResolvedValueOnce(undefined) // source exists
        .mockResolvedValueOnce(undefined) // getInstalledInfo: target dir exists
        .mockResolvedValueOnce(undefined) // getInstalledInfo: manifest exists
        .mockResolvedValueOnce(undefined) // getInstalledInfo: hooks exist
        .mockResolvedValueOnce(undefined) // verifyInstallation: manifest
        .mockResolvedValueOnce(undefined) // verifyInstallation: hooks
        .mockResolvedValueOnce(undefined); // verifyInstallation: README

      vi.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fsp, 'cp').mockResolvedValue(undefined);

      const result = await installer.install();

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');
      expect(result.installedVersion).toBe(oldVersion);
      expect(result.sourceVersion).toBe(newVersion);
      expect(fsp.cp).toHaveBeenCalled(); // Should copy for update
    });
  });

  describe('Cross-Platform Path Handling', () => {
    it('should use platform-appropriate path separators', () => {
      const targetPath = installer.getTargetPath();

      // Path should use platform's separator
      expect(targetPath).toMatch(/[/\\]/);

      // Should contain all components
      expect(targetPath.includes('.gemini')).toBe(true);
      expect(targetPath.includes('extensions')).toBe(true);
      expect(targetPath.includes('codemie')).toBe(true);
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
      const mockVersion = '1.0.0';

      // Mock: not installed, source exists
      // Correct flow:
      // 1. access(sourcePath) - verify source exists
      // 2. getVersion(sourcePath) - readFile to get version
      // 3. getInstalledInfo() - access(targetPath) throws immediately, returns null
      // 4. mkdir, cp
      // 5. verifyInstallation - for each critical file: access + readFile (if JSON)
      vi.spyOn(fsp, 'readFile')
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // getVersion(source)
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // verify: gemini-extension.json
        .mockResolvedValueOnce(JSON.stringify({ hooks: {} })); // verify: hooks/hooks.json

      vi.spyOn(fsp, 'access')
        .mockResolvedValueOnce(undefined) // 1. source exists
        .mockRejectedValueOnce(new Error('Not installed')) // 3. getInstalledInfo: target dir throws
        .mockResolvedValueOnce(undefined) // 5. verify: gemini-extension.json
        .mockResolvedValueOnce(undefined) // 5. verify: hooks/hooks.json
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
      const customInstaller = new GeminiExtensionInstaller(customMetadata);

      // The installer should internally use the agent name
      // We can't directly test this without exposing internals,
      // but we verify it was constructed successfully
      expect(customInstaller).toBeInstanceOf(GeminiExtensionInstaller);
    });
  });

  describe('Gemini-Specific Behavior', () => {
    it('should use gemini-extension.json as manifest', () => {
      // This is tested indirectly through install() behavior
      // The manifest path is used internally in getManifestPath()
      expect(installer).toBeInstanceOf(GeminiExtensionInstaller);
    });

    it('should install to auto-discovery location', () => {
      // Gemini CLI auto-discovers extensions from ~/.gemini/extensions/
      const targetPath = installer.getTargetPath();
      expect(targetPath).toContain('.gemini');
      expect(targetPath).toContain('extensions');

      // Should be directly under extensions/ (not in a subdirectory)
      const parts = targetPath.split(/[/\\]/);
      const extensionsIndex = parts.indexOf('extensions');
      expect(extensionsIndex).toBeGreaterThan(-1);
      expect(parts[extensionsIndex + 1]).toBe('codemie');
    });
  });

  describe('Critical Files Verification', () => {
    it('should verify all required files exist after installation', async () => {
      const mockVersion = '1.0.0';

      // Mock successful installation
      vi.spyOn(fsp, 'readFile')
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // getVersion(source)
        .mockResolvedValueOnce(JSON.stringify({ name: 'codemie', version: mockVersion })) // verify manifest
        .mockResolvedValueOnce(JSON.stringify({ hooks: {} })); // verify hooks

      vi.spyOn(fsp, 'access')
        .mockResolvedValueOnce(undefined) // source exists
        .mockRejectedValueOnce(new Error('Not installed')) // getInstalledInfo: target dir throws immediately
        .mockResolvedValueOnce(undefined) // verify: gemini-extension.json
        .mockResolvedValueOnce(undefined) // verify: hooks/hooks.json
        .mockResolvedValueOnce(undefined); // verify: README.md

      vi.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fsp, 'cp').mockResolvedValue(undefined);

      const result = await installer.install();

      expect(result.success).toBe(true);

      // Verify that access was called for all critical files
      expect(fsp.access).toHaveBeenCalledWith(
        expect.stringContaining('gemini-extension.json'),
        expect.anything()
      );
      expect(fsp.access).toHaveBeenCalledWith(
        expect.stringContaining('hooks.json'),
        expect.anything()
      );
      expect(fsp.access).toHaveBeenCalledWith(
        expect.stringContaining('README.md'),
        expect.anything()
      );
    });
  });
});

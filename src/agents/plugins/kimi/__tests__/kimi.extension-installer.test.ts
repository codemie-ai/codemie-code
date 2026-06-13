/**
 * Tests for Kimi Extension Installer
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
const { KimiExtensionInstaller } = await import('../kimi.extension-installer.js');
const fsp = await import('fs/promises');

const mockMetadata: AgentMetadata = {
  name: 'kimi',
  displayName: 'Kimi Code CLI',
  description: 'Test metadata for the Kimi extension installer',
  npmPackage: null,
  cliCommand: 'kimi',
  envMapping: {},
  supportedProviders: ['ai-run-sso']
};

describe('KimiExtensionInstaller', () => {
  const expectedTargetPath = join(homedir(), '.kimi-code', 'skills', 'codemie-kimi');
  let installer: KimiExtensionInstaller;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    installer = new KimiExtensionInstaller(mockMetadata);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getTargetPath', () => {
    it('should return correct target path in ~/.kimi-code/skills/', () => {
      const targetPath = installer.getTargetPath();
      expect(targetPath).toMatch(/\.kimi-code[\\/]skills[\\/]codemie-kimi$/);
    });

    it('should return absolute path', () => {
      expect(isAbsolute(installer.getTargetPath())).toBe(true);
    });
  });

  describe('getSourcePath', () => {
    it('should return a path ending with the extension directory', () => {
      const sourcePath = (installer as unknown as { getSourcePath(): string }).getSourcePath();
      expect(sourcePath).toMatch(/[\\/]extension$/);
    });
  });

  describe('getCriticalFiles', () => {
    it('should include manifest.json and SKILL.md', () => {
      const criticalFiles = (installer as unknown as { getCriticalFiles(): string[] }).getCriticalFiles();
      expect(criticalFiles).toContain('manifest.json');
      expect(criticalFiles).toContain('SKILL.md');
    });
  });

  describe('install', () => {
    it('should fail when the source directory is missing', async () => {
      vi.spyOn(fsp, 'access').mockRejectedValueOnce(new Error('Source not found'));

      const result = await installer.install();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toContain('Source path not found');
    });

    it('should report already_exists when the same version is installed', async () => {
      const mockVersion = '0.1.0';

      vi.spyOn(fsp, 'access')
        .mockResolvedValueOnce(undefined) // source exists
        .mockResolvedValueOnce(undefined) // target dir exists
        .mockResolvedValueOnce(undefined) // manifest exists
        .mockResolvedValueOnce(undefined); // SKILL.md exists

      vi.spyOn(fsp, 'readFile')
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // source version
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })); // installed version

      vi.spyOn(fsp, 'cp');

      const result = await installer.install();

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_exists');
      expect(result.sourceVersion).toBe(mockVersion);
      expect(result.installedVersion).toBe(mockVersion);
      expect(result.targetPath).toBe(expectedTargetPath);
      expect(fsp.cp).not.toHaveBeenCalled();
    });

    it('should copy files for a new install', async () => {
      const mockVersion = '0.1.0';

      vi.spyOn(fsp, 'readFile')
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })) // source version
        .mockResolvedValueOnce(JSON.stringify({ version: mockVersion })); // verify manifest

      vi.spyOn(fsp, 'access')
        .mockResolvedValueOnce(undefined) // source exists
        .mockRejectedValueOnce(new Error('Not installed')) // target dir missing
        .mockResolvedValueOnce(undefined) // verify manifest
        .mockResolvedValueOnce(undefined); // verify SKILL.md

      vi.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fsp, 'cp').mockResolvedValue(undefined);

      const result = await installer.install();

      expect(result.success).toBe(true);
      expect(result.action).toBe('copied');
      expect(result.sourceVersion).toBe(mockVersion);
      expect(result.targetPath).toBe(expectedTargetPath);
      expect(fsp.cp).toHaveBeenCalled();
    });
  });
});

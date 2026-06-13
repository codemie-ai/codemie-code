/**
 * Tests for Kimi Extension Installer
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import type { AgentMetadata } from '../../core/types.js';
import { KimiExtensionInstaller } from '../kimi.extension-installer.js';

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
  const installer = new KimiExtensionInstaller(mockMetadata);

  describe('getTargetPath', () => {
    it('should return correct target path in ~/.kimi-code/skills/', () => {
      const targetPath = installer.getTargetPath();
      expect(targetPath).toMatch(/.kimi-code\/skills\/codemie-kimi$/);
    });
  });

  describe('getSourcePath', () => {
    it('should return a path ending with /extension', () => {
      const sourcePath = (installer as unknown as { getSourcePath(): string }).getSourcePath();
      expect(sourcePath.endsWith('/extension')).toBe(true);
    });
  });

  describe('getCriticalFiles', () => {
    it('should include manifest.json and SKILL.md', () => {
      const criticalFiles = (installer as unknown as { getCriticalFiles(): string[] }).getCriticalFiles();
      expect(criticalFiles).toContain('manifest.json');
      expect(criticalFiles).toContain('SKILL.md');
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as npm from '../npm.js';
import { NpmError, NpmErrorCode } from '../errors.js';

// Mock the exec module
vi.mock('../exec.js', () => ({
  exec: vi.fn()
}));

// Mock the logger module
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

import { exec } from '../exec.js';
import { logger } from '../logger.js';

const mockExec = vi.mocked(exec);

describe('npm utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('installGlobal', () => {
    it('should install package successfully', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.installGlobal('test-package');

      expect(mockExec).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', 'test-package'],
        expect.objectContaining({ timeout: 120000 })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'Installing test-package globally...'
      );
      expect(logger.success).toHaveBeenCalledWith(
        'test-package installed successfully'
      );
    });

    it('should install package with version', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.installGlobal('test-package', { version: '1.0.0' });

      expect(mockExec).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', 'test-package@1.0.0'],
        expect.objectContaining({ timeout: 120000 })
      );
      expect(logger.success).toHaveBeenCalledWith(
        'test-package@1.0.0 installed successfully'
      );
    });

    it('should throw NpmError with TIMEOUT code on timeout', async () => {
      mockExec.mockRejectedValue(new Error('Command timed out after 120000ms'));

      await expect(npm.installGlobal('test-package')).rejects.toThrow(NpmError);

      try {
        await npm.installGlobal('test-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.TIMEOUT);
      }
    });

    it('should throw NpmError with PERMISSION_ERROR code on EACCES', async () => {
      mockExec.mockRejectedValue(new Error('EACCES: permission denied'));

      try {
        await npm.installGlobal('test-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.PERMISSION_ERROR);
        expect((error as NpmError).message).toContain('elevated permissions');
      }
    });

    it('should throw NpmError with NETWORK_ERROR code on network failure', async () => {
      mockExec.mockRejectedValue(new Error('ENOTFOUND registry.npmjs.org'));

      try {
        await npm.installGlobal('test-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.NETWORK_ERROR);
        expect((error as NpmError).message).toContain('internet connection');
      }
    });

    it('should throw NpmError with NOT_FOUND code on package not found', async () => {
      mockExec.mockRejectedValue(new Error('404 Not Found - GET https://registry.npmjs.org/nonexistent-package'));

      try {
        await npm.installGlobal('nonexistent-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.NOT_FOUND);
        expect((error as NpmError).message).toContain('package name and version');
      }
    });

    it('should use custom timeout', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.installGlobal('test-package', { timeout: 60000 });

      expect(mockExec).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', 'test-package'],
        expect.objectContaining({ timeout: 60000 })
      );
    });
  });

  describe('uninstallGlobal', () => {
    it('should uninstall package successfully', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.uninstallGlobal('test-package');

      expect(mockExec).toHaveBeenCalledWith(
        'npm',
        ['uninstall', '-g', 'test-package'],
        expect.objectContaining({ timeout: 30000 })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'Uninstalling test-package globally...'
      );
      expect(logger.success).toHaveBeenCalledWith(
        'test-package uninstalled successfully'
      );
    });

    it('should throw NpmError on failure', async () => {
      mockExec.mockRejectedValue(new Error('Package not installed'));

      await expect(npm.uninstallGlobal('test-package')).rejects.toThrow(
        NpmError
      );
    });
  });

  describe('listGlobal', () => {
    it('should return true when package is installed (exit code 0)', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: 'npm@10.2.4', stderr: '' });

      const result = await npm.listGlobal('npm');

      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        'npm',
        ['list', '-g', 'npm'],
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should return false when package is not installed (exit code 1)', async () => {
      mockExec.mockResolvedValue({ code: 1, stdout: '', stderr: '' });

      const result = await npm.listGlobal('definitely-not-installed-package-xyz');

      expect(result).toBe(false);
    });

    it('should return false when exec throws error', async () => {
      mockExec.mockRejectedValue(new Error('Command failed'));

      const result = await npm.listGlobal('test-package');

      expect(result).toBe(false);
    });
  });

  describe('getVersion', () => {
    it('should parse and return npm version correctly', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '10.2.4', stderr: '' });

      const version = await npm.getVersion();

      expect(version).toBe('10.2.4');
      expect(mockExec).toHaveBeenCalledWith(
        'npm',
        ['--version'],
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should handle pre-release versions', async () => {
      mockExec.mockResolvedValue({
        code: 0,
        stdout: '10.0.0-beta.1',
        stderr: ''
      });

      const version = await npm.getVersion();

      expect(version).toBe('10.0.0');
    });

    it('should return null when npm is not found', async () => {
      mockExec.mockRejectedValue(new Error('npm: command not found'));

      const version = await npm.getVersion();

      expect(version).toBeNull();
    });

    it('should return null when version cannot be parsed', async () => {
      mockExec.mockResolvedValue({
        code: 0,
        stdout: 'invalid version',
        stderr: ''
      });

      const version = await npm.getVersion();

      expect(version).toBeNull();
    });
  });

  describe('npxRun', () => {
    it('should run npx command successfully', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.npxRun('create-react-app', ['my-app']);

      expect(mockExec).toHaveBeenCalledWith(
        'npx',
        ['create-react-app', 'my-app'],
        expect.objectContaining({ timeout: 300000, interactive: undefined })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'Running npx create-react-app my-app...'
      );
      expect(logger.success).toHaveBeenCalledWith(
        'npx create-react-app completed successfully'
      );
    });

    it('should run with interactive mode', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.npxRun('create-react-app', ['my-app'], { interactive: true });

      expect(mockExec).toHaveBeenCalledWith(
        'npx',
        ['create-react-app', 'my-app'],
        expect.objectContaining({ interactive: true })
      );
    });

    it('should use custom timeout', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.npxRun('eslint', ['src/'], { timeout: 60000 });

      expect(mockExec).toHaveBeenCalledWith(
        'npx',
        ['eslint', 'src/'],
        expect.objectContaining({ timeout: 60000 })
      );
    });

    it('should throw NpmError on failure', async () => {
      mockExec.mockRejectedValue(new Error('Command failed'));

      await expect(
        npm.npxRun('create-react-app', ['my-app'])
      ).rejects.toThrow(NpmError);
    });

    it('should handle empty args array', async () => {
      mockExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      await npm.npxRun('some-command');

      expect(mockExec).toHaveBeenCalledWith(
        'npx',
        ['some-command'],
        expect.objectContaining({ timeout: 300000 })
      );
    });
  });
});

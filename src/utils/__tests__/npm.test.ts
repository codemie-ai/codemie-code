import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NpmError, NpmErrorCode } from '../errors.js';
import * as exec from '../exec.js';

// Mock the logger module
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

import { logger } from '../logger.js';

describe('npm utility', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(exec, 'exec');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('installGlobal', () => {
    it('should install package successfully', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { installGlobal } = await import('../processes.js');
      await installGlobal('test-package');

      expect(execSpy).toHaveBeenCalledWith(
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
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { installGlobal } = await import('../processes.js');
      await installGlobal('test-package', { version: '1.0.0' });

      expect(execSpy).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', 'test-package@1.0.0'],
        expect.objectContaining({ timeout: 120000 })
      );
      expect(logger.success).toHaveBeenCalledWith(
        'test-package@1.0.0 installed successfully'
      );
    });

    it('should throw NpmError with TIMEOUT code on timeout', async () => {
      execSpy.mockRejectedValue(new Error('Command timed out after 120000ms'));

      const { installGlobal } = await import('../processes.js');
      await expect(installGlobal('test-package')).rejects.toThrow(NpmError);

      try {
        await installGlobal('test-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.TIMEOUT);
      }
    });

    it('should throw NpmError with PERMISSION_ERROR code on EACCES', async () => {
      execSpy.mockRejectedValue(new Error('EACCES: permission denied'));

      const { installGlobal } = await import('../processes.js');
      try {
        await installGlobal('test-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.PERMISSION_ERROR);
        expect((error as NpmError).message).toContain('elevated permissions');
      }
    });

    it('should throw NpmError with NETWORK_ERROR code on network failure', async () => {
      execSpy.mockRejectedValue(new Error('ENOTFOUND registry.npmjs.org'));

      const { installGlobal } = await import('../processes.js');
      try {
        await installGlobal('test-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.NETWORK_ERROR);
        expect((error as NpmError).message).toContain('internet connection');
      }
    });

    it('should throw NpmError with NOT_FOUND code on package not found', async () => {
      execSpy.mockRejectedValue(new Error('404 Not Found - GET https://registry.npmjs.org/nonexistent-package'));

      const { installGlobal } = await import('../processes.js');
      try {
        await installGlobal('nonexistent-package');
      } catch (error) {
        expect(error).toBeInstanceOf(NpmError);
        expect((error as NpmError).code).toBe(NpmErrorCode.NOT_FOUND);
        expect((error as NpmError).message).toContain('package name and version');
      }
    });

    it('should use custom timeout', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { installGlobal } = await import('../processes.js');
      await installGlobal('test-package', { timeout: 60000 });

      expect(execSpy).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', 'test-package'],
        expect.objectContaining({ timeout: 60000 })
      );
    });
  });

  describe('uninstallGlobal', () => {
    it('should uninstall package successfully', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { uninstallGlobal } = await import('../processes.js');
      await uninstallGlobal('test-package');

      expect(execSpy).toHaveBeenCalledWith(
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
      execSpy.mockRejectedValue(new Error('Package not installed'));

      const { uninstallGlobal } = await import('../processes.js');
      await expect(uninstallGlobal('test-package')).rejects.toThrow(NpmError);
    });
  });

  describe('listGlobal', () => {
    it('should return true when package is installed (exit code 0)', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: 'npm@10.2.4', stderr: '' });

      const { listGlobal } = await import('../processes.js');
      const result = await listGlobal('npm');

      expect(result).toBe(true);
      expect(execSpy).toHaveBeenCalledWith(
        'npm',
        ['list', '-g', 'npm'],
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should return false when package is not installed (exit code 1)', async () => {
      execSpy.mockResolvedValue({ code: 1, stdout: '', stderr: '' });

      const { listGlobal } = await import('../processes.js');
      const result = await listGlobal('definitely-not-installed-package-xyz');

      expect(result).toBe(false);
    });

    it('should return false when exec throws error', async () => {
      execSpy.mockRejectedValue(new Error('Command failed'));

      const { listGlobal } = await import('../processes.js');
      const result = await listGlobal('test-package');

      expect(result).toBe(false);
    });
  });

  describe('getVersion', () => {
    it('should parse and return npm version correctly', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '10.2.4', stderr: '' });

      const { getVersion } = await import('../processes.js');
      const version = await getVersion();

      expect(version).toBe('10.2.4');
      expect(execSpy).toHaveBeenCalledWith(
        'npm',
        ['--version'],
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should handle pre-release versions', async () => {
      execSpy.mockResolvedValue({
        code: 0,
        stdout: '10.0.0-beta.1',
        stderr: ''
      });

      const { getVersion } = await import('../processes.js');
      const version = await getVersion();

      expect(version).toBe('10.0.0');
    });

    it('should return null when npm is not found', async () => {
      execSpy.mockRejectedValue(new Error('npm: command not found'));

      const { getVersion } = await import('../processes.js');
      const version = await getVersion();

      expect(version).toBeNull();
    });

    it('should return null when version cannot be parsed', async () => {
      execSpy.mockResolvedValue({
        code: 0,
        stdout: 'invalid version',
        stderr: ''
      });

      const { getVersion } = await import('../processes.js');
      const version = await getVersion();

      expect(version).toBeNull();
    });
  });

  describe('getLatestVersion', () => {
    it('should return latest version from npm registry', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '1.0.51\n', stderr: '' });

      const { getLatestVersion } = await import('../processes.js');
      const version = await getLatestVersion('@anthropic-ai/claude-code');

      expect(version).toBe('1.0.51');
      expect(execSpy).toHaveBeenCalledWith(
        'npm',
        ['view', '@anthropic-ai/claude-code', 'version'],
        expect.objectContaining({ timeout: 10000 })
      );
    });

    it('should return null when package is not found', async () => {
      execSpy.mockResolvedValue({ code: 1, stdout: '', stderr: 'npm ERR! 404' });

      const { getLatestVersion } = await import('../processes.js');
      const version = await getLatestVersion('nonexistent-package-xyz');

      expect(version).toBeNull();
    });

    it('should return null when exec throws error', async () => {
      execSpy.mockRejectedValue(new Error('Network error'));

      const { getLatestVersion } = await import('../processes.js');
      const version = await getLatestVersion('test-package');

      expect(version).toBeNull();
    });

    it('should return null when stdout is empty', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { getLatestVersion } = await import('../processes.js');
      const version = await getLatestVersion('test-package');

      expect(version).toBeNull();
    });

    it('should use custom timeout', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '2.0.0', stderr: '' });

      const { getLatestVersion } = await import('../processes.js');
      await getLatestVersion('test-package', { timeout: 5000 });

      expect(execSpy).toHaveBeenCalledWith(
        'npm',
        ['view', 'test-package', 'version'],
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should trim whitespace from version output', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '  3.0.0  \n', stderr: '' });

      const { getLatestVersion } = await import('../processes.js');
      const version = await getLatestVersion('test-package');

      expect(version).toBe('3.0.0');
    });
  });

  describe('npxRun', () => {
    it('should run npx command successfully', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { npxRun } = await import('../processes.js');
      await npxRun('create-react-app', ['my-app']);

      expect(execSpy).toHaveBeenCalledWith(
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
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { npxRun } = await import('../processes.js');
      await npxRun('create-react-app', ['my-app'], { interactive: true });

      expect(execSpy).toHaveBeenCalledWith(
        'npx',
        ['create-react-app', 'my-app'],
        expect.objectContaining({ interactive: true })
      );
    });

    it('should use custom timeout', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { npxRun } = await import('../processes.js');
      await npxRun('eslint', ['src/'], { timeout: 60000 });

      expect(execSpy).toHaveBeenCalledWith(
        'npx',
        ['eslint', 'src/'],
        expect.objectContaining({ timeout: 60000 })
      );
    });

    it('should throw NpmError on failure', async () => {
      execSpy.mockRejectedValue(new Error('Command failed'));

      const { npxRun } = await import('../processes.js');
      await expect(
        npxRun('create-react-app', ['my-app'])
      ).rejects.toThrow(NpmError);
    });

    it('should handle empty args array', async () => {
      execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const { npxRun } = await import('../processes.js');
      await npxRun('some-command');

      expect(execSpy).toHaveBeenCalledWith(
        'npx',
        ['some-command'],
        expect.objectContaining({ timeout: 300000 })
      );
    });
  });
});

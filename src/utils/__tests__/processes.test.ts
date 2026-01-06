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

  /**
   * Tests for cross-platform command detection utilities
   * Validates path trimming for Windows \r\n line endings
   */
  describe('getCommandPath', () => {
    it('should trim Windows-style line endings (\\r\\n)', async () => {
      // Mock where.exe output with \r\n line endings (Windows style)
      execSpy.mockResolvedValue({
        code: 0,
        stdout: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\n',
        stderr: ''
      });

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('claude');

      // Should return path WITHOUT trailing \r
      expect(result).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd');
      expect(result).not.toContain('\r');
      expect(result).not.toContain('\n');
    });

    it('should handle multiple paths from where.exe', async () => {
      // where.exe can return multiple matches
      execSpy.mockResolvedValue({
        code: 0,
        stdout: 'C:\\Program Files\\nodejs\\node.exe\r\nC:\\Users\\test\\node.exe\r\n',
        stderr: ''
      });

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('node');

      // Should return first path, properly trimmed
      expect(result).toBe('C:\\Program Files\\nodejs\\node.exe');
    });

    it('should handle Unix-style line endings (\\n)', async () => {
      // Mock which output with \n line endings (Unix style)
      execSpy.mockResolvedValue({
        code: 0,
        stdout: '/usr/local/bin/node\n',
        stderr: ''
      });

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('node');

      // Should return path without trailing \n
      expect(result).toBe('/usr/local/bin/node');
      expect(result).not.toContain('\n');
    });

    it('should handle mixed line endings', async () => {
      // Edge case: mixed \r\n and \n
      execSpy.mockResolvedValue({
        code: 0,
        stdout: '/usr/bin/python3\r\n/usr/local/bin/python3\n',
        stderr: ''
      });

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('python3');

      // Should return first path, properly trimmed
      expect(result).toBe('/usr/bin/python3');
    });

    it('should handle old Mac line endings (\\r)', async () => {
      // Old Mac OS used \r (carriage return only)
      execSpy.mockResolvedValue({
        code: 0,
        stdout: '/usr/bin/node\r/usr/local/bin/node\r',
        stderr: ''
      });

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('node');

      // Should return first path, properly trimmed
      expect(result).toBe('/usr/bin/node');
    });

    it('should return null when command not found', async () => {
      execSpy.mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'INFO: Could not find files for the given pattern(s).'
      });

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('nonexistent');

      expect(result).toBeNull();
    });

    it('should return null on execution error', async () => {
      execSpy.mockRejectedValue(new Error('Command failed'));

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('test');

      expect(result).toBeNull();
    });

    it('should filter out empty lines', async () => {
      // Output with empty lines (shouldn't happen but handle gracefully)
      execSpy.mockResolvedValue({
        code: 0,
        stdout: '\r\n\r\nC:\\path\\to\\cmd.exe\r\n\r\n',
        stderr: ''
      });

      const { getCommandPath } = await import('../processes.js');
      const result = await getCommandPath('cmd');

      expect(result).toBe('C:\\path\\to\\cmd.exe');
    });
  });

  describe('commandExists', () => {
    it('should return true when command exists', async () => {
      execSpy.mockResolvedValue({
        code: 0,
        stdout: 'C:\\Windows\\System32\\cmd.exe\r\n',
        stderr: ''
      });

      const { commandExists } = await import('../processes.js');
      const result = await commandExists('cmd');

      expect(result).toBe(true);
    });

    it('should return false when command not found', async () => {
      execSpy.mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'INFO: Could not find files for the given pattern(s).'
      });

      const { commandExists } = await import('../processes.js');
      const result = await commandExists('nonexistent');

      expect(result).toBe(false);
    });

    it('should return false on execution error', async () => {
      execSpy.mockRejectedValue(new Error('Command failed'));

      const { commandExists } = await import('../processes.js');
      const result = await commandExists('test');

      expect(result).toBe(false);
    });
  });
});

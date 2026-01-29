import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as processes from '../processes.js';

// Mock the logger module
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('detectInstallationMethod', () => {
  let getCommandPathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getCommandPathSpy = vi.spyOn(processes, 'getCommandPath');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('npm installations', () => {
    it('should detect npm installation on Unix (node_modules)', async () => {
      getCommandPathSpy.mockResolvedValue('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });

    it('should detect npm installation on Windows (node_modules)', async () => {
      getCommandPathSpy.mockResolvedValue('C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\claude\\bin\\claude.cmd');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });

    it('should detect nvm installations on Unix', async () => {
      getCommandPathSpy.mockResolvedValue('/home/user/.nvm/versions/node/v20.0.0/lib/node_modules/claude/bin/claude');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });

    it('should detect npm custom prefix on Unix', async () => {
      getCommandPathSpy.mockResolvedValue('/home/user/.npm-global/lib/node_modules/claude/bin/claude');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });

    it('should detect Windows npm directory', async () => {
      getCommandPathSpy.mockResolvedValue('C:\\Users\\user\\AppData\\npm\\claude.cmd');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });

    it('should detect Windows system npm', async () => {
      getCommandPathSpy.mockResolvedValue('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\claude.cmd');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });
  });

  describe('native installations', () => {
    it('should detect native installation on Unix', async () => {
      getCommandPathSpy.mockResolvedValue('/usr/local/bin/claude');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('native');
    });

    it('should detect native installation on macOS (/opt/homebrew)', async () => {
      getCommandPathSpy.mockResolvedValue('/opt/homebrew/bin/claude');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('native');
    });

    it('should detect native installation on Windows (Program Files)', async () => {
      getCommandPathSpy.mockResolvedValue('C:\\Program Files\\Claude\\claude.exe');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('native');
    });

    it('should detect native installation on Linux (/usr/bin)', async () => {
      getCommandPathSpy.mockResolvedValue('/usr/bin/claude');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('native');
    });
  });

  describe('unknown installations', () => {
    it('should return unknown if command not found', async () => {
      getCommandPathSpy.mockResolvedValue(null);

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('unknown');
    });

    it('should return unknown on empty path', async () => {
      getCommandPathSpy.mockResolvedValue('');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('unknown');
    });
  });

  describe('error handling', () => {
    it('should handle getCommandPath errors gracefully', async () => {
      getCommandPathSpy.mockRejectedValue(new Error('Command execution failed'));

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('unknown');
    });

    it('should handle permission errors gracefully', async () => {
      getCommandPathSpy.mockRejectedValue(new Error('EACCES: permission denied'));

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('unknown');
    });

    it('should handle timeout errors gracefully', async () => {
      getCommandPathSpy.mockRejectedValue(new Error('Command timed out'));

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('unknown');
    });
  });

  describe('cross-platform path handling', () => {
    it('should handle Unix-style paths with spaces', async () => {
      getCommandPathSpy.mockResolvedValue('/home/user name/.nvm/versions/node/v20.0.0/bin/claude');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });

    it('should handle Windows-style paths with spaces', async () => {
      getCommandPathSpy.mockResolvedValue('C:\\Program Files\\node_modules\\claude\\bin\\claude.cmd');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });

    it('should handle Windows paths with mixed case drive letters', async () => {
      getCommandPathSpy.mockResolvedValue('c:\\Users\\User\\AppData\\npm\\claude.cmd');

      const { detectInstallationMethod } = await import('../installation-detector.js');
      const result = await detectInstallationMethod('claude');

      expect(result).toBe('npm');
    });
  });
});

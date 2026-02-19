/**
 * Tests for plugin name validation and plugin directory resolution
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cross-platform mock for isPathWithinDirectory (Windows path.join uses backslashes)
const mockIsPathWithin = (base: string, resolved: string): boolean => {
  const norm = (p: string) => p.replace(/\\/g, '/');
  return norm(resolved).startsWith(norm(base)) && !resolved.includes('..');
};

// Mock dependencies for getPluginDir
vi.mock('../../../utils/paths.js', () => ({
  getCodemiePath: vi.fn(() => '/home/user/.codemie/plugins'),
  isPathWithinDirectory: vi.fn(mockIsPathWithin),
}));

const { getCodemiePath, isPathWithinDirectory } = await import('../../../utils/paths.js');
const { validatePluginName } = await import('../types.js');
const { PluginDiscovery } = await import('../PluginDiscovery.js');

describe('validatePluginName', () => {
  describe('valid names', () => {
    it('accepts a simple lowercase name', () => {
      expect(() => validatePluginName('myplugin')).not.toThrow();
    });

    it('accepts a single character name', () => {
      expect(() => validatePluginName('a')).not.toThrow();
    });

    it('accepts name with digits', () => {
      expect(() => validatePluginName('plugin123')).not.toThrow();
    });

    it('accepts name with hyphens', () => {
      expect(() => validatePluginName('my-plugin')).not.toThrow();
    });

    it('accepts max-length name (50 chars)', () => {
      const name = 'a' + 'b'.repeat(49);
      expect(() => validatePluginName(name)).not.toThrow();
    });
  });

  describe('path traversal rejection', () => {
    it('rejects ../evil', () => {
      expect(() => validatePluginName('../evil')).toThrow();
    });

    it('rejects ../../etc/passwd', () => {
      expect(() => validatePluginName('../../etc/passwd')).toThrow();
    });

    it('rejects bare ..', () => {
      expect(() => validatePluginName('..')).toThrow();
    });
  });

  describe('format violations', () => {
    it('rejects uppercase letters', () => {
      expect(() => validatePluginName('MyPlugin')).toThrow();
    });

    it('rejects name starting with digit', () => {
      expect(() => validatePluginName('1plugin')).toThrow();
    });

    it('rejects name starting with hyphen', () => {
      expect(() => validatePluginName('-plugin')).toThrow();
    });

    it('rejects name exceeding 50 chars', () => {
      const name = 'a' + 'b'.repeat(50); // 51 chars
      expect(() => validatePluginName(name)).toThrow();
    });

    it('rejects empty string', () => {
      expect(() => validatePluginName('')).toThrow();
    });

    it('rejects @ character', () => {
      expect(() => validatePluginName('@scope/plugin')).toThrow();
    });

    it('rejects space character', () => {
      expect(() => validatePluginName('my plugin')).toThrow();
    });

    it('rejects underscore character', () => {
      expect(() => validatePluginName('my_plugin')).toThrow();
    });

    it('rejects dot character', () => {
      expect(() => validatePluginName('my.plugin')).toThrow();
    });

    it('rejects slash character', () => {
      expect(() => validatePluginName('my/plugin')).toThrow();
    });
  });

  describe('error type and message', () => {
    it('throws PathSecurityError', () => {
      try {
        validatePluginName('INVALID');
        expect.fail('should have thrown');
      } catch (error: any) {
        expect(error.name).toBe('PathSecurityError');
      }
    });

    it('includes the invalid name in the error message', () => {
      try {
        validatePluginName('../evil');
        expect.fail('should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('../evil');
      }
    });

    it('includes the pattern description in the error message', () => {
      try {
        validatePluginName('INVALID');
        expect.fail('should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('lowercase');
      }
    });
  });
});

describe('PluginDiscovery.getPluginDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCodemiePath).mockReturnValue('/home/user/.codemie/plugins');
    vi.mocked(isPathWithinDirectory).mockImplementation(mockIsPathWithin);
  });

  it('returns resolved path for valid name', () => {
    const result = PluginDiscovery.getPluginDir('myplugin');
    expect(result).toContain('myplugin');
    expect(result).toMatch(/\.codemie[/\\]plugins/);
  });

  it('throws for invalid name', () => {
    expect(() => PluginDiscovery.getPluginDir('../evil')).toThrow();
  });

  it('throws when path escapes plugins directory', () => {
    vi.mocked(isPathWithinDirectory).mockReturnValue(false);
    expect(() => PluginDiscovery.getPluginDir('myplugin')).toThrow('escapes');
  });
});

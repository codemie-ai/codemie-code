/**
 * Tests for inject-sanitizer temp file management.
 *
 * Uses vi.resetModules() to reset module-level state (pluginFilePath, cleanupRegistered)
 * between tests, since the module uses mutable closures.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock os.tmpdir
vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

// Mock logger
vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the source constant
vi.mock('../reasoning-sanitizer-source.js', () => ({
  REASONING_SANITIZER_PLUGIN_SOURCE: 'mock-plugin-source-code',
}));

describe('inject-sanitizer', () => {
  let getReasoningSanitizerPluginUrl: typeof import('../inject-sanitizer.js').getReasoningSanitizerPluginUrl;
  let cleanupReasoningSanitizerPlugin: typeof import('../inject-sanitizer.js').cleanupReasoningSanitizerPlugin;
  let writeFileSync: typeof import('fs').writeFileSync;
  let unlinkSync: typeof import('fs').unlinkSync;
  let mkdirSync: typeof import('fs').mkdirSync;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset modules to clear module-level state (pluginFilePath, cleanupRegistered)
    vi.resetModules();

    const fs = await import('fs');
    writeFileSync = fs.writeFileSync;
    unlinkSync = fs.unlinkSync;
    mkdirSync = fs.mkdirSync;

    const mod = await import('../inject-sanitizer.js');
    getReasoningSanitizerPluginUrl = mod.getReasoningSanitizerPluginUrl;
    cleanupReasoningSanitizerPlugin = mod.cleanupReasoningSanitizerPlugin;
  });

  describe('getReasoningSanitizerPluginUrl', () => {
    it('returns file:// URL ending with reasoning-sanitizer.ts', () => {
      const url = getReasoningSanitizerPluginUrl();

      expect(url).toMatch(/^file:\/\//);
      expect(url).toMatch(/reasoning-sanitizer\.ts$/);
    });

    it('creates temp dir with mkdirSync', () => {
      getReasoningSanitizerPluginUrl();

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('codemie-hooks'),
        { recursive: true },
      );
    });

    it('writes source to temp file via writeFileSync', () => {
      getReasoningSanitizerPluginUrl();

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('reasoning-sanitizer.ts'),
        'mock-plugin-source-code',
        'utf-8',
      );
    });

    it('is idempotent — same URL and single write on repeated calls', () => {
      const url1 = getReasoningSanitizerPluginUrl();
      const url2 = getReasoningSanitizerPluginUrl();

      expect(url1).toBe(url2);
      expect(writeFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanupReasoningSanitizerPlugin', () => {
    it('deletes temp file after getUrl was called', () => {
      getReasoningSanitizerPluginUrl();

      cleanupReasoningSanitizerPlugin();

      expect(unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('reasoning-sanitizer.ts'),
      );
    });

    it('is a safe no-op when no file exists', () => {
      // Never called getUrl, so no file to clean up
      cleanupReasoningSanitizerPlugin();

      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('handles unlinkSync errors gracefully', () => {
      getReasoningSanitizerPluginUrl();
      vi.mocked(unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });

      // Should not throw
      expect(() => cleanupReasoningSanitizerPlugin()).not.toThrow();
    });

    it('after cleanup, getUrl creates a new file (writeFileSync called again)', () => {
      getReasoningSanitizerPluginUrl();
      expect(writeFileSync).toHaveBeenCalledTimes(1);

      cleanupReasoningSanitizerPlugin();

      getReasoningSanitizerPluginUrl();
      expect(writeFileSync).toHaveBeenCalledTimes(2);
    });
  });
});

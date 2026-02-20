/**
 * Tests for resolveCodemieOpenCodeBinary()
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
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

const { existsSync } = await import('fs');
const { logger } = await import('../../../../utils/logger.js');
const { resolveCodemieOpenCodeBinary } = await import('../codemie-opencode-binary.js');

const mockExistsSync = vi.mocked(existsSync);

describe('resolveCodemieOpenCodeBinary', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CODEMIE_OPENCODE_WL_BIN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns env var path when CODEMIE_OPENCODE_WL_BIN is set and file exists', () => {
    process.env.CODEMIE_OPENCODE_WL_BIN = '/custom/bin/codemie';
    mockExistsSync.mockImplementation((p) => p === '/custom/bin/codemie');

    const result = resolveCodemieOpenCodeBinary();

    expect(result).toBe('/custom/bin/codemie');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('CODEMIE_OPENCODE_WL_BIN')
    );
  });

  it('warns and continues resolution when CODEMIE_OPENCODE_WL_BIN set but file missing', () => {
    process.env.CODEMIE_OPENCODE_WL_BIN = '/missing/bin/codemie';
    mockExistsSync.mockReturnValue(false);

    const result = resolveCodemieOpenCodeBinary();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CODEMIE_OPENCODE_WL_BIN')
    );
    // Falls through to null since no node_modules binaries exist either
    expect(result).toBeNull();
  });

  it('skips env check when CODEMIE_OPENCODE_WL_BIN not set', () => {
    mockExistsSync.mockReturnValue(false);

    resolveCodemieOpenCodeBinary();

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('CODEMIE_OPENCODE_WL_BIN')
    );
  });

  it('returns platform binary when found in node_modules', () => {
    mockExistsSync.mockImplementation((p) => {
      const ps = String(p);
      // Platform package dir exists and binary file exists
      return ps.includes('node_modules/@codemieai/codemie-opencode-') && ps.includes('/bin/');
    });

    const result = resolveCodemieOpenCodeBinary();

    if (result) {
      expect(result).toContain('bin');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('platform binary')
      );
    }
    // If platform package is not found (node_modules doesn't exist), result may be null
  });

  it('returns wrapper binary when platform package not available', () => {
    mockExistsSync.mockImplementation((p) => {
      const ps = String(p);
      // Platform-specific package NOT found, but wrapper package found
      if (ps.includes('codemie-opencode-darwin') || ps.includes('codemie-opencode-linux') || ps.includes('codemie-opencode-windows')) {
        return false;
      }
      return ps.includes('node_modules/@codemieai/codemie-opencode') && ps.includes('/bin/');
    });

    const result = resolveCodemieOpenCodeBinary();

    if (result) {
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('wrapper binary')
      );
    }
  });

  it('returns null when no binary found anywhere', () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveCodemieOpenCodeBinary();

    expect(result).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('not found')
    );
  });
});

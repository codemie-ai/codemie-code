import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('../exec.js', () => ({
  exec: vi.fn()
}));

vi.mock('fs/promises', () => ({
  default: {
    lstat: vi.fn(),
    readlink: vi.fn(),
    symlink: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn()
  }
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      platform: vi.fn(() => 'linux')
    }
  };
});

import { logger } from '../logger.js';
import { exec } from '../exec.js';
import fs from 'fs/promises';
import { restoreCliBinLink } from '../cli-bin.js';

function mockNpmPrefix(prefix = '/usr/local') {
  vi.mocked(exec).mockResolvedValue({
    code: 0,
    stdout: `${prefix}\n`,
    stderr: ''
  });
}

function mockSymlink(isSymlink = true) {
  vi.mocked(fs.lstat).mockResolvedValue({
    isSymbolicLink: () => isSymlink
  } as any);
}

describe('restoreCliBinLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.platform).mockReturnValue('linux');
  });

  it('should skip on Windows platform', async () => {
    vi.mocked(os.platform).mockReturnValue('win32');

    await restoreCliBinLink();

    expect(exec).not.toHaveBeenCalled();
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('Skipping CLI binary link restore on Windows');
  });

  it('should restore symlink when overwritten by agent package', async () => {
    mockNpmPrefix();
    mockSymlink();
    vi.mocked(fs.readlink).mockResolvedValue(
      '../lib/node_modules/@codemieai/codemie-opencode/bin/codemie'
    );
    vi.mocked(fs.symlink).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);

    await restoreCliBinLink();

    expect(fs.symlink).toHaveBeenCalledWith(
      '../lib/node_modules/@codemieai/code/bin/codemie.js',
      expect.stringContaining('.codemie-tmp-')
    );
    expect(fs.rename).toHaveBeenCalledWith(
      expect.stringContaining('.codemie-tmp-'),
      '/usr/local/bin/codemie'
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Restored codemie CLI binary link after agent update'
    );
  });

  it('should skip restore when symlink already points to correct target', async () => {
    mockNpmPrefix();
    mockSymlink();
    vi.mocked(fs.readlink).mockResolvedValue(
      '../lib/node_modules/@codemieai/code/bin/codemie.js'
    );

    await restoreCliBinLink();

    expect(fs.symlink).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('should skip when path is a regular file, not a symlink', async () => {
    mockNpmPrefix();
    mockSymlink(false);

    await restoreCliBinLink();

    expect(fs.readlink).not.toHaveBeenCalled();
    expect(fs.symlink).not.toHaveBeenCalled();
  });

  it('should return early when npm prefix -g fails', async () => {
    vi.mocked(exec).mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'error'
    });

    await restoreCliBinLink();

    expect(fs.lstat).not.toHaveBeenCalled();
  });

  it('should return silently when lstat throws ENOENT (binary does not exist)', async () => {
    mockNpmPrefix();
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fs.lstat).mockRejectedValue(enoent);

    await expect(restoreCliBinLink()).resolves.toBeUndefined();

    // Should NOT log the misleading "Could not verify/restore" message
    expect(logger.debug).not.toHaveBeenCalledWith(
      'Could not verify/restore CLI binary link:',
      expect.any(Error)
    );
    // Should not attempt any symlink operations
    expect(fs.readlink).not.toHaveBeenCalled();
    expect(fs.symlink).not.toHaveBeenCalled();
  });

  it('should clean up temp file when atomic rename fails', async () => {
    mockNpmPrefix();
    mockSymlink();
    vi.mocked(fs.readlink).mockResolvedValue(
      '../lib/node_modules/@codemieai/codemie-opencode/bin/codemie'
    );
    vi.mocked(fs.symlink).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockRejectedValue(new Error('rename failed'));
    vi.mocked(fs.unlink).mockResolvedValue(undefined);

    await restoreCliBinLink();

    expect(fs.unlink).toHaveBeenCalledWith(
      expect.stringContaining('.codemie-tmp-')
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Could not verify/restore CLI binary link:',
      expect.any(Error)
    );
  });

  it('should handle symlink creation failure gracefully', async () => {
    mockNpmPrefix();
    mockSymlink();
    vi.mocked(fs.readlink).mockResolvedValue(
      '../lib/node_modules/@codemieai/codemie-opencode/bin/codemie'
    );
    vi.mocked(fs.symlink).mockRejectedValue(new Error('EACCES: permission denied'));
    vi.mocked(fs.unlink).mockRejectedValue(new Error('ENOENT'));

    await expect(restoreCliBinLink()).resolves.toBeUndefined();

    expect(fs.unlink).toHaveBeenCalledWith(
      expect.stringContaining('.codemie-tmp-')
    );
    expect(fs.rename).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Could not verify/restore CLI binary link:',
      expect.any(Error)
    );
  });
});

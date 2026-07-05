/**
 * processes.ts — spawnDetached platform-conditional options.
 * Isolated file: mocks node:child_process file-wide, so it must not share a
 * module scope with the npm-utility suite in processes.test.ts.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })),
  exec: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { spawnDetached } from '../processes.js';

describe('spawnDetached', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides the console window on Windows (windowsHide: true)', () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    const pid = spawnDetached('node', ['daemon.js']);
    expect(pid).toBe(4242);
    expect(spawn).toHaveBeenCalledWith(
      'node',
      ['daemon.js'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true })
    );
  });

  it('does not hide the console window off Windows (windowsHide: false)', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    spawnDetached('node', ['daemon.js']);
    expect(spawn).toHaveBeenCalledWith(
      'node',
      ['daemon.js'],
      expect.objectContaining({ windowsHide: false })
    );
  });
});

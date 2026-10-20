import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { spawnDetached, isProcessAlive } = await import('../processes.js');

describe('spawnDetached', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ pid: 123, unref: vi.fn(), on: vi.fn() });
  });

  it('forwards windowsHide to spawn', () => {
    expect(spawnDetached('node', ['x.js'], { windowsHide: true })).toBe(123);
    expect(spawnMock).toHaveBeenCalledWith('node', ['x.js'], expect.objectContaining({ detached: true, windowsHide: true }));
  });

  it('leaves windowsHide undefined by default', () => {
    spawnDetached('node');
    expect(spawnMock.mock.calls[0][2].windowsHide).toBeUndefined();
  });

  it('returns -1 when the child has no pid', () => {
    spawnMock.mockReturnValue({ pid: undefined, unref: vi.fn(), on: vi.fn() });
    expect(spawnDetached('node')).toBe(-1);
  });

  it('handles the child error event so a failed spawn does not crash the process', () => {
    const on = vi.fn();
    spawnMock.mockReturnValue({ pid: undefined, unref: vi.fn(), on });

    spawnDetached('missing-binary');

    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(() => on.mock.calls.find(([event]) => event === 'error')![1](new Error('spawn ENOENT'))).not.toThrow();
  });
});

describe('isProcessAlive', () => {
  it('is true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for a dead pid', () => {
    expect(isProcessAlive(9999999)).toBe(false);
  });
});

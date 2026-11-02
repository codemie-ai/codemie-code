import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { spawnDetached, isProcessAlive, signalTree } = await import('../processes.js');

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

describe('signalTree', () => {
  let killed: string[];

  /** `pgrep -P` as the OS answers it: exit status 1 when the process has no children. */
  function pgrepFinds(children: Record<number, number[]>): void {
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      const found = children[Number(args[1])];
      if (!found) {
        throw Object.assign(new Error('pgrep: no match'), { status: 1 });
      }
      return found.map((pid) => `${pid}\n`).join('');
    });
  }

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
  }

  beforeEach(() => {
    killed = [];
    execFileSyncMock.mockReset();
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      killed.push(`${pid}:${signal}`);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signals a two-level tree deepest first, then the root', () => {
    pgrepFinds({ 100: [200], 200: [300, 301] });

    signalTree(100, 'SIGTERM');

    expect(killed).toEqual(['300:SIGTERM', '301:SIGTERM', '200:SIGTERM', '100:SIGTERM']);
  });

  it('keeps signalling the others when one pid is already gone', () => {
    pgrepFinds({ 100: [200, 201] });
    vi.mocked(process.kill).mockImplementation((pid: number, signal?: string | number) => {
      if (pid === 200) {
        throw errno('ESRCH');
      }
      killed.push(`${pid}:${signal}`);
      return true;
    });

    expect(() => signalTree(100, 'SIGKILL')).not.toThrow();

    expect(killed).toEqual(['201:SIGKILL', '100:SIGKILL']);
  });

  it('signals only the root when pgrep finds no children', () => {
    pgrepFinds({});

    signalTree(100, 'SIGHUP');

    expect(killed).toEqual(['100:SIGHUP']);
  });

  it('still signals the root when the pgrep listing times out', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync pgrep ETIMEDOUT'), { code: 'ETIMEDOUT', status: null });
    });

    expect(() => signalTree(100, 'SIGTERM')).not.toThrow();

    expect(killed).toEqual(['100:SIGTERM']);
  });
});

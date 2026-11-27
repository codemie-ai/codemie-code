import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

function fakeChild(pid: number): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter };
  child.pid = pid;
  child.kill = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('exec timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock('os');
  });

  it('kills the whole process tree with taskkill on Windows shell timeout', async () => {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, default: { ...actual, platform: () => 'win32' } };
    });
    const child = fakeChild(4242);
    spawnMock.mockReturnValueOnce(child).mockReturnValue(fakeChild(1));

    const { exec } = await import('../exec.js');
    const promise = exec('pi', ['install', 'x'], { shell: true, timeout: 1000 });
    const assertion = expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    const taskkillCall = spawnMock.mock.calls.find(call => call[0] === 'taskkill');
    expect(taskkillCall?.[1]).toEqual(['/pid', '4242', '/T', '/F']);
  });

  it('uses child.kill on non-Windows timeout', async () => {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, default: { ...actual, platform: () => 'linux' } };
    });
    const child = fakeChild(4243);
    spawnMock.mockReturnValueOnce(child);

    const { exec } = await import('../exec.js');
    const promise = exec('pi', [], { timeout: 1000 });
    const assertion = expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(child.kill).toHaveBeenCalled();
    expect(spawnMock.mock.calls.some(call => call[0] === 'taskkill')).toBe(false);
  });
});

/**
 * `proxy disconnect --all`.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTarget {
  id: string;
  label: string;
  connected: boolean;
  /** The connected check failed with this message. */
  error?: string;
  disconnect?: () => Promise<void>;
}

const targets: FakeTarget[] = [];
const stopDaemon = vi.fn().mockResolvedValue(undefined);

vi.mock('../client-targets.js', () => ({
  readClientTargetStates: async () => targets.map((target) => ({
    target,
    connected: target.connected,
    ...(target.error !== undefined && { error: target.error }),
  })),
  listConnectedClientTargets: async () => targets.filter((t) => t.connected),
}));
vi.mock('../daemon-manager.js', () => ({
  checkStatus: async () => ({ running: true }),
  stopDaemon: () => stopDaemon(),
}));
vi.mock('../daemon-lock.js', () => ({
  DAEMON_LOCK_COMMAND_BUDGET_MS: 1,
  withDaemonLock: async (_ms: number, fn: () => Promise<unknown>) => fn(),
}));

describe('disconnectAll', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    targets.length = 0;
    process.exitCode = undefined;
    stopDaemon.mockReset().mockResolvedValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('continues past a failing target, reports it, exits 1 and keeps the daemon', async () => {
    const ok = vi.fn().mockResolvedValue(undefined);
    targets.push(
      { id: 'a', label: 'Alpha', connected: true, disconnect: async () => { process.exitCode = 1; } },
      { id: 'b', label: 'Beta', connected: true, disconnect: ok },
      { id: 'c', label: 'Gamma', connected: true, disconnect: async () => { throw new Error('boom'); } },
    );
    const { disconnectAll } = await import('../disconnect-all.js');

    const result = await disconnectAll();

    expect(ok).toHaveBeenCalled();
    expect(result).toEqual({ disconnected: ['Beta'], failed: ['Alpha', 'Gamma'] });
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Alpha, Gamma'));
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('stops the daemon only with --stop', async () => {
    targets.push({ id: 'b', label: 'Beta', connected: true, disconnect: async () => {} });
    const { disconnectAll } = await import('../disconnect-all.js');

    await disconnectAll({ stop: true });

    expect(stopDaemon).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('a failed stop is reported and exits 1', async () => {
    targets.push({ id: 'b', label: 'Beta', connected: true, disconnect: async () => {} });
    stopDaemon.mockRejectedValue(new Error('kill failed'));
    const { disconnectAll } = await import('../disconnect-all.js');

    await disconnectAll({ stop: true });

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop proxy'));
    expect(process.exitCode).toBe(1);
  });

  it('a target whose connected check failed is reported as not disconnected and exits 1', async () => {
    const remove = vi.fn(async () => {});
    targets.push(
      { id: 'a', label: 'Alpha', connected: false, error: 'EACCES', disconnect: remove },
      { id: 'b', label: 'Beta', connected: true, disconnect: async () => {} },
    );
    const { disconnectAll } = await import('../disconnect-all.js');

    const result = await disconnectAll();

    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ disconnected: ['Beta'], failed: ['Alpha'] });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Alpha: check failed (EACCES); not disconnected'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Nothing connected'));
    expect(process.exitCode).toBe(1);
  });

  it('a second run with nothing connected reports so and exits 0', async () => {
    const remove = vi.fn(async () => {});
    const target = { id: 'b', label: 'Beta', connected: true, disconnect: async () => { await remove(); target.connected = false; } };
    targets.push(target);
    const { disconnectAll } = await import('../disconnect-all.js');

    await disconnectAll();
    remove.mockClear();
    const second = await disconnectAll();

    expect(remove).not.toHaveBeenCalled();
    expect(second).toEqual({ disconnected: [], failed: [] });
    expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining('Nothing connected'));
    expect(process.exitCode).toBeUndefined();
  });
});

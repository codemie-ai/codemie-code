/**
 * `proxy disconnect --all`.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const targets: Array<{ id: string; label: string; connected: boolean; disconnect?: () => Promise<void> }> = [];
const stopDaemon = vi.fn().mockResolvedValue(undefined);

vi.mock('../client-targets.js', () => ({
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
    stopDaemon.mockClear();
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

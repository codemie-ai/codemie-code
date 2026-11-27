import { describe, expect, it, vi } from 'vitest';

import { runUninstall } from '../uninstall.js';
import type { UninstallDeps } from '../uninstall.js';
import type { Scheduler } from '../scheduler/index.js';

function schedulerReturning(present: boolean): Scheduler {
  return {
    preflight: async () => undefined,
    register: async () => ({}),
    unregister: async () => present,
    query: async () => 'disabled',
    exists: async () => 'absent',
  };
}

interface Harness {
  deps: UninstallDeps;
  printed: string[];
  unregister: ReturnType<typeof vi.fn>;
  deleteSettings: ReturnType<typeof vi.fn>;
  removeWorkingCopy: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<UninstallDeps> = {}): Harness {
  const printed: string[] = [];
  const unregister = vi.fn(async () => true);
  const deleteSettings = vi.fn(async () => true);
  const removeWorkingCopy = vi.fn(async () => true);

  const schedulerFor = vi.fn(
    (): Scheduler => ({
      preflight: async () => undefined,
      register: async () => ({}),
      unregister: (...args: []) => unregister(...args),
      query: async () => 'disabled',
      exists: async () => 'absent',
    })
  );

  const deps: UninstallDeps = {
    loadSettings: async () => null,
    schedulerFor,
    deleteSettings,
    removeWorkingCopy,
    print: (line: string): void => {
      printed.push(line);
    },
    teardown: async (removeInstall) => {
      await removeInstall();
      return false;
    },
    ...overrides,
  };

  return { deps, printed, unregister, deleteSettings, removeWorkingCopy };
}

describe('runUninstall', () => {
  it('calls unregister, deleteSettings and removeWorkingCopy, and exits 0', async () => {
    const { deps, unregister, deleteSettings, removeWorkingCopy } = makeDeps();

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(deleteSettings).toHaveBeenCalledTimes(1);
    expect(removeWorkingCopy).toHaveBeenCalledTimes(1);
  });

  it('reports the working copy removal when it existed', async () => {
    const { deps, printed } = makeDeps({
      removeWorkingCopy: vi.fn(async () => true),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).toMatch(/local git working copy was removed/i);
  });

  it('does not report a working copy removal when none existed', async () => {
    const { deps, printed } = makeDeps({
      schedulerFor: () => schedulerReturning(true),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).not.toMatch(/local git working copy was removed/i);
  });

  it('prints "nothing to remove" and exits 0 when the job, settings and working copy were all absent', async () => {
    const { deps, printed } = makeDeps({
      schedulerFor: () => schedulerReturning(false),
      deleteSettings: vi.fn(async () => false),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).toMatch(/nothing to remove/i);
  });

  it('reports removal (not "nothing to remove") when only the OS job existed', async () => {
    const { deps, printed } = makeDeps({
      schedulerFor: () => schedulerReturning(true),
      deleteSettings: vi.fn(async () => false),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).not.toMatch(/nothing to remove/i);
  });

  it('reports removal (not "nothing to remove") when only the settings existed', async () => {
    const { deps, printed } = makeDeps({
      schedulerFor: () => schedulerReturning(false),
      deleteSettings: vi.fn(async () => true),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).not.toMatch(/nothing to remove/i);
  });

  it('reports removal (not "nothing to remove") when only the working copy existed', async () => {
    const { deps, printed } = makeDeps({
      schedulerFor: () => schedulerReturning(false),
      deleteSettings: vi.fn(async () => false),
      removeWorkingCopy: vi.fn(async () => true),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).not.toMatch(/nothing to remove/i);
  });

  it('keeps both last-sent markers and the run log (never calls anything related to them)', async () => {
    const { deps, printed } = makeDeps();

    // UninstallDeps has no marker/log fields at all — this is a type-level guarantee as
    // much as a runtime one, asserted here by exhaustively listing the deps surface.
    expect(Object.keys(deps).sort()).toEqual(['deleteSettings', 'loadSettings', 'print', 'removeWorkingCopy', 'schedulerFor', 'teardown']);

    await runUninstall(deps);

    expect(printed.join('\n')).toMatch(/last-sent markers/i);
    expect(printed.join('\n')).toMatch(/run log/i);
  });

  it('prints a redacted failure message and exits 1 when deleteSettings throws', async () => {
    const { deps, printed } = makeDeps({
      deleteSettings: vi.fn(async () => {
        throw new Error('EACCES: permission denied, sig=SUPERSECRET123');
      }),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(1);
    expect(printed.join('\n')).not.toContain('SUPERSECRET123');
  });
});

describe('runUninstall — the mode\'s teardown', () => {
  it('hands its removal to the teardown and removes nothing by itself', async () => {
    const events: string[] = [];
    const { deps, unregister, deleteSettings } = makeDeps({
      teardown: async (removeInstall) => {
        events.push('teardown: before');
        expect(unregister).not.toHaveBeenCalled();
        expect(deleteSettings).not.toHaveBeenCalled();
        await removeInstall();
        events.push('teardown: after');
        return false;
      },
    });
    unregister.mockImplementation(async () => {
      events.push('unregister');
      return true;
    });
    deleteSettings.mockImplementation(async () => {
      events.push('delete settings');
      return true;
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(events).toEqual(['teardown: before', 'unregister', 'delete settings', 'teardown: after']);
  });

  it.each([
    [true, false, ['Analytics sync uninstalled.', '  The last-sent markers (webhook and git) and the run log were kept.']],
    [false, false, ['Nothing to remove: analytics sync is not installed.']],
    [true, true, ['Analytics sync uninstalled.', '  The OS job and the sync settings were removed.', '  The last-sent markers (webhook and git) and the run log were kept.']],
  ])('a teardown that took something away: %s, a job: %s, no settings and no working copy → its lines', async (tookAway, job, lines) => {
    const { deps, printed } = makeDeps({
      schedulerFor: () => schedulerReturning(job),
      deleteSettings: vi.fn(async () => false),
      removeWorkingCopy: vi.fn(async () => false),
      teardown: async (removeInstall) => {
        await removeInstall();
        return tookAway;
      },
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed).toEqual(lines);
  });

  it('a teardown that throws before the removal exits 1 and leaves the job and the settings', async () => {
    const { deps, printed, unregister, deleteSettings, removeWorkingCopy } = makeDeps({
      teardown: async () => {
        throw new Error('Another codemie process is starting or stopping the proxy; try again.');
      },
    });

    const code = await runUninstall(deps);

    expect(code).toBe(1);
    expect(printed).toContain('Uninstall failed: Another codemie process is starting or stopping the proxy; try again.');
    expect(unregister).not.toHaveBeenCalled();
    expect(deleteSettings).not.toHaveBeenCalled();
    expect(removeWorkingCopy).not.toHaveBeenCalled();
  });
});

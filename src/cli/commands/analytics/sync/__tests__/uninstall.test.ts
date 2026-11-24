import { describe, expect, it, vi } from 'vitest';

import { runUninstall } from '../uninstall.js';
import type { UninstallDeps } from '../uninstall.js';

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

  const deps: UninstallDeps = {
    unregister,
    deleteSettings,
    removeWorkingCopy,
    print: (line: string): void => {
      printed.push(line);
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
      unregister: vi.fn(async () => true),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).not.toMatch(/local git working copy was removed/i);
  });

  it('prints "nothing to remove" and exits 0 when the job, settings and working copy were all absent', async () => {
    const { deps, printed } = makeDeps({
      unregister: vi.fn(async () => false),
      deleteSettings: vi.fn(async () => false),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).toMatch(/nothing to remove/i);
  });

  it('reports removal (not "nothing to remove") when only the OS job existed', async () => {
    const { deps, printed } = makeDeps({
      unregister: vi.fn(async () => true),
      deleteSettings: vi.fn(async () => false),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).not.toMatch(/nothing to remove/i);
  });

  it('reports removal (not "nothing to remove") when only the settings existed', async () => {
    const { deps, printed } = makeDeps({
      unregister: vi.fn(async () => false),
      deleteSettings: vi.fn(async () => true),
      removeWorkingCopy: vi.fn(async () => false),
    });

    const code = await runUninstall(deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).not.toMatch(/nothing to remove/i);
  });

  it('reports removal (not "nothing to remove") when only the working copy existed', async () => {
    const { deps, printed } = makeDeps({
      unregister: vi.fn(async () => false),
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
    expect(Object.keys(deps).sort()).toEqual(['deleteSettings', 'print', 'removeWorkingCopy', 'unregister']);

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

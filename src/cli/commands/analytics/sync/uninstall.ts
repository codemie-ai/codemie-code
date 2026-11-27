/**
 * Uninstall runner for `codemie analytics sync uninstall`.
 *
 * Removes the OS scheduler job, the settings file holding the webhook/git configuration, and
 * (AC12) the local working copy the git target keeps on disk. Both last-sent markers
 * (`~/.codemie/analytics-last-sent` for the webhook target, `~/.codemie/analytics-last-sent-git`
 * for the git target) and the run log are never touched — removing delivery is not the same
 * as forgetting history, and a later re-install should not re-send or duplicate what was
 * already sent. Every side effect is injected via {@link UninstallDeps} so tests run without
 * touching the real scheduler or filesystem. The job and settings removal runs inside the
 * mode's `teardown`, which calls it once; a teardown that throws before that leaves both.
 *
 * `runUninstall` never throws and never calls `process.exit`.
 */

import { rm, stat } from 'fs/promises';

import { deleteSyncSettings, loadSyncSettings } from './config-store.js';
import { errorMessage } from './redact.js';
import { createRealSchedulerDeps, createScheduler, resolveSchedulerName } from './scheduler/index.js';
import type { Scheduler } from './scheduler/index.js';
import type { SyncSettings } from './types.js';
import { gitWorkingCopyPath } from './targets/git-target.js';

/** Every side effect `runUninstall` needs, injected so tests run without a real scheduler or
 * fs. `createRealUninstallDeps()` below wires the real ones. */
export interface UninstallDeps {
  /** Throws on an unreadable/invalid settings file; `null` means no settings file exists
   * (the default scheduler name is then used). */
  loadSettings(): Promise<SyncSettings | null>;
  /** A scheduler bound to the given OS job name. Its `unregister()` removes the job whether
   * enabled or disabled (tolerant of it being absent) and reports whether it was present. */
  schedulerFor(name: string): Scheduler;
  /** Deletes the settings file and reports whether it existed. */
  deleteSettings(): Promise<boolean>;
  /** Removes the git target's local working copy ({@link gitWorkingCopyPath}) and reports
   * whether it existed beforehand. Real deps: check existence first (so the boolean is
   * meaningful), then `rm(gitWorkingCopyPath(), { recursive: true, force: true })`. */
  removeWorkingCopy(): Promise<boolean>;
  print(line: string): void;
  /** The mode's own removal around the uninstall's: it calls the given removal once, and answers whether its own
   * removal took anything away. */
  teardown(removeInstall: () => Promise<void>): Promise<boolean>;
}

export async function runUninstall(deps: UninstallDeps): Promise<number> {
  let unregistered = false;
  let deleted = false;
  let workingCopyRemoved: boolean;
  let tornDown: boolean;
  try {
    const settings = await deps.loadSettings();
    const name = resolveSchedulerName(settings ?? {}, process.platform);
    tornDown = await deps.teardown(async () => {
      unregistered = await deps.schedulerFor(name).unregister();
      deleted = await deps.deleteSettings();
    });
    workingCopyRemoved = await deps.removeWorkingCopy();
  } catch (err) {
    // Nothing after a failure is removed: settings and working copy are kept so the job name
    // stays known and uninstall can be retried.
    deps.print(`Uninstall failed: ${errorMessage(err)}`);
    return 1;
  }

  if (!unregistered && !deleted && !workingCopyRemoved && !tornDown) {
    deps.print('Nothing to remove: analytics sync is not installed.');
    return 0;
  }

  deps.print('Analytics sync uninstalled.');
  if (unregistered || deleted) {
    deps.print('  The OS job and the sync settings were removed.');
  }
  if (workingCopyRemoved) {
    deps.print('  The local git working copy was removed.');
  }
  deps.print('  The last-sent markers (webhook and git) and the run log were kept.');
  return 0;
}

/** Real dependencies for `runUninstall`: the real scheduler and settings store, the git
 * target's working-copy removal, `console.log`, and the mode's `teardown`. */
export function createRealUninstallDeps(teardown: UninstallDeps['teardown']): UninstallDeps {
  return {
    teardown,
    loadSettings: () => loadSyncSettings(),
    schedulerFor: (name: string) => createScheduler(createRealSchedulerDeps(), name),
    deleteSettings: () => deleteSyncSettings(),
    removeWorkingCopy: async (): Promise<boolean> => {
      const path = gitWorkingCopyPath();
      let existed: boolean;
      try {
        await stat(path);
        existed = true;
      } catch {
        existed = false;
      }
      await rm(path, { recursive: true, force: true });
      return existed;
    },
    print: (line: string): void => {
      console.log(line);
    }
  };
}

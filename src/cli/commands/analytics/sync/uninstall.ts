/**
 * Uninstall runner for `codemie analytics sync uninstall`.
 *
 * Removes the OS scheduler job, the settings file holding the webhook/git configuration, and
 * (AC12) the local working copy the git target keeps on disk. Both last-sent markers
 * (`~/.codemie/analytics-last-sent` for the webhook target, `~/.codemie/analytics-last-sent-git`
 * for the git target) and the run log are never touched — removing delivery is not the same
 * as forgetting history, and a later re-install should not re-send or duplicate what was
 * already sent. Every side effect is injected via {@link UninstallDeps} so tests run without
 * touching the real scheduler or filesystem.
 *
 * `runUninstall` never throws and never calls `process.exit`.
 */

import { rm, stat } from 'fs/promises';

import { deleteSyncSettings } from './config-store.js';
import { errorMessage } from './redact.js';
import { createRealSchedulerDeps, createScheduler } from './scheduler/index.js';
import { gitWorkingCopyPath } from './targets/git-target.js';

/** Every side effect `runUninstall` needs, injected so tests run without a real scheduler or
 * fs. `createRealUninstallDeps()` below wires the real ones. */
export interface UninstallDeps {
  /** Removes the OS job whether enabled or disabled (tolerant of it already being absent)
   * and reports whether anything was actually present. */
  unregister(): Promise<boolean>;
  /** Deletes the settings file and reports whether it existed. */
  deleteSettings(): Promise<boolean>;
  /** Removes the git target's local working copy ({@link gitWorkingCopyPath}) and reports
   * whether it existed beforehand. Real deps: check existence first (so the boolean is
   * meaningful), then `rm(gitWorkingCopyPath(), { recursive: true, force: true })`. */
  removeWorkingCopy(): Promise<boolean>;
  print(line: string): void;
}

export async function runUninstall(deps: UninstallDeps): Promise<number> {
  let unregistered: boolean;
  let deleted: boolean;
  let workingCopyRemoved: boolean;
  try {
    unregistered = await deps.unregister();
    deleted = await deps.deleteSettings();
    workingCopyRemoved = await deps.removeWorkingCopy();
  } catch (err) {
    deps.print(`Uninstall failed: ${errorMessage(err)}`);
    return 1;
  }

  if (!unregistered && !deleted && !workingCopyRemoved) {
    deps.print('Nothing to remove: analytics sync is not installed.');
    return 0;
  }

  deps.print('Analytics sync uninstalled.');
  deps.print('  The OS job and the sync settings were removed.');
  if (workingCopyRemoved) {
    deps.print('  The local git working copy was removed.');
  }
  deps.print('  The last-sent markers (webhook and git) and the run log were kept.');
  return 0;
}

/** Real dependencies for `runUninstall`: the real scheduler and settings store, the git
 * target's working-copy removal, and `console.log`. */
export function createRealUninstallDeps(): UninstallDeps {
  const scheduler = createScheduler(createRealSchedulerDeps());

  return {
    unregister: () => scheduler.unregister(),
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

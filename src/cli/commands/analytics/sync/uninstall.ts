/**
 * Uninstall runner for `codemie analytics sync uninstall`.
 *
 * Removes the OS scheduler job and the settings file holding the webhook URL. The last-sent
 * marker and the run log are never touched — removing delivery is not the same as forgetting
 * history, and a later re-install should not re-send or duplicate what was already sent.
 * Every side effect is injected via {@link UninstallDeps} so tests run without touching the
 * real scheduler or filesystem.
 *
 * `runUninstall` never throws and never calls `process.exit`.
 */

import { deleteSyncSettings } from './config-store.js';
import { errorMessage } from './redact.js';
import { createRealSchedulerDeps, createScheduler } from './scheduler/index.js';

/** Every side effect `runUninstall` needs, injected so tests run without a real scheduler or
 * fs. `createRealUninstallDeps()` below wires the real ones. */
export interface UninstallDeps {
  /** Removes the OS job whether enabled or disabled (tolerant of it already being absent)
   * and reports whether anything was actually present. */
  unregister(): Promise<boolean>;
  /** Deletes the settings file and reports whether it existed. */
  deleteSettings(): Promise<boolean>;
  print(line: string): void;
}

export async function runUninstall(deps: UninstallDeps): Promise<number> {
  let unregistered: boolean;
  let deleted: boolean;
  try {
    unregistered = await deps.unregister();
    deleted = await deps.deleteSettings();
  } catch (err) {
    deps.print(`Uninstall failed: ${errorMessage(err)}`);
    return 1;
  }

  if (!unregistered && !deleted) {
    deps.print('Nothing to remove: analytics sync is not installed.');
    return 0;
  }

  deps.print('Analytics sync uninstalled.');
  deps.print('  The OS job and the sync settings were removed.');
  deps.print('  The last-sent marker and the run log were kept.');
  return 0;
}

/** Real dependencies for `runUninstall`: the real scheduler and settings store, and
 * `console.log`. */
export function createRealUninstallDeps(): UninstallDeps {
  const scheduler = createScheduler(createRealSchedulerDeps());

  return {
    unregister: () => scheduler.unregister(),
    deleteSettings: () => deleteSyncSettings(),
    print: (line: string): void => {
      console.log(line);
    }
  };
}

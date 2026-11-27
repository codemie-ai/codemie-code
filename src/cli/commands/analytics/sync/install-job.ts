/**
 * The replace of the previous sync job for `runInstall`: what the install is about to replace, snapshotted, the owned
 * jobs unregistered and the new one registered, and the previous settings and jobs put back when the replace fails.
 */
import { DEFAULT_AT, validateAt } from './config-store.js';
import { printFailure } from './install-plan.js';
import { errorMessage } from './redact.js';
import { ownedNames, resolveSchedulerName, validateSchedulerName } from './scheduler/index.js';
import type { JobCommand, RegisterResult, Scheduler } from './scheduler/index.js';
import type { SyncSettings } from './types.js';

/** The side effects of the replace: the part of `runInstall`'s deps it uses. */
interface JobDeps {
  schedulerFor(name: string): Scheduler;
  writeSettings(settings: SyncSettings): Promise<void>;
  deleteSettings(): Promise<boolean>;
  readSettingsRaw(): Promise<string | null>;
  restoreSettingsRaw(raw: string): Promise<void>;
  print(line: string): void;
}

/** An owned job that was enabled before install: its name and the run time it had. */
interface PreviousJob {
  name: string;
  at: string;
}

/** What `install` is about to replace: the settings file as stored and the owned jobs that ran. */
interface PreviousInstall {
  settingsRaw: string | null;
  jobs: PreviousJob[];
  /** Every owned name that was queried — the only names install may unregister. */
  names: string[];
}

/** The saved name in the stored settings, or `undefined` when absent, invalid or unreadable
 * (then only the default name is owned, so no path is built from a bad value). */
export function previousTaskName(settingsRaw: string | null): string | undefined {
  try {
    const taskName = (JSON.parse(settingsRaw ?? '{}') as { taskName?: unknown }).taskName;
    return typeof taskName === 'string' ? validateSchedulerName(taskName) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the install is about to replace: the settings file as stored (`null` when unreadable) and every owned job that
 * is enabled, with the run time of the stored settings, plus the owned names it queried. A query that fails counts
 * as disabled.
 */
export async function snapshotPreviousInstall(deps: JobDeps): Promise<PreviousInstall> {
  const settingsRaw = await deps.readSettingsRaw().catch(() => null);
  const at = previousRunTime(settingsRaw);
  const names = ownedNames({ taskName: previousTaskName(settingsRaw) }, process.platform);
  const jobs: PreviousJob[] = [];
  for (const name of names) {
    const state = await deps.schedulerFor(name).query().catch(() => 'disabled');
    if (state === 'enabled') {
      jobs.push({ name, at });
    }
  }
  return { settingsRaw, jobs, names };
}

function previousRunTime(settingsRaw: string | null): string {
  try {
    const at = (JSON.parse(settingsRaw ?? '{}') as { at?: unknown }).at;
    return validateAt(typeof at === 'string' ? at : undefined);
  } catch {
    return DEFAULT_AT;
  }
}

/**
 * After a failed replace, unregisters the new name, puts back the settings file as stored,
 * and re-registers every job that was enabled before — each under its own name, with its own
 * schedule — then tells the developer which state the machine is in. The jobs are registered
 * as the CLI's own, from the restored settings: a standalone collector's settings are
 * collector-compatible, so its daily delivery carries on.
 */
async function restorePreviousInstall(
  deps: JobDeps,
  previous: PreviousInstall,
  cmd: JobCommand,
  newName: string
): Promise<void> {
  await deps.schedulerFor(newName).unregister().catch(() => undefined);

  if (previous.settingsRaw === null) {
    await deps.deleteSettings().catch(() => undefined);
  } else {
    try {
      await deps.restoreSettingsRaw(previous.settingsRaw);
    } catch (err) {
      deps.print(`Your previous settings could not be restored: ${errorMessage(err)}`);
      deps.print('Daily delivery is stopped on this machine until install succeeds.');
      return;
    }
  }

  if (previous.jobs.length === 0) {
    deps.print(
      previous.settingsRaw === null
        ? 'Nothing was installed.'
        : 'Your previous settings were restored. No daily job was enabled before this install, so none is now.'
    );
    return;
  }

  let failed = false;
  for (const job of previous.jobs) {
    try {
      await deps.schedulerFor(job.name).register(cmd, job.at);
    } catch (err) {
      failed = true;
      deps.print(`Your previous daily job "${job.name}" could not be registered again: ${errorMessage(err)}`);
    }
  }

  if (failed) {
    deps.print('Your previous settings were restored. Daily delivery may be stopped on this machine until install succeeds.');
  } else {
    deps.print(
      `Your previous settings and daily job${previous.jobs.length > 1 ? 's' : ''} ` +
        `(${previous.jobs.map((job) => `${job.name} at ${job.at} local`).join(', ')}) were restored; delivery continues as before.`
    );
  }
}

/**
 * Replaces the OS job and settings with `settings`: unregisters every owned job of `previous`,
 * writes the settings, registers the resolved name with `cmd`. On any failure after an old job
 * was removed, restores the previous settings and jobs ({@link restorePreviousInstall}), so a
 * failed install never silently stops a delivery that used to work. Only names from
 * `ownedNames` are ever queried or touched.
 */
export async function replaceJob(
  deps: JobDeps,
  settings: SyncSettings,
  cmd: JobCommand,
  previous: PreviousInstall
): Promise<RegisterResult | null> {
  const newName = resolveSchedulerName(settings, process.platform);
  try {
    for (const name of previous.names) {
      await deps.schedulerFor(name).unregister();
    }
    await deps.writeSettings(settings);
    return await deps.schedulerFor(newName).register(cmd, settings.at);
  } catch (err) {
    printFailure(deps, err);
    await restorePreviousInstall(deps, previous, cmd, newName);
    return null;
  }
}

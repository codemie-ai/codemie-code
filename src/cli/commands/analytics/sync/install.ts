/**
 * Install runner for `codemie analytics sync install`.
 *
 * Fixed order (spec §Install): validate options -> platform preflight -> resolve the task name
 * and check it does not overwrite a foreign task -> resolve email -> detect the standalone collector -> test-push the git target (if configured) -> unregister
 * any existing job (collector's or a previous CLI install's — same job identities, see
 * `./scheduler/generators.ts`) -> write settings -> register the job -> print the summary.
 * Every side effect is injected via {@link InstallDeps} so tests run without touching the
 * real scheduler, filesystem or a terminal.
 *
 * The git test push proves push access to the configured repository BEFORE anything else is
 * touched: on failure nothing is unregistered, written or registered, and the git target's
 * working copy is removed so a bad clone never lingers. It never requests or stores a token;
 * every printed URL goes through `redactSecrets`.
 *
 * `runInstall` never throws and never calls `process.exit`; every failure path prints a
 * redacted message via `deps.print` and returns a non-zero exit code. It never reads or
 * writes the "last sent" marker (`./marker.ts`) — take-over from the standalone collector
 * keeps that marker exactly as it is, so the next run neither re-sends nor leaves a gap.
 */

import { existsSync } from 'fs';
import { rm } from 'fs/promises';

import { ConfigLoader } from '@/utils/config.js';
import { SyncGitError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import {
  DEFAULT_AT,
  deleteSyncSettings,
  readSyncSettingsRaw,
  restoreSyncSettingsRaw,
  validateAt,
  validateInstallOptions,
  writeSyncSettings
} from './config-store.js';
import { lookbackText, webhookHost } from './format.js';
import { EMAIL_REGEX, realIdentityDeps, resolveSyncIdentity } from './identity.js';
import { errorMessage, redactSecrets } from './redact.js';
import {
  createRealSchedulerDeps,
  createScheduler,
  defaultSchedulerName,
  ownedNames,
  resolveJobCommand,
  resolveSchedulerName,
  sameSchedulerName,
  assertNameSupportedOnPlatform,
  validateSchedulerName
} from './scheduler/index.js';
import type { JobCommand, RegisterResult, Scheduler } from './scheduler/index.js';
import { createGitRunner, gitHint } from './targets/git-client.js';
import { GitTarget, gitWorkingCopyPath } from './targets/git-target.js';
import type { GitSettings, InstallOptions, SyncSettings } from './types.js';

/** Every side effect `runInstall` needs, injected so tests run without a real scheduler, fs
 * or terminal. `createRealInstallDeps()` below wires the real ones. */
export interface InstallDeps {
  /** A scheduler for one job name (see `./scheduler/index.ts`). */
  schedulerFor(name: string): Scheduler;
  writeSettings(settings: SyncSettings): Promise<void>;
  deleteSettings(): Promise<boolean>;
  /** The current settings file as stored, or `null` when there is none. */
  readSettingsRaw(): Promise<string | null>;
  /** Puts back a file returned by `readSettingsRaw`. */
  restoreSettingsRaw(raw: string): Promise<void>;
  /** Config email, then `git config --global user.email` (`./identity.ts`); throws
   * `SyncIdentityMissingError` when neither resolves. */
  resolveIdentity(): Promise<string>;
  isTTY: boolean;
  /** Only called when `isTTY` is true and `resolveIdentity()` throws. */
  promptEmail(): Promise<string>;
  /** Only called when `isTTY` is true and no `--task-name` was given. `defaultName` is the
   * name an empty answer keeps. Returns the raw answer; empty means the default. */
  promptTaskName(defaultName: string): Promise<string>;
  /** Only called when `isTTY` is true, the name was typed at the prompt and a task with that
   * name already exists that this tool does not own. `true` means overwrite it. */
  confirmOverwrite(name: string): Promise<boolean>;
  saveUserEmail(email: string): Promise<void>;
  /** Whether the standalone collector's clone is still present (`~/.codemie/codemie-onboarding`). */
  collectorDirExists(): boolean;
  resolveJobCommand(): Promise<JobCommand>;
  /** Prompt-free test push of a placeholder file into the configured git target, proving
   * push access BEFORE anything is unregistered/written/registered. Only called when
   * `settings.git` is set. Real deps: `new GitTarget(git, email, createGitRunner()).testPush()`. */
  testGitPush(git: GitSettings, email: string): Promise<void>;
  /** Removes the git target's working copy; called when `testGitPush` fails, so a bad clone
   * never lingers. Real deps: `rm(gitWorkingCopyPath(), { recursive: true, force: true })`. */
  removeWorkingCopy(): Promise<void>;
  print(line: string): void;
}

function printSummary(
  deps: InstallDeps,
  settings: SyncSettings,
  email: string,
  collectorPresent: boolean,
  registerResult: RegisterResult
): void {
  deps.print('Analytics sync installed.');
  deps.print(`  Run time:         ${settings.at} local`);
  deps.print(`  Lookback window:  ${lookbackText(settings)}`);
  deps.print(`  Include external: ${settings.includeExternal}`);
  if (settings.webhookUrl !== undefined) {
    deps.print(`  Webhook:          ${webhookHost(settings.webhookUrl)}`);
  }
  if (settings.git !== undefined) {
    deps.print(`  Repository:       ${redactSecrets(settings.git.repoUrl)}`);
    if (settings.git.branch !== undefined) {
      deps.print(`  Branch:           ${settings.git.branch}`);
    }
    if (settings.git.path !== undefined) {
      deps.print(`  Path:             ${settings.git.path}`);
    }
  }
  deps.print(`  Email:            ${email}`);
  deps.print('');
  deps.print('Try it now:   codemie analytics sync run');
  deps.print('Check status: codemie analytics sync status');

  if (collectorPresent) {
    deps.print('');
    deps.print(
      'The standalone collector\'s job was taken over by this install; its last-sent marker ' +
        'was kept. Its folder can be deleted:'
    );
    deps.print(`  ${getCodemiePath('codemie-onboarding')}`);
  }

  if (registerResult.lingerWarning) {
    deps.print('');
    deps.print(`Warning: ${redactSecrets(registerResult.lingerWarning)}`);
  }
}

/**
 * Resolve the email the reports will carry: `deps.resolveIdentity()` first; if that fails and
 * a terminal is attached, prompt and persist it; otherwise return `null` so the caller fails
 * with instructions. Never writes settings or touches the scheduler.
 */
async function resolveInstallEmail(deps: InstallDeps): Promise<string | null> {
  try {
    return await deps.resolveIdentity();
  } catch {
    if (!deps.isTTY) {
      return null;
    }

    const email = await deps.promptEmail();
    await deps.saveUserEmail(email);
    return email;
  }
}

function printFailure(deps: InstallDeps, err: unknown): void {
  deps.print(`Install failed: ${errorMessage(err)}`);
}

/** Same as {@link printFailure}, plus `gitHint(err.gitCause)` naming the likely cause when
 * `err` is a `SyncGitError` (a failed test push). */
function printGitFailure(deps: InstallDeps, err: unknown): void {
  printFailure(deps, err);
  if (err instanceof SyncGitError) {
    deps.print(gitHint(err.gitCause));
  }
}

/** Validate the options and run the platform preflight; `null` (after printing why) on failure. */
async function prepareSettings(opts: InstallOptions, deps: InstallDeps): Promise<SyncSettings | null> {
  try {
    const settings = validateInstallOptions(opts);
    await deps.schedulerFor(defaultSchedulerName(process.platform)).preflight();
    return settings;
  } catch (err) {
    printFailure(deps, err);
    return null;
  }
}

/** Resolve the report email for install; `null` (after printing why) on failure. */
async function resolveEmailOrReport(deps: InstallDeps): Promise<string | null> {
  try {
    const email = await resolveInstallEmail(deps);
    if (email === null) {
      deps.print(
        'No email is configured for analytics sync, and no terminal is attached to ask for one.\n' +
          'Set one with `git config --global user.email <email>`, or run `codemie analytics sync install` ' +
          'again in a terminal to be prompted.\n' +
          'Nothing was registered.'
      );
    }
    return email;
  } catch (err) {
    printFailure(deps, err);
    return null;
  }
}

/**
 * When `settings.git` is configured, proves push access with a prompt-free test push before
 * anything else is touched (spec AC2). Returns `true` (no-op) for a webhook-only install.
 * On failure: prints the redacted message plus `gitHint(err.gitCause)` when the test push
 * threw a `SyncGitError`, removes the working copy (its own failure never masks the test
 * push's), and returns `false` — the caller stops before unregister/write/register.
 */
async function testGitTarget(deps: InstallDeps, settings: SyncSettings, email: string): Promise<boolean> {
  if (settings.git === undefined) {
    return true;
  }

  try {
    await deps.testGitPush(settings.git, email);
    return true;
  } catch (err) {
    printGitFailure(deps, err);
    await deps.removeWorkingCopy().catch(() => undefined);
    return false;
  }
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
function previousTaskName(settingsRaw: string | null): string | undefined {
  try {
    const taskName = (JSON.parse(settingsRaw ?? '{}') as { taskName?: unknown }).taskName;
    return typeof taskName === 'string' ? validateSchedulerName(taskName) : undefined;
  } catch {
    return undefined;
  }
}

async function snapshotPreviousInstall(deps: InstallDeps): Promise<PreviousInstall> {
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
  deps: InstallDeps,
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
 * Replaces the OS job and settings with `settings`: unregisters every owned job found, writes
 * the settings, registers the resolved name. On any failure after an old job was removed,
 * restores the previous settings and jobs ({@link restorePreviousInstall}), so a failed
 * install never silently stops a delivery that used to work. Only names from `ownedNames` are
 * ever queried or touched.
 */
async function replaceJob(deps: InstallDeps, settings: SyncSettings): Promise<RegisterResult | null> {
  let cmd: JobCommand;
  try {
    cmd = await deps.resolveJobCommand();
  } catch (err) {
    printFailure(deps, err);
    deps.print('Nothing was changed.');
    return null;
  }

  const newName = resolveSchedulerName(settings, process.platform);
  const previous = await snapshotPreviousInstall(deps);
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

/** Where the install's task name came from: the `--task-name` flag, an answer typed at the
 * prompt, or nothing (the platform default). */
type TaskNameSource = 'flag' | 'prompt' | 'default';

interface ResolvedTaskName {
  settings: SyncSettings;
  source: TaskNameSource;
}

/** Drops `taskName` when it is the platform default, so default installs store nothing. */
function withoutDefaultName(settings: SyncSettings): SyncSettings {
  const defaultName = defaultSchedulerName(process.platform);
  if (settings.taskName === undefined || !sameSchedulerName(settings.taskName, defaultName, process.platform)) {
    return settings;
  }
  const { taskName: _default, ...rest } = settings;
  return rest;
}

/** The name to install with: `--task-name` (already in `settings`), else on a terminal the
 * prompt's answer (empty keeps the default), else the default. Throws `SyncConfigError` on an
 * invalid answer or a name this OS cannot use. */
async function resolveTaskName(opts: InstallOptions, settings: SyncSettings, deps: InstallDeps): Promise<ResolvedTaskName> {
  let resolved: ResolvedTaskName = { settings, source: opts.taskName !== undefined ? 'flag' : 'default' };

  if (opts.taskName === undefined && deps.isTTY) {
    const answer = (await deps.promptTaskName(defaultSchedulerName(process.platform))).trim();
    if (answer !== '') {
      resolved = { settings: { ...settings, taskName: validateSchedulerName(answer) }, source: 'prompt' };
    }
  }

  const normalized = withoutDefaultName(resolved.settings);
  if (normalized.taskName === undefined) {
    return { settings: normalized, source: 'default' };
  }
  assertNameSupportedOnPlatform(normalized.taskName, process.platform);
  return { settings: normalized, source: resolved.source };
}

/**
 * Before anything is removed: when the chosen name is neither the previously saved name nor
 * the platform default, checks whether a scheduler task with that name already exists (enabled
 * or not). An existing foreign task, or one whose presence cannot be determined, is only
 * replaced on `--force` or after an interactive yes (name typed at the prompt). Returns
 * `true` to proceed; `false` (after printing why) leaves everything untouched.
 */
async function confirmNameAvailable(
  opts: InstallOptions,
  resolved: ResolvedTaskName,
  deps: InstallDeps
): Promise<boolean> {
  const name = resolved.settings.taskName;
  if (name === undefined) {
    return true;
  }

  const saved = previousTaskName(await deps.readSettingsRaw().catch(() => null));
  if (saved !== undefined && sameSchedulerName(name, saved, process.platform)) {
    return true;
  }

  const presence = await deps.schedulerFor(name).exists().catch(() => 'unknown' as const);
  if (presence === 'absent') {
    return true;
  }

  const warning =
    presence === 'present'
      ? `The following task already exists and will be deleted and overwritten by this one: ${name}`
      : `Could not check whether a scheduler task named "${name}" already exists; if it does, it will be deleted and overwritten by this one.`;
  deps.print(warning);

  if (opts.force === true) {
    return true;
  }

  if (resolved.source === 'prompt' && deps.isTTY) {
    if (await deps.confirmOverwrite(name)) {
      return true;
    }
    deps.print(`Install cancelled. The task "${name}" was not changed. Nothing was changed.`);
    return false;
  }

  deps.print('Re-run with --force to overwrite it.');
  deps.print('Nothing was changed.');
  return false;
}

export async function runInstall(opts: InstallOptions, deps: InstallDeps): Promise<number> {
  const validated = await prepareSettings(opts, deps);
  if (validated === null) {
    return 1;
  }

  let settings: SyncSettings;
  try {
    const resolved = await resolveTaskName(opts, validated, deps);
    if (!(await confirmNameAvailable(opts, resolved, deps))) {
      return 1;
    }
    settings = resolved.settings;
  } catch (err) {
    printFailure(deps, err);
    return 1;
  }

  const email = await resolveEmailOrReport(deps);
  if (email === null) {
    return 1;
  }

  const collectorPresent = deps.collectorDirExists();

  if (!(await testGitTarget(deps, settings, email))) {
    return 1;
  }

  const registerResult = await replaceJob(deps, settings);
  if (registerResult === null) {
    return 1;
  }

  printSummary(deps, settings, email, collectorPresent, registerResult);
  return 0;
}

/** Real dependencies for `runInstall`: the real scheduler, settings store, identity
 * resolution, an inquirer email prompt, `ConfigLoader.saveUserEmail`, the real collector-dir
 * check and job command, and `console.log`. */
export function createRealInstallDeps(): InstallDeps {
  return {
    schedulerFor: (name: string) => createScheduler(createRealSchedulerDeps(), name),
    writeSettings: (settings: SyncSettings) => writeSyncSettings(settings),
    deleteSettings: () => deleteSyncSettings(),
    readSettingsRaw: () => readSyncSettingsRaw(),
    restoreSettingsRaw: (raw: string) => restoreSyncSettingsRaw(raw),
    resolveIdentity: () => resolveSyncIdentity(realIdentityDeps),
    isTTY: Boolean(process.stdin.isTTY),
    promptEmail: async (): Promise<string> => {
      const inquirer = (await import('inquirer')).default;
      const { email } = await inquirer.prompt<{ email: string }>([
        {
          type: 'input',
          name: 'email',
          message: 'Enter the email address your analytics reports will carry:',
          validate: (value: string) => EMAIL_REGEX.test(value.trim()) || 'Please enter a valid email address'
        }
      ]);
      return email.trim();
    },
    promptTaskName: async (defaultName: string): Promise<string> => {
      const inquirer = (await import('inquirer')).default;
      const { taskName } = await inquirer.prompt<{ taskName: string }>([
        {
          type: 'input',
          name: 'taskName',
          message: `Scheduler task name (Enter for default "${defaultName}"):`,
          validate: (value: string) => {
            if (value.trim() === '') return true;
            try {
              assertNameSupportedOnPlatform(validateSchedulerName(value.trim()), process.platform);
              return true;
            } catch (err) {
              return errorMessage(err);
            }
          }
        }
      ]);
      return taskName.trim();
    },
    confirmOverwrite: async (name: string): Promise<boolean> => {
      const inquirer = (await import('inquirer')).default;
      const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
        {
          type: 'confirm',
          name: 'overwrite',
          message: `A task named "${name}" already exists and will be deleted and overwritten. Continue?`,
          default: false
        }
      ]);
      return overwrite;
    },
    saveUserEmail: (email: string) => ConfigLoader.saveUserEmail(email),
    collectorDirExists: () => existsSync(getCodemiePath('codemie-onboarding')),
    resolveJobCommand,
    testGitPush: (git: GitSettings, email: string) => new GitTarget(git, email, createGitRunner()).testPush(),
    removeWorkingCopy: () => rm(gitWorkingCopyPath(), { recursive: true, force: true }),
    print: (line: string): void => {
      console.log(line);
    }
  };
}

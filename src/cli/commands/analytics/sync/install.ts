/**
 * Install runner for `codemie analytics sync install`.
 *
 * Fixed order (spec §Install): validate options -> platform preflight -> resolve email ->
 * detect the standalone collector -> test-push the git target (if configured) -> unregister
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
import { createRealSchedulerDeps, createScheduler, resolveJobCommand } from './scheduler/index.js';
import type { JobCommand, RegisterResult, Scheduler } from './scheduler/index.js';
import { createGitRunner, gitHint } from './targets/git-client.js';
import { GitTarget, gitWorkingCopyPath } from './targets/git-target.js';
import type { GitSettings, InstallOptions, SyncSettings } from './types.js';

/** Every side effect `runInstall` needs, injected so tests run without a real scheduler, fs
 * or terminal. `createRealInstallDeps()` below wires the real ones. */
export interface InstallDeps {
  scheduler: Scheduler;
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
    await deps.scheduler.preflight();
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

/** What `install` is about to replace: the settings file as stored and whether a job ran. */
interface PreviousInstall {
  settingsRaw: string | null;
  jobEnabled: boolean;
  /** The previous run time, or the default when the old file names none (or is unreadable). */
  at: string;
}

async function snapshotPreviousInstall(deps: InstallDeps): Promise<PreviousInstall> {
  const settingsRaw = await deps.readSettingsRaw().catch(() => null);
  const jobEnabled = (await deps.scheduler.query().catch(() => 'disabled')) === 'enabled';
  return { settingsRaw, jobEnabled, at: previousRunTime(settingsRaw) };
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
 * After a failed replace, puts back what was there before it — the settings file as stored,
 * and a daily job when one was enabled — and tells the developer which state the machine is
 * in. The job is re-registered as the CLI's own, from the restored settings: a standalone
 * collector's settings are collector-compatible, so its daily delivery carries on.
 */
async function restorePreviousInstall(deps: InstallDeps, previous: PreviousInstall, cmd: JobCommand): Promise<void> {
  await deps.scheduler.unregister().catch(() => undefined);

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

  if (!previous.jobEnabled) {
    deps.print(
      previous.settingsRaw === null
        ? 'Nothing was installed.'
        : 'Your previous settings were restored. No daily job was enabled before this install, so none is now.'
    );
    return;
  }

  try {
    await deps.scheduler.register(cmd, previous.at);
    deps.print(`Your previous settings and daily job (${previous.at} local) were restored; delivery continues as before.`);
  } catch (err) {
    deps.print(`Your previous settings were restored, but the daily job could not be registered again: ${errorMessage(err)}`);
    deps.print('Daily delivery is stopped on this machine until install succeeds.');
  }
}

/**
 * Replaces the OS job and settings with `settings`. On any failure after the old job was
 * removed, restores the previous settings and job ({@link restorePreviousInstall}), so a
 * failed install never silently stops a delivery that used to work.
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

  const previous = await snapshotPreviousInstall(deps);
  try {
    await deps.scheduler.unregister();
    await deps.writeSettings(settings);
    return await deps.scheduler.register(cmd, settings.at);
  } catch (err) {
    printFailure(deps, err);
    await restorePreviousInstall(deps, previous, cmd);
    return null;
  }
}

export async function runInstall(opts: InstallOptions, deps: InstallDeps): Promise<number> {
  const settings = await prepareSettings(opts, deps);
  if (settings === null) {
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
    scheduler: createScheduler(createRealSchedulerDeps()),
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

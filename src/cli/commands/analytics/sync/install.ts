/**
 * Install runner for `codemie analytics sync install`.
 *
 * Fixed order (spec §Install): validate options -> platform preflight -> resolve email ->
 * detect the standalone collector -> unregister any existing job (collector's or a previous
 * CLI install's — same job identities, see `./scheduler/generators.ts`) -> write settings ->
 * register the job -> print the summary. Every side effect is injected via {@link InstallDeps}
 * so tests run without touching the real scheduler, filesystem or a terminal.
 *
 * `runInstall` never throws and never calls `process.exit`; every failure path prints a
 * redacted message via `deps.print` and returns a non-zero exit code. It never reads or
 * writes the "last sent" marker (`./marker.ts`) — take-over from the standalone collector
 * keeps that marker exactly as it is, so the next run neither re-sends nor leaves a gap.
 */

import { existsSync } from 'fs';

import { ConfigLoader } from '@/utils/config.js';
import { getCodemiePath } from '@/utils/paths.js';

import { deleteSyncSettings, validateInstallOptions, writeSyncSettings } from './config-store.js';
import { lookbackText, webhookHost } from './format.js';
import { EMAIL_REGEX, realIdentityDeps, resolveSyncIdentity } from './identity.js';
import { errorMessage, redactSecrets } from './redact.js';
import { createRealSchedulerDeps, createScheduler, resolveJobCommand } from './scheduler/index.js';
import type { JobCommand, RegisterResult, Scheduler } from './scheduler/index.js';
import type { InstallOptions, SyncSettings } from './types.js';

/** Every side effect `runInstall` needs, injected so tests run without a real scheduler, fs
 * or terminal. `createRealInstallDeps()` below wires the real ones. */
export interface InstallDeps {
  scheduler: Scheduler;
  writeSettings(settings: SyncSettings): Promise<void>;
  deleteSettings(): Promise<boolean>;
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
  deps.print(`  Webhook:          ${webhookHost(settings.webhookUrl)}`);
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
 * Replace any existing job with a fresh one: unregister (same job identities as the standalone
 * collector, see ./scheduler/generators.ts, so this removes either the collector's job or a
 * previous CLI install's — tolerant of neither existing), write settings, register. A register
 * failure rolls back both the job files written before the failing OS call and the settings,
 * so nothing half-installed is left; a rollback failure never masks the register error.
 * Returns `null` (after printing why) on any failure.
 */
async function replaceJob(deps: InstallDeps, settings: SyncSettings): Promise<RegisterResult | null> {
  try {
    await deps.scheduler.unregister();
    await deps.writeSettings(settings);
  } catch (err) {
    printFailure(deps, err);
    return null;
  }

  try {
    const cmd = await deps.resolveJobCommand();
    return await deps.scheduler.register(cmd, settings.at);
  } catch (err) {
    await deps.scheduler.unregister().catch(() => undefined);
    await deps.deleteSettings().catch(() => undefined);
    printFailure(deps, err);
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
    print: (line: string): void => {
      console.log(line);
    }
  };
}

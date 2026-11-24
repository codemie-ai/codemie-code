/**
 * Thin register/unregister/query wiring around the pure generators in `./generators.ts`.
 *
 * Talks to the OS scheduler (`launchctl`, `systemctl --user` + `loginctl`, `schtasks`) through
 * an injected `exec` and a minimal async `fs` surface, so tests run against fakes and never
 * touch the real home directory or a real scheduler. Nothing here reads `process.platform`,
 * `os.homedir()`, `process.getuid()` or `os.userInfo()` directly — all of it comes through
 * `SchedulerDeps`, which the caller (install/status/uninstall, tasks 5-6) wires to the real
 * values.
 */

import { dirname, join } from 'path';
import { homedir as osHomedir, tmpdir, userInfo } from 'os';
import { access, mkdir, rm, writeFile } from 'fs/promises';

import { exec as realExec, type ExecResult } from '@/utils/exec.js';
import { SyncSchedulerRegisterError, SyncSchedulerUnsupportedError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  launchdPlist,
  systemdUnits,
  taskSchedulerXml,
  type JobCommand
} from './generators.js';

export { assertNameSupportedOnPlatform, resolveJobCommand, validateSchedulerName } from './generators.js';

/** Settings shape the name resolver needs (a subset of `SyncSettings`). */
export interface SchedulerNameSettings {
  taskName?: string;
}

/** The default scheduler job name for a platform: launchd label, systemd unit base name, or Windows task name. */
export function defaultSchedulerName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return LAUNCHD_LABEL;
  if (platform === 'win32') return WINDOWS_TASK_NAME;
  return SYSTEMD_UNIT_NAME;
}

/** Scheduler job name for the saved settings: the saved full name, or the platform default. */
export function resolveSchedulerName(settings: SchedulerNameSettings, platform: NodeJS.Platform): string {
  return settings.taskName ?? defaultSchedulerName(platform);
}

/** Whether two job names are the same job on `platform` (launchd and Task Scheduler names are
 * case-insensitive in practice; systemd unit names are case-sensitive). */
export function sameSchedulerName(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** Names this installation owns on the platform: the saved name plus the default, de-duplicated. */
export function ownedNames(settings: SchedulerNameSettings, platform: NodeJS.Platform): string[] {
  return [...new Set([resolveSchedulerName(settings, platform), defaultSchedulerName(platform)])];
}
export type { JobCommand } from './generators.js';

/** The minimal async fs surface the scheduler needs — a builder's choice, kept small so
 * tests can fake it without touching the real filesystem. */
export interface SchedulerFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding }): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  /** Whether `path` exists (any file type). */
  exists(path: string): Promise<boolean>;
}

export interface SchedulerDeps {
  platform: NodeJS.Platform;
  exec: typeof realExec;
  homedir(): string;
  /** Numeric UID, used for the darwin `gui/<uid>/<label>` launchd domain target. */
  uid(): number;
  /** OS username, used for `loginctl enable-linger <user>` — injected rather than read from
   * `$USER`/`os.userInfo()` directly here, so tests control it. */
  username(): string;
  /** Waits `ms` — injected so tests do not actually wait on the launchd bootstrap retry. */
  sleep(ms: number): Promise<void>;
  fs: SchedulerFs;
}

export interface RegisterResult {
  /** Set (never thrown) when Linux `loginctl enable-linger` fails — the job is still
   * registered; the caller surfaces this as a warning. */
  lingerWarning?: string;
}

export type JobState = 'enabled' | 'disabled';

/** Whether a scheduler task with a name exists, enabled or not. `unknown` means the check
 * itself failed, so the task may or may not be there. */
export type TaskPresence = 'present' | 'absent' | 'unknown';

export interface Scheduler {
  preflight(): Promise<void>;
  register(cmd: JobCommand, at: string): Promise<RegisterResult>;
  unregister(): Promise<boolean>;
  query(): Promise<JobState>;
  /** Whether a task with this name exists (enabled or disabled); errors yield `unknown`. */
  exists(): Promise<TaskPresence>;
}

const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux', 'win32'];

function darwinDomainTarget(deps: SchedulerDeps, name: string): string {
  return `gui/${deps.uid()}/${name}`;
}

function darwinPlistPath(deps: SchedulerDeps, name: string): string {
  return join(deps.homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
}

function linuxUnitDir(deps: SchedulerDeps): string {
  return join(deps.homedir(), '.config', 'systemd', 'user');
}

function linuxServicePath(deps: SchedulerDeps, name: string): string {
  return join(linuxUnitDir(deps), `${name}.service`);
}

function linuxTimerUnit(name: string): string {
  return `${name}.timer`;
}

function linuxTimerPath(deps: SchedulerDeps, name: string): string {
  return join(linuxUnitDir(deps), linuxTimerUnit(name));
}

/** Temp file schtasks reads the task XML from. Not injected: it is write-then-read within
 * a single `register()` call and the real OS tmpdir is always writable. */
function windowsTaskXmlPath(): string {
  return join(tmpdir(), 'codemie-analytics-sync-task.xml');
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function commandOutput(result: ExecResult): string {
  return result.stderr || result.stdout;
}

/** Run an OS command and report whether it exited 0; a spawn failure counts as "no". */
async function succeeded(deps: SchedulerDeps, command: string, args: string[]): Promise<boolean> {
  try {
    return (await deps.exec(command, args)).code === 0;
  } catch {
    return false;
  }
}

/** Remove `path`, reporting whether it existed (no `force`, so a missing file rejects). */
async function removeFile(deps: SchedulerDeps, path: string): Promise<boolean> {
  try {
    await deps.fs.rm(path);
    return true;
  } catch {
    return false;
  }
}

function unsupported(platform: NodeJS.Platform): SyncSchedulerUnsupportedError {
  return new SyncSchedulerUnsupportedError(
    `codemie analytics sync install is not supported on platform "${platform}".`
  );
}

async function preflight(deps: SchedulerDeps): Promise<void> {
  if (!SUPPORTED_PLATFORMS.includes(deps.platform)) {
    throw unsupported(deps.platform);
  }
  if (deps.platform !== 'linux') {
    return;
  }

  try {
    const result = await deps.exec('systemctl', ['--user', 'show-environment']);
    if (result.code !== 0) {
      throw new Error(commandOutput(result) || `exit code ${result.code}`);
    }
  } catch (err) {
    throw new SyncSchedulerUnsupportedError(
      `systemd --user is not reachable: ${errorDetail(err)}. ` +
        'This usually means the session has no user D-Bus/systemd (e.g. a non-interactive SSH session).'
    );
  }
}

/** Delay before retrying `launchctl bootstrap`: `bootout` finishes asynchronously, and an
 * immediate bootstrap of the same label can fail with "5: Input/output error". */
const BOOTSTRAP_RETRY_DELAY_MS = 1000;

async function registerDarwin(deps: SchedulerDeps, name: string, cmd: JobCommand, at: string): Promise<RegisterResult> {
  const plistPath = darwinPlistPath(deps, name);
  // launchd opens StandardOutPath itself and fails silently when its directory is missing.
  const launchdLogPath = getCodemiePath('logs', 'analytics-sync.launchd.log');
  await deps.fs.mkdir(dirname(launchdLogPath), { recursive: true });
  await deps.fs.mkdir(dirname(plistPath), { recursive: true });
  await deps.fs.writeFile(plistPath, launchdPlist(cmd, at, launchdLogPath, name), { encoding: 'utf-8' });

  // Tolerates "not loaded" (and any other failure) — a prior job may not exist.
  await deps.exec('launchctl', ['bootout', darwinDomainTarget(deps, name)]).catch(() => undefined);

  const bootstrapArgs = ['bootstrap', `gui/${deps.uid()}`, plistPath];
  let bootstrap = await deps.exec('launchctl', bootstrapArgs);
  if (bootstrap.code !== 0) {
    await deps.sleep(BOOTSTRAP_RETRY_DELAY_MS);
    bootstrap = await deps.exec('launchctl', bootstrapArgs);
  }
  if (bootstrap.code !== 0) {
    const output = commandOutput(bootstrap);
    throw new SyncSchedulerRegisterError(`launchctl bootstrap failed: ${output}`, output);
  }

  return {};
}

async function enableLinger(deps: SchedulerDeps): Promise<RegisterResult> {
  try {
    const linger = await deps.exec('loginctl', ['enable-linger', deps.username()]);
    return linger.code === 0 ? {} : { lingerWarning: `loginctl enable-linger failed: ${commandOutput(linger)}` };
  } catch (err) {
    return { lingerWarning: `loginctl enable-linger failed: ${errorDetail(err)}` };
  }
}

async function registerLinux(deps: SchedulerDeps, name: string, cmd: JobCommand, at: string): Promise<RegisterResult> {
  await deps.fs.mkdir(linuxUnitDir(deps), { recursive: true });
  const { service, timer } = systemdUnits(cmd, at);
  await deps.fs.writeFile(linuxServicePath(deps, name), service, { encoding: 'utf-8' });
  await deps.fs.writeFile(linuxTimerPath(deps, name), timer, { encoding: 'utf-8' });

  const daemonReload = await deps.exec('systemctl', ['--user', 'daemon-reload']);
  if (daemonReload.code !== 0) {
    const output = commandOutput(daemonReload);
    throw new SyncSchedulerRegisterError(`systemctl --user daemon-reload failed: ${output}`, output);
  }

  const enableNow = await deps.exec('systemctl', ['--user', 'enable', '--now', linuxTimerUnit(name)]);
  if (enableNow.code !== 0) {
    const output = commandOutput(enableNow);
    throw new SyncSchedulerRegisterError(`systemctl --user enable --now failed: ${output}`, output);
  }

  return enableLinger(deps);
}

async function registerWindows(deps: SchedulerDeps, name: string, cmd: JobCommand, at: string): Promise<RegisterResult> {
  const xmlPath = windowsTaskXmlPath();
  const xml = taskSchedulerXml(cmd, at);
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  await deps.fs.writeFile(xmlPath, withBom);

  // Tolerates the task not existing yet.
  await deps.exec('schtasks', ['/Delete', '/F', '/TN', name]).catch(() => undefined);

  const create = await deps.exec('schtasks', ['/Create', '/XML', xmlPath, '/TN', name, '/F']);
  if (create.code !== 0) {
    const output = commandOutput(create);
    throw new SyncSchedulerRegisterError(`schtasks /Create failed: ${output}`, output);
  }

  return {};
}

async function register(deps: SchedulerDeps, name: string, cmd: JobCommand, at: string): Promise<RegisterResult> {
  switch (deps.platform) {
    case 'darwin':
      return registerDarwin(deps, name, cmd, at);
    case 'linux':
      return registerLinux(deps, name, cmd, at);
    case 'win32':
      return registerWindows(deps, name, cmd, at);
    default:
      throw unsupported(deps.platform);
  }
}

async function queryDarwin(deps: SchedulerDeps, name: string): Promise<JobState> {
  return (await succeeded(deps, 'launchctl', ['print', darwinDomainTarget(deps, name)])) ? 'enabled' : 'disabled';
}

async function queryLinux(deps: SchedulerDeps, name: string): Promise<JobState> {
  try {
    const result = await deps.exec('systemctl', ['--user', 'is-enabled', linuxTimerUnit(name)]);
    return result.stdout.trim() === 'enabled' ? 'enabled' : 'disabled';
  } catch {
    return 'disabled';
  }
}

async function queryWindows(deps: SchedulerDeps, name: string): Promise<JobState> {
  try {
    const result = await deps.exec('schtasks', ['/Query', '/TN', name, '/FO', 'LIST', '/V']);
    if (result.code !== 0) {
      return 'disabled';
    }
    return /Status:\s*Disabled/i.test(result.stdout) ? 'disabled' : 'enabled';
  } catch {
    return 'disabled';
  }
}

async function query(deps: SchedulerDeps, name: string): Promise<JobState> {
  switch (deps.platform) {
    case 'darwin':
      return queryDarwin(deps, name);
    case 'linux':
      return queryLinux(deps, name);
    case 'win32':
      return queryWindows(deps, name);
    default:
      return 'disabled';
  }
}

/** systemd states `is-enabled` prints for a unit file that exists, enabled or not. */
const SYSTEMD_KNOWN_STATES = new Set([
  'enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime',
  'static', 'indirect', 'disabled', 'generated', 'transient', 'bad'
]);

async function existsDarwin(deps: SchedulerDeps, name: string): Promise<TaskPresence> {
  try {
    if ((await deps.exec('launchctl', ['print', darwinDomainTarget(deps, name)])).code === 0) {
      return 'present';
    }
    return (await deps.fs.exists(darwinPlistPath(deps, name))) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

async function existsLinux(deps: SchedulerDeps, name: string): Promise<TaskPresence> {
  try {
    if ((await deps.fs.exists(linuxServicePath(deps, name))) || (await deps.fs.exists(linuxTimerPath(deps, name)))) {
      return 'present';
    }
    const result = await deps.exec('systemctl', ['--user', 'is-enabled', linuxTimerUnit(name)]);
    if (result.code === 0 || SYSTEMD_KNOWN_STATES.has(result.stdout.trim())) {
      return 'present';
    }
    return /no such file|not found|does not exist/i.test(commandOutput(result)) ? 'absent' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Matches the first CSV field (`"\\Task Name"`) of each `schtasks /Query /FO CSV /NH` line. */
const SCHTASKS_FIRST_FIELD = /^"((?:[^"]|"")*)"/;

async function existsWindows(deps: SchedulerDeps, name: string): Promise<TaskPresence> {
  try {
    // The full listing is locale-independent, unlike the error text of `/Query /TN <name>`.
    const result = await deps.exec('schtasks', ['/Query', '/FO', 'CSV', '/NH']);
    if (result.code !== 0) {
      return 'unknown';
    }
    const wanted = `\\${name}`.toLowerCase();
    const found = result.stdout.split(/\r?\n/).some((line) => {
      const field = SCHTASKS_FIRST_FIELD.exec(line.trim())?.[1]?.replace(/""/g, '"');
      return field !== undefined && field.toLowerCase() === wanted;
    });
    return found ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

async function exists(deps: SchedulerDeps, name: string): Promise<TaskPresence> {
  switch (deps.platform) {
    case 'darwin':
      return existsDarwin(deps, name);
    case 'linux':
      return existsLinux(deps, name);
    case 'win32':
      return existsWindows(deps, name);
    default:
      return 'unknown';
  }
}

async function unregisterDarwin(deps: SchedulerDeps, name: string): Promise<boolean> {
  const bootedOut = await succeeded(deps, 'launchctl', ['bootout', darwinDomainTarget(deps, name)]);
  const plistRemoved = await removeFile(deps, darwinPlistPath(deps, name));
  return bootedOut || plistRemoved;
}

async function unregisterLinux(deps: SchedulerDeps, name: string): Promise<boolean> {
  // Disable whatever state the timer is in (enabled, or disabled outside the CLI).
  const disabled = await succeeded(deps, 'systemctl', ['--user', 'disable', '--now', linuxTimerUnit(name)]);
  const serviceRemoved = await removeFile(deps, linuxServicePath(deps, name));
  const timerRemoved = await removeFile(deps, linuxTimerPath(deps, name));
  if (serviceRemoved || timerRemoved) {
    await succeeded(deps, 'systemctl', ['--user', 'daemon-reload']);
  }
  return disabled || serviceRemoved || timerRemoved;
}

async function unregisterWindows(deps: SchedulerDeps, name: string): Promise<boolean> {
  // Deletes the task whether it is enabled or was disabled outside the CLI.
  return succeeded(deps, 'schtasks', ['/Delete', '/F', '/TN', name]);
}

/** Remove the job regardless of its enabled state; `true` when anything was actually present
 * (a loaded/registered job or its files), `false` when there was nothing to remove. */
async function unregister(deps: SchedulerDeps, name: string): Promise<boolean> {
  switch (deps.platform) {
    case 'darwin':
      return unregisterDarwin(deps, name);
    case 'linux':
      return unregisterLinux(deps, name);
    case 'win32':
      return unregisterWindows(deps, name);
    default:
      return false;
  }
}

export function createScheduler(deps: SchedulerDeps, name: string): Scheduler {
  return {
    preflight: () => preflight(deps),
    register: (cmd: JobCommand, at: string) => register(deps, name, cmd, at),
    unregister: () => unregister(deps, name),
    query: () => query(deps, name),
    exists: () => exists(deps, name)
  };
}

/**
 * Real {@link SchedulerDeps} wired to the actual process/OS — `process.platform`, the real
 * `exec`, `os.homedir()`, a `process.getuid` fallback (absent on Windows, hence `?? 0` — the
 * value is unused there since only the darwin branch reads `uid()`), `os.userInfo().username`
 * and `fs/promises`. Used by `install`/`status`/`uninstall`'s real-deps factories; tests
 * inject their own fakes instead.
 */
export function createRealSchedulerDeps(): SchedulerDeps {
  return {
    platform: process.platform,
    exec: realExec,
    homedir: () => osHomedir(),
    uid: () => process.getuid?.() ?? 0,
    username: () => userInfo().username,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    fs: {
      mkdir,
      writeFile,
      rm,
      exists: (path: string) => access(path).then(() => true, () => false)
    }
  };
}

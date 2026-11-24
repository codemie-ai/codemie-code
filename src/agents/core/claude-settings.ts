/**
 * Claude Code's own settings files: where each layer lives on this platform and how one layer, the managed
 * `managed-settings.d` drop-ins and the macOS managed plist are read. Shared by every plugin that needs
 * Claude's settings (analytics evidence, the cloud-provider settings check); it reads only and never writes.
 */
import { access, readFile, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, posix } from 'node:path';
import { resolveHomeDir } from '@/utils/paths.js';
import { exec } from '@/utils/exec.js';
import { CodeMieError } from '@/utils/errors.js';

/**
 * Enterprise managed settings, highest precedence; only the file Claude Code reads on this platform. Claude Code
 * itself uses these fixed folders: on Windows always `C:\Program Files\ClaudeCode` (not `%ProgramFiles%`, and
 * no longer `C:\ProgramData\ClaudeCode`), so a policy placed anywhere else does not apply to it either.
 */
export function managedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return ['C:/Program Files/ClaudeCode/managed-settings.json'];
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

/** Settings layers, lowest to highest precedence (later wins): user, project, local, managed. */
export function settingsLayerPaths(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const projectDir = env.CLAUDE_PROJECT_DIR?.trim() || cwd;
  const userDir = env.CLAUDE_CONFIG_DIR?.trim() || resolveHomeDir('.claude');
  return [
    join(userDir, 'settings.json'),
    join(projectDir, '.claude', 'settings.json'),
    join(projectDir, '.claude', 'settings.local.json'),
    ...managedSettingsPaths(platform),
  ];
}

export type SettingsLayerState = 'absent' | 'malformed' | 'unreadable' | 'ok';

export interface SettingsLayerResult {
  path: string;
  /** absent: no file; malformed: not valid JSON, or a root that is not an object; unreadable: I/O error; ok: parsed. */
  state: SettingsLayerState;
  /** Set only when `state` is 'ok'. */
  parsed?: Record<string, unknown>;
}

/** A JSON value Claude Code accepts as a settings object: a plain object, not null or an array. */
function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Reads one of Claude Code's own JSON settings files (strict JSON; the VS Code file is JSONC and is read elsewhere). */
export async function readSettingsLayer(file: string): Promise<SettingsLayerResult> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    return { path: file, state: isMissing(err) ? 'absent' : 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path: file, state: 'malformed' };
  }
  if (!isSettingsObject(parsed)) {
    // Valid JSON that is not a settings object holds no settings at all: as malformed as broken JSON.
    return { path: file, state: 'malformed' };
  }
  return { path: file, state: 'ok', parsed };
}

/** `managed-settings.d` directories, one beside each managed-settings.json of the platform. */
export function managedDropInDirs(platform: NodeJS.Platform): string[] {
  return managedSettingsPaths(platform).map((file) => `${posix.dirname(file)}/managed-settings.d`);
}

/**
 * Managed drop-in files (`managed-settings.d/*.json`), each directory in name order. A missing directory yields
 * nothing; a directory that exists but cannot be listed yields one 'unreadable' result for the directory itself.
 * `dropInDirs` replaces the platform default (tests inject a tmp dir).
 */
export async function readManagedDropIns(
  platform: NodeJS.Platform = process.platform,
  dropInDirs: string[] = managedDropInDirs(platform)
): Promise<SettingsLayerResult[]> {
  const results: SettingsLayerResult[] = [];
  for (const dir of dropInDirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (!isMissing(err)) results.push({ path: dir, state: 'unreadable' });
      continue;
    }
    // Same selection as Claude Code: `.json` files, hidden files (a leading dot) left out, in name order.
    const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    for (const name of files) results.push(await readSettingsLayer(join(dir, name)));
  }
  return results;
}

/** Result of one external command; a runner rejects when the command cannot start or is killed. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/** Upper bound for one managed-source query; a timeout reads as "cannot tell". */
export const MANAGED_QUERY_TIMEOUT_MS = 2500;

/** Default runner: the shared exec helper with the managed-query timeout. */
export const defaultCommandRunner: CommandRunner = (command, args) =>
  exec(command, args, { timeout: MANAGED_QUERY_TIMEOUT_MS });

export interface ManagedReaderOptions {
  timeoutMs?: number;
}

/** macOS managed-preferences domain Claude Code reads its MDM policy from. */
export const MANAGED_PLIST_DOMAIN = 'com.anthropic.claudecode';

/** macOS managed-preferences plist for the `com.anthropic.claudecode` domain (device-level scope). */
export const MANAGED_PLIST_PATH = `/Library/Managed Preferences/${MANAGED_PLIST_DOMAIN}.plist`;

/** Called by its full path, as Claude Code does, so a `plutil` earlier on PATH is never run. */
export const PLUTIL_PATH = '/usr/bin/plutil';

/** The login name, or '' when the OS cannot tell (Claude Code then reads the device-level plist only). */
function currentUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/**
 * The macOS managed plists Claude Code reads, in its order: the per-user plist
 * (`/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`), then the device-level one. A name that
 * cannot be a single folder name leaves the per-user plist out.
 */
export function managedPlistPaths(username: string = currentUsername()): string[] {
  const usable = username !== '' && username !== '.' && username !== '..' && !/[/\\\0]/.test(username);
  return [...(usable ? [`/Library/Managed Preferences/${username}/${MANAGED_PLIST_DOMAIN}.plist`] : []), MANAGED_PLIST_PATH];
}

/** A managed-source query (for example `plutil`) did not answer in time; the source reads as "cannot tell". */
export class ManagedQueryTimeoutError extends CodeMieError {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = 'ManagedQueryTimeoutError';
  }
}

async function runWithTimeout(run: CommandRunner, command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ManagedQueryTimeoutError(command, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([run(command, args), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseSettingsObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isSettingsObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function defaultExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * macOS managed plist. A missing file is "no policy" (absent, plutil never runs); an existing file that plutil
 * cannot run on, times out on, or whose output is not a JSON object is 'unreadable' (cannot tell).
 */
export async function readManagedPlist(
  run: CommandRunner,
  exists: (file: string) => boolean | Promise<boolean> = defaultExists,
  options: ManagedReaderOptions & { file?: string } = {}
): Promise<SettingsLayerResult> {
  const file = options.file ?? MANAGED_PLIST_PATH;
  try {
    if (!(await exists(file))) return { path: file, state: 'absent' };
    const result = await runWithTimeout(
      run,
      PLUTIL_PATH,
      ['-convert', 'json', '-o', '-', '--', file],
      options.timeoutMs ?? MANAGED_QUERY_TIMEOUT_MS
    );
    if (result.code !== 0) return { path: file, state: 'unreadable' };
    const parsed = parseSettingsObject(result.stdout);
    return parsed ? { path: file, state: 'ok', parsed } : { path: file, state: 'unreadable' };
  } catch {
    return { path: file, state: 'unreadable' };
  }
}

/**
 * Every macOS managed plist Claude Code reads (`managedPlistPaths`), in its order, one result each and read in
 * parallel. `files` replaces the default list (tests inject tmp paths).
 */
export async function readManagedPlists(
  run: CommandRunner,
  exists: (file: string) => boolean | Promise<boolean> = defaultExists,
  options: ManagedReaderOptions & { files?: string[] } = {}
): Promise<SettingsLayerResult[]> {
  const files = options.files ?? managedPlistPaths();
  return Promise.all(files.map((file) => readManagedPlist(run, exists, { file, timeoutMs: options.timeoutMs })));
}

import { access, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { resolveHomeDir } from '@/utils/paths.js';
import { exec } from '@/utils/exec.js';

export interface ClaudeSettingsEnv {
  /** Merged `env` blocks, lowest to highest precedence; values are raw (validated by the routing rules). */
  env: Record<string, unknown>;
  /** False when any layer exists but could not be read/parsed/shaped: the merged env is then not trustworthy. */
  complete: boolean;
  /** True when any layer configures an `apiKeyHelper`: the session then authenticates with an API key, not OAuth. */
  apiKeyHelper?: boolean;
}

/** Enterprise managed settings, highest precedence; only the file Claude Code reads on this platform. */
export function managedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return ['C:/Program Files/ClaudeCode/managed-settings.json', 'C:/ProgramData/ClaudeCode/managed-settings.json'];
  }
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
  /** absent: no file; malformed: not valid JSON; unreadable: I/O error or a root that is not an object; ok: parsed. */
  state: SettingsLayerState;
  /** Set only when `state` is 'ok'. */
  parsed?: Record<string, unknown>;
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { path: file, state: 'unreadable' };
  }
  return { path: file, state: 'ok', parsed: parsed as Record<string, unknown> };
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
    const files = names.filter((n) => n.endsWith('.json')).sort();
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

/** macOS managed-preferences plist for the `com.anthropic.claudecode` domain (system-wide scope). */
export const MANAGED_PLIST_PATH = '/Library/Managed Preferences/com.anthropic.claudecode.plist';

/** Registry key Claude Code reads enterprise policy from on Windows; the `Settings` value holds JSON text. */
const REGISTRY_POLICY_KEY = String.raw`SOFTWARE\Policies\ClaudeCode`;
const REGISTRY_HIVES = ['HKLM', 'HKCU'] as const;

async function runWithTimeout(run: CommandRunner, command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
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
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
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
    const result = await runWithTimeout(run, 'plutil', ['-convert', 'json', '-o', '-', file], options.timeoutMs ?? MANAGED_QUERY_TIMEOUT_MS);
    if (result.code !== 0) return { path: file, state: 'unreadable' };
    const parsed = parseSettingsObject(result.stdout);
    return parsed ? { path: file, state: 'ok', parsed } : { path: file, state: 'unreadable' };
  } catch {
    return { path: file, state: 'unreadable' };
  }
}

async function readRegistryHive(run: CommandRunner, hive: string, timeoutMs: number): Promise<SettingsLayerResult> {
  const keyPath = `${hive}\\${REGISTRY_POLICY_KEY}`;
  const path = `${keyPath}\\Settings`;
  try {
    // A non-zero exit with empty stdout is "not found" whatever the (localised) message says.
    const key = await runWithTimeout(run, 'reg', ['query', keyPath], timeoutMs);
    if (key.code !== 0) return { path, state: key.stdout.trim() === '' ? 'absent' : 'unreadable' };
    const value = await runWithTimeout(run, 'reg', ['query', keyPath, '/v', 'Settings'], timeoutMs);
    if (value.code !== 0) return { path, state: value.stdout.trim() === '' ? 'absent' : 'unreadable' };
    const line = /^\s*Settings\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*?)\s*$/im.exec(value.stdout);
    const parsed = line ? parseSettingsObject(line[2]) : undefined;
    return parsed ? { path, state: 'ok', parsed } : { path, state: 'unreadable' };
  } catch {
    return { path, state: 'unreadable' };
  }
}

/** Windows registry policy, HKLM first (it outranks HKCU), one result per hive. */
export async function readManagedRegistry(run: CommandRunner, options: ManagedReaderOptions = {}): Promise<SettingsLayerResult[]> {
  const timeoutMs = options.timeoutMs ?? MANAGED_QUERY_TIMEOUT_MS;
  return Promise.all(REGISTRY_HIVES.map((hive) => readRegistryHive(run, hive, timeoutMs)));
}

/** A missing file is no override; an unreadable/malformed one (or a non-object `env`) is unknown, never "absent". */
export async function readClaudeSettingsEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<ClaudeSettingsEnv> {
  const layers = await Promise.all(settingsLayerPaths(cwd, env, platform).map(readSettingsLayer));
  const merged: Record<string, unknown> = {};
  let complete = true;
  let apiKeyHelper = false;
  for (const result of layers) {
    if (result.state === 'absent') continue;
    const layer = result.parsed;
    if (result.state !== 'ok' || !layer) {
      complete = false;
      continue;
    }
    // forceLoginMethod 'console' bills the API, not the saved subscription login: same effect as a key helper.
    if ((typeof layer.apiKeyHelper === 'string' && layer.apiKeyHelper.trim()) || layer.forceLoginMethod === 'console') apiKeyHelper = true;
    const block = layer.env;
    if (block === undefined) continue;
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      complete = false;
      continue;
    }
    Object.assign(merged, block);
  }
  return { env: merged, complete, ...(apiKeyHelper ? { apiKeyHelper } : {}) };
}

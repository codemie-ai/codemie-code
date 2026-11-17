import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { resolveHomeDir } from '@/utils/paths.js';

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
function managedDropInDirs(platform: NodeJS.Platform): string[] {
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

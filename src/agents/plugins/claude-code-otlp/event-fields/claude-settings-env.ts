import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHomeDir } from '@/utils/paths.js';

export interface ClaudeSettingsEnv {
  /** Merged `env` blocks, lowest to highest precedence; values are raw (validated by the routing rules). */
  env: Record<string, unknown>;
  /** False when any layer exists but could not be read/parsed/shaped: the merged env is then not trustworthy. */
  complete: boolean;
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

type Layer = Record<string, unknown> | 'absent' | 'unreadable';

async function readLayer(file: string): Promise<Layer> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** A missing file is no override; an unreadable/malformed one (or a non-object `env`) is unknown, never "absent". */
export async function readClaudeSettingsEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<ClaudeSettingsEnv> {
  const layers = await Promise.all(settingsLayerPaths(cwd, env, platform).map(readLayer));
  const merged: Record<string, unknown> = {};
  let complete = true;
  for (const layer of layers) {
    if (layer === 'absent') continue;
    if (layer === 'unreadable') {
      complete = false;
      continue;
    }
    const block = layer.env;
    if (block === undefined) continue;
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      complete = false;
      continue;
    }
    Object.assign(merged, block);
  }
  return { env: merged, complete };
}

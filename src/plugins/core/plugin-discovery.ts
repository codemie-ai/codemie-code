/** Read-only discovery of plugin source directories and settings. */
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { getCodemiePath } from '../../utils/paths.js';
import type { PluginSettings, PluginSource } from './types.js';

export interface PluginDiscoverySource {
  dirs: string[];
  source: PluginSource;
}

async function childDirectories(parent: string, onError?: (error: unknown) => void): Promise<string[]> {
  if (!existsSync(parent)) return [];
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => join(parent, entry.name));
  } catch (error) {
    onError?.(error);
    return [];
  }
}

/** Return sources in the same first-wins order used by plugin resolution. */
export async function discoverPluginSources(
  cwd: string,
  settings: PluginSettings = {},
  cliDirs: string[] = [],
  onUserCacheError?: (error: unknown) => void
): Promise<PluginDiscoverySource[]> {
  return [
    { dirs: cliDirs, source: 'local' },
    { dirs: await childDirectories(join(cwd, '.codemie', 'plugins')), source: 'project' },
    { dirs: await childDirectories(getCodemiePath('plugins', 'cache'), onUserCacheError), source: 'user' },
    { dirs: settings.dirs || [], source: 'local' },
  ];
}

/** Read settings without initializing logging or writing files. */
export async function readPluginSettingsQuietly(): Promise<PluginSettings> {
  try {
    const raw = await readFile(getCodemiePath('plugins.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

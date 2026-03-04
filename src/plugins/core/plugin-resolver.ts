/**
 * Plugin Resolver
 *
 * Discovers plugins from multiple sources, resolves enabled/disabled state,
 * and returns an ordered list of loaded plugins. Higher-priority sources
 * win when the same plugin exists in multiple locations.
 */

import { join, basename } from 'path';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { logger } from '../../utils/logger.js';
import { getCodemiePath } from '../../utils/paths.js';
import { loadPlugin } from './plugin-loader.js';
import type { LoadedPlugin, PluginSettings, PluginSource } from './types.js';

/**
 * Options for plugin resolution
 */
export interface PluginResolverOptions {
  /** Additional plugin directories from CLI flags (highest priority) */
  cliDirs?: string[];

  /** Working directory for project-level plugins */
  cwd?: string;

  /** Plugin settings from config */
  settings?: PluginSettings;
}

/**
 * Resolve all plugins from all sources
 *
 * Discovery sources (in priority order):
 * 1. CLI flag directories (--plugin-dir) — highest priority
 * 2. Project plugins (.codemie/plugins/) — team-shared
 * 3. User cache (~/.codemie/plugins/cache/) — personal installs
 * 4. Settings dirs (from config plugins.dirs) — managed
 *
 * @param options - Resolution options
 * @returns Array of loaded plugins, deduplicated (highest priority wins)
 */
export async function resolvePlugins(
  options: PluginResolverOptions = {}
): Promise<LoadedPlugin[]> {
  const { cliDirs = [], cwd = process.cwd(), settings = {} } = options;
  const disabledSet = new Set(settings.disabled || []);
  const enabledSet = settings.enabled ? new Set(settings.enabled) : null;

  // Discover from all sources
  const sources: Array<{ dirs: string[]; source: PluginSource; priority: number }> = [
    { dirs: cliDirs, source: 'local', priority: 400 },
    { dirs: await getProjectPluginDirs(cwd), source: 'project', priority: 300 },
    { dirs: await getUserPluginDirs(), source: 'user', priority: 200 },
    { dirs: settings.dirs || [], source: 'local', priority: 100 },
  ];

  // Load all plugins from all sources
  const pluginMap = new Map<string, LoadedPlugin>();

  for (const { dirs, source, priority: _priority } of sources) {
    for (const dir of dirs) {
      try {
        const isEnabled = determineEnabled(dir, enabledSet, disabledSet);
        const plugin = await loadPlugin(dir, source, isEnabled);
        const name = plugin.manifest.name;

        // Higher priority source wins (first encountered wins since we iterate highest first)
        if (!pluginMap.has(name)) {
          pluginMap.set(name, plugin);
        } else {
          logger.debug(
            `[plugin] Skipping duplicate plugin "${name}" from ${dir} (already loaded from higher priority source)`
          );
        }
      } catch (error) {
        logger.debug(
          `[plugin] Failed to load plugin from ${dir}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  const plugins = Array.from(pluginMap.values());
  logger.debug(`[plugin] Resolved ${plugins.length} plugins (${plugins.filter(p => p.enabled).length} enabled)`);

  return plugins;
}

/**
 * Get project-level plugin directories
 *
 * Scans .codemie/plugins/ for subdirectories, each treated as a plugin root.
 */
async function getProjectPluginDirs(cwd: string): Promise<string[]> {
  const projectPluginsDir = join(cwd, '.codemie', 'plugins');
  if (!existsSync(projectPluginsDir)) {
    return [];
  }

  try {
    const entries = await readdir(projectPluginsDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(projectPluginsDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Get user-level plugin directories from cache
 */
async function getUserPluginDirs(): Promise<string[]> {
  const cacheDir = getCodemiePath('plugins', 'cache');
  if (!existsSync(cacheDir)) {
    return [];
  }

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(cacheDir, entry.name));
  } catch (error) {
    logger.debug(`[plugin] Failed to read user plugin cache: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Determine if a plugin directory should be enabled
 */
function determineEnabled(
  dir: string,
  enabledSet: Set<string> | null,
  disabledSet: Set<string>
): boolean {
  // Extract plugin name from directory for matching
  const dirName = basename(dir);

  // Explicit disabled takes precedence
  if (disabledSet.has(dirName)) {
    return false;
  }

  // If enabledSet exists, only enable explicitly listed plugins
  if (enabledSet) {
    return enabledSet.has(dirName);
  }

  // Default: enabled
  return true;
}

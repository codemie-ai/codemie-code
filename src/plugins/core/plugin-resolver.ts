/**
 * Plugin Resolver
 *
 * Discovers plugins from multiple sources, resolves enabled/disabled state,
 * and returns an ordered list of loaded plugins. Higher-priority sources
 * win when the same plugin exists in multiple locations.
 */

import { basename } from 'path';
import { logger } from '../../utils/logger.js';
import { discoverPluginSources } from './plugin-discovery.js';
import { loadPlugin } from './plugin-loader.js';
import type { LoadedPlugin, PluginSettings } from './types.js';

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
  const sources = await discoverPluginSources(cwd, settings, cliDirs, error => {
    logger.debug(`[plugin] Failed to read user plugin cache: ${error instanceof Error ? error.message : String(error)}`);
  });

  // Load all plugins from all sources
  const pluginMap = new Map<string, LoadedPlugin>();

  for (const { dirs, source } of sources) {
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

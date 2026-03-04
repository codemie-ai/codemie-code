/**
 * Plugin Hooks Loader
 *
 * Discovers and merges hooks configuration from plugins.
 * Supports both hooks/hooks.json files and inline manifest hooks config.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { expandPluginRoot } from '../core/manifest-parser.js';
import type { HooksConfiguration, HookMatcher } from '../../hooks/types.js';
import type { PluginManifest } from '../core/types.js';

/**
 * Load hooks configuration from a plugin
 *
 * @param pluginDir - Absolute path to the plugin root
 * @param manifest - Parsed plugin manifest
 * @returns HooksConfiguration or null if no hooks found
 */
export async function loadPluginHooks(
  pluginDir: string,
  manifest: PluginManifest
): Promise<HooksConfiguration | null> {
  const hooksField = manifest.hooks;

  // Inline hooks configuration in manifest
  if (hooksField && typeof hooksField === 'object' && !Array.isArray(hooksField)) {
    return hooksField as HooksConfiguration;
  }

  // Path(s) to hooks config files
  const hooksPaths = resolveHooksPaths(pluginDir, hooksField);

  for (const hooksPath of hooksPaths) {
    if (!existsSync(hooksPath)) continue;

    try {
      const raw = await readFile(hooksPath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Expand ${CLAUDE_PLUGIN_ROOT} in command strings
      return expandHooksCommands(parsed, pluginDir);
    } catch (error) {
      logger.debug(
        `[plugin] Failed to parse hooks from ${hooksPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return null;
}

/**
 * Merge plugin hooks into an existing hooks configuration
 *
 * Plugin hooks are appended to each event's matcher array (lower priority than profile hooks).
 *
 * @param base - Existing hooks configuration (from profile or defaults)
 * @param pluginHooks - Hooks from a plugin
 * @returns Merged hooks configuration
 */
export function mergeHooks(
  base: HooksConfiguration,
  pluginHooks: HooksConfiguration
): HooksConfiguration {
  const merged = { ...base };
  const events = Object.keys(pluginHooks) as Array<keyof HooksConfiguration>;

  for (const event of events) {
    const pluginMatchers = pluginHooks[event];
    if (!pluginMatchers || pluginMatchers.length === 0) continue;

    const baseMatchers = merged[event] || [];
    merged[event] = [...baseMatchers, ...pluginMatchers];
  }

  return merged;
}

/**
 * Resolve hooks file paths from manifest field or defaults
 */
function resolveHooksPaths(
  pluginDir: string,
  hooksField: string | string[] | HooksConfiguration | undefined
): string[] {
  if (!hooksField || typeof hooksField === 'object') {
    // Default: check hooks/hooks.json
    return [join(pluginDir, 'hooks', 'hooks.json')];
  }

  const paths = Array.isArray(hooksField) ? hooksField : [hooksField];
  return paths.map(p => join(pluginDir, p));
}

/**
 * Expand ${CLAUDE_PLUGIN_ROOT} in all hook command strings
 */
function expandHooksCommands(
  hooks: HooksConfiguration,
  pluginDir: string
): HooksConfiguration {
  const result: HooksConfiguration = {};
  const events = Object.keys(hooks) as Array<keyof HooksConfiguration>;

  for (const event of events) {
    const matchers = hooks[event];
    if (!matchers) continue;

    result[event] = matchers.map((matcher: HookMatcher) => ({
      ...matcher,
      hooks: matcher.hooks.map(hook => ({
        ...hook,
        ...(hook.command && { command: expandPluginRoot(hook.command, pluginDir) }),
      })),
    }));
  }

  return result;
}

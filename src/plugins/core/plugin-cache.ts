/**
 * Plugin Cache
 *
 * Manages the plugin cache directory at ~/.codemie/plugins/cache/.
 * Handles copying plugins for installation and cleaning up orphaned entries.
 */

import { join, resolve, sep } from 'path';
import { existsSync } from 'fs';
import { mkdir, cp, rm, readdir, readFile, writeFile } from 'fs/promises';
import { logger } from '../../utils/logger.js';
import { getCodemiePath } from '../../utils/paths.js';
import { parseManifest } from './manifest-parser.js';

/**
 * Validate that a plugin name is safe (kebab-case, no path traversal)
 */
function validatePluginName(name: string): void {
  if (!name || /[/\\]/.test(name) || name.includes('..')) {
    throw new Error(`Invalid plugin name: "${name}". Must be a simple kebab-case name.`);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid plugin name: "${name}". Must be kebab-case (lowercase alphanumeric with hyphens).`);
  }
}

/**
 * Get the plugin cache directory path
 */
export function getPluginCacheDir(): string {
  return getCodemiePath('plugins', 'cache');
}

/**
 * Install a plugin from a source directory into the cache
 *
 * Copies the plugin directory to ~/.codemie/plugins/cache/<plugin-name>/.
 * If the plugin already exists with the same version, skips the copy.
 *
 * @param sourceDir - Absolute path to the plugin source directory
 * @returns The cache directory path where the plugin was installed
 */
export async function installPluginToCache(sourceDir: string): Promise<string> {
  if (!existsSync(sourceDir)) {
    throw new Error(`Plugin source directory does not exist: ${sourceDir}`);
  }

  // Parse manifest to get plugin name and version
  const manifest = await parseManifest(sourceDir);
  const cacheDir = getPluginCacheDir();
  const pluginCacheDir = join(cacheDir, manifest.name);

  // Check if already installed with same version
  if (existsSync(pluginCacheDir)) {
    try {
      const existingManifest = await parseManifest(pluginCacheDir);
      if (existingManifest.version && manifest.version && existingManifest.version === manifest.version) {
        logger.debug(`[plugin] Plugin "${manifest.name}" v${manifest.version} already cached, skipping`);
        return pluginCacheDir;
      }
    } catch (error) {
      logger.debug(`[plugin] Corrupt cache for "${manifest.name}", reinstalling: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Remove existing cached version
    await rm(pluginCacheDir, { recursive: true, force: true });
  }

  // Ensure cache directory exists
  await mkdir(cacheDir, { recursive: true });

  // Copy plugin to cache
  await cp(sourceDir, pluginCacheDir, { recursive: true });

  logger.debug(`[plugin] Installed "${manifest.name}" to cache: ${pluginCacheDir}`);
  return pluginCacheDir;
}

/**
 * Remove a plugin from the cache
 *
 * @param pluginName - Name of the plugin to remove
 * @returns true if the plugin was removed, false if not found
 */
export async function removePluginFromCache(pluginName: string): Promise<boolean> {
  validatePluginName(pluginName);

  const cacheDir = getPluginCacheDir();
  const pluginCacheDir = join(cacheDir, pluginName);

  // Verify resolved path stays within cache directory
  const resolvedPath = resolve(pluginCacheDir);
  const resolvedCache = resolve(cacheDir);
  if (!resolvedPath.startsWith(resolvedCache + sep)) {
    throw new Error(`Plugin path escapes cache directory: ${pluginName}`);
  }

  if (!existsSync(pluginCacheDir)) {
    return false;
  }

  await rm(pluginCacheDir, { recursive: true, force: true });
  logger.debug(`[plugin] Removed "${pluginName}" from cache`);
  return true;
}

/**
 * List all cached plugins
 *
 * @returns Array of { name, dir } for each cached plugin
 */
export async function listCachedPlugins(): Promise<Array<{ name: string; dir: string }>> {
  const cacheDir = getPluginCacheDir();

  if (!existsSync(cacheDir)) {
    return [];
  }

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        dir: join(cacheDir, entry.name),
      }));
  } catch (error) {
    logger.debug(`[plugin] Failed to list cached plugins: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Read plugin settings from ~/.codemie/plugins.json
 */
export async function readPluginSettings(): Promise<{
  enabled?: string[];
  disabled?: string[];
  dirs?: string[];
}> {
  const settingsPath = getCodemiePath('plugins.json');

  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const raw = await readFile(settingsPath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    logger.debug(`[plugin] Failed to read plugin settings: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * Write plugin settings to ~/.codemie/plugins.json
 */
export async function writePluginSettings(settings: {
  enabled?: string[];
  disabled?: string[];
  dirs?: string[];
}): Promise<void> {
  const settingsPath = getCodemiePath('plugins.json');
  const pluginsDir = getCodemiePath('plugins');

  await mkdir(pluginsDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Enable a plugin by name (remove from disabled list)
 */
export async function enablePlugin(pluginName: string): Promise<void> {
  validatePluginName(pluginName);
  const settings = await readPluginSettings();
  settings.disabled = (settings.disabled || []).filter(n => n !== pluginName);
  await writePluginSettings(settings);
}

/**
 * Disable a plugin by name (add to disabled list)
 */
export async function disablePlugin(pluginName: string): Promise<void> {
  validatePluginName(pluginName);
  const settings = await readPluginSettings();
  settings.disabled = settings.disabled || [];
  if (!settings.disabled.includes(pluginName)) {
    settings.disabled.push(pluginName);
  }
  await writePluginSettings(settings);
}

/**
 * Check if a plugin is installed in the cache
 */
export function isPluginCached(pluginName: string): boolean {
  validatePluginName(pluginName);
  return existsSync(join(getPluginCacheDir(), pluginName));
}

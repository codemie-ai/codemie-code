import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { getCodemiePath, isPathWithinDirectory } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import { PathSecurityError } from '../../utils/errors.js';
import { PluginManifestParser } from './PluginManifestParser.js';
import { InstalledPluginMetaSchema, validatePluginName } from './types.js';
import type {
  DiscoveredPlugin,
  PluginDiscoveryOptions,
  InstalledPluginMeta,
} from './types.js';

/**
 * Default plugins directory within CodeMie home
 */
const PLUGINS_DIR = 'plugins';

/**
 * Installed plugin metadata filename
 */
const INSTALLED_META_FILE = 'plugin.installed.json';

/**
 * Plugin discovery engine
 *
 * Discovers plugins from:
 * 1. ~/.codemie/plugins/ (installed plugins)
 * 2. Custom directories via --plugin-dir (development mode)
 */
export class PluginDiscovery {
  private cache: Map<string, DiscoveredPlugin[]> = new Map();

  /**
   * Discover all plugins
   *
   * @param options - Discovery options
   * @returns Array of discovered plugins
   */
  async discoverPlugins(
    options: PluginDiscoveryOptions = {}
  ): Promise<DiscoveredPlugin[]> {
    const { pluginDirs = [], forceReload = false, pluginName } = options;

    // Check cache
    const cacheKey = this.getCacheKey(options);
    if (!forceReload && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Discover from all sources
    const [installedPlugins, devPlugins] = await Promise.all([
      this.discoverInstalledPlugins(),
      this.discoverDevPlugins(pluginDirs),
    ]);

    // Combine and deduplicate (dev plugins take priority)
    let allPlugins = this.deduplicatePlugins([...devPlugins, ...installedPlugins]);

    // Filter by plugin name if specified
    if (pluginName) {
      allPlugins = allPlugins.filter((p) => p.name === pluginName);
    }

    // Cache result
    this.cache.set(cacheKey, allPlugins);

    return allPlugins;
  }

  /**
   * Discover plugins from ~/.codemie/plugins/
   */
  private async discoverInstalledPlugins(): Promise<DiscoveredPlugin[]> {
    const pluginsDir = getCodemiePath(PLUGINS_DIR);
    return this.discoverFromDirectory(pluginsDir, false);
  }

  /**
   * Discover plugins from development directories
   */
  private async discoverDevPlugins(pluginDirs: string[]): Promise<DiscoveredPlugin[]> {
    const results = await Promise.all(
      pluginDirs.map((dir) => this.discoverFromDirectory(dir, true))
    );
    return results.flat();
  }

  /**
   * Discover plugins from a specific directory
   *
   * @param directory - Directory to scan
   * @param isDevelopment - Whether this is a development directory
   * @returns Array of discovered plugins
   */
  private async discoverFromDirectory(
    directory: string,
    isDevelopment: boolean
  ): Promise<DiscoveredPlugin[]> {
    const plugins: DiscoveredPlugin[] = [];

    try {
      // Check if directory exists
      if (!existsSync(directory)) {
        return plugins;
      }

      // List subdirectories
      const entries = await readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const pluginDir = join(directory, entry.name);

        // Check if it's a valid plugin (has manifest)
        if (!PluginManifestParser.hasManifest(pluginDir)) {
          // For development mode, also check if the directory itself is a plugin
          if (isDevelopment && PluginManifestParser.hasManifest(directory)) {
            // The directory passed is the plugin itself
            const plugin = await this.loadPlugin(directory, isDevelopment);
            if (plugin) {
              plugins.push(plugin);
            }
            return plugins;
          }
          continue;
        }

        // Load the plugin
        const plugin = await this.loadPlugin(pluginDir, isDevelopment);
        if (plugin) {
          plugins.push(plugin);
        }
      }
    } catch (error) {
      logger.debug(`Failed to discover plugins from ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return plugins;
  }

  /**
   * Load a single plugin from a directory
   *
   * @param pluginDir - Plugin directory path
   * @param isDevelopment - Whether this is a development plugin
   * @returns Discovered plugin or undefined if invalid
   */
  private async loadPlugin(
    pluginDir: string,
    isDevelopment: boolean
  ): Promise<DiscoveredPlugin | undefined> {
    // Parse manifest
    const parseResult = await PluginManifestParser.parse(pluginDir);

    if (parseResult.error || !parseResult.manifest) {
      return undefined;
    }

    // Load installed metadata if available
    let installedMeta: InstalledPluginMeta | undefined;
    if (!isDevelopment) {
      installedMeta = await this.loadInstalledMeta(pluginDir);
    }

    return {
      name: parseResult.manifest.name,
      path: pluginDir,
      manifest: parseResult.manifest,
      installedMeta,
      isDevelopment,
    };
  }

  /**
   * Load installed plugin metadata
   *
   * @param pluginDir - Plugin directory path
   * @returns Installed metadata or undefined
   */
  private async loadInstalledMeta(
    pluginDir: string
  ): Promise<InstalledPluginMeta | undefined> {
    const metaPath = join(pluginDir, INSTALLED_META_FILE);

    try {
      if (!existsSync(metaPath)) {
        return undefined;
      }

      const content = await readFile(metaPath, 'utf-8');
      const rawMeta = JSON.parse(content);

      const result = InstalledPluginMetaSchema.safeParse(rawMeta);
      if (!result.success) {
        return undefined;
      }

      return result.data;
    } catch (error) {
      logger.debug(`Failed to load installed metadata from ${pluginDir}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Deduplicate plugins by name (first occurrence wins)
   * Since dev plugins are added first, they take priority
   */
  private deduplicatePlugins(plugins: DiscoveredPlugin[]): DiscoveredPlugin[] {
    const seen = new Map<string, DiscoveredPlugin>();

    for (const plugin of plugins) {
      if (!seen.has(plugin.name)) {
        seen.set(plugin.name, plugin);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Generate cache key from options
   */
  private getCacheKey(options: PluginDiscoveryOptions): string {
    const { pluginDirs = [], pluginName } = options;
    return `${pluginDirs.sort().join(':')}::${pluginName || ''}`;
  }

  /**
   * Clear discovery cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Get the default plugins directory path
   */
  static getPluginsDir(): string {
    return getCodemiePath(PLUGINS_DIR);
  }

  /**
   * Check if a plugin is installed
   *
   * @param pluginName - Plugin name to check
   * @returns true if installed
   */
  async isPluginInstalled(pluginName: string): Promise<boolean> {
    const pluginDir = PluginDiscovery.getPluginDir(pluginName);
    return existsSync(pluginDir) && PluginManifestParser.hasManifest(pluginDir);
  }

  /**
   * Get plugin directory path
   *
   * @param pluginName - Plugin name
   * @returns Absolute path to plugin directory
   */
  static getPluginDir(pluginName: string): string {
    validatePluginName(pluginName);
    const pluginsDir = PluginDiscovery.getPluginsDir();
    const resolved = join(pluginsDir, pluginName);
    if (!isPathWithinDirectory(pluginsDir, resolved)) {
      throw new PathSecurityError(
        resolved,
        `Plugin path escapes the plugins directory '${pluginsDir}'`
      );
    }
    return resolved;
  }
}

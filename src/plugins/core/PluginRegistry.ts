import { PluginDiscovery } from './PluginDiscovery.js';
import { PluginLoader } from './PluginLoader.js';
import type {
  DiscoveredPlugin,
  LoadedPlugin,
  PluginDiscoveryOptions,
} from './types.js';

/**
 * Plugin registry singleton
 *
 * Central registry for all plugins. Handles:
 * - Plugin discovery
 * - Plugin loading
 * - Plugin lookup
 * - Cache management
 *
 * Similar pattern to AgentRegistry but for plugins.
 */
export class PluginRegistry {
  private static instance: PluginRegistry;
  private discovery: PluginDiscovery;
  private loader: PluginLoader;
  private loadedPlugins: Map<string, LoadedPlugin> = new Map();
  private discoveredPlugins: Map<string, DiscoveredPlugin> = new Map();
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  /** Additional plugin directories for development mode */
  private devPluginDirs: string[] = [];

  /**
   * Private constructor (singleton pattern)
   */
  private constructor() {
    this.discovery = new PluginDiscovery();
    this.loader = new PluginLoader();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  /**
   * Add development plugin directory
   *
   * Call this before initialization to load plugins from custom directories
   *
   * @param dir - Absolute path to plugin directory
   */
  addDevPluginDir(dir: string): void {
    if (!this.devPluginDirs.includes(dir)) {
      this.devPluginDirs.push(dir);
      // Clear cache to force re-discovery
      if (this.initialized) {
        this.reset();
      }
    }
  }

  /**
   * Initialize the registry (lazy initialization)
   *
   * Discovers and loads all plugins. Safe to call multiple times.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Prevent concurrent initialization
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitialize();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  /**
   * Perform actual initialization
   */
  private async doInitialize(): Promise<void> {
    // Discover all plugins
    const options: PluginDiscoveryOptions = {
      pluginDirs: this.devPluginDirs,
      forceReload: true,
    };

    const discovered = await this.discovery.discoverPlugins(options);

    // Store discovered plugins
    this.discoveredPlugins.clear();
    for (const plugin of discovered) {
      this.discoveredPlugins.set(plugin.name, plugin);
    }

    // Load all plugins
    this.loadedPlugins.clear();
    for (const plugin of discovered) {
      const loaded = await this.loader.loadPlugin(plugin);
      this.loadedPlugins.set(plugin.name, loaded);
    }

    this.initialized = true;
  }

  /**
   * Get a plugin by name
   *
   * @param name - Plugin name
   * @returns Loaded plugin or undefined
   */
  async getPlugin(name: string): Promise<LoadedPlugin | undefined> {
    await this.initialize();
    return this.loadedPlugins.get(name);
  }

  /**
   * Get all loaded plugins
   *
   * @returns Array of all loaded plugins
   */
  async getAllPlugins(): Promise<LoadedPlugin[]> {
    await this.initialize();
    return Array.from(this.loadedPlugins.values());
  }

  /**
   * Get all discovered plugins (before loading)
   *
   * @returns Array of all discovered plugins
   */
  async getDiscoveredPlugins(): Promise<DiscoveredPlugin[]> {
    await this.initialize();
    return Array.from(this.discoveredPlugins.values());
  }

  /**
   * Get plugin names
   *
   * @returns Array of plugin names
   */
  async getPluginNames(): Promise<string[]> {
    await this.initialize();
    return Array.from(this.loadedPlugins.keys());
  }

  /**
   * Check if a plugin is loaded
   *
   * @param name - Plugin name
   * @returns true if loaded
   */
  async hasPlugin(name: string): Promise<boolean> {
    await this.initialize();
    return this.loadedPlugins.has(name);
  }

  /**
   * Get skills from a specific plugin
   *
   * @param pluginName - Plugin name
   * @returns Array of skill names from the plugin
   */
  async getPluginSkills(pluginName: string): Promise<string[]> {
    const plugin = await this.getPlugin(pluginName);
    return plugin?.skillNames || [];
  }

  /**
   * Get all skills from all plugins
   *
   * @returns Map of plugin name to skill names
   */
  async getAllPluginSkills(): Promise<Map<string, string[]>> {
    await this.initialize();

    const result = new Map<string, string[]>();
    for (const [name, plugin] of this.loadedPlugins) {
      result.set(name, plugin.skillNames);
    }

    return result;
  }

  /**
   * Reload all plugins
   *
   * Clears cache and re-discovers/re-loads all plugins
   */
  async reload(): Promise<void> {
    this.reset();
    await this.initialize();
  }

  /**
   * Reset the registry
   *
   * Clears all caches and loaded plugins
   */
  reset(): void {
    this.discovery.clearCache();
    this.loader.clearCache();
    this.loadedPlugins.clear();
    this.discoveredPlugins.clear();
    this.initialized = false;
    this.initializationPromise = null;
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    initialized: boolean;
    pluginCount: number;
    totalSkillCount: number;
    pluginNames: string[];
  } {
    let totalSkillCount = 0;
    for (const plugin of this.loadedPlugins.values()) {
      totalSkillCount += plugin.skillCount;
    }

    return {
      initialized: this.initialized,
      pluginCount: this.loadedPlugins.size,
      totalSkillCount,
      pluginNames: Array.from(this.loadedPlugins.keys()),
    };
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    if (PluginRegistry.instance) {
      PluginRegistry.instance.reset();
    }
    PluginRegistry.instance = undefined as unknown as PluginRegistry;
  }
}

/**
 * Plugin Registry - Manages plugin lifecycle and ordering
 *
 * SOLID: Single responsibility = plugin management
 * KISS: Simple registry with priority-based sorting
 */

import { ProxyPlugin, PluginConfig, PluginContext, ProxyInterceptor } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Plugin registry - manages plugin lifecycle and ordering
 */
export class PluginRegistry {
  private plugins = new Map<string, ProxyPlugin>();
  private configs = new Map<string, PluginConfig>();
  private interceptors = new Map<string, ProxyInterceptor>();

  /**
   * Register a plugin (typically called at app startup)
   */
  register(plugin: ProxyPlugin, config?: Partial<PluginConfig>): void {
    this.plugins.set(plugin.id, plugin);

    this.configs.set(plugin.id, {
      id: plugin.id,
      enabled: true, // Default enabled
      priority: plugin.priority,
      ...config
    });

    logger.debug(`[PluginRegistry] Registered plugin: ${plugin.id}`);
  }

  /**
   * Initialize all enabled plugins with context
   */
  async initialize(context: PluginContext): Promise<ProxyInterceptor[]> {
    const enabledPlugins = this.getEnabledPluginsSorted();
    const interceptors: ProxyInterceptor[] = [];

    for (const plugin of enabledPlugins) {
      try {
        const interceptor = await plugin.createInterceptor(context);
        this.interceptors.set(plugin.id, interceptor);
        interceptors.push(interceptor);

        logger.debug(`[PluginRegistry] Initialized plugin: ${plugin.id} (priority: ${plugin.priority})`);
      } catch (error) {
        logger.error(`[PluginRegistry] Failed to initialize plugin ${plugin.id}:`, error);
        // Continue with other plugins (fail gracefully)
      }
    }

    return interceptors;
  }

  /**
   * Get enabled plugins sorted by priority (ascending)
   */
  private getEnabledPluginsSorted(): ProxyPlugin[] {
    const enabled: Array<{ plugin: ProxyPlugin; priority: number }> = [];

    for (const [id, plugin] of this.plugins) {
      const config = this.configs.get(id);
      if (config?.enabled) {
        const priority = config.priority ?? plugin.priority;
        enabled.push({ plugin, priority });
      }
    }

    // Sort by priority (lower = earlier)
    enabled.sort((a, b) => a.priority - b.priority);

    return enabled.map(e => e.plugin);
  }

  /**
   * Enable/disable plugin at runtime
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const config = this.configs.get(pluginId);
    if (!config) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    config.enabled = enabled;

    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      if (enabled && plugin.onEnable) {
        await plugin.onEnable();
      } else if (!enabled && plugin.onDisable) {
        await plugin.onDisable();
      }
    }
  }

  /**
   * Get all registered plugins
   */
  getAll(): ProxyPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin configuration
   */
  getConfig(pluginId: string): PluginConfig | undefined {
    return this.configs.get(pluginId);
  }

  /**
   * Update plugin configuration
   */
  updateConfig(pluginId: string, updates: Partial<PluginConfig>): void {
    const config = this.configs.get(pluginId);
    if (config) {
      Object.assign(config, updates);
    }
  }

  /**
   * Clear all plugins (for testing)
   */
  clear(): void {
    this.plugins.clear();
    this.configs.clear();
    this.interceptors.clear();
  }
}

// Singleton instance
let registryInstance: PluginRegistry | null = null;

export function getPluginRegistry(): PluginRegistry {
  if (!registryInstance) {
    registryInstance = new PluginRegistry();
  }
  return registryInstance;
}

export function resetPluginRegistry(): void {
  registryInstance = null;
}

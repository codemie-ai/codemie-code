/**
 * Analytics Plugin System
 *
 * Extensible architecture for adding custom metrics without modifying core.
 * SOLID: Open/Closed - extend analytics via plugins, don't modify core.
 */

import { Analytics } from '../index.js';
import { AnalyticsEvent } from '../types.js';

/**
 * Analytics Plugin Interface
 * Allows extending analytics without modifying core
 */
export interface AnalyticsPlugin {
  /** Plugin name (must be unique) */
  name: string;

  /** Plugin version */
  version: string;

  /** Called when plugin is registered */
  initialize?(analytics: Analytics): Promise<void>;

  /** Transform/enrich events before writing */
  processEvent?(event: AnalyticsEvent): Promise<AnalyticsEvent | null>;

  /** Get current aggregated metrics snapshot (for reporting) */
  getMetrics?(): Record<string, unknown>;

  /** Reset plugin metrics (useful for new sessions) */
  reset?(): void;

  /** Custom event types this plugin handles (optional) */
  customEventTypes?: string[];
}

/**
 * Plugin Registry
 * Central place for all analytics plugins
 */
export class AnalyticsPluginRegistry {
  private plugins = new Map<string, AnalyticsPlugin>();

  /**
   * Register a plugin
   * @throws Error if plugin name already registered
   */
  register(plugin: AnalyticsPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Analytics plugin "${plugin.name}" is already registered`);
    }

    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Get all registered plugins
   */
  getAll(): AnalyticsPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin by name
   */
  getByName(name: string): AnalyticsPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Check if plugin is registered
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Unregister plugin
   */
  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  /**
   * Clear all plugins
   */
  clear(): void {
    this.plugins.clear();
  }
}

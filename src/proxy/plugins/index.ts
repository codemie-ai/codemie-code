/**
 * Core Proxy Plugins
 *
 * KISS: Single file to register all core plugins
 * Extensibility: Easy to add new plugins
 */

import { getPluginRegistry } from './registry.js';
import { SSOAuthPlugin } from './sso-auth.plugin.js';
import { HeaderInjectionPlugin } from './header-injection.plugin.js';
import { AnalyticsPlugin } from './analytics.plugin.js';

/**
 * Register core plugins
 * Called at app startup
 */
export function registerCorePlugins(): void {
  const registry = getPluginRegistry();

  // Register in any order (priority determines execution order)
  registry.register(new SSOAuthPlugin());
  registry.register(new HeaderInjectionPlugin());
  registry.register(new AnalyticsPlugin(), {
    enabled: false // Disabled by default (enabled in proxy start() if analytics is enabled)
  });
}

// Auto-register on import
registerCorePlugins();

// Re-export for convenience
export { SSOAuthPlugin, HeaderInjectionPlugin, AnalyticsPlugin };
export { getPluginRegistry, resetPluginRegistry } from './registry.js';
export * from './types.js';

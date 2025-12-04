/**
 * Core Proxy Plugins
 *
 * KISS: Single file to register all core plugins
 * Extensibility: Easy to add new plugins
 */

import { getPluginRegistry } from './registry.js';
import { SSOAuthPlugin } from './sso-auth.plugin.js';
import { HeaderInjectionPlugin } from './header-injection.plugin.js';
import { LoggingPlugin } from './logging.plugin.js';

/**
 * Register core plugins
 * Called at app startup
 */
export function registerCorePlugins(): void {
  const registry = getPluginRegistry();

  // Register in any order (priority determines execution order)
  registry.register(new SSOAuthPlugin());
  registry.register(new HeaderInjectionPlugin());
  registry.register(new LoggingPlugin()); // Always enabled - logs to log files at INFO level
}

// Auto-register on import
registerCorePlugins();

// Re-export for convenience
export { SSOAuthPlugin, HeaderInjectionPlugin, LoggingPlugin };
export { getPluginRegistry, resetPluginRegistry } from './registry.js';
export * from './types.js';

/**
 * Core Proxy Plugins
 *
 * KISS: Single file to register all core plugins
 * Extensibility: Easy to add new plugins
 */

import { getPluginRegistry } from './registry.js';
import { EndpointBlockerPlugin } from './endpoint-blocker.plugin.js';
import { SSOAuthPlugin } from './sso-auth.plugin.js';
import { HeaderInjectionPlugin } from './header-injection.plugin.js';
import { LoggingPlugin } from './logging.plugin.js';
import { SSOMetricsSyncPlugin } from '../../metrics/sync/sso.metrics-sync.plugin.js';

/**
 * Register core plugins
 * Called at app startup
 */
export function registerCorePlugins(): void {
  const registry = getPluginRegistry();

  // Register in any order (priority determines execution order)
  registry.register(new EndpointBlockerPlugin()); // Priority 5 - blocks unwanted endpoints early
  registry.register(new SSOAuthPlugin());
  registry.register(new HeaderInjectionPlugin());
  registry.register(new LoggingPlugin()); // Always enabled - logs to log files at INFO level
  registry.register(new SSOMetricsSyncPlugin()); // SSO capability - gracefully skips if not in SSO mode
}

// Auto-register on import
registerCorePlugins();

// Re-export for convenience
export { EndpointBlockerPlugin, SSOAuthPlugin, HeaderInjectionPlugin, LoggingPlugin };
export { SSOMetricsSyncPlugin } from '../../metrics/sync/sso.metrics-sync.plugin.js';
export { getPluginRegistry, resetPluginRegistry } from './registry.js';
export * from './types.js';

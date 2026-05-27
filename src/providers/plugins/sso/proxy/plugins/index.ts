/**
 * Core Proxy Plugins
 *
 * KISS: Single file to register all core plugins
 * Extensibility: Easy to add new plugins
 */

import { getPluginRegistry } from "./registry.js";
import { MCPAuthPlugin } from "./mcp-auth.plugin.js";
import { EndpointBlockerPlugin } from "./endpoint-blocker.plugin.js";
import { GatewayKeyPlugin } from "./gateway-key.plugin.js";
import { SSOAuthPlugin } from "./sso-auth.plugin.js";
import { JWTAuthPlugin } from "./jwt-auth.plugin.js";
import { HeaderInjectionPlugin } from "./header-injection.plugin.js";
import { RequestSanitizerPlugin } from "./request-sanitizer.plugin.js";
import { ClaudeRequestNormalizerPlugin } from "./claude-request-normalizer.plugin.js";
import { CodexEncryptedContentSanitizerPlugin } from "./codex-encrypted-content-sanitizer.plugin.js";
import { LoggingPlugin } from "./logging.plugin.js";
import { SSOSessionSyncPlugin } from "./sso.session-sync.plugin.js";
import { SessionExpiryHandlerPlugin } from "./session-expiry-handler.plugin.js";

/**
 * Register core plugins
 * Called at app startup
 */
export function registerCorePlugins(): void {
  const registry = getPluginRegistry();

  // Register in any order (priority determines execution order)
  registry.register(new MCPAuthPlugin()); // Priority 3 - MCP auth relay routing
  registry.register(new EndpointBlockerPlugin()); // Priority 5 - blocks unwanted endpoints early
registry.register(new GatewayKeyPlugin()); // Priority 7 - validates local gateway auth, strips header before upstream
  registry.register(new SSOAuthPlugin());
  registry.register(new JWTAuthPlugin());
  registry.register(new ClaudeRequestNormalizerPlugin()); // Priority 14 - normalizes thinking params for claude models
  registry.register(new RequestSanitizerPlugin()); // Priority 15 - strips unsupported reasoning params
  registry.register(new CodexEncryptedContentSanitizerPlugin()); // Priority 16 - strips encrypted reasoning state for Codex
  registry.register(new HeaderInjectionPlugin());
  registry.register(new LoggingPlugin()); // Always enabled - logs to log files at INFO level
  registry.register(new SessionExpiryHandlerPlugin()); // Priority 20 - detects 401/403, triggers re-auth in proxy core
  registry.register(new SSOSessionSyncPlugin()); // Priority 100 - syncs sessions via multiple processors
}

// Auto-register on import
registerCorePlugins();

// Re-export for convenience
export {
  MCPAuthPlugin,
  EndpointBlockerPlugin,
  GatewayKeyPlugin,
  SSOAuthPlugin,
  JWTAuthPlugin,
  HeaderInjectionPlugin,
  RequestSanitizerPlugin,
  ClaudeRequestNormalizerPlugin,
  CodexEncryptedContentSanitizerPlugin,
  LoggingPlugin,
};
export { SSOSessionSyncPlugin } from "./sso.session-sync.plugin.js";
export { SessionExpiryHandlerPlugin } from "./session-expiry-handler.plugin.js";
export { getPluginRegistry, resetPluginRegistry } from "./registry.js";
export * from "./types.js";

/**
 * Plugin System - Public API
 *
 * Exports the core plugin system components for use throughout the codebase.
 */

// Types
export type {
  PluginManifest,
  PluginAuthor,
  McpConfig,
  McpServerConfig,
  LspConfig,
  LspServerConfig,
  LoadedPlugin,
  PluginSource,
  PluginSkill,
  PluginCommand,
  PluginAgent,
  PluginSettings,
} from './types.js';

export { PluginErrorCode } from './types.js';

// Manifest parser
export { parseManifest, hasManifest, expandPluginRoot, expandPluginRootDeep } from './manifest-parser.js';

// Plugin loader
export { loadPlugin } from './plugin-loader.js';

// Plugin resolver
export { resolvePlugins } from './plugin-resolver.js';
export type { PluginResolverOptions } from './plugin-resolver.js';

// Plugin cache
export {
  getPluginCacheDir,
  installPluginToCache,
  removePluginFromCache,
  listCachedPlugins,
  readPluginSettings,
  writePluginSettings,
  enablePlugin,
  disablePlugin,
  isPluginCached,
} from './plugin-cache.js';

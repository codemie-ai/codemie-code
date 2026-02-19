/**
 * Plugin System - Public API
 *
 * Provides plugin discovery, loading, and marketplace integration for CodeMie.
 * Compatible with Claude Code's official plugin format (.claude-plugin/plugin.json).
 */

// Core exports
export { PluginRegistry } from './core/PluginRegistry.js';
export { PluginDiscovery } from './core/PluginDiscovery.js';
export { PluginLoader } from './core/PluginLoader.js';
export { PluginManifestParser } from './core/PluginManifestParser.js';

// Core type exports
export type {
  PluginManifest,
  PluginSource,
  InstalledPluginMeta,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginSkillInfo,
  PluginManifestParseResult,
  PluginDiscoveryOptions,
  PluginValidationResult,
  PluginOperationResult,
} from './core/types.js';
export { PluginManifestSchema, InstalledPluginMetaSchema, validatePluginName } from './core/types.js';

// Marketplace exports
export { MarketplaceClient } from './marketplace/MarketplaceClient.js';
export { MarketplaceRegistry } from './marketplace/MarketplaceRegistry.js';
export { PluginInstaller } from './marketplace/PluginInstaller.js';

// Marketplace type exports
export type {
  MarketplaceSource,
  MarketplaceSourceType,
  MarketplaceConfig,
  MarketplaceIndex,
  MarketplacePluginEntry,
  MarketplaceSearchResult,
  PluginDownloadInfo,
  PluginInstallOptions,
  PluginInstallResult,
  PluginUpdateInfo,
} from './marketplace/types.js';
export {
  MarketplaceSourceSchema,
  MarketplaceConfigSchema,
  MarketplaceIndexSchema,
  MarketplacePluginEntrySchema,
} from './marketplace/types.js';

import { z } from 'zod';

/**
 * Marketplace source type
 */
export type MarketplaceSourceType = 'github';

/**
 * Marketplace source configuration
 */
export interface MarketplaceSource {
  /** Unique identifier for this source */
  id: string;

  /** Display name */
  name: string;

  /** Source type (currently only github) */
  type: MarketplaceSourceType;

  /** GitHub repository owner/repo (e.g., "anthropics/claude-plugins-official") */
  repository: string;

  /** Branch to use (default: main) */
  branch?: string;

  /** Whether this is the default marketplace */
  isDefault?: boolean;

  /** Whether this source is enabled */
  enabled: boolean;
}

/**
 * Zod schema for marketplace source
 */
export const MarketplaceSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal('github'),
  repository: z.string().min(1),
  branch: z.string().optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().default(true),
});

/**
 * Marketplace configuration stored at ~/.codemie/marketplaces.json
 */
export interface MarketplaceConfig {
  /** Version of the config schema */
  version: number;

  /** List of marketplace sources */
  sources: MarketplaceSource[];

  /** Last updated timestamp */
  lastUpdated: string;
}

/**
 * Zod schema for marketplace config
 */
export const MarketplaceConfigSchema = z.object({
  version: z.number().default(1),
  sources: z.array(MarketplaceSourceSchema).default([]),
  lastUpdated: z.string(),
});

/**
 * Plugin entry in a marketplace index
 */
export interface MarketplacePluginEntry {
  /** Plugin name */
  name: string;

  /** Plugin description */
  description: string;

  /** Current version */
  version: string;

  /** Author name */
  author?: string;

  /** Plugin keywords/tags */
  keywords?: string[];

  /** Plugin category */
  category?: string;

  /** Path within the marketplace repo (e.g., "plugins/gitlab-tools") */
  path: string;

  /** Whether this is an external plugin reference */
  isExternal?: boolean;

  /** External repository (if isExternal is true) */
  externalRepo?: string;

  /** Last update timestamp */
  updatedAt?: string;

  /** Download count (if available) */
  downloads?: number;

  /** Star count (if available) */
  stars?: number;
}

/**
 * Marketplace index (cached locally)
 */
export interface MarketplaceIndex {
  /** Marketplace source ID */
  sourceId: string;

  /** List of available plugins */
  plugins: MarketplacePluginEntry[];

  /** Index version */
  version: number;

  /** When the index was fetched */
  fetchedAt: string;

  /** Index expiry time */
  expiresAt: string;
}

/**
 * Zod schema for marketplace plugin entry
 */
export const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  version: z.string(),
  author: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  path: z.string(),
  isExternal: z.boolean().optional(),
  externalRepo: z.string().optional(),
  updatedAt: z.string().optional(),
  downloads: z.number().optional(),
  stars: z.number().optional(),
});

/**
 * Zod schema for marketplace index
 */
export const MarketplaceIndexSchema = z.object({
  sourceId: z.string(),
  plugins: z.array(MarketplacePluginEntrySchema),
  version: z.number().default(1),
  fetchedAt: z.string(),
  expiresAt: z.string(),
});

/**
 * Result of a marketplace search
 */
export interface MarketplaceSearchResult {
  /** Plugin entry */
  plugin: MarketplacePluginEntry;

  /** Marketplace source ID */
  sourceId: string;

  /** Marketplace source name */
  sourceName: string;

  /** Search relevance score */
  score: number;
}

/**
 * Plugin download information
 */
export interface PluginDownloadInfo {
  /** Plugin name */
  name: string;

  /** Download URL (GitHub archive) */
  downloadUrl: string;

  /** Repository (owner/repo) */
  repository: string;

  /** Branch */
  branch: string;

  /** Path within repository */
  path: string;

  /** Version */
  version: string;

  /** Commit hash (if available) */
  commitHash?: string;
}

/**
 * Installation options
 */
export interface PluginInstallOptions {
  /** Force reinstall even if already installed */
  force?: boolean;

  /** Specific version to install */
  version?: string;

  /** Source marketplace ID (uses default if not specified) */
  sourceId?: string;
}

/**
 * Installation result
 */
export interface PluginInstallResult {
  success: boolean;
  pluginName: string;
  version: string;
  installedPath: string;
  message: string;
  error?: Error;
}

/**
 * Update check result
 */
export interface PluginUpdateInfo {
  pluginName: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  updateUrl?: string;
}

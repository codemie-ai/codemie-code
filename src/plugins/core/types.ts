import { z } from 'zod';

/**
 * Plugin source type
 */
export type PluginSource = 'marketplace' | 'local';

/**
 * Zod schema for Claude-compatible plugin manifest
 * Compatible with .claude-plugin/plugin.json format
 */
export const PluginManifestSchema = z.object({
  // Required fields
  name: z.string().min(1, 'Plugin name is required'),
  description: z.string().min(1, 'Plugin description is required'),

  // Optional version (Claude Code plugins may not include this)
  version: z.string().optional().default('0.0.0'),

  // Optional standard fields - author can be string or object
  author: z
    .union([
      z.string(),
      z.object({
        name: z.string(),
        email: z.string().optional(),
        url: z.string().optional(),
      }),
    ])
    .optional()
    .transform((val) => {
      if (typeof val === 'object' && val !== null) {
        return val.name;
      }
      return val;
    }),
  license: z.string().optional(),
  homepage: z.string().url().optional(),
  repository: z.string().optional(),
  keywords: z.array(z.string()).optional(),

  // Plugin capabilities (what the plugin provides)
  capabilities: z
    .object({
      skills: z.boolean().default(false),
      commands: z.boolean().default(false),
      hooks: z.boolean().default(false),
      mcp: z.boolean().default(false),
      lsp: z.boolean().default(false),
    })
    .optional(),

  // Compatibility requirements
  compatibility: z
    .object({
      agents: z.array(z.string()).optional(),
      minVersion: z.string().optional(),
    })
    .optional(),

  // CodeMie-specific extensions
  codemie: z
    .object({
      priority: z.number().default(0),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
    })
    .optional(),
});

/**
 * TypeScript interface for plugin manifest
 */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Plugin installation metadata
 * Stored as plugin.installed.json in the plugin directory
 */
export interface InstalledPluginMeta {
  /** Plugin name */
  name: string;

  /** Installed version */
  version: string;

  /** Source of installation */
  source: PluginSource;

  /** Marketplace ID if installed from marketplace */
  marketplaceId?: string;

  /** Repository URL if installed from marketplace */
  repositoryUrl?: string;

  /** Installation timestamp (ISO 8601) */
  installedAt: string;

  /** Last update timestamp (ISO 8601) */
  updatedAt: string;

  /** Hash of the installed version (for update detection) */
  commitHash?: string;
}

/**
 * Zod schema for installed plugin metadata
 */
export const InstalledPluginMetaSchema = z.object({
  name: z.string(),
  version: z.string(),
  source: z.enum(['marketplace', 'local']),
  marketplaceId: z.string().optional(),
  repositoryUrl: z.string().optional(),
  installedAt: z.string(),
  updatedAt: z.string(),
  commitHash: z.string().optional(),
});

/**
 * Discovered plugin (before loading)
 */
export interface DiscoveredPlugin {
  /** Plugin name from manifest */
  name: string;

  /** Absolute path to plugin directory */
  path: string;

  /** Parsed manifest */
  manifest: PluginManifest;

  /** Installation metadata (if installed from marketplace) */
  installedMeta?: InstalledPluginMeta;

  /** Whether this is a development plugin (loaded via --plugin-dir) */
  isDevelopment: boolean;
}

/**
 * Loaded plugin with all resources
 */
export interface LoadedPlugin extends DiscoveredPlugin {
  /** Loaded skill names from this plugin */
  skillNames: string[];

  /** Number of skills loaded */
  skillCount: number;

  /** Load timestamp */
  loadedAt: string;

  /** Any errors during loading (non-fatal) */
  loadErrors: string[];
}

/**
 * Plugin skill info attached to skills from plugins
 */
export interface PluginSkillInfo {
  /** Plugin name */
  pluginName: string;

  /** Full namespaced skill name (plugin-name:skill-name) */
  fullSkillName: string;

  /** Plugin version */
  pluginVersion: string;

  /** Plugin source */
  pluginSource: PluginSource;
}

/**
 * Result of parsing a plugin manifest
 */
export interface PluginManifestParseResult {
  manifest?: PluginManifest;
  error?: {
    path: string;
    message: string;
    cause?: unknown;
  };
}

/**
 * Options for plugin discovery
 */
export interface PluginDiscoveryOptions {
  /** Additional directories to scan for plugins (development mode) */
  pluginDirs?: string[];

  /** Force reload (ignore cache) */
  forceReload?: boolean;

  /** Filter by plugin name */
  pluginName?: string;
}

/**
 * Plugin validation result
 */
export interface PluginValidationResult {
  valid: boolean;
  pluginPath: string;
  pluginName?: string;
  errors: string[];
}

/**
 * Plugin operation result
 */
export interface PluginOperationResult {
  success: boolean;
  pluginName: string;
  message: string;
  error?: Error;
}

/**
 * Plugin System Types
 *
 * Defines interfaces for the native plugin system following the Anthropic
 * Claude Code plugin format (.claude-plugin/plugin.json, skills/, commands/, etc.)
 */

import type { HooksConfiguration } from '../../hooks/types.js';

// ============================================================================
// Plugin Manifest (from .claude-plugin/plugin.json)
// ============================================================================

/**
 * Author information for a plugin
 */
export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/**
 * MCP server configuration from a plugin
 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Individual MCP server configuration
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * LSP server configuration from a plugin
 */
export interface LspConfig {
  lspServers: Record<string, LspServerConfig>;
}

/**
 * Individual LSP server configuration
 */
export interface LspServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  languages?: string[];
}

/**
 * Plugin manifest as defined in .claude-plugin/plugin.json
 *
 * Follows the Anthropic Claude Code plugin format.
 */
export interface PluginManifest {
  /** Plugin name (required, kebab-case) */
  name: string;

  /** Semantic version */
  version?: string;

  /** Human-readable description */
  description?: string;

  /** Author information */
  author?: PluginAuthor;

  /** Plugin homepage URL */
  homepage?: string;

  /** Source repository URL */
  repository?: string;

  /** License identifier (e.g., 'MIT', 'Apache-2.0') */
  license?: string;

  /** Search keywords */
  keywords?: string[];

  /** Commands directory path override(s) */
  commands?: string | string[];

  /** Agents directory path override(s) */
  agents?: string | string[];

  /** Skills directory path override(s) */
  skills?: string | string[];

  /** Hooks config path(s) or inline config */
  hooks?: string | string[] | HooksConfiguration;

  /** MCP servers config path(s) or inline config */
  mcpServers?: string | string[] | McpConfig;

  /** LSP servers config path(s) or inline config */
  lspServers?: string | string[] | LspConfig;

  /** Output style path overrides */
  outputStyles?: string | string[];
}

// ============================================================================
// Plugin Components
// ============================================================================

/**
 * A skill discovered from a plugin's skills/ or commands/ directory
 */
export interface PluginSkill {
  /** Name of the parent plugin */
  pluginName: string;

  /** Original skill name from SKILL.md frontmatter */
  skillName: string;

  /** Namespaced name: "plugin-name:skill-name" */
  namespacedName: string;

  /** Absolute path to the skill file */
  filePath: string;

  /** Raw file content (markdown body after frontmatter) */
  content: string;

  /** Parsed frontmatter metadata */
  metadata: Record<string, unknown>;
}

/**
 * A command discovered from a plugin's commands/ directory
 */
export interface PluginCommand {
  /** Name of the parent plugin */
  pluginName: string;

  /** Original command name */
  commandName: string;

  /** Namespaced name: "plugin-name:command-name" */
  namespacedName: string;

  /** Absolute path to the command file */
  filePath: string;

  /** Raw file content */
  content: string;

  /** Parsed frontmatter metadata */
  metadata: Record<string, unknown>;
}

/**
 * An agent discovered from a plugin's agents/ directory
 */
export interface PluginAgent {
  /** Name of the parent plugin */
  pluginName: string;

  /** Original agent name */
  agentName: string;

  /** Namespaced name: "plugin-name:agent-name" */
  namespacedName: string;

  /** Absolute path to the agent file */
  filePath: string;

  /** Raw file content */
  content: string;

  /** Parsed frontmatter metadata */
  metadata: Record<string, unknown>;
}

// ============================================================================
// Loaded Plugin
// ============================================================================

/**
 * Source of where a plugin was found/installed
 */
export type PluginSource = 'local' | 'user' | 'project';

/**
 * A fully loaded and resolved plugin with all its components
 */
export interface LoadedPlugin {
  /** Parsed manifest from plugin.json */
  manifest: PluginManifest;

  /** Absolute path to the plugin root directory */
  rootDir: string;

  /** Where the plugin was found/installed */
  source: PluginSource;

  /** Whether this plugin is enabled */
  enabled: boolean;

  /** Discovered skills with namespace prefix */
  skills: PluginSkill[];

  /** Discovered commands with namespace prefix */
  commands: PluginCommand[];

  /** Discovered agents with namespace prefix */
  agents: PluginAgent[];

  /** Merged hooks configuration (or null if none) */
  hooks: HooksConfiguration | null;

  /** Merged MCP server configuration (or null if none) */
  mcpServers: McpConfig | null;
}

// ============================================================================
// Plugin Settings
// ============================================================================

/**
 * Plugin settings stored in config
 */
export interface PluginSettings {
  /** Explicitly enabled plugin names */
  enabled?: string[];

  /** Explicitly disabled plugin names */
  disabled?: string[];

  /** Additional plugin directories to scan */
  dirs?: string[];
}

// ============================================================================
// Plugin Errors
// ============================================================================

/**
 * Error codes for plugin operations
 */
export enum PluginErrorCode {
  MANIFEST_NOT_FOUND = 'MANIFEST_NOT_FOUND',
  MANIFEST_INVALID = 'MANIFEST_INVALID',
  PLUGIN_NOT_FOUND = 'PLUGIN_NOT_FOUND',
  PLUGIN_ALREADY_INSTALLED = 'PLUGIN_ALREADY_INSTALLED',
  INSTALL_FAILED = 'INSTALL_FAILED',
  LOAD_FAILED = 'LOAD_FAILED',
}

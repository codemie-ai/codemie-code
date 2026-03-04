/**
 * Plugin MCP Loader
 *
 * Discovers and merges MCP (Model Context Protocol) server configurations from plugins.
 * MCP servers are namespaced to avoid conflicts between plugins.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { expandPluginRootDeep } from '../core/manifest-parser.js';
import type { McpConfig, McpServerConfig, PluginManifest } from '../core/types.js';

/**
 * Load MCP server configuration from a plugin
 *
 * @param pluginDir - Absolute path to the plugin root
 * @param manifest - Parsed plugin manifest
 * @returns McpConfig with namespaced server names, or null if none found
 */
export async function loadPluginMcpServers(
  pluginDir: string,
  manifest: PluginManifest
): Promise<McpConfig | null> {
  const mcpField = manifest.mcpServers;

  // Inline MCP config in manifest
  if (mcpField && typeof mcpField === 'object' && !Array.isArray(mcpField)) {
    const config = mcpField as McpConfig;
    return namespaceMcpServers(config, manifest.name, pluginDir);
  }

  // Path(s) to MCP config files
  const mcpPaths = resolveMcpPaths(pluginDir, mcpField);

  for (const mcpPath of mcpPaths) {
    if (!existsSync(mcpPath)) continue;

    try {
      const raw = await readFile(mcpPath, 'utf-8');
      const parsed = JSON.parse(raw) as McpConfig;
      return namespaceMcpServers(parsed, manifest.name, pluginDir);
    } catch (error) {
      logger.debug(
        `[plugin] Failed to parse MCP config from ${mcpPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return null;
}

/**
 * Merge plugin MCP config into an existing MCP configuration
 *
 * @param base - Existing MCP config
 * @param pluginMcp - MCP config from a plugin (already namespaced)
 * @returns Merged MCP config
 */
export function mergeMcpConfigs(base: McpConfig, pluginMcp: McpConfig): McpConfig {
  return {
    mcpServers: {
      ...base.mcpServers,
      ...pluginMcp.mcpServers,
    },
  };
}

/**
 * Namespace MCP server names to prevent conflicts between plugins
 *
 * E.g., a server named "filesystem" in plugin "my-tools" becomes "my-tools:filesystem"
 */
function namespaceMcpServers(
  config: McpConfig,
  pluginName: string,
  pluginDir: string
): McpConfig {
  if (!config.mcpServers) {
    return { mcpServers: {} };
  }

  const namespacedServers: Record<string, McpServerConfig> = {};

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const namespacedName = `${pluginName}:${serverName}`;
    // Expand ${CLAUDE_PLUGIN_ROOT} in server config
    const expanded = expandPluginRootDeep(serverConfig, pluginDir) as McpServerConfig;
    namespacedServers[namespacedName] = expanded;
  }

  return { mcpServers: namespacedServers };
}

/**
 * Resolve MCP config file paths from manifest field or defaults
 */
function resolveMcpPaths(
  pluginDir: string,
  mcpField: string | string[] | McpConfig | undefined
): string[] {
  if (!mcpField || typeof mcpField === 'object') {
    // Default: check .mcp.json at plugin root
    return [join(pluginDir, '.mcp.json')];
  }

  const paths = Array.isArray(mcpField) ? mcpField : [mcpField];
  return paths.map(p => join(pluginDir, p));
}

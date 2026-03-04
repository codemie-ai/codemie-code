/**
 * Plugin Loader
 *
 * Loads a single plugin from a directory. Parses the manifest and discovers
 * all components (skills, commands, agents, hooks, MCP servers).
 */

import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { parseManifest } from './manifest-parser.js';
import { discoverPluginSkills, discoverPluginCommands } from '../loaders/skills-loader.js';
import { loadPluginHooks } from '../loaders/hooks-loader.js';
import { loadPluginMcpServers } from '../loaders/mcp-loader.js';
import { discoverPluginAgents } from '../loaders/agents-loader.js';
import type { LoadedPlugin, PluginSource } from './types.js';

/**
 * Load a plugin from a directory
 *
 * Parses the manifest, discovers all components (skills, commands, agents,
 * hooks, MCP servers), and returns a fully loaded plugin object.
 *
 * @param pluginDir - Absolute path to the plugin root directory
 * @param source - Where this plugin was found (local, user, project)
 * @param enabled - Whether the plugin should be enabled (default: true)
 * @returns Loaded plugin with all discovered components
 * @throws Error if the directory doesn't exist or manifest is invalid
 */
export async function loadPlugin(
  pluginDir: string,
  source: PluginSource,
  enabled: boolean = true
): Promise<LoadedPlugin> {
  if (!existsSync(pluginDir)) {
    throw new Error(`Plugin directory does not exist: ${pluginDir}`);
  }

  // Parse manifest
  const manifest = await parseManifest(pluginDir);
  logger.debug(`[plugin] Loading plugin "${manifest.name}" from ${pluginDir}`);

  // Discover all components in parallel
  const [skills, commands, agents, hooks, mcpServers] = await Promise.all([
    discoverPluginSkills(pluginDir, manifest),
    discoverPluginCommands(pluginDir, manifest),
    discoverPluginAgents(pluginDir, manifest),
    loadPluginHooks(pluginDir, manifest),
    loadPluginMcpServers(pluginDir, manifest),
  ]);

  const plugin: LoadedPlugin = {
    manifest,
    rootDir: pluginDir,
    source,
    enabled,
    skills,
    commands,
    agents,
    hooks,
    mcpServers,
  };

  logger.debug(
    `[plugin] Loaded "${manifest.name}": ${skills.length} skills, ${commands.length} commands, ${agents.length} agents`
  );

  return plugin;
}

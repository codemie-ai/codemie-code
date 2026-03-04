/**
 * Plugin Agents Loader
 *
 * Discovers agent definitions from a plugin's agents/ directory.
 * Each agent is namespaced with the plugin name.
 */

import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import fg from 'fast-glob';
import { logger } from '../../utils/logger.js';
import { parseFrontmatter, hasFrontmatter } from '../../utils/frontmatter.js';
import type { PluginAgent, PluginManifest } from '../core/types.js';

/**
 * Discover agents from a plugin directory
 *
 * Looks for *.md files in the plugin's agents/ directory (or custom paths from manifest).
 * Each agent is namespaced as "plugin-name:agent-name".
 *
 * @param pluginDir - Absolute path to the plugin root
 * @param manifest - Parsed plugin manifest
 * @returns Array of discovered plugin agents
 */
export async function discoverPluginAgents(
  pluginDir: string,
  manifest: PluginManifest
): Promise<PluginAgent[]> {
  const agentsDirs = resolveAgentDirs(pluginDir, manifest.agents);
  const agents: PluginAgent[] = [];

  for (const dir of agentsDirs) {
    try {
      const files = await fg('*.md', {
        cwd: dir,
        absolute: true,
        caseSensitiveMatch: false,
        deep: 1,
        ignore: ['**/node_modules/**', '**/.git/**'],
        onlyFiles: true,
      });

      for (const filePath of files) {
        try {
          const agent = await parsePluginAgentFile(filePath, manifest.name);
          if (agent) {
            agents.push(agent);
          }
        } catch (error) {
          logger.debug(
            `[plugin] Failed to parse agent ${filePath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch {
      // Directory doesn't exist — skip silently
    }
  }

  return agents;
}

/**
 * Parse a single agent .md file into a PluginAgent
 */
async function parsePluginAgentFile(
  filePath: string,
  pluginName: string
): Promise<PluginAgent | null> {
  const fileContent = await readFile(filePath, 'utf-8');

  let metadata: Record<string, unknown> = {};
  let content: string;

  if (hasFrontmatter(fileContent)) {
    const parsed = parseFrontmatter(fileContent, filePath);
    metadata = parsed.metadata as Record<string, unknown>;
    content = parsed.content;
  } else {
    content = fileContent.trim();
  }

  // Derive agent name from metadata or filename (without .md extension)
  const agentName = (metadata.name as string) || basename(filePath, '.md');

  if (!agentName) {
    return null;
  }

  return {
    pluginName,
    agentName,
    namespacedName: `${pluginName}:${agentName}`,
    filePath,
    content,
    metadata,
  };
}

/**
 * Resolve agent directories from manifest field or defaults
 */
function resolveAgentDirs(
  pluginDir: string,
  agentsField: string | string[] | undefined
): string[] {
  if (!agentsField) {
    return [join(pluginDir, 'agents')];
  }

  const paths = Array.isArray(agentsField) ? agentsField : [agentsField];
  return paths.map(p => join(pluginDir, p));
}

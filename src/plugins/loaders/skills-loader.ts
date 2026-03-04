/**
 * Plugin Skills Loader
 *
 * Discovers skills from a plugin's skills/ and commands/ directories.
 * Skills are namespaced with the plugin name to avoid conflicts.
 */

import { readFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import fg from 'fast-glob';
import { logger } from '../../utils/logger.js';
import { parseFrontmatter, hasFrontmatter } from '../../utils/frontmatter.js';
import type { PluginSkill, PluginCommand, PluginManifest } from '../core/types.js';

/**
 * Discover skills from a plugin directory
 *
 * Looks for SKILL.md files in the plugin's skills/ directory (or custom paths from manifest).
 * Each skill is namespaced as "plugin-name:skill-name".
 *
 * @param pluginDir - Absolute path to the plugin root
 * @param manifest - Parsed plugin manifest
 * @returns Array of discovered plugin skills
 */
export async function discoverPluginSkills(
  pluginDir: string,
  manifest: PluginManifest
): Promise<PluginSkill[]> {
  const skillsDirs = resolveComponentDirs(pluginDir, manifest.skills, 'skills');
  const skills: PluginSkill[] = [];

  for (const dir of skillsDirs) {
    try {
      const files = await fg('**/SKILL.md', {
        cwd: dir,
        absolute: true,
        caseSensitiveMatch: false,
        deep: 3,
        ignore: ['**/node_modules/**', '**/.git/**'],
        onlyFiles: true,
      });

      for (const filePath of files) {
        try {
          const skill = await parsePluginSkillFile(filePath, manifest.name);
          if (skill) {
            skills.push(skill);
          }
        } catch (error) {
          logger.debug(
            `[plugin] Failed to parse skill ${filePath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch {
      // Directory doesn't exist — skip silently
    }
  }

  return skills;
}

/**
 * Discover commands from a plugin directory
 *
 * Looks for *.md files in the plugin's commands/ directory (or custom paths from manifest).
 * Each command is namespaced as "plugin-name:command-name".
 *
 * @param pluginDir - Absolute path to the plugin root
 * @param manifest - Parsed plugin manifest
 * @returns Array of discovered plugin commands
 */
export async function discoverPluginCommands(
  pluginDir: string,
  manifest: PluginManifest
): Promise<PluginCommand[]> {
  const commandsDirs = resolveComponentDirs(pluginDir, manifest.commands, 'commands');
  const commands: PluginCommand[] = [];

  for (const dir of commandsDirs) {
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
          const command = await parsePluginCommandFile(filePath, manifest.name);
          if (command) {
            commands.push(command);
          }
        } catch (error) {
          logger.debug(
            `[plugin] Failed to parse command ${filePath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch {
      // Directory doesn't exist — skip silently
    }
  }

  return commands;
}

/**
 * Parse a single SKILL.md file into a PluginSkill
 */
async function parsePluginSkillFile(
  filePath: string,
  pluginName: string
): Promise<PluginSkill | null> {
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

  // Derive skill name from metadata or directory name
  const skillName = (metadata.name as string) || basename(dirname(filePath));

  if (!skillName) {
    return null;
  }

  return {
    pluginName,
    skillName,
    namespacedName: `${pluginName}:${skillName}`,
    filePath,
    content,
    metadata,
  };
}

/**
 * Parse a single command .md file into a PluginCommand
 */
async function parsePluginCommandFile(
  filePath: string,
  pluginName: string
): Promise<PluginCommand | null> {
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

  // Derive command name from metadata or filename (without .md extension)
  const commandName = (metadata.name as string) || basename(filePath, '.md');

  if (!commandName) {
    return null;
  }

  return {
    pluginName,
    commandName,
    namespacedName: `${pluginName}:${commandName}`,
    filePath,
    content,
    metadata,
  };
}

/**
 * Resolve component directories from manifest field or defaults
 *
 * @param pluginDir - Plugin root directory
 * @param manifestField - Value from manifest (string, string[], or undefined)
 * @param defaultDir - Default directory name (e.g., 'skills', 'commands')
 * @returns Array of absolute directory paths to scan
 */
function resolveComponentDirs(
  pluginDir: string,
  manifestField: string | string[] | undefined,
  defaultDir: string
): string[] {
  if (!manifestField) {
    return [join(pluginDir, defaultDir)];
  }

  const paths = Array.isArray(manifestField) ? manifestField : [manifestField];
  return paths.map(p => join(pluginDir, p));
}

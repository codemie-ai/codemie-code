import { join } from 'path';
import fg from 'fast-glob';
import type { DiscoveredPlugin, LoadedPlugin } from './types.js';

/**
 * Plugin loader
 *
 * Loads plugin resources (skills, future: commands, hooks, MCP, LSP).
 * Phase 1: Skills only
 */
export class PluginLoader {
  private cache: Map<string, LoadedPlugin> = new Map();

  /**
   * Load a plugin's resources
   *
   * @param plugin - Discovered plugin to load
   * @returns Loaded plugin with resources
   */
  async loadPlugin(plugin: DiscoveredPlugin): Promise<LoadedPlugin> {
    // Check cache
    const cacheKey = `${plugin.name}::${plugin.path}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const loadErrors: string[] = [];
    let skillNames: string[] = [];

    // Load skills if plugin has skills capability
    const hasSkills =
      plugin.manifest.capabilities?.skills !== false &&
      (await this.hasSkillsDirectory(plugin.path));

    if (hasSkills) {
      try {
        skillNames = await this.discoverSkillNames(plugin.path);
      } catch (error) {
        loadErrors.push(
          `Failed to load skills: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const loaded: LoadedPlugin = {
      ...plugin,
      skillNames,
      skillCount: skillNames.length,
      loadedAt: new Date().toISOString(),
      loadErrors,
    };

    // Cache result
    this.cache.set(cacheKey, loaded);

    return loaded;
  }

  /**
   * Check if a plugin has a skills directory
   *
   * @param pluginPath - Plugin directory path
   * @returns true if skills/ directory exists
   */
  private async hasSkillsDirectory(pluginPath: string): Promise<boolean> {
    try {
      const skillsDir = join(pluginPath, 'skills');
      const pattern = '**/SKILL.md';
      const files = await fg(pattern, {
        cwd: skillsDir,
        caseSensitiveMatch: false,
        onlyFiles: true,
        deep: 3,
      });
      return files.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Discover skill names from a plugin
   *
   * Skills are located in plugin/skills/{skill-name}/SKILL.md
   *
   * @param pluginPath - Plugin directory path
   * @returns Array of skill names
   */
  private async discoverSkillNames(pluginPath: string): Promise<string[]> {
    const skillsDir = join(pluginPath, 'skills');

    try {
      const pattern = '**/SKILL.md';
      const files = await fg(pattern, {
        cwd: skillsDir,
        caseSensitiveMatch: false,
        onlyFiles: true,
        absolute: false,
        deep: 3,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      // Extract skill names from paths (e.g., "my-skill/SKILL.md" -> "my-skill")
      const skillNames = files.map((file) => {
        const parts = file.split('/');
        // If SKILL.md is at root of skills/, use the directory name
        if (parts.length === 1) {
          return 'default';
        }
        return parts[0];
      });

      // Deduplicate and filter
      return [...new Set(skillNames)].filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the skills directory for a plugin
   *
   * @param pluginPath - Plugin directory path
   * @returns Absolute path to skills directory
   */
  static getSkillsDir(pluginPath: string): string {
    return join(pluginPath, 'skills');
  }

  /**
   * Get the path to a specific skill within a plugin
   *
   * @param pluginPath - Plugin directory path
   * @param skillName - Skill name
   * @returns Absolute path to skill directory
   */
  static getSkillPath(pluginPath: string, skillName: string): string {
    return join(pluginPath, 'skills', skillName);
  }

  /**
   * Clear loader cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

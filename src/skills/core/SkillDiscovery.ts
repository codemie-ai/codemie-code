import { readFile } from 'fs/promises';
import { join } from 'path';
import fg from 'fast-glob';
import { getCodemiePath } from '../../utils/paths.js';
import { parseFrontmatter, FrontmatterParseError } from '../utils/frontmatter.js';
import { SkillMetadataSchema } from './types.js';
import type {
  Skill,
  SkillMetadata,
  SkillSource,
  SkillParseResult,
  SkillDiscoveryOptions,
} from './types.js';

/**
 * Priority multipliers for skill sources
 * Higher priority = loaded first, can override lower priority
 */
const SOURCE_PRIORITY: Record<SkillSource, number> = {
  project: 1000, // Highest priority
  'mode-specific': 500, // Medium priority
  global: 100, // Lowest priority
};

/**
 * Skill discovery engine
 *
 * Discovers SKILL.md files from multiple locations, parses frontmatter,
 * validates metadata, and applies priority sorting.
 */
export class SkillDiscovery {
  private cache: Map<string, Skill[]> = new Map();

  /**
   * Discover all skills matching the given options
   *
   * @param options - Discovery options (cwd, mode, agent, forceReload)
   * @returns Array of discovered and validated skills, sorted by priority
   */
  async discoverSkills(options: SkillDiscoveryOptions = {}): Promise<Skill[]> {
    const { cwd = process.cwd(), forceReload = false } = options;

    // Check cache first
    const cacheKey = this.getCacheKey(options);
    if (!forceReload && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Discover from all locations
    const [projectSkills, modeSkills, globalSkills] = await Promise.all([
      this.discoverProjectSkills(cwd),
      this.discoverModeSkills(options.mode),
      this.discoverGlobalSkills(),
    ]);

    // Combine and deduplicate by name (higher priority wins)
    const allSkills = [...projectSkills, ...modeSkills, ...globalSkills];
    const deduplicatedSkills = this.deduplicateSkills(allSkills);

    // Filter by agent if specified
    let filteredSkills = deduplicatedSkills;
    if (options.agentName) {
      filteredSkills = this.filterByAgent(deduplicatedSkills, options.agentName);
    }

    // Filter by mode if specified
    if (options.mode) {
      filteredSkills = this.filterByMode(filteredSkills, options.mode);
    }

    // Sort by computed priority (descending)
    const sortedSkills = this.sortByPriority(filteredSkills);

    // Cache result
    this.cache.set(cacheKey, sortedSkills);

    return sortedSkills;
  }

  /**
   * Discover skills from project directory (.codemie/skills/)
   */
  private async discoverProjectSkills(cwd: string): Promise<Skill[]> {
    const projectSkillsDir = join(cwd, '.codemie', 'skills');
    return this.discoverFromDirectory(projectSkillsDir, 'project');
  }

  /**
   * Discover skills from mode-specific directory (~/.codemie/skills-{mode}/)
   */
  private async discoverModeSkills(mode?: string): Promise<Skill[]> {
    if (!mode) return [];

    const modeSkillsDir = getCodemiePath(`skills-${mode}`);
    return this.discoverFromDirectory(modeSkillsDir, 'mode-specific');
  }

  /**
   * Discover skills from global directory (~/.codemie/skills/)
   */
  private async discoverGlobalSkills(): Promise<Skill[]> {
    const globalSkillsDir = getCodemiePath('skills');
    return this.discoverFromDirectory(globalSkillsDir, 'global');
  }

  /**
   * Discover skills from a specific directory
   *
   * @param directory - Directory to search
   * @param source - Source type (project, mode-specific, global)
   * @returns Array of discovered skills
   */
  private async discoverFromDirectory(
    directory: string,
    source: SkillSource
  ): Promise<Skill[]> {
    try {
      // Find all SKILL.md files (case-insensitive, up to 3 levels deep)
      const pattern = '**/SKILL.md';
      const files = await fg(pattern, {
        cwd: directory,
        absolute: true,
        caseSensitiveMatch: false,
        deep: 3,
        ignore: ['**/node_modules/**', '**/.git/**'],
        onlyFiles: true,
      });

      // Parse all skill files
      const parseResults = await Promise.all(
        files.map((filePath) => this.parseSkillFile(filePath, source))
      );

      // Filter out errors and return valid skills
      const skills = parseResults
        .filter((result): result is { skill: Skill } => result.skill !== undefined)
        .map((result) => result.skill);

      return skills;
    } catch {
      // Directory doesn't exist or other error - return empty array
      return [];
    }
  }

  /**
   * Parse a single skill file
   *
   * @param filePath - Absolute path to SKILL.md
   * @param source - Source type
   * @returns Parse result with skill or error
   */
  private async parseSkillFile(
    filePath: string,
    source: SkillSource
  ): Promise<SkillParseResult> {
    try {
      // Read file
      const fileContent = await readFile(filePath, 'utf-8');

      // Parse frontmatter
      const { metadata, content } = parseFrontmatter(fileContent, filePath);

      // Validate metadata with Zod
      const validatedMetadata = SkillMetadataSchema.parse(metadata);

      // Compute priority
      const computedPriority = this.computePriority(validatedMetadata, source);

      // Create skill object
      const skill: Skill = {
        metadata: validatedMetadata,
        content: content.trim(),
        filePath,
        source,
        computedPriority,
      };

      return { skill };
    } catch (error) {
      // Log error but don't throw - allow partial discovery
      const errorMessage =
        error instanceof FrontmatterParseError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);

      return {
        error: {
          filePath,
          message: errorMessage,
          cause: error,
        },
      };
    }
  }

  /**
   * Compute priority for a skill
   *
   * Priority = source base priority + metadata priority
   */
  private computePriority(metadata: SkillMetadata, source: SkillSource): number {
    const sourceBasePriority = SOURCE_PRIORITY[source];
    const metadataPriority = metadata.priority || 0;
    return sourceBasePriority + metadataPriority;
  }

  /**
   * Deduplicate skills by name (higher priority wins)
   */
  private deduplicateSkills(skills: Skill[]): Skill[] {
    const skillMap = new Map<string, Skill>();

    for (const skill of skills) {
      const existingSkill = skillMap.get(skill.metadata.name);

      if (!existingSkill || skill.computedPriority > existingSkill.computedPriority) {
        skillMap.set(skill.metadata.name, skill);
      }
    }

    return Array.from(skillMap.values());
  }

  /**
   * Filter skills by agent compatibility
   */
  private filterByAgent(skills: Skill[], agentName: string): Skill[] {
    return skills.filter((skill) => {
      // If no compatibility specified, skill is compatible with all agents
      if (!skill.metadata.compatibility?.agents) {
        return true;
      }

      // Check if agent is in compatibility list
      return skill.metadata.compatibility.agents.includes(agentName);
    });
  }

  /**
   * Filter skills by mode
   */
  private filterByMode(skills: Skill[], mode: string): Skill[] {
    return skills.filter((skill) => {
      // If no modes specified, skill is available in all modes
      if (!skill.metadata.modes || skill.metadata.modes.length === 0) {
        return true;
      }

      // Check if mode is in modes list
      return skill.metadata.modes.includes(mode);
    });
  }

  /**
   * Sort skills by computed priority (descending)
   */
  private sortByPriority(skills: Skill[]): Skill[] {
    return [...skills].sort((a, b) => b.computedPriority - a.computedPriority);
  }

  /**
   * Generate cache key from options
   */
  private getCacheKey(options: SkillDiscoveryOptions): string {
    const { cwd = process.cwd(), mode, agentName } = options;
    return `${cwd}::${mode || ''}::${agentName || ''}`;
  }

  /**
   * Clear cache (force reload on next discovery)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics (for debugging)
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

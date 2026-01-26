import { SkillDiscovery } from './SkillDiscovery.js';
import type {
  Skill,
  SkillDiscoveryOptions,
  SkillValidationResult,
} from './types.js';

/**
 * Skill manager singleton
 *
 * Provides high-level API for skill management:
 * - Discovery and caching
 * - Agent-aware filtering
 * - Validation
 * - Cache management
 */
export class SkillManager {
  private static instance: SkillManager;
  private discovery: SkillDiscovery;

  /**
   * Private constructor (singleton pattern)
   */
  private constructor() {
    this.discovery = new SkillDiscovery();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): SkillManager {
    if (!SkillManager.instance) {
      SkillManager.instance = new SkillManager();
    }
    return SkillManager.instance;
  }

  /**
   * Get skills for a specific agent
   *
   * @param agentName - Name of the agent (e.g., 'codemie-code')
   * @param options - Additional discovery options
   * @returns Array of skills compatible with the agent
   */
  async getSkillsForAgent(
    agentName: string,
    options: Omit<SkillDiscoveryOptions, 'agentName'> = {}
  ): Promise<Skill[]> {
    return this.discovery.discoverSkills({
      ...options,
      agentName,
    });
  }

  /**
   * Get a specific skill by name
   *
   * @param name - Skill name
   * @param options - Discovery options
   * @returns Skill if found, undefined otherwise
   */
  async getSkillByName(
    name: string,
    options: SkillDiscoveryOptions = {}
  ): Promise<Skill | undefined> {
    const skills = await this.discovery.discoverSkills(options);
    return skills.find((skill) => skill.metadata.name === name);
  }

  /**
   * List all discovered skills
   *
   * @param options - Discovery options
   * @returns Array of all skills
   */
  async listSkills(options: SkillDiscoveryOptions = {}): Promise<Skill[]> {
    return this.discovery.discoverSkills(options);
  }

  /**
   * Reload skills (clear cache and force re-discovery)
   *
   * Call this after adding/removing/modifying skill files
   */
  reload(): void {
    this.discovery.clearCache();
  }

  /**
   * Validate all skill files
   *
   * Attempts to discover and parse all skills, returning validation results
   *
   * @param options - Discovery options
   * @returns Validation results for all skills
   */
  async validateAll(
    options: SkillDiscoveryOptions = {}
  ): Promise<{ valid: Skill[]; invalid: SkillValidationResult[] }> {
    try {
      // Force reload to ensure fresh validation
      const skills = await this.discovery.discoverSkills({
        ...options,
        forceReload: true,
      });

      // All discovered skills are valid (parsing errors are filtered out in discovery)
      const valid = skills;

      // For now, we don't track invalid skills (they're silently filtered)
      // Future enhancement: return parse errors from discovery
      const invalid: SkillValidationResult[] = [];

      return { valid, invalid };
    } catch (error) {
      // Discovery failed entirely
      return {
        valid: [],
        invalid: [
          {
            valid: false,
            filePath: 'unknown',
            errors: [
              error instanceof Error ? error.message : String(error),
            ],
          },
        ],
      };
    }
  }

  /**
   * Get cache statistics (for debugging)
   */
  getCacheStats(): { size: number; keys: string[] } {
    return this.discovery.getCacheStats();
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    SkillManager.instance = undefined as unknown as SkillManager;
  }
}

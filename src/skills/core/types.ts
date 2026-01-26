import { z } from 'zod';

/**
 * Zod schema for skill metadata (frontmatter)
 */
export const SkillMetadataSchema = z.object({
  name: z.string().min(1, 'Skill name is required'),
  description: z.string().min(1, 'Skill description is required'),
  version: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  modes: z.array(z.string()).optional(),
  compatibility: z
    .object({
      agents: z.array(z.string()).optional(),
      minVersion: z.string().optional(),
    })
    .optional(),
  priority: z.number().default(0),
});

/**
 * TypeScript interface for skill metadata
 */
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

/**
 * Source type for a skill
 */
export type SkillSource = 'global' | 'project' | 'mode-specific';

/**
 * Complete skill with metadata, content, and location info
 */
export interface Skill {
  /** Parsed and validated metadata from YAML frontmatter */
  metadata: SkillMetadata;

  /** Markdown content (body after frontmatter) */
  content: string;

  /** Absolute path to the SKILL.md file */
  filePath: string;

  /** Where this skill was discovered from */
  source: SkillSource;

  /** Computed priority (source-based + metadata priority) */
  computedPriority: number;
}

/**
 * Result of parsing a skill file
 */
export interface SkillParseResult {
  skill?: Skill;
  error?: {
    filePath: string;
    message: string;
    cause?: unknown;
  };
}

/**
 * Options for skill discovery
 */
export interface SkillDiscoveryOptions {
  /** Working directory (for project-level skills) */
  cwd?: string;

  /** Filter by mode (e.g., 'code', 'architect') */
  mode?: string;

  /** Filter by agent name */
  agentName?: string;

  /** Force cache reload */
  forceReload?: boolean;
}

/**
 * Validation result for a skill
 */
export interface SkillValidationResult {
  valid: boolean;
  filePath: string;
  skillName?: string;
  errors: string[];
}

/**
 * Configuration for skills in agent config
 */
export interface SkillsConfig {
  /** Enable/disable skill loading */
  enabled?: boolean;

  /** Mode for mode-specific skills */
  mode?: string;

  /** Auto-reload on file changes (future feature) */
  autoReload?: boolean;
}

/**
 * Skills System - Public API
 *
 * Provides skill discovery, loading, and management for CodeMie agents.
 */

// Core exports
export { SkillManager } from './core/SkillManager.js';
export { SkillDiscovery } from './core/SkillDiscovery.js';

// Type exports
export type {
  Skill,
  SkillMetadata,
  SkillSource,
  SkillParseResult,
  SkillDiscoveryOptions,
  SkillValidationResult,
  SkillsConfig,
} from './core/types.js';
export { SkillMetadataSchema } from './core/types.js';

// Utility exports
export {
  parseFrontmatter,
  hasFrontmatter,
  extractMetadata,
  extractContent,
  FrontmatterParseError,
} from './utils/frontmatter.js';
export type { FrontmatterResult } from './utils/frontmatter.js';

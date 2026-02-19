/**
 * Skills System - Public API
 *
 * Provides skill discovery, loading, and management for CodeMie agents.
 */

// Core exports
export { SkillManager } from './core/SkillManager.js';
export { SkillDiscovery } from './core/SkillDiscovery.js';

// Sync exports
export { SkillSync } from './sync/SkillSync.js';
export type { SyncOptions, SyncResult } from './sync/SkillSync.js';

// Type exports
export type {
  Skill,
  SkillMetadata,
  SkillSource,
  SkillParseResult,
  SkillDiscoveryOptions,
  SkillValidationResult,
  SkillsConfig,
  PluginSkillInfo,
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

// Pattern matcher exports
export {
  extractSkillPatterns,
  isValidSkillName,
  isValidNamespacedSkillName,
  parseNamespacedSkillName,
} from './utils/pattern-matcher.js';
export type { SkillPattern, PatternMatchResult } from './utils/pattern-matcher.js';

/**
 * Re-export from shared utils location
 *
 * The frontmatter parser has been moved to src/utils/frontmatter.ts
 * so it can be shared across the codebase without architecture violations.
 */
export {
  parseFrontmatter,
  hasFrontmatter,
  extractMetadata,
  extractContent,
  FrontmatterParseError,
} from '../../../../utils/frontmatter.js';

export type { FrontmatterResult } from '../../../../utils/frontmatter.js';

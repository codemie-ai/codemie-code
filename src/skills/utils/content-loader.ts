/**
 * Content loader for skill files and inventory
 *
 * Loads skill content and builds file inventories for pattern-based invocation.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Skill } from '../core/types.js';
import { logger } from '../../utils/logger.js';

/**
 * Skill with file inventory
 */
export interface SkillWithInventory {
  /** Base skill metadata and content */
  skill: Skill;
  /** Relative file paths (excluding SKILL.md) */
  files: string[];
  /** Formatted content ready for prompt injection */
  formattedContent: string;
}

/**
 * File extensions to include in inventory
 */
const INCLUDED_EXTENSIONS = new Set([
  '.md',
  '.sh',
  '.js',
  '.ts',
  '.py',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.txt',
]);

/**
 * Directories to exclude from inventory
 */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * Maximum depth for file scanning (prevent infinite loops)
 */
const MAX_DEPTH = 5;

/**
 * Load a skill with its file inventory
 *
 * @param skill - Skill to load inventory for
 * @returns Skill with file inventory and formatted content
 */
export async function loadSkillWithInventory(
  skill: Skill
): Promise<SkillWithInventory> {
  // Get skill directory from SKILL.md path
  const skillDirectory = path.dirname(skill.filePath);

  // Build file inventory
  const files = await buildFileInventory(skillDirectory);

  // Format content for injection
  const formattedContent = formatSkillContent(skill, files);

  return {
    skill,
    files,
    formattedContent,
  };
}

/**
 * Build file inventory for a skill directory
 *
 * @param skillDirectoryPath - Absolute path to skill directory
 * @returns Array of relative file paths (sorted alphabetically)
 */
async function buildFileInventory(
  skillDirectoryPath: string
): Promise<string[]> {
  const files: string[] = [];

  try {
    // Check if directory exists
    if (!fs.existsSync(skillDirectoryPath)) {
      logger.warn(`Skill directory not found: ${skillDirectoryPath}`);
      return [];
    }

    // Scan directory recursively
    await scanDirectory(skillDirectoryPath, skillDirectoryPath, files, 0);

    // Sort alphabetically for consistent output
    files.sort();

    return files;
  } catch (error) {
    logger.warn(
      `Failed to build file inventory for ${skillDirectoryPath}:`,
      error
    );
    return [];
  }
}

/**
 * Recursively scan a directory for files
 *
 * @param basePath - Base skill directory path
 * @param currentPath - Current directory being scanned
 * @param files - Accumulator for discovered files
 * @param depth - Current recursion depth
 */
async function scanDirectory(
  basePath: string,
  currentPath: string,
  files: string[],
  depth: number
): Promise<void> {
  // Prevent infinite loops
  if (depth >= MAX_DEPTH) {
    return;
  }

  try {
    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      // Skip hidden files/directories
      if (entry.name.startsWith('.')) {
        continue;
      }

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }

        // Recurse into subdirectory
        await scanDirectory(basePath, fullPath, files, depth + 1);
      } else if (entry.isFile()) {
        // Skip SKILL.md (already loaded)
        if (entry.name === 'SKILL.md') {
          continue;
        }

        // Check file extension
        const ext = path.extname(entry.name);
        if (INCLUDED_EXTENSIONS.has(ext)) {
          // Store relative path
          const relativePath = path.relative(basePath, fullPath);
          files.push(relativePath);
        }
      }
      // Skip symbolic links (avoid loops)
    }
  } catch (error) {
    // Permission errors or other issues - log and continue
    logger.debug(
      `Failed to scan directory ${currentPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Format skill content for prompt injection
 *
 * @param skill - Skill to format
 * @param files - File inventory
 * @returns Formatted markdown content
 */
function formatSkillContent(skill: Skill, files: string[]): string {
  const parts: string[] = [];

  // Header
  parts.push(`## Skill: ${skill.metadata.name}`);
  parts.push('');
  parts.push(skill.metadata.description);
  parts.push('');

  // Skill content
  parts.push('### SKILL.md Content');
  parts.push('');
  parts.push(skill.content);
  parts.push('');

  // File inventory (if any)
  if (files.length > 0) {
    parts.push('### Available Files');
    parts.push('');
    parts.push(
      'The following files are available in this skill directory.'
    );
    parts.push('Use the Read tool to access their content when needed:');
    parts.push('');

    for (const file of files) {
      parts.push(`- ${file}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Extensions Scan Utilities
 *
 * Scans agent extension directories at project and global levels.
 * Reports counts and names of agents, commands, skills, hooks, and rules installed.
 *
 * Agent-agnostic: each agent declares its own directory paths via AgentExtensionsConfig.
 *
 * Security Notes:
 * - ONLY counts/names files, never reads their contents
 * - All failures return zero counts and empty name arrays (graceful degradation)
 */

import { readdir } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';
import type { AgentExtensionsConfig, ExtensionsCount, ExtensionsNames, ExtensionsScanSummary } from '../agents/core/types.js';

// Re-export types for convenience
export type { AgentExtensionsConfig, ExtensionsCount, ExtensionsNames, ExtensionsScanSummary };

// ============================================================================
// Constants
// ============================================================================

const SCRIPT_EXTENSIONS = new Set(['.sh', '.js', '.py', '.ts']);

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve extensions base directory path
 * Handles '~/' prefix (home-relative) and relative paths from cwd
 */
function resolveExtensionsPath(dirPath: string, cwd: string): string {
  if (dirPath.startsWith('~/')) {
    return path.join(homedir(), dirPath.slice(2));
  }
  if (path.isAbsolute(dirPath)) {
    return dirPath;
  }
  return path.join(cwd, dirPath);
}

// ============================================================================
// File Listing
// ============================================================================

/**
 * List markdown files recursively in a directory, returning their names.
 *
 * @param dirPath - Directory to scan
 * @param exactName - If provided, only match files with this exact name (case-insensitive).
 *                    When set (e.g. 'SKILL.md'), the returned name is the parent directory
 *                    name — i.e. the skill's directory name, not the entry file itself.
 *                    When unset, the name is the filename without the .md extension.
 */
async function listMdFiles(dirPath: string, exactName?: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { recursive: true, withFileTypes: true });
    const names: string[] = [];

    for (const e of entries) {
      if (!e.isFile()) continue;
      const lowerName = e.name.toLowerCase();

      if (exactName) {
        // Skill-directory pattern: SKILL.md lives inside a named skill subdirectory.
        // The meaningful name is the parent directory (the skill name), not the file.
        if (lowerName === exactName.toLowerCase()) {
          names.push(path.basename(e.parentPath));
        }
      } else {
        if (lowerName.endsWith('.md') && lowerName !== 'readme.md') {
          names.push(e.name.slice(0, -3)); // strip .md extension
        }
      }
    }

    return names;
  } catch {
    return [];
  }
}

/**
 * List script files (.sh, .js, .py, .ts) recursively in a directory
 * Used for hooks directory
 */
async function listScriptFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { recursive: true, withFileTypes: true });
    return entries
      .filter(e => e.isFile() && SCRIPT_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      .map(e => e.name);
  } catch {
    return [];
  }
}

// ============================================================================
// Directory Scanning
// ============================================================================

/**
 * Scan an agent's extension base directory and return counts and names per category.
 * Each subdirectory (agents/, commands/, skills/, hooks/, rules/) is scanned independently.
 *
 * @param baseDir - Resolved absolute path to the agent's extensions base directory
 * @param skillsEntryFile - If set, only count/name skills files with this exact name (e.g. 'SKILL.md')
 */
async function scanExtensionsDir(
  baseDir: string,
  skillsEntryFile?: string
): Promise<{ counts: ExtensionsCount; names: ExtensionsNames }> {
  const [agents, commands, skills, hooks, rules] = await Promise.all([
    listMdFiles(path.join(baseDir, 'agents')),
    listMdFiles(path.join(baseDir, 'commands')),
    listMdFiles(path.join(baseDir, 'skills'), skillsEntryFile),
    listScriptFiles(path.join(baseDir, 'hooks')),
    listMdFiles(path.join(baseDir, 'rules')),
  ]);

  return {
    counts: {
      agents: agents.length,
      commands: commands.length,
      skills: skills.length,
      hooks: hooks.length,
      rules: rules.length,
    },
    names: {
      agents: agents.sort(),
      commands: commands.sort(),
      skills: skills.sort(),
      hooks: hooks.sort(),
      rules: rules.sort(),
    },
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Scan agent extension directories at project and global levels
 *
 * Main entry point for metrics integration.
 * Uses agent-declared paths from AgentExtensionsConfig (set in agent metadata).
 * Returns empty counts and empty name arrays for any scope not declared by the agent.
 *
 * @param extensionsConfig - Agent's extensions directory config (from metadata)
 * @param cwd - Current working directory (for resolving relative project paths)
 * @returns ExtensionsScanSummary with counts and names per scope
 */
export async function getExtensionsScanSummary(
  extensionsConfig: AgentExtensionsConfig | undefined,
  cwd: string
): Promise<ExtensionsScanSummary> {
  const emptyCount: ExtensionsCount = { agents: 0, commands: 0, skills: 0, hooks: 0, rules: 0 };
  const emptyNames: ExtensionsNames = { agents: [], commands: [], skills: [], hooks: [], rules: [] };

  if (!extensionsConfig) {
    return {
      project: { ...emptyCount },
      global: { ...emptyCount },
      projectNames: { ...emptyNames },
      globalNames: { ...emptyNames },
    };
  }

  try {
    const { skillsEntryFile } = extensionsConfig;

    const [projectResult, globalResult] = await Promise.all([
      extensionsConfig.project
        ? scanExtensionsDir(resolveExtensionsPath(extensionsConfig.project, cwd), skillsEntryFile)
        : Promise.resolve({ counts: { ...emptyCount }, names: { ...emptyNames } }),
      extensionsConfig.global
        ? scanExtensionsDir(resolveExtensionsPath(extensionsConfig.global, cwd), skillsEntryFile)
        : Promise.resolve({ counts: { ...emptyCount }, names: { ...emptyNames } }),
    ]);

    logger.debug('[extensions-scan] Scan complete', {
      project: projectResult.counts,
      global: globalResult.counts,
    });

    return {
      project: projectResult.counts,
      global: globalResult.counts,
      projectNames: projectResult.names,
      globalNames: globalResult.names,
    };
  } catch (error) {
    logger.debug('[extensions-scan] Unexpected error:', error);
    return {
      project: { ...emptyCount },
      global: { ...emptyCount },
      projectNames: { ...emptyNames },
      globalNames: { ...emptyNames },
    };
  }
}

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

/** Subdirectory names scanned per category when an agent declares no override. */
const DEFAULT_DIR_NAMES: Required<NonNullable<AgentExtensionsConfig['dirNames']>> = {
  agents: ['agents'],
  commands: ['commands'],
  skills: ['skills'],
  hooks: ['hooks'],
  rules: ['rules'],
};

/**
 * Merge per-directory results, dropping a name only when an EARLIER directory
 * already supplied it.
 *
 * De-duplication is deliberately across directories, never within one. A single
 * directory is listed recursively, so `commands/a/build.md` and
 * `commands/b/build.md` are two distinct extensions that both must count —
 * flattening into one Set collapsed them and silently shrank commands_count /
 * agents_count for every agent that uses namespaced subdirectories. Only the
 * cross-directory case (the same extension found under two spellings, e.g.
 * `agent/` and `agents/`) is a genuine duplicate.
 */
function mergeNames(results: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const names of results) {
    merged.push(...names.filter(name => !seen.has(name)));
    for (const name of names) {
      seen.add(name);
    }
  }

  return merged.sort();
}

/**
 * Scan an agent's extension base directories and return counts and names per category.
 *
 * Each category may map to several subdirectory names (see
 * AgentExtensionsConfig.dirNames) and each scope may span several base
 * directories; everything is scanned and merged, with names de-duplicated so an
 * extension present under two spellings is not counted twice.
 *
 * @param baseDirs - Resolved absolute paths to scan for this scope
 * @param config - The agent's extensions config (dirNames, skillsEntryFile)
 */
async function scanExtensionsDirs(
  baseDirs: string[],
  config: AgentExtensionsConfig
): Promise<{ counts: ExtensionsCount; names: ExtensionsNames }> {
  const dirNames = { ...DEFAULT_DIR_NAMES, ...config.dirNames };
  const { skillsEntryFile } = config;

  /** Every (baseDir, subdirectory) pair to scan for one category. */
  const targets = (category: keyof typeof dirNames): string[] =>
    baseDirs.flatMap(baseDir => dirNames[category].map(name => path.join(baseDir, name)));

  const [agents, commands, skills, hooks, rules] = await Promise.all([
    Promise.all(targets('agents').map(dir => listMdFiles(dir))).then(mergeNames),
    Promise.all(targets('commands').map(dir => listMdFiles(dir))).then(mergeNames),
    Promise.all(targets('skills').map(dir => listMdFiles(dir, skillsEntryFile))).then(mergeNames),
    Promise.all(targets('hooks').map(dir => listScriptFiles(dir))).then(mergeNames),
    Promise.all(targets('rules').map(dir => listMdFiles(dir))).then(mergeNames),
  ]);

  return {
    counts: {
      agents: agents.length,
      commands: commands.length,
      skills: skills.length,
      hooks: hooks.length,
      rules: rules.length,
    },
    names: { agents, commands, skills, hooks, rules },
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
    const resolveScope = (primary: string | undefined, extras: string[] | undefined): string[] =>
      [primary, ...(extras ?? [])]
        .filter((dir): dir is string => Boolean(dir))
        .map(dir => resolveExtensionsPath(dir, cwd));

    const projectDirs = resolveScope(extensionsConfig.project, extensionsConfig.extraProjectDirs);
    const globalDirs = resolveScope(extensionsConfig.global, extensionsConfig.extraGlobalDirs);

    const [projectResult, globalResult] = await Promise.all([
      projectDirs.length > 0
        ? scanExtensionsDirs(projectDirs, extensionsConfig)
        : Promise.resolve({ counts: { ...emptyCount }, names: { ...emptyNames } }),
      globalDirs.length > 0
        ? scanExtensionsDirs(globalDirs, extensionsConfig)
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

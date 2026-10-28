/**
 * CodeMie-owned preferences for Claude Code analytics collection (AC1/AC2/AC3).
 *
 * Unlike the allowlist in `claude-code-otlp.allowlist.ts`, which is stored inside Claude Code's
 * own `~/.claude/settings.json`, these preferences live in a dedicated CodeMie file
 * (`getCodemiePath('claude-analytics.json')`) so that `connect`/`disconnect`/`--scope user` never
 * touch them. Absent or empty is identical to today's behavior (`enabled: true`, nothing
 * excluded) — this file adds new rules, it never narrows existing tracking on its own.
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { canonicalizePath, isPathInside } from '@/agents/core/project-allowlist.js';

const CONFIG_VERSION = 1;

export interface ClaudeAnalyticsPreferences {
  version: 1;
  enabled: boolean;
  excludedProjects: string[];
}

export const DEFAULT_CLAUDE_ANALYTICS_PREFERENCES: ClaudeAnalyticsPreferences = {
  version: 1,
  enabled: true,
  excludedProjects: [],
};

export type ClaudeAnalyticsPreferencesState =
  | { kind: 'ok'; value: ClaudeAnalyticsPreferences }
  | { kind: 'corrupt' };

export function getClaudeAnalyticsPreferencesPath(): string {
  return getCodemiePath('claude-analytics.json');
}

function isValidPreferences(value: unknown): value is Partial<ClaudeAnalyticsPreferences> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') {
    return false;
  }
  if (v.excludedProjects !== undefined) {
    if (!Array.isArray(v.excludedProjects)) {
      return false;
    }
    if (!v.excludedProjects.every((p) => typeof p === 'string' && p.length > 0 && isAbsolute(p))) {
      return false;
    }
  }
  return true;
}

/**
 * Reads the preferences file. Never throws.
 *
 * - Absent or empty file -> defaults (identical to today's behavior).
 * - Present but unparsable, wrong shape, or a present key with the wrong type -> `'corrupt'`.
 *   The hook-side caller must fail closed (not tracked); a CLI write must refuse to overwrite it.
 */
export async function readClaudeAnalyticsPreferences(): Promise<ClaudeAnalyticsPreferencesState> {
  let raw: string;
  try {
    raw = await readFile(getClaudeAnalyticsPreferencesPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', value: DEFAULT_CLAUDE_ANALYTICS_PREFERENCES };
    }
    logger.debug('[claude-code-otlp preferences] Failed to read preferences, treating as corrupt');
    return { kind: 'corrupt' };
  }

  if (raw.trim().length === 0) {
    return { kind: 'ok', value: DEFAULT_CLAUDE_ANALYTICS_PREFERENCES };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }

  if (!isValidPreferences(parsed)) {
    return { kind: 'corrupt' };
  }

  return {
    kind: 'ok',
    value: {
      version: CONFIG_VERSION,
      enabled: parsed.enabled ?? DEFAULT_CLAUDE_ANALYTICS_PREFERENCES.enabled,
      excludedProjects: parsed.excludedProjects ?? DEFAULT_CLAUDE_ANALYTICS_PREFERENCES.excludedProjects,
    },
  };
}

/**
 * Reads the current preferences (defaults if absent), applies `mutate`, and writes the result
 * atomically (temp file + rename). Throws `ConfigurationError` if the existing file is corrupt —
 * the bytes on disk are never touched in that case.
 */
export async function updateClaudeAnalyticsPreferences(
  mutate: (current: ClaudeAnalyticsPreferences) => ClaudeAnalyticsPreferences | Promise<ClaudeAnalyticsPreferences>
): Promise<ClaudeAnalyticsPreferences> {
  const path = getClaudeAnalyticsPreferencesPath();
  const current = await readClaudeAnalyticsPreferences();
  if (current.kind === 'corrupt') {
    throw new ConfigurationError(
      `Claude analytics preferences are corrupt and were not changed: ${path}. Fix or delete it, then retry.`
    );
  }

  const next = await mutate(current.value);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(next, null, 2), 'utf-8');
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  return next;
}

/** True if `cwd` is inside (or equal to) any entry in `excludedProjects`. */
export async function isProjectExcluded(cwd: string | undefined, excludedProjects: string[]): Promise<boolean> {
  if (!cwd) {
    return false;
  }
  const canonicalCwd = await canonicalizePath(cwd);
  for (const entry of excludedProjects) {
    if (isPathInside(canonicalCwd, await canonicalizePath(entry))) {
      return true;
    }
  }
  return false;
}

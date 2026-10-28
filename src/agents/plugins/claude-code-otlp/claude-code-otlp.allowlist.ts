/**
 * Per-project allowlist for Claude Code OTLP analytics.
 *
 * The allowlist is a JSON array of absolute paths stored as a string in
 * `~/.claude/settings.json` -> `env.CODEMIE_ANALYTICS_PROJECT_FILTER`. The
 * connector writes it; the hook process (the OTLP plugin) is its only runtime
 * consumer. The daemon has no allowlist logic.
 *
 * The path-matching primitives below are agent-independent and shared via
 * `@/agents/core/project-allowlist.js`; only this file's storage format
 * (Claude's settings.json) and `AllowlistState`'s "absent means all projects
 * tracked" semantics are Claude-specific. Other connectors (e.g. Copilot) use
 * their own storage reader and an explicit enabled/scope model instead of
 * "absent means all" — see `@/agents/core/copilot-connector-scope.js`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { resolveHomeDir } from '@/utils/paths.js';
import {
  type AllowlistState,
  parseAllowlist,
  canonicalizePath,
  isPathInside,
  isProjectTracked,
  addProjectPath,
  removeProjectPath,
} from '@/agents/core/project-allowlist.js';

export const CODEMIE_ANALYTICS_PROJECT_FILTER_ENV = 'CODEMIE_ANALYTICS_PROJECT_FILTER';

export type { AllowlistState };
export { parseAllowlist, canonicalizePath, isPathInside, isProjectTracked, addProjectPath, removeProjectPath };

export type AllowlistScope = 'user' | 'project';

/**
 * Infers the currently configured scope from the stored allowlist. A missing
 * allowlist is a fresh connection (Global by default) and an explicitly empty
 * allowlist is Global; a non-empty allowlist is Project. Invalid state maps to
 * Project rather than broadening tracking.
 */
export function inferAllowlistScope(state: AllowlistState): AllowlistScope {
  if (state.kind === 'absent') {
    return 'user';
  }
  return state.kind === 'valid' && state.paths.length === 0 ? 'user' : 'project';
}

/** Path of the user-level Claude Code settings file that holds the allowlist. */
export function getClaudeSettingsPath(): string {
  return join(resolveHomeDir(), '.claude', 'settings.json');
}

/** Reads the allowlist from `~/.claude/settings.json`. Never throws. */
export async function readAllowlistState(): Promise<AllowlistState> {
  let raw: string;
  try {
    raw = await readFile(getClaudeSettingsPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    logger.debug('[Claude Code OTLP allowlist] Failed to read settings, treating allowlist as invalid');
    return { kind: 'invalid' };
  }

  if (raw.trim().length === 0) {
    return { kind: 'absent' };
  }

  try {
    const settings: unknown = JSON.parse(raw);
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return { kind: 'invalid' };
    }
    const env = (settings as { env?: unknown }).env;
    if (env === undefined) {
      return { kind: 'absent' };
    }
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      return { kind: 'invalid' };
    }
    return parseAllowlist((env as Record<string, unknown>)[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]);
  } catch {
    return { kind: 'invalid' };
  }
}

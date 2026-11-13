/**
 * Agent-independent canonical-path and allowlist helpers, shared by every OTLP connector's
 * per-project tracking config. Each connector owns its own storage location and read/write
 * format (see `claude-code-otlp.allowlist.ts` for Claude's `~/.claude/settings.json` reader);
 * only the path semantics below are shared.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type AllowlistState =
  | { kind: 'absent' }
  | { kind: 'valid'; paths: string[] }
  | { kind: 'invalid' };

/**
 * Parses a raw allowlist value. Invalid = unparsable JSON, not an array, or any
 * item that is not a non-empty absolute path string.
 */
export function parseAllowlist(value: unknown): AllowlistState {
  if (value === undefined) {
    return { kind: 'absent' };
  }

  if (typeof value !== 'string') {
    return { kind: 'invalid' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: 'invalid' };
  }

  if (!Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }

  const paths: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length === 0 || !isAbsolute(item)) {
      return { kind: 'invalid' };
    }
    paths.push(item);
  }
  return { kind: 'valid', paths };
}

function stripTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  // Keep a Windows drive root such as `C:\` intact
  if (/^[A-Za-z]:$/.test(p.slice(0, end))) {
    return p.slice(0, end) + sep;
  }
  return p.slice(0, end);
}

/**
 * Resolves symlinks (falls back to `path.resolve` for missing dirs) and strips
 * trailing separators. Casing is preserved; use {@link isPathInside} to compare.
 */
export async function canonicalizePath(p: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(p);
  } catch {
    resolved = resolve(p);
  }
  return stripTrailingSeparators(resolved);
}

/** Case-insensitive on win32 and darwin, for comparison only. */
export function comparable(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/** True if `child` equals or is nested under `parent`. Never a string-prefix check. */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(comparable(parent), comparable(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * absent or empty list => tracked (all projects); invalid => not tracked;
 * otherwise `cwd` must sit inside at least one entry.
 */
export async function isProjectTracked(cwd: string | undefined, state: AllowlistState): Promise<boolean> {
  if (state.kind === 'absent') {
    return true;
  }
  if (state.kind === 'invalid') {
    return false;
  }
  if (state.paths.length === 0) {
    return true;
  }
  if (!cwd) {
    return false;
  }

  const canonicalCwd = await canonicalizePath(cwd);
  for (const entry of state.paths) {
    if (isPathInside(canonicalCwd, await canonicalizePath(entry))) {
      return true;
    }
  }
  return false;
}

/** Returns a new list with `projectPath` added (canonical dedupe). */
export async function addProjectPath(paths: string[], projectPath: string): Promise<string[]> {
  const canonical = await canonicalizePath(projectPath);
  for (const existing of paths) {
    if (comparable(await canonicalizePath(existing)) === comparable(canonical)) {
      return [...paths];
    }
  }
  return [...paths, canonical];
}

/**
 * Returns a new list without `projectPath`. Matches by canonical path and by
 * raw string so an entry for a deleted project can still be removed.
 */
export async function removeProjectPath(paths: string[], projectPath: string): Promise<string[]> {
  const canonical = comparable(await canonicalizePath(projectPath));
  const kept: string[] = [];
  for (const existing of paths) {
    const matches =
      existing === projectPath || comparable(await canonicalizePath(existing)) === canonical;
    if (!matches) {
      kept.push(existing);
    }
  }
  return kept;
}

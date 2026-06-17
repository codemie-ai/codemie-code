// src/agents/plugins/kimi/kimi.paths.ts
/**
 * Kimi path utilities.
 *
 * Kimi stores session data and user state at:
 *   ${KIMI_CODE_HOME:-~/.kimi-code}/sessions/{workDirKey}/{sessionId}/agents/main/wire.jsonl
 *
 * Kimi does not use XDG conventions by default, but it supports KIMI_CODE_HOME
 * for isolating local state.
 *
 * Work directory keys are deterministic: the slug is derived from the resolved
 * directory basename (truncated and sanitized), and the suffix is the first 12
 * characters of a SHA-256 hash of the resolved path. This keeps directory names
 * readable while avoiding collisions between different paths that share the same
 * basename.
 */

import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';

/**
 * Returns the Kimi home directory.
 *
 * Defaults to ${userHome}/.kimi-code unless KIMI_CODE_HOME is set.
 */
export function getKimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

/**
 * Returns the path to Kimi's global config file.
 *
 *   ${KIMI_CODE_HOME}/config.toml
 */
export function getKimiConfigPath(): string {
  return join(getKimiCodeHome(), 'config.toml');
}

/**
 * Returns the base directory for all Kimi sessions.
 *
 *   ${KIMI_CODE_HOME}/sessions
 */
export function getKimiSessionsDir(): string {
  return join(getKimiCodeHome(), 'sessions');
}

/**
 * Encodes a working directory path into a deterministic, filesystem-safe key.
 *
 * The key has the shape:
 *   wd_{slug}_{hash}
 *
 * - `slug` is the lowercase basename of the resolved cwd, with non-alphanumeric
 *   characters replaced by `-`, leading/trailing dashes stripped, and truncated
 *   to 40 characters. If the result is empty, `.`, or `..`, it is replaced with
 *   `workspace`.
 * - `hash` is the first 12 characters of the SHA-256 digest of the resolved cwd.
 */
export function encodeKimiWorkDirKey(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  let slug = basename(resolvedCwd).toLowerCase();

  slug = slug.replace(/[^a-z0-9._-]/g, '-');
  slug = slug.replace(/^-+|-+$/g, '');
  slug = slug.slice(0, 40);

  if (slug === '' || slug === '.' || slug === '..') {
    slug = 'workspace';
  }

  const hash = createHash('sha256')
    .update(resolvedCwd)
    .digest('hex')
    .slice(0, 12);

  return `wd_${slug}_${hash}`;
}

/**
 * Returns the session directory for a given cwd and session id.
 *
 *   ${KIMI_CODE_HOME}/sessions/{workDirKey}/{sessionId}
 */
export function getKimiSessionDir(cwd: string, sessionId: string): string {
  return join(getKimiSessionsDir(), encodeKimiWorkDirKey(cwd), sessionId);
}

/**
 * Returns the main agent wire file path for a given cwd and session id.
 *
 *   ${KIMI_CODE_HOME}/sessions/{workDirKey}/{sessionId}/agents/main/wire.jsonl
 */
export function getKimiMainWirePath(cwd: string, sessionId: string): string {
  return join(getKimiSessionDir(cwd, sessionId), 'agents', 'main', 'wire.jsonl');
}

/**
 * Returns the directory for user-defined Kimi skills.
 *
 *   ${KIMI_CODE_HOME}/skills
 */
export function getKimiUserSkillsDir(): string {
  return join(getKimiCodeHome(), 'skills');
}

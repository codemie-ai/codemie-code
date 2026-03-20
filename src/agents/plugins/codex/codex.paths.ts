// src/agents/plugins/codex/codex.paths.ts
/**
 * Codex path utilities.
 *
 * Codex stores rollout files at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-{ISO8601}-{uuid}.jsonl
 *
 * Unlike OpenCode, Codex does NOT use XDG conventions — ~/.codex is fixed.
 *
 * References:
 * - https://github.com/openai/codex/blob/main/codex-rs/docs/configuration.md
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Returns the Codex home directory: ~/.codex
 */
export function getCodexHomePath(): string {
  return join(homedir(), '.codex');
}

/**
 * Returns the Codex sessions base directory: ~/.codex/sessions
 * Returns null if the directory does not exist (Codex not run yet).
 */
export function getCodexSessionsPath(): string | null {
  const sessionsPath = join(homedir(), '.codex', 'sessions');
  return existsSync(sessionsPath) ? sessionsPath : null;
}

/**
 * Returns the day-specific session directory for a given date:
 *   ~/.codex/sessions/YYYY/MM/DD
 *
 * Note: This directory may not exist yet.
 */
export function getCodexSessionDayPath(date: Date): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return join(getCodexHomePath(), 'sessions', year, month, day);
}

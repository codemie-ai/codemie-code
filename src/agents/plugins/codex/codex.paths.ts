// src/agents/plugins/codex/codex.paths.ts
/**
 * Codex path utilities.
 *
 * Codex stores rollout files at:
 *   ${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-{ISO8601}-{uuid}.jsonl
 *
 * Codex does not use XDG conventions by default, but it supports CODEX_HOME
 * for isolating local state.
 *
 * References:
 * - https://developers.openai.com/codex/config-advanced
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Returns the Codex home directory.
 */
export function getCodexHomePath(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Returns the Codex sessions base directory.
 * Returns null if the directory does not exist (Codex not run yet).
 */
export function getCodexSessionsPath(): string | null {
  const sessionsPath = join(getCodexHomePath(), 'sessions');
  return existsSync(sessionsPath) ? sessionsPath : null;
}

/**
 * Returns the day-specific session directory for a given date:
 *   ${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD
 *
 * Note: This directory may not exist yet.
 */
export function getCodexSessionDayPath(date: Date): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return join(getCodexHomePath(), 'sessions', year, month, day);
}

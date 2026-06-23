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

/** Label used when discovering rollouts under the native Codex home. */
export type CodexDiscoveryAgentName = 'codex' | 'codemie-codex';

export interface CodexDiscoveryRoot {
  sessionsPath: string;
  agentName: CodexDiscoveryAgentName;
}

/**
 * Returns the Codex home directory.
 */
export function getCodexHomePath(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Session roots scanned for analytics native discovery.
 * Native `codex` uses ~/.codex/sessions; `codemie-codex` isolates state under ~/.codex/codemie/home.
 */
export function getCodexDiscoverySessionRoots(): CodexDiscoveryRoot[] {
  const nativeHome = join(homedir(), '.codex');
  const candidates: CodexDiscoveryRoot[] = [
    { sessionsPath: join(nativeHome, 'sessions'), agentName: 'codex' },
    { sessionsPath: join(nativeHome, 'codemie', 'home', 'sessions'), agentName: 'codemie-codex' },
  ];

  const codexHome = process.env.CODEX_HOME;
  if (codexHome) {
    const envSessions = join(codexHome, 'sessions');
    if (!candidates.some((c) => c.sessionsPath === envSessions)) {
      const agentName: CodexDiscoveryAgentName =
        codexHome.includes(`${join('.codex', 'codemie', 'home')}`) ? 'codemie-codex' : 'codex';
      candidates.push({ sessionsPath: envSessions, agentName });
    }
  }

  const seen = new Set<string>();
  const out: CodexDiscoveryRoot[] = [];
  for (const root of candidates) {
    if (seen.has(root.sessionsPath) || !existsSync(root.sessionsPath)) {
      continue;
    }
    seen.add(root.sessionsPath);
    out.push(root);
  }
  return out;
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

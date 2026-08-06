/**
 * Reads `~/.copilot/session-state/<uuid>/workspace.yaml`.
 *
 * This is the discovery manifest: it carries session identity, project path, repository,
 * branch, and timestamps in a few hundred bytes, so discovery never has to open a
 * transcript. That matters — real `events.jsonl` files reach megabytes, and a report run
 * would otherwise pay to read transcripts it goes on to filter out.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { CopilotWorkspaceManifest, RawWorkspaceYaml } from './copilot-cli-event-types.js';
import { logger } from '../../../utils/logger.js';

/** ISO-8601 to epoch ms; undefined when absent or unparseable. */
function toEpochMs(iso?: string): number | undefined {
  if (!iso) {
    return undefined;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Parse one session directory's manifest.
 *
 * Returns null when the file is missing, unreadable, malformed, or carries no session id.
 * Never throws — a single unreadable session directory must not abort discovery.
 */
export function readWorkspaceManifest(sessionDir: string): CopilotWorkspaceManifest | null {
  let text: string;
  try {
    text = readFileSync(join(sessionDir, 'workspace.yaml'), 'utf-8');
  } catch {
    return null;
  }

  let raw: RawWorkspaceYaml;
  try {
    raw = (parseYaml(text) ?? {}) as RawWorkspaceYaml;
  } catch (error) {
    logger.debug(`[copilot-cli] malformed workspace.yaml in ${sessionDir}:`, error);
    return null;
  }

  if (!raw || typeof raw !== 'object' || !raw.id) {
    return null;
  }

  return {
    id: raw.id,
    cwd: raw.cwd,
    gitRoot: raw.git_root,
    repository: raw.repository,
    hostType: raw.host_type,
    branch: raw.branch,
    name: raw.name,
    createdAt: toEpochMs(raw.created_at),
    updatedAt: toEpochMs(raw.updated_at),
  };
}

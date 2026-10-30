import { existsSync } from 'fs';
import { appendFile, readFile, rename, unlink } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { logger } from '@/utils/logger.js';
import { getSessionPath } from './session-config.js';

/** The three files of a session set under a name prefix (`''` live, `completed_`). */
function sessionSetFiles(sessionsDir: string, name: string): { json: string; metrics: string; conversation: string } {
  return {
    json: join(sessionsDir, `${name}.json`),
    metrics: join(sessionsDir, `${name}_metrics.jsonl`),
    conversation: join(sessionsDir, `${name}_conversation.jsonl`),
  };
}

/** The generation of a record file: its agent session id, else its start time; undefined when unreadable. */
async function readGeneration(jsonPath: string): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(jsonPath, 'utf-8')) as { startTime?: number; correlation?: { agentSessionId?: string } };
    const agentSessionId = record.correlation?.agentSessionId;
    const generation = agentSessionId && agentSessionId !== 'unknown'
      ? agentSessionId
      : record.startTime !== undefined ? String(record.startTime) : undefined;
    return generation?.replace(/[^A-Za-z0-9._-]/g, '_');
  } catch {
    return undefined;
  }
}

/**
 * Move a session set (`<prefix><id>.json`, `_metrics.jsonl`, `_conversation.jsonl`) to its
 * generation name `completed_<id>-<generation>*`, `-<n>` appended when that name is taken.
 * A failed rename moves the files already moved back and rethrows: the set never ends half-moved.
 * Returns the new base name, or undefined when there was no set to move.
 */
export async function moveSetToGeneration(sessionId: string, prefix: '' | 'completed_'): Promise<string | undefined> {
  const sessionsDir = dirname(getSessionPath(sessionId));
  const from = sessionSetFiles(sessionsDir, `${prefix}${sessionId}`);
  if (!existsSync(from.json)) return undefined;

  const generation = (await readGeneration(from.json)) ?? 'unknown';
  let base = `completed_${sessionId}-${generation}`;
  for (let n = 2; existsSync(join(sessionsDir, `${base}.json`)); n++) {
    base = `completed_${sessionId}-${generation}-${n}`;
  }
  const to = sessionSetFiles(sessionsDir, base);
  const moved: Array<keyof typeof from> = [];
  try {
    // The .json last: a kill mid-move leaves it under its name, and the next close moves the rest to the same generation.
    for (const key of ['metrics', 'conversation', 'json'] as const) {
      if (!existsSync(from[key])) continue;
      if (key !== 'json' && existsSync(to[key])) {
        // A move cut by a kill left this sidecar there; the lines written since go after it, never over it
        // Not pushed to `moved`: its source is gone, a rollback must not rename the combined file over it
        await appendFile(to[key], await readFile(from[key]));
        await unlink(from[key]);
      } else {
        await rename(from[key], to[key]);
        moved.push(key);
      }
    }
  } catch (error) {
    for (const key of moved.reverse()) {
      await rename(to[key], from[key]).catch((undoError: unknown) => {
        logger.error(`[hook] Could not move ${basename(to[key])} back to ${basename(from[key])}:`, undoError);
      });
    }
    throw error;
  }
  logger.info(`[hook] Moved ${prefix}${sessionId} set to generation ${base}`);
  return base;
}

/**
 * Rename session files with 'completed_' prefix
 * Uses session-config.ts helpers to ensure consistent paths.
 *
 * Renames:
 * - Session file: {sessionId}.json → completed_{sessionId}.json
 * - Metrics file: {sessionId}_metrics.jsonl → completed_{sessionId}_metrics.jsonl
 * - Conversations file: {sessionId}_conversation.jsonl → completed_{sessionId}_conversation.jsonl
 *
 * Never over another generation: an existing `completed_{sessionId}*` set of another
 * generation (its agent session id, else its start time, differs) is first moved to
 * `completed_{sessionId}-<generation>*`; the same generation is renamed over (a later
 * state of the same record).
 *
 * @param sessionId - The CodeMie session ID
 */
export async function renameSessionFiles(sessionId: string): Promise<void> {
  const sessionsDir = dirname(getSessionPath(sessionId));
  const live = sessionSetFiles(sessionsDir, sessionId);
  const completed = sessionSetFiles(sessionsDir, `completed_${sessionId}`);

  if (existsSync(live.json) && existsSync(completed.json)) {
    const [liveGeneration, completedGeneration] = await Promise.all([readGeneration(live.json), readGeneration(completed.json)]);
    // An unreadable generation is never taken for the same one
    if (liveGeneration === undefined || liveGeneration !== completedGeneration) {
      try {
        await moveSetToGeneration(sessionId, 'completed_');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[hook:SessionEnd] Failed to move the previous generation aside; not renaming: ${errorMessage}`);
        return;
      }
    }
    // ponytail: same generation — lines only in the older completed_ files are lost locally (already delivered)
  }

  const renamedFiles: string[] = [];
  const errors: string[] = [];
  for (const [label, key] of [['session', 'json'], ['metrics', 'metrics'], ['conversations', 'conversation']] as const) {
    try {
      if (existsSync(live[key])) {
        await rename(live[key], completed[key]);
        renamedFiles.push(label);
        logger.debug(`[hook:SessionEnd] Renamed ${label} file: ${basename(live[key])} → ${basename(completed[key])}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`${label}: ${errorMessage}`);
      logger.warn(`[hook:SessionEnd] Failed to rename ${label} file: ${errorMessage}`);
    }
  }

  // Log summary
  if (renamedFiles.length > 0) {
    logger.info(`[hook:SessionEnd] Renamed files: ${renamedFiles.join(', ')}`);
  }

  if (errors.length > 0) {
    logger.warn(`[hook:SessionEnd] File rename errors: ${errors.join('; ')}`);
  }
}

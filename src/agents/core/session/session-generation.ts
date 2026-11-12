import { existsSync, readdirSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { appendFile, readFile, rename, unlink, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { getSessionConversationLockPath, getSessionMetricsLockPath, getSessionPath } from './session-config.js';
import { acquireSessionFileLock, type LockBounds } from '@/providers/plugins/sso/session/utils/locked-jsonl.js';
import type { PidLock } from '@/utils/pid-lock.js';

/** The three files of a session set under a name prefix (`''` live, `completed_`). */
function sessionSetFiles(sessionsDir: string, name: string): { json: string; metrics: string; conversation: string } {
  return {
    json: join(sessionsDir, `${name}.json`),
    metrics: join(sessionsDir, `${name}_metrics.jsonl`),
    conversation: join(sessionsDir, `${name}_conversation.jsonl`),
  };
}

/** The generation of a record, safe in a file name: its agent session id, else its start time. */
export function recordGeneration(record: { startTime?: number; correlation?: { agentSessionId?: string } }): string | undefined {
  const agentSessionId = record.correlation?.agentSessionId;
  const generation = agentSessionId && agentSessionId !== 'unknown'
    ? agentSessionId
    : record.startTime !== undefined ? String(record.startTime) : undefined;
  return generation?.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The record files of a generation: `completed_<id>-<generation>.json`, `completed_<id>-<generation>-<n>.json`,
 * and `completed_<id>.json` when its record is of that generation (a finalizer's plain rename; unreadable → not included).
 */
export function generationSetFiles(sessionId: string, generation: string): string[] {
  const sessionsDir = dirname(getSessionPath(sessionId));
  const base = `completed_${sessionId}-${generation}`;
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = names
    .filter((name) => name === `${base}.json` || (name.startsWith(`${base}-`) && /^\d+\.json$/.test(name.slice(base.length + 1))))
    .map((name) => join(sessionsDir, name));
  const plain = join(sessionsDir, `completed_${sessionId}.json`);
  if (names.includes(basename(plain)) && readGenerationSync(plain) === generation) files.push(plain);
  return files;
}

function readGenerationSync(jsonPath: string): string | undefined {
  try {
    return recordGeneration(JSON.parse(readFileSync(jsonPath, 'utf-8')) as Parameters<typeof recordGeneration>[0]);
  } catch {
    return undefined;
  }
}

/** Whether the generation of a native session was already closed under the id: a record file of its generation exists. */
export function isClosedGeneration(sessionId: string, nativeSessionId: string): boolean {
  const generation = recordGeneration({ correlation: { agentSessionId: nativeSessionId } });
  return generation !== undefined && generationSetFiles(sessionId, generation).length > 0;
}

/** The generation of a record file; undefined when unreadable. */
async function readGeneration(jsonPath: string): Promise<string | undefined> {
  try {
    return recordGeneration(JSON.parse(await readFile(jsonPath, 'utf-8')) as Parameters<typeof recordGeneration>[0]);
  } catch {
    return undefined;
  }
}

/**
 * Runs `fn` holding the session's metrics and conversation locks, both taken before it runs: a writer holds
 * a file's lock for its whole read-and-write, so a lock that cannot be taken leaves the set as it is.
 * @throws {SessionFileLockTimeoutError} When a lock stays held past the bounds
 */
async function withSetLocks<T>(sessionId: string, bounds: LockBounds | undefined, fn: () => Promise<T>): Promise<T> {
  const locks: PidLock[] = [];
  try {
    for (const lockPath of [getSessionMetricsLockPath(sessionId), getSessionConversationLockPath(sessionId)]) {
      locks.push(await acquireSessionFileLock(lockPath, bounds));
    }
    return await fn();
  } finally {
    for (const lock of locks) await lock.release();
  }
}

/**
 * Move a session set (`<prefix><id>.json`, `_metrics.jsonl`, `_conversation.jsonl`) to its
 * generation name `completed_<id>-<generation>*`, `-<n>` appended when that name is taken.
 * The live set (`''`) moves under its metrics and conversation locks, taken within `bounds` before anything moves.
 * A failed rename moves the files already moved back and rethrows: the set never ends half-moved.
 * Returns the new base name, or undefined when there was no set to move.
 * @throws {SessionFileLockTimeoutError} When a lock of the live set stays held past `bounds`: nothing moved
 */
export async function moveSetToGeneration(sessionId: string, prefix: '' | 'completed_', bounds?: LockBounds): Promise<string | undefined> {
  return prefix === ''
    ? withSetLocks(sessionId, bounds, () => moveSetToGenerationUnlocked(sessionId, prefix))
    : moveSetToGenerationUnlocked(sessionId, prefix);
}

async function moveSetToGenerationUnlocked(sessionId: string, prefix: '' | 'completed_'): Promise<string | undefined> {
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
 * Re-keys the live set (`{id}.json` and its two sidecars) under a fresh session id, so the generation stays in the
 * delivery queue: the start pass lists live records by name (`<uuid>.json`), which a `completed_<id>-<generation>` name is not.
 * The set moves under its metrics and conversation locks (taken within `bounds`) and under the new id's reconcile lock,
 * so no start pass reads the new record before its sidecars are there. The new `.json` is written first and the old one
 * removed last: a kill mid-move leaves the old record whole, and a later close queues it once more (an end metric may be
 * sent twice; no line is lost). A failed move puts the sidecars back and rethrows.
 * Returns the new session id, or undefined when there was no set to move.
 * @throws {SessionFileLockTimeoutError} When a lock of the live set stays held past `bounds`: nothing moved
 */
export async function requeueSetUnderNewId(sessionId: string, bounds?: LockBounds): Promise<string | undefined> {
  return withSetLocks(sessionId, bounds, () => requeueSetUnlocked(sessionId));
}

async function requeueSetUnlocked(sessionId: string): Promise<string | undefined> {
  const sessionsDir = dirname(getSessionPath(sessionId));
  const from = sessionSetFiles(sessionsDir, sessionId);
  if (!existsSync(from.json)) return undefined;

  const record = JSON.parse(await readFile(from.json, 'utf-8')) as Record<string, unknown>;
  const newId = randomUUID();
  const to = sessionSetFiles(sessionsDir, newId);
  const { acquirePidLock } = await import('@/utils/pid-lock.js');
  const lock = await acquirePidLock(getCodemiePath('sessions', `${newId}.reconcile.lock`), { mode: 'try' });
  const moved: Array<'metrics' | 'conversation'> = [];
  try {
    const tmp = `${to.json}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...record, sessionId: newId }, null, 2), 'utf-8');
    await rename(tmp, to.json);
    try {
      for (const key of ['metrics', 'conversation'] as const) {
        if (!existsSync(from[key])) continue;
        await rename(from[key], to[key]);
        moved.push(key);
      }
    } catch (error) {
      for (const key of moved.reverse()) {
        await rename(to[key], from[key]).catch((undoError: unknown) => {
          logger.error(`[hook] Could not move ${basename(to[key])} back to ${basename(from[key])}:`, undoError);
        });
      }
      await unlink(to.json).catch(() => undefined);
      throw error;
    }
    await unlink(from.json);
  } finally {
    await lock?.release();
  }
  logger.info(`[hook] Kept the undelivered ${sessionId} set queued as ${newId}`);
  return newId;
}

type SessionSetFiles = ReturnType<typeof sessionSetFiles>;

/** Renames the live set to `completed_` under the metrics and conversation locks; the labels renamed and the errors. */
async function renameLiveSet(
  sessionId: string,
  live: SessionSetFiles,
  completed: SessionSetFiles,
  bounds?: LockBounds
): Promise<{ renamedFiles: string[]; errors: string[] }> {
  const renamedFiles: string[] = [];
  const errors: string[] = [];
  try {
    await withSetLocks(sessionId, bounds, async () => {
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
    });
  } catch (lockError) {
    errors.push(`not renamed: ${lockError instanceof Error ? lockError.message : String(lockError)}`);
  }
  return { renamedFiles, errors };
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
 * @param bounds - What stops the wait for the metrics and conversation locks; past it nothing is renamed
 * @returns Whether the whole set was renamed: no rename failed and no live `{sessionId}.json` is left
 */
export async function renameSessionFiles(sessionId: string, bounds?: LockBounds): Promise<boolean> {
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
        return false;
      }
    }
    // ponytail: same generation — lines only in the older completed_ files are lost locally (already delivered)
  }

  const { renamedFiles, errors } = await renameLiveSet(sessionId, live, completed, bounds);

  // Log summary
  if (renamedFiles.length > 0) {
    logger.info(`[hook:SessionEnd] Renamed files: ${renamedFiles.join(', ')}`);
  }

  if (errors.length > 0) {
    logger.warn(`[hook:SessionEnd] File rename errors: ${errors.join('; ')}`);
  }
  return errors.length === 0 && !existsSync(live.json);
}

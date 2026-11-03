/**
 * Locked access to a session's metrics / conversation JSONL.
 *
 * Every append, rewrite and rename of one of these files runs under its pid-lock, so a writer that
 * read the file never overwrites a line another process appended since. A write that finds its live
 * file gone (the session was completed and renamed) is dropped and logged, never re-creating the file.
 */

import { appendFile, mkdir, open } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { acquirePidLock, PID_LOCK_WAIT_BUDGET_MS, type PidLock } from '@/utils/pid-lock.js';
import { logger } from '@/utils/logger.js';
import { SessionFileLockTimeoutError } from '@/utils/errors.js';
import {
  getSessionConversationLockPath,
  getSessionConversationPath,
  getSessionMetricsLockPath,
  getSessionMetricsPath,
  getSessionPath
} from '@/agents/core/session/session-config.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import { writeJSONLAtomic } from './jsonl-writer.js';

/** How long a writer waits for a session file's lock (poll interval: the pid-lock's 25 ms). */
export const SESSION_FILE_LOCK_BUDGET_MS = PID_LOCK_WAIT_BUDGET_MS;

/** Which of a session's JSONL files: its metric deltas or its conversation payloads. */
export type SessionFileKind = 'metrics' | 'conversation';

/** What stops the lock wait early: a hook's abort / deadline. */
export interface LockBounds {
  deadlineMs?: number;
  signal?: AbortSignal;
  pidOnlyLiveness?: boolean;
}

/** The lock wait bounds of a processing run: its sync deadline, its abort signal, pid-only liveness in a hook process. */
export function lockBoundsOf(context?: Pick<ProcessingContext, 'syncDeadlineMs' | 'abortSignal' | 'hookProcess'>): LockBounds {
  return {
    deadlineMs: context?.syncDeadlineMs,
    signal: context?.abortSignal,
    pidOnlyLiveness: context?.hookProcess === true
  };
}

function pathsOf(kind: SessionFileKind, sessionId: string): { file: string; lock: string } {
  return kind === 'metrics'
    ? { file: getSessionMetricsPath(sessionId), lock: getSessionMetricsLockPath(sessionId) }
    : { file: getSessionConversationPath(sessionId), lock: getSessionConversationLockPath(sessionId) };
}

/**
 * Takes the lock of a session file.
 * @throws {SessionFileLockTimeoutError} When the lock stays held past the budget, the deadline or the abort
 */
export async function acquireSessionFileLock(
  lockPath: string,
  bounds: LockBounds = {}
): Promise<PidLock> {
  const lock = await acquirePidLock(lockPath, { mode: 'wait', budgetMs: SESSION_FILE_LOCK_BUDGET_MS, ...bounds });
  if (!lock) {
    throw new SessionFileLockTimeoutError(lockPath);
  }
  return lock;
}

/**
 * Runs `fn(filePath)` under the file's lock. With `mustExist` the file has to exist already; otherwise
 * it may be created only while the live session record exists. A file that is gone is not re-created:
 * `fn` is skipped, the drop is logged and undefined is returned.
 * @throws {SessionFileLockTimeoutError} When the lock stays held past the budget, the deadline or the abort
 */
export async function withSessionFile<T>(
  kind: SessionFileKind,
  sessionId: string,
  bounds: LockBounds,
  mustExist: boolean,
  fn: (filePath: string) => Promise<T>
): Promise<T | undefined> {
  const { file, lock: lockPath } = pathsOf(kind, sessionId);
  const lock = await acquireSessionFileLock(lockPath, bounds);
  try {
    if (!existsSync(file) && (mustExist || !existsSync(getSessionPath(sessionId)))) {
      logger.warn(`[locked-jsonl] ${kind} file of session ${sessionId} is gone (completed), write dropped`);
      return undefined;
    }
    return await fn(file);
  } finally {
    await lock.release();
  }
}

/**
 * Appends JSONL `data` to `file`. A file whose last byte is not a newline (a torn line of a cut write) gets one
 * first: the torn line stays torn and is skipped by the sync, rewrite, `readAll` and delivery-check readers
 * (a rewrite drops it), the new line stays readable.
 * The caller holds the file's lock.
 */
export async function appendJsonlLines(file: string, data: string): Promise<void> {
  let separator = '';
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) separator = '\n';
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await appendFile(file, separator + data, 'utf-8');
}

/**
 * Appends `data` to a session file under its lock. False when dropped because the file is gone.
 * @throws {SessionFileLockTimeoutError} When the lock stays held past the budget, the deadline or the abort
 */
export async function appendSessionFile(
  kind: SessionFileKind,
  sessionId: string,
  data: string,
  context?: ProcessingContext
): Promise<boolean> {
  const done = await withSessionFile(kind, sessionId, lockBoundsOf(context), false, async (file) => {
    await mkdir(dirname(file), { recursive: true });
    await appendJsonlLines(file, data);
    return true;
  });
  return done === true;
}

/**
 * Re-reads the file under its lock, lets `merge` apply this run's changes to the lines as they are now
 * (lines appended meanwhile stay as read), and writes the result with tmp + rename.
 * False when dropped because the file is gone.
 * @throws {SessionFileLockTimeoutError} When the lock stays held past the budget
 */
export async function rewriteSessionFile<T>(
  kind: SessionFileKind,
  sessionId: string,
  merge: (current: T[]) => T[],
  context?: ProcessingContext
): Promise<boolean> {
  // Not bounded by the caller's abort / deadline: the outcome of requests already sent must be recorded
  const bounds: LockBounds = { pidOnlyLiveness: context?.hookProcess === true };
  const done = await withSessionFile(kind, sessionId, bounds, true, async (file) => {
    await writeJSONLAtomic(file, merge(await readJSONLTolerant<T>(file, '[locked-jsonl]')));
    return true;
  });
  return done === true;
}

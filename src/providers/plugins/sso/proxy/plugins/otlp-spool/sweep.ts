import { unlink } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import {
  SPOOL_STREAMS,
  listSessionIds,
  statusFile,
  streamFile,
} from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { createStatus, readStatus } from './session-status.js';
import { isSessionDrained, lastActivityMs, readSpoolState } from './spool-state.js';
import { abandonedSessionGraceMs, endedSessionGraceMs } from './spool-config.js';

/**
 * Lightweight garbage collection for the OTLP spool.
 *
 * Two cleanup paths, both of which require every stream to be drained
 * (`fileSize === cursor`) so no undelivered bytes are ever destroyed:
 *
 * 1. Normally ended sessions (`endedAt` set): deleted once the end grace period
 *    has elapsed since the later of `endedAt` and the last spool-file write, so
 *    late hook/OTEL writes postpone cleanup.
 * 2. Abandoned sessions (no `endedAt`): deleted once the abandonment timeout has
 *    elapsed since the last spool-file write. Activity is read from spool-file
 *    mtimes, never from the status file, because cursor updates rewrite the
 *    status file without any new data arriving.
 *
 * Consequence: a live session that stays quiet (and fully drained) for longer
 * than the abandonment timeout may have its spool removed. That is safe — the
 * next producer write recreates the status and spool files from scratch.
 */
export async function sweepSpool(): Promise<void> {
  for (const sessionId of await listSessionIds()) {
    try {
      await sweepSession(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[otlp-sweep] per-session error', ...sanitizeLogArgs({ sessionId, err: msg }));
    }
  }
}

async function sweepSession(sessionId: string): Promise<void> {
  // Cheap unlocked pre-scan to keep the sweep off the hot path...
  if (!(await isDeletable(sessionId))) return;

  await withSessionLock(sessionId, async () => {
    // ...then re-read status, sizes and mtimes under the lock before deleting.
    if (!(await isDeletable(sessionId))) return;
    await deleteSession(sessionId);
  });
}

async function isDeletable(sessionId: string): Promise<boolean> {
  const status = (await readStatus(sessionId)) ?? createStatus();
  const spool = await readSpoolState(sessionId, status);

  if (!isSessionDrained(spool)) return false;

  const activityMs = await lastActivityMs(spool);
  if (activityMs === null) return false; // nothing on disk to clean up

  const idleSince =
    status.endedAt !== undefined ? Math.max(status.endedAt, activityMs) : activityMs;
  const timeoutMs =
    status.endedAt !== undefined ? endedSessionGraceMs() : abandonedSessionGraceMs();

  return Date.now() - idleSince >= timeoutMs;
}

async function deleteSession(sessionId: string): Promise<void> {
  const paths = [...SPOOL_STREAMS.map((s) => streamFile(sessionId, s)), statusFile(sessionId)];
  for (const path of paths) {
    try {
      await unlink(path);
    } catch {
      // File may already be gone
    }
  }
  logger.debug('[otlp-sweep] swept session', ...sanitizeLogArgs({ sessionId }));
}

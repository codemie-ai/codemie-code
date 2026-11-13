/**
 * Single-field updates a hook makes on a live CodeMie session record: the transcript a SessionEnd
 * located, the id the start metric went out under.
 */
import type { SessionStore } from '@/agents/core/session/SessionStore.js';
import type { Session } from '@/agents/core/session/types.js';
import { reconcileLockPath } from '@/agents/core/session/stale-session-reconciliation.js';
import { isSharedTranscriptStore } from '@/agents/core/session/session-origin-audit.js';
import { logger } from '@/utils/logger.js';
import type { SessionEndOptions } from './session-end-options.js';
import { isOtherGeneration } from './own-generation.js';

/**
 * How long the start-id write waits for the record's reconcile lock: a short-lived holder — a
 * reconcile, the live wrapper, the previous generation's SessionEnd — releases within it; the bound
 * keeps a held lock from stalling the hook.
 */
const START_ID_LOCK_WAIT_MS = 2_000;

async function sessionStore(): Promise<SessionStore> {
  const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
  return new SessionStore();
}

/** The session record as the store loads it; none when there is no record. */
export async function loadSessionRecord(sessionId: string): Promise<Session | null> {
  return (await sessionStore()).loadSession(sessionId);
}

/**
 * Whether the record is already completed: its SessionEnd flushed the run, and a Stop hook that
 * outlives it syncs nothing (with no later-record bound it would select a later run's session).
 */
export async function isCompletedRecord(sessionId: string, hookName: string): Promise<boolean> {
  if ((await loadSessionRecord(sessionId))?.status !== 'completed') return false;
  logger.debug(`[hook:${hookName}] Session ${sessionId} is already completed; nothing synced`);
  return true;
}

/**
 * Store the transcript a SessionEnd names on a record that has none, before the flush: a run killed
 * before its plugin's own session end never wrote the path, and pricing and the next-record bound
 * read it from the record. A record that already carries a path keeps it. Called by SessionEnd under the
 * record's reconcile lock (the handler holds it), so its save needs none of its own.
 */
export async function recordLocatedTranscript(record: Session, transcriptPath: string | undefined): Promise<void> {
  if (!transcriptPath || record.correlation?.agentSessionFile || isSharedTranscriptStore(transcriptPath)) return;
  record.correlation = { ...record.correlation, status: 'matched', agentSessionFile: transcriptPath };
  await (await sessionStore()).saveSession(record);
}

/**
 * Store the `session_id` the server accepted the start metric under on the record of the generation
 * it was issued for: the live record, `active`, not of another generation (agent session id unset,
 * that id, `'unknown'` or the CodeMie id itself). The load and the save run under the reconcile lock,
 * waited for up to {@link START_ID_LOCK_WAIT_MS}, never past `lockDeadlineMs`, what the SessionStart's
 * lock budget has left, nor past the hook's abort: a start that spent it on the previous generation tries once. A lock not
 * obtained, or a lock error, writes nothing and is logged, never thrown: the metric is already sent,
 * and the end metric falls back to the agent session id. A record of another generation is left
 * byte-identical.
 */
export async function recordStartMetricSessionId(
  sessionId: string,
  startMetricSessionId: string,
  options: SessionEndOptions,
  lockDeadlineMs: number
): Promise<void> {
  try {
    const { acquirePidLock } = await import('@/utils/pid-lock.js');
    const deadlineMs = Math.min(lockDeadlineMs, Date.now() + START_ID_LOCK_WAIT_MS);
    const lockOptions = { pidOnlyLiveness: options.hookProcess === true, signal: options.abortSignal };
    const lock = await acquirePidLock(
      reconcileLockPath(sessionId),
      deadlineMs <= Date.now() ? { mode: 'try', ...lockOptions } : { mode: 'wait', deadlineMs, ...lockOptions }
    );
    if (!lock) {
      logger.warn(`[hook:SessionStart] start metric id of ${sessionId} not stored: record locked; the end metric falls back to the agent session id`);
      return;
    }
    try {
      const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
      const store = new SessionStore();
      const latest = await store.loadSession(sessionId);
      if (latest?.status === 'active' && !isOtherGeneration(latest, startMetricSessionId)) await store.saveSession({ ...latest, startMetricSessionId });
    } finally {
      // Its own catch: a failed release is not a failed store
      await lock.release().catch((error: unknown) => {
        logger.warn(`[hook:SessionStart] lock of ${sessionId} not released: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    logger.warn(`[hook:SessionStart] start id not stored for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

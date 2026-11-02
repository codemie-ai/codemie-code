import { logger } from '@/utils/logger.js';
import type { BaseHookEvent } from '@/agents/core/types.js';
import type { Session } from '@/agents/core/session/types.js';
import { lastRecordedActivityAt, readLiveRecord, reconcileLockPath } from '@/agents/core/session/stale-session-reconciliation.js';
import { isClosedGeneration } from '@/agents/core/session/session-generation.js';
import type { HookProcessingConfig, SessionStartEvent } from '../hook.js';
import type { SessionEndOptions } from './session-end-options.js';

/**
 * Whether the record belongs to another generation than the event's native session: its agent
 * session id is set, is not `'unknown'`, is not the CodeMie id a safety-net record carries, and is
 * not the event's `session_id`, whatever its correlation status. False for an event without a `session_id`.
 */
export function isOtherGeneration(record: Session | null | undefined, nativeSessionId: string | undefined): boolean {
  if (!record || !nativeSessionId) return false;
  const agentSessionId = record.correlation?.agentSessionId;
  return !!agentSessionId && agentSessionId !== 'unknown' && agentSessionId !== record.sessionId && agentSessionId !== nativeSessionId;
}

/**
 * The SessionStart a generation's first written event stands in for: the generation starts where
 * the one it follows ended, and its transcript records count from there.
 */
export function generationStartEvent(event: BaseHookEvent, startTime: number): SessionStartEvent {
  return {
    hook_event_name: 'SessionStart',
    source: 'late-start',
    session_id: event.session_id,
    transcript_path: event.transcript_path,
    permission_mode: event.permission_mode,
    ...(event.cwd && { cwd: event.cwd }),
    startTime,
  };
}

/**
 * Makes `{id}.json` the record of the event's own generation before the event writes to it. `own`:
 * no record, or one of this generation. `closed`: the record is another generation's and the
 * event's own generation was already closed and moved aside (a late event of it); the event writes
 * nothing. `created`: another generation's record was set aside (closed first when live) and a
 * fresh one written under the reconcile lock — by this event, or by another hook process of this
 * generation that took the lock first. `deferred`: the lock is held by another process; it is tried
 * once, never waited for (a Stop hook blocks the agent's turn); the event writes nothing.
 */
export async function ensureOwnGeneration(
  event: BaseHookEvent,
  sessionId: string,
  config: HookProcessingConfig | undefined,
  options: SessionEndOptions
): Promise<'own' | 'closed' | 'created' | 'deferred'> {
  const live = await readLiveRecord(sessionId);
  const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
  const record = live ?? (await new SessionStore().loadSession(sessionId));
  if (!record || !isOtherGeneration(record, event.session_id)) return 'own';
  // ponytail: a `/resume` back to a closed generation whose SessionStart could not write (lock held) reads the same as a late
  // event of that generation and is dropped until its next SessionStart; a start marker written by that SessionStart would tell them apart
  if (isClosedGeneration(sessionId, event.session_id)) {
    logger.info(`[hook:${event.hook_event_name}] ${event.session_id} is a closed generation of ${sessionId}; the event belongs to it, nothing written`);
    return 'closed';
  }

  const { createSessionRecordOverUnclosed } = await import('../hook.js');
  // ponytail: the exact start is the SessionStart that could not write; the previous generation's end is its lower bound
  const startTime = record.endTime ?? (await lastRecordedActivityAt(record));
  await createSessionRecordOverUnclosed(generationStartEvent(event, startTime), sessionId, config, options, Date.now());
  const current = await readLiveRecord(sessionId);
  if (current && !isOtherGeneration(current, event.session_id)) return 'created';
  logger.warn(
    `[hook:${event.hook_event_name}] ${sessionId}.json is not the record of ${event.session_id} and no own record ` +
    `could be written (${reconcileLockPath(sessionId)} held, or the write failed); the event is deferred, nothing written`
  );
  return 'deferred';
}

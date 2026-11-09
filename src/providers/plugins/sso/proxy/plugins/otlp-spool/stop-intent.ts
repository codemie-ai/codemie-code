import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { writeStop, type StopReason } from '@/agents/core/evidence/stop-marker.js';
import { withSessionLock } from './session-lock.js';
import { readStatus, writeStatus, type SessionStatus } from './session-status.js';

/*
 * A stop that could not be written to its marker is never just logged. Where the caller can keep the data (retention, tick),
 * it leaves the backlog and hold untouched and retries (`tryStop`). After a send already happened (an unverified or final
 * answer) the intent is kept in the session status, the spool's own durable state, and in memory; `stopIntentPending`
 * refuses every later send and retries the marker. In-memory alone does not survive a restart: if the status write fails too
 * the intent is volatile and said so.
 */

const unwritten = new Map<string, StopReason>();
/** Sessions whose send checkpoint was set by THIS process. A checkpoint on disk that is not in here is a previous process's unresolved attempt. */
const inflight = new Set<string>();

/** This process has a request (or a failed checkpoint release) of the session in flight. */
export const holdsCheckpoint = (key: string): boolean => inflight.has(key);

/** The stop a session owes: a recorded intent, or (conservatively) an unresolved checkpoint from before a restart whose answer is unknown. */
export function owedStop(key: string, status: SessionStatus | null | undefined): StopReason | undefined {
  return unwritten.get(key) ?? status?.stopIntent ?? (status?.sendCheckpoint && !inflight.has(key) ? 'response_unverified' : undefined);
}

/**
 * Write-ahead checkpoint for a new-contract request: durable before the POST; false = send nothing. It is cleared by
 * `endSend` once the outcome is processed, so a crash or storage failure after the POST leaves it for `stopIntentPending`.
 */
export async function beginSend(key: string, sessionId: string): Promise<boolean> {
  if (inflight.has(key)) return true; // an auth / stale-policy retry of the same send: already durable
  try {
    await withSessionLock(sessionId, async () => {
      const status = await readStatus(sessionId);
      if (!status) throw new Error('no session status');
      if (!status.sendCheckpoint) {
        status.sendCheckpoint = true;
        await writeStatus(sessionId, status);
      }
    });
    inflight.add(key);
    return true;
  } catch {
    return false;
  }
}

/** Outcome processed. `keep` = a required stop is not yet recorded anywhere durable: the checkpoint stays. */
export async function endSend(key: string, sessionId: string, keep: boolean): Promise<void> {
  if (keep) return;
  try {
    await withSessionLock(sessionId, async () => {
      const status = await readStatus(sessionId);
      if (status?.sendCheckpoint) {
        delete status.sendCheckpoint;
        await writeStatus(sessionId, status);
      }
    });
    inflight.delete(key);
  } catch { /* stays set: this process keeps sending only on a fresh begin; a restart treats it as unresolved */ }
}

/** Writes the marker; false (never throws) when it could not be written. */
export async function tryStop(key: string, reason: StopReason, sessionId: string): Promise<boolean> {
  try {
    await writeStop(key, reason, sessionId);
    return true;
  } catch (err) {
    logger.warn('[otlp-stop] stop marker not written; publication stays blocked and the stop is retried', ...sanitizeLogArgs({ sessionId, reason, err: err instanceof Error ? err.message : String(err) }));
    return false;
  }
}

/** Outside the session lock. 'marker' = durable stop; 'intent' = durable intent in the session status; 'volatile' = this process only. */
export async function stopOrRecordIntent(key: string, reason: StopReason, sessionId: string): Promise<'marker' | 'intent' | 'volatile'> {
  if (await tryStop(key, reason, sessionId)) return 'marker';
  if (!unwritten.has(key)) unwritten.set(key, reason);
  try {
    await withSessionLock(sessionId, async () => {
      const status = await readStatus(sessionId);
      if (!status) throw new Error('no session status');
      status.stopIntent ??= reason;
      await writeStatus(sessionId, status);
    });
    return 'intent';
  } catch {
    logger.warn('[otlp-stop] stop intent held in memory only; a restart before the marker can be written loses it', ...sanitizeLogArgs({ sessionId, reason }));
    return 'volatile';
  }
}

/** True while a recorded stop intent is unresolved (callers must send nothing); each call retries the marker and then clears the intent. Outside the session lock. */
export async function stopIntentPending(key: string, sessionId: string): Promise<boolean> {
  const reason = owedStop(key, await readStatus(sessionId));
  if (!reason) return false;
  if (await tryStop(key, reason, sessionId)) {
    unwritten.delete(key);
    await withSessionLock(sessionId, async () => {
      const status = await readStatus(sessionId);
      if (status?.stopIntent || (status?.sendCheckpoint && !inflight.has(key))) {
        delete status.stopIntent;
        if (!inflight.has(key)) delete status.sendCheckpoint;
        await writeStatus(sessionId, status);
      }
    }).catch(() => undefined); // the marker exists; a leftover intent only retries an idempotent create-once write
  }
  return true;
}

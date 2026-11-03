import { stat } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { streamFile, type SpoolStream } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { oldestCarried, readStatus, writeStatus, type DeliveryFailure, type SessionStatus } from './session-status.js';
import { deliveryBackoffMs, heldRetentionMs } from './spool-config.js';
import type { DeliveryLossReason } from './session-project.js';
import type { SendOutcome } from './response.js';

/*
 * Finite retention of unacknowledged deliveries (AC9): the per-stream failure record in the session
 * status, its backoff gate and its expiry. Takes the session lock itself (never call while holding it) and imports nothing
 * from spool-io/forwarder, so both can depend on it.
 */

/** The stream's failure record while it still describes the pending range (same start, still inside the file). */
async function liveDelivery(sessionId: string, status: SessionStatus, stream: SpoolStream): Promise<DeliveryFailure | undefined> {
  const rec = status.delivery?.[stream];
  if (!rec || rec.cursor !== status.cursors[stream]) return undefined;
  try {
    return (await stat(streamFile(sessionId, stream))).size >= rec.end ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The retention bound of one failing range: drop exactly the unacknowledged `[cursor, end)` of this
 * stream, with its reason and byte count recorded and warned. Acknowledged bytes, other streams and
 * anything appended after `end` are untouched (the latter is new pending data with its own clock).
 * Mutates `status` only; caller holds the lock and writes.
 */
function expireDeliveryLocked(sessionId: string, status: SessionStatus, stream: SpoolStream, rec: DeliveryFailure, now: number): void {
  const bytes = rec.end - rec.cursor;
  status.cursors[stream] = rec.end;
  status.lastLoss = { reason: rec.reason, at: now, bytes, ...(rec.detail ? { detail: rec.detail } : {}) };
  delete status.delivery![stream];
  if (Object.keys(status.delivery!).length === 0) delete status.delivery;
  logger.warn(
    '[otlp-spool] unacknowledged analytics dropped at the retention bound',
    ...sanitizeLogArgs({ sessionId, stream, reason: rec.reason, detail: rec.detail, bytes })
  );
}

/**
 * Before a stream's request: `wait` while its bounded backoff runs; at the retention bound the failing
 * range is dropped (recorded) and the stream continues with whatever arrived after it. Takes the
 * session lock: never call while holding it.
 */
export async function deliveryGate(sessionId: string, stream: SpoolStream, now: number = Date.now()): Promise<'go' | 'wait'> {
  // Common case first, without the lock: nothing recorded for this stream.
  if (!(await readStatus(sessionId))?.delivery?.[stream]) return 'go';
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status?.delivery?.[stream]) return 'go';
    const rec = await liveDelivery(sessionId, status, stream);
    if (!rec) {
      delete status.delivery[stream];
      if (Object.keys(status.delivery).length === 0) delete status.delivery;
      await writeStatus(sessionId, status);
      return 'go';
    }
    if (now - rec.since >= heldRetentionMs()) {
      expireDeliveryLocked(sessionId, status, stream, rec, now);
      await writeStatus(sessionId, status);
      return 'go';
    }
    return now < rec.nextAt ? 'wait' : 'go';
  });
}

/**
 * An unacknowledged request for the range starting at `cursor`: remember the first failure (kept across
 * reason changes, restarts and proof successes), space the next attempt, and drop the range if it is
 * now past the retention bound. Only the failed request's `range` is the affected backlog. A range that was acknowledged meanwhile (cursor moved) is ignored.
 * Takes the session lock: never call while holding it.
 */
export async function noteDeliveryFailure(
  sessionId: string,
  stream: SpoolStream,
  failure: { reason: DeliveryLossReason; detail?: string },
  range: { cursor: number; end: number },
  now: number = Date.now()
): Promise<'noted' | 'lost' | 'stale'> {
  return withSessionLock(sessionId, async () => {
    const { cursor } = range;
    const status = await readStatus(sessionId);
    if (!status || status.cursors[stream] !== cursor) return 'stale';
    const previous = await liveDelivery(sessionId, status, stream);
    let size: number;
    try {
      size = (await stat(streamFile(sessionId, stream))).size;
    } catch {
      return 'stale';
    }
    if (size <= cursor) return 'stale';
    const attempts = (previous?.attempts ?? 0) + 1;
    const pending = Math.min(range.end, size);
    // Bytes handed over from the owner-pending queue at the head of the range keep their original age, and only they expire with it.
    const carried = oldestCarried(status, stream, cursor, pending);
    const head = carried && carried.start <= cursor ? carried : undefined;
    const rec: DeliveryFailure = {
      reason: failure.reason,
      ...(failure.detail ? { detail: failure.detail.slice(0, 200) } : {}),
      since: previous?.since ?? (head ? Math.min(head.since, now) : now),
      cursor,
      end: previous?.end ?? (head ? Math.min(pending, head.end) : pending), // the range that failed, not everything pending behind it
      attempts,
      nextAt: now + deliveryBackoffMs(attempts),
    };
    status.delivery = { ...status.delivery, [stream]: rec };
    const lost = now - rec.since >= heldRetentionMs();
    if (lost) expireDeliveryLocked(sessionId, status, stream, rec, now);
    await writeStatus(sessionId, status);
    return lost ? 'lost' : 'noted';
  });
}

/**
 * What an unacknowledged outcome counts as against the retention bound. Local non-attempts (stale
 * credentials, a range no longer sendable) and an expired login are not delivery failures; every other
 * unacknowledged answer is, whatever its reason, so a changing reason never restarts the clock.
 */
export function deliveryFailureOf(o: SendOutcome): { reason: DeliveryLossReason; detail?: string } | undefined {
  if (o.kind === 'ok' || o.kind === 'discarded' || o.kind === 'auth-expired') return undefined;
  const cause = o.reason ?? o.kind;
  if (cause === 'credentials_stale' || cause === 'not_sendable') return undefined;
  if (['http_400', 'http_413', 'http_422'].includes(cause)) return { reason: 'delivery_rejected', detail: cause };
  if (o.detail) return { reason: 'destination_unavailable', detail: o.detail };
  if (cause === 'response_malformed' || cause === 'response_too_large') return { reason: 'response_unverified', detail: cause };
  return { reason: 'delivery_failed', detail: cause };
}

/** The one place an unacknowledged request starts (or continues) its range's retention clock. Never throws. */
export async function recordUnacknowledged(
  sessionId: string,
  stream: SpoolStream,
  outcome: SendOutcome,
  range: { cursor: number; end: number }
): Promise<void> {
  const failure = deliveryFailureOf(outcome);
  if (!failure) return;
  try {
    await noteDeliveryFailure(sessionId, stream, failure, range);
  } catch (err) {
    logger.debug('[otlp-forwarder] delivery failure not recorded', ...sanitizeLogArgs({ sessionId, stream, err: err instanceof Error ? err.message : String(err) }));
  }
}

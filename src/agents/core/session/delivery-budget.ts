/**
 * The delivery budget of a closed session record: the one place that decides when a record may leave the delivery
 * queue with data still unsent.
 *
 * A record is dropped only after a `counted` failure, once its failing clock has run the retry window AND at least
 * {@link MIN_REAL_ATTEMPTS} real attempts were made; the evidence retention is the outer bound. Outages, rejected
 * credentials and aborts never spend it.
 */
import type { DropReason, Session } from './types.js';
import { SessionStore } from './SessionStore.js';
import { renameSessionFiles } from './session-generation.js';
import { legacyMetricsWithheld } from './legacy-metrics-gate.js';
import { getSessionConversationPath, getSessionMetricsPath } from './session-config.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import { getPayloadId } from '@/providers/plugins/sso/session/processors/conversations/payload-queue.js';
import { CONVERSATION_SYNC_STATUS, type ConversationPayloadRecord } from '@/providers/plugins/sso/session/processors/conversations/types.js';
import type { RequestOutcome } from '@/providers/plugins/sso/session/bounded-request.js';
import { evidenceRecordIdleDays } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-config.js';
import { logger } from '@/utils/logger.js';

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = DAY_MS;

/** Real attempts a record needs before the window can drop it. */
const MIN_REAL_ATTEMPTS = 3;

/** How long a record may keep failing before it can be dropped; `CODEMIE_DELIVERY_RETRY_WINDOW_MS` overrides the 24h default. */
export function retryWindowMs(): number {
  const parsed = Number(process.env.CODEMIE_DELIVERY_RETRY_WINDOW_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_MS;
}

/** The record with one more real attempt; the caller saves it before the send. */
export function beginRealAttempt(s: Session, now: number = Date.now()): Session {
  return { ...s, deliveryRealAttempts: (s.deliveryRealAttempts ?? 0) + 1, deliveryAttemptedAt: now };
}

/**
 * The record after an attempt ended in `outcome`: the failing clock starts on the first outcome that met a failing
 * server or an outage (neither `ok` nor `not-attempt`: an attempt that made no request starts nothing), and the attempt
 * is given back unless the outcome is `counted`. An `ok` outcome clears the clock (the next failure starts a new one). A `rejected` outcome also stamps the drop (first one wins), so the exit
 * notice can report it; the record stays queued while other lines are undelivered.
 */
export function noteOutcome(s: Session, outcome: RequestOutcome, now: number): Session {
  const next: Session = { ...s };
  if (outcome !== 'ok' && outcome !== 'not-attempt') next.deliveryFailingSince = s.deliveryFailingSince ?? now;
  // A successful attempt ends the failing streak: the window runs from the first failure after it (null survives a merge)
  else if (outcome === 'ok' && s.deliveryFailingSince != null) next.deliveryFailingSince = null;
  if (outcome !== 'counted') next.deliveryRealAttempts = Math.max(0, (s.deliveryRealAttempts ?? 0) - 1);
  return outcome === 'rejected' ? stampRejection(next, now) : next;
}

/**
 * The record with the drop of a server rejection (a JSON 400/422) stamped, so the exit notice reports it; an earlier
 * stamp stays. Spends no attempt and starts no clock: for a rejection met outside an attempt (a timer run).
 */
export function stampRejection(s: Session, now: number): Session {
  return s.droppedAt !== undefined ? s : { ...s, droppedAt: now, droppedReason: 'rejected by the server' };
}

/** Why the record may leave the queue now, or undefined while it must stay. */
export function budgetSpent(s: Session, lastOutcome: RequestOutcome, now: number): DropReason | undefined {
  const at = s.endTime ?? s.startTime;
  if (at !== undefined && now - at >= evidenceRecordIdleDays() * DAY_MS) return 'retention expired';
  if (lastOutcome !== 'counted' || s.deliveryFailingSince == null) return undefined;
  // A clock in the future (a skewed system time) counts as no time elapsed
  const elapsed = Math.max(0, now - s.deliveryFailingSince);
  if (elapsed >= retryWindowMs() && (s.deliveryRealAttempts ?? 0) >= MIN_REAL_ATTEMPTS) return 'retry budget exhausted';
  return undefined;
}

/** The earliest moment the record could be dropped: the end of its retry window, or of the evidence retention when that comes first. */
export function notDroppedBefore(s: Session, now: number): number {
  const windowEnd = (s.deliveryFailingSince ?? now) + retryWindowMs();
  const at = s.endTime ?? s.startTime;
  // Never a moment already past: a record held back past its window by too few real attempts is not promised a date behind us
  return Math.max(now, at === undefined ? windowEnd : Math.min(windowEnd, at + evidenceRecordIdleDays() * DAY_MS));
}

/**
 * Whether a closed record still holds data it was to send: an end metric neither sent nor skipped, or — for a matched
 * record — a metric line still pending or failed, or a conversation payload neither sent nor superseded. A file
 * that cannot be read is not delivered; a torn line in it is skipped.
 */
export async function hasUndeliveredData(record: Session): Promise<boolean> {
  if (record.endMetricSentAt === undefined && record.endMetricSkipped === undefined) return true;
  if (record.correlation?.status !== 'matched') return false;
  try {
    // A legacy-gate skip withholds the metric deltas for good: only the conversation payloads still count
    if (!legacyMetricsWithheld(record)) {
      const deltas = await readJSONLTolerant<{ syncStatus?: string }>(getSessionMetricsPath(record.sessionId), '[delivery]');
      // The lines the metrics processor will send (pending/failed): a line it never resends cannot hold the record queued
      if (deltas.some((delta) => delta.syncStatus === 'pending' || delta.syncStatus === 'failed')) return true;
    }
    const payloads = await readJSONLTolerant<ConversationPayloadRecord>(getSessionConversationPath(record.sessionId), '[delivery]');
    const sent = new Set(payloads.filter((p) => p.status === CONVERSATION_SYNC_STATUS.SUCCESS).map(getPayloadId));
    return payloads.some((p) =>
      (p.status === CONVERSATION_SYNC_STATUS.PENDING || p.status === CONVERSATION_SYNC_STATUS.FAILED) && !sent.has(getPayloadId(p)));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[delivery] ${record.sessionId}: cannot read its pending data; counted undelivered: ${msg}`);
    return true;
  }
}

/**
 * Takes the record out of the delivery queue (renames its files; `rename` replaces the plain rename when the caller
 * bounds it by a deadline or an abort signal, and returns whether the files moved). With a `reason` and data still unsent it
 * first writes `droppedAt` and `droppedReason` (an earlier drop mark stays); without a reason the close is
 * local-by-design and is never marked. When the files did not move the record stays queued: `s` is saved as given, so
 * the mark just written is cleared and the caller's state (clock, counters) is kept.
 */
export async function leaveQueue(
  s: Session,
  reason: DropReason | undefined,
  now: number,
  rename: (sessionId: string) => Promise<boolean> = (sessionId) => renameSessionFiles(sessionId)
): Promise<boolean> {
  const store = new SessionStore();
  if (reason && (await hasUndeliveredData(s))) {
    await store.saveSession({ ...s, droppedAt: s.droppedAt ?? now, droppedReason: s.droppedReason ?? reason });
    logger.warn(`[delivery] ${s.sessionId}: leaves the delivery queue with data unsent (${reason}); marked dropped`);
  }
  const renamed = await rename(s.sessionId);
  if (!renamed) {
    // The record stays queued: it keeps the state the caller computed (clock, counters) and no mark just written, so the exit notice stays true
    await store.saveSession(s).catch((error: unknown) => {
      logger.warn(`[delivery] ${s.sessionId}: not renamed and its state cannot be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return renamed;
}

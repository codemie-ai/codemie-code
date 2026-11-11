import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { liveDelivery } from './delivery-state.js';
import { listSessionIdsStrict, SPOOL_STREAMS, type SpoolStream } from './spool-paths.js';
import { createStatus, readStatus, type SessionStatus } from './session-status.js';
import { readSpoolState } from './spool-state.js';
import type { Capability } from './policy-cache.js';

/** How many sessions are inspected at once (bounds open file handles on a large spool). */
const SESSION_CONCURRENCY = 16;

/**
 * Hold reasons that mean the session's local classification never completed — either because the
 * backend never answered (`classificationUnreachable`, capability `'unknown'`) or because it
 * answered that it will never support classification for this session (`classificationUnsupported`,
 * capability `'legacy'`). Deliberately excludes `publication_stopped`, which means the backend
 * answered and declined, not that classification stalled.
 */
const CLASSIFICATION_STALL_REASONS = new Set(['publication_contract_unavailable', 'organization_encoding_unsupported']);

/** What the spool says about analytics delivery, aggregated over every session. Derived from existing files only. */
export interface SpoolDeliverySummary {
  /** Sum of unsent bytes (size - cursor) across all spool streams of all sessions. */
  pendingBytes: number;
  /** The spool could not be read completely, so `pendingBytes` may be too low. */
  incomplete?: boolean;
  /** A session with pending data is held because the analytics endpoint does not match the credential identity. */
  mismatchHeld: boolean;
  /** The live delivery-failure record that retries first, across all streams; absent when none fails. */
  sendFailure?: SendFailure;
  /** A session's classification never completed because the backend never answered (see spec AC1-AC3). */
  classificationUnreachable: boolean;
  /**
   * A session's classification will never complete because the backend answered that it does not
   * support classification at all (an authenticated 404 on classification-policy, capability
   * `'legacy'`). Unlike `classificationUnreachable`, this is not transient: the held data is
   * eventually discarded once its retention window elapses.
   */
  classificationUnsupported: boolean;
  /**
   * The newest drop any session status records: a backend discard (`lastDiscard`, `local: false`) or a
   * local loss (`lastLoss`, `local: true`); `at` in epoch milliseconds. Absent when none records one.
   */
  latestDrop?: LatestDrop;
}

/** When the next delivery attempt is due (epoch milliseconds) and the error code of that failure. */
export interface SendFailure {
  nextAt: number;
  detail?: string;
}

export interface LatestDrop {
  reason: string;
  stream?: SpoolStream;
  at: number;
  local: boolean;
}

function newer(a: LatestDrop | undefined, b: LatestDrop | undefined): LatestDrop | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

function earlier(a: SendFailure | undefined, b: SendFailure | undefined): SendFailure | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.nextAt < a.nextAt ? b : a;
}

function sessionDrop(status: SessionStatus): LatestDrop | undefined {
  const { lastDiscard, lastLoss } = status;
  const discard: LatestDrop | undefined = lastDiscard
    ? { reason: lastDiscard.reason, stream: lastDiscard.stream, at: lastDiscard.at, local: false }
    : undefined;
  const loss: LatestDrop | undefined = lastLoss
    ? { reason: lastLoss.reason, ...(lastLoss.stream ? { stream: lastLoss.stream } : {}), at: lastLoss.at, local: true }
    : undefined;
  return newer(discard, loss);
}

async function summarizeSession(sessionId: string, capability: Capability): Promise<SpoolDeliverySummary> {
  const status = await readStatus(sessionId);
  const spool = await readSpoolState(sessionId, status ?? createStatus());
  const pendingBytes = SPOOL_STREAMS.reduce((sum, stream) => {
    const { size, cursor } = spool.streams[stream];
    return sum + Math.max(0, size - cursor);
  }, 0);
  if (!status) {
    return { pendingBytes, mismatchHeld: false, classificationUnreachable: false, classificationUnsupported: false };
  }

  const holdReason = status.holds?.session?.reason ?? '';
  const mismatchHeld = pendingBytes > 0 && holdReason === 'analytics_endpoint_mismatch';
  const classificationUnreachable = pendingBytes > 0 && capability === 'unknown' && CLASSIFICATION_STALL_REASONS.has(holdReason);
  const classificationUnsupported = pendingBytes > 0 && capability === 'legacy' && CLASSIFICATION_STALL_REASONS.has(holdReason);
  const live = await Promise.all(SPOOL_STREAMS.map((stream) => liveDelivery(sessionId, status, stream)));
  const latestDrop = sessionDrop(status);
  const sendFailure = live.reduce<SendFailure | undefined>(
    (first, rec) => earlier(first, rec && { nextAt: rec.nextAt, ...(rec.detail ? { detail: rec.detail } : {}) }),
    undefined
  );
  return {
    pendingBytes,
    mismatchHeld,
    classificationUnreachable,
    classificationUnsupported,
    ...(sendFailure ? { sendFailure } : {}),
    ...(latestDrop ? { latestDrop } : {}),
  };
}

/**
 * Read-only roll-up of the OTLP spool's delivery state, with the newest recorded drop. Never throws: an
 * unreadable spool yields the empty summary marked `incomplete`, and a session whose status is unreadable counts its stream
 * bytes as pending without flags or drop.
 * `capability` defaults to `'evidence'` so a no-argument call never flags `classificationUnreachable` or
 * `classificationUnsupported`.
 */
export async function summarizeSpoolDelivery(capability: Capability = 'evidence'): Promise<SpoolDeliverySummary> {
  const summary: SpoolDeliverySummary = {
    pendingBytes: 0,
    mismatchHeld: false,
    classificationUnreachable: false,
    classificationUnsupported: false,
  };
  try {
    const ids = await listSessionIdsStrict();
    for (let i = 0; i < ids.length; i += SESSION_CONCURRENCY) {
      const batch = await Promise.all(ids.slice(i, i + SESSION_CONCURRENCY).map((id) => summarizeSession(id, capability)));
      for (const s of batch) {
        summary.pendingBytes += s.pendingBytes;
        summary.mismatchHeld ||= s.mismatchHeld;
        const sendFailure = earlier(summary.sendFailure, s.sendFailure);
        if (sendFailure) summary.sendFailure = sendFailure;
        summary.classificationUnreachable ||= s.classificationUnreachable;
        summary.classificationUnsupported ||= s.classificationUnsupported;
        const latestDrop = newer(summary.latestDrop, s.latestDrop);
        if (latestDrop) summary.latestDrop = latestDrop;
      }
    }
  } catch (err) {
    summary.incomplete = true;
    logger.debug('[otlp-spool] delivery summary incomplete', ...sanitizeLogArgs({ err: err instanceof Error ? err.message : String(err) }));
  }
  return summary;
}

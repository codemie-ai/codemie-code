import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { liveDelivery } from './delivery-state.js';
import { listSessionIds, SPOOL_STREAMS } from './spool-paths.js';
import { createStatus, readStatus } from './session-status.js';
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
  /** A session with pending data is held because the analytics endpoint does not match the credential identity. */
  mismatchHeld: boolean;
  /** At least one stream has a live delivery-failure record. */
  sendFailed: boolean;
  /** A session's classification never completed because the backend never answered (see spec AC1-AC3). */
  classificationUnreachable: boolean;
  /**
   * A session's classification will never complete because the backend answered that it does not
   * support classification at all (an authenticated 404 on classification-policy, capability
   * `'legacy'`). Unlike `classificationUnreachable`, this is not transient: the held data is
   * eventually discarded once its retention window elapses.
   */
  classificationUnsupported: boolean;
}

async function summarizeSession(sessionId: string, capability: Capability): Promise<SpoolDeliverySummary> {
  const status = await readStatus(sessionId);
  const spool = await readSpoolState(sessionId, status ?? createStatus());
  const pendingBytes = SPOOL_STREAMS.reduce((sum, stream) => {
    const { size, cursor } = spool.streams[stream];
    return sum + Math.max(0, size - cursor);
  }, 0);
  if (!status) {
    return { pendingBytes, mismatchHeld: false, sendFailed: false, classificationUnreachable: false, classificationUnsupported: false };
  }

  const holdReason = status.holds?.session?.reason ?? '';
  const mismatchHeld = pendingBytes > 0 && holdReason === 'analytics_endpoint_mismatch';
  const classificationUnreachable = pendingBytes > 0 && capability === 'unknown' && CLASSIFICATION_STALL_REASONS.has(holdReason);
  const classificationUnsupported = pendingBytes > 0 && capability === 'legacy' && CLASSIFICATION_STALL_REASONS.has(holdReason);
  const live = await Promise.all(SPOOL_STREAMS.map((stream) => liveDelivery(sessionId, status, stream)));
  return {
    pendingBytes,
    mismatchHeld,
    sendFailed: live.some((rec) => rec !== undefined),
    classificationUnreachable,
    classificationUnsupported,
  };
}

/**
 * Read-only roll-up of the OTLP spool's delivery state. Never throws: an unreadable spool yields the
 * empty summary, and a session whose status is unreadable counts its stream bytes as pending without flags.
 * `capability` defaults to `'evidence'` so a no-argument call never flags `classificationUnreachable` or
 * `classificationUnsupported`.
 */
export async function summarizeSpoolDelivery(capability: Capability = 'evidence'): Promise<SpoolDeliverySummary> {
  const summary: SpoolDeliverySummary = {
    pendingBytes: 0,
    mismatchHeld: false,
    sendFailed: false,
    classificationUnreachable: false,
    classificationUnsupported: false,
  };
  try {
    const ids = await listSessionIds();
    for (let i = 0; i < ids.length; i += SESSION_CONCURRENCY) {
      const batch = await Promise.all(ids.slice(i, i + SESSION_CONCURRENCY).map((id) => summarizeSession(id, capability)));
      for (const s of batch) {
        summary.pendingBytes += s.pendingBytes;
        summary.mismatchHeld ||= s.mismatchHeld;
        summary.sendFailed ||= s.sendFailed;
        summary.classificationUnreachable ||= s.classificationUnreachable;
        summary.classificationUnsupported ||= s.classificationUnsupported;
      }
    }
  } catch (err) {
    logger.debug('[otlp-spool] delivery summary incomplete', ...sanitizeLogArgs({ err: err instanceof Error ? err.message : String(err) }));
  }
  return summary;
}

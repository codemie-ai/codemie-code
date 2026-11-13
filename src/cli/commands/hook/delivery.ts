import { logger } from '@/utils/logger.js';
import { beginRealAttempt, budgetSpent, hasUndeliveredData, leaveQueue, noteOutcome } from '@/agents/core/session/delivery-budget.js';
import { attemptResult } from '@/agents/core/session/stale-session-reconciliation.js';
import type { DropReason, Session } from '@/agents/core/session/types.js';
import type { RequestOutcome } from '@/providers/plugins/sso/session/bounded-request.js';
import { hasSendPath } from '@/agents/core/session/send-path.js';
import { renameSessionFiles } from '@/agents/core/session/session-generation.js';
import { lockBoundsOf } from '@/providers/plugins/sso/session/utils/locked-jsonl.js';
import type { HookProcessingConfig } from '../hook.js';
import { syncApplies } from './config-value.js';
import { applySessionEndOptions, sessionEndDeadlineMs, sessionEndOptions, type SessionEndOptions } from './session-end-options.js';
import { buildProcessingContext } from './processing-context.js';
import { sendSessionEndMetrics } from './end-metric.js';

/** Reasons after which the wrapper exits with the agent, so its exit step delivers the record. */
const WRAPPER_EXIT_REASONS = new Set(['prompt_input_exit', 'logout']);

/**
 * The pid of the live wrapper that delivers this record at its exit, else undefined.
 * The wrapper's exit step delivers only with a send path, so without one the hook delivers.
 * Pid-only liveness: a `ps` start-time check would spend the agent's ~1 s SessionEnd budget.
 */
export async function liveWrapperDelivering(reason: string | undefined, config: HookProcessingConfig | undefined): Promise<number | undefined> {
  if (!reason || !WRAPPER_EXIT_REASONS.has(reason) || !syncApplies(config) || !hasSendPath(process.env)) return undefined;
  const { WRAPPER_PID_ENV, isProcessAlive } = await import('../../../utils/processes.js');
  const pid = Number(process.env[WRAPPER_PID_ENV]);
  return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid) ? pid : undefined;
}

/**
 * Deliver a completed record: its end metric (once: never after `endMetricSentAt`), then
 * its pending data, then the `completed_` rename when delivery is done. The caller holds the
 * session's reconcile lock.
 */
export async function deliverSessionRecord(
  sessionId: string,
  agentSessionId: string,
  reason: string | undefined,
  config: HookProcessingConfig | undefined,
  options: SessionEndOptions
): Promise<void> {
  // A caller that holds the reconcile lock reports the attempt's outcome itself (the start pass, the `/clear` close)
  const reports = !options.holdsReconcileLock && syncApplies(config);
  const attempt = reports ? attemptSignal(options) : undefined;
  const bounded = attempt ? { ...options, abortSignal: attempt.signal } : options;
  try {
    if (attempt) await beginAttempt(sessionId);

    // 3. Send session end metrics (only reads the session file, which still exists —
    //    the rename stays last)
    await sendSessionEndMetrics(sessionId, agentSessionId, reason, config, bounded);

    // 4. API SYNC: Sync pending data to API using SessionSyncer (deadline-bounded,
    //    abortable; unfinished work stays pending)
    await syncPendingDataToAPI(sessionId, agentSessionId, config, bounded);
  } finally {
    attempt?.release();
  }
  const reported = attempt ? await reportOutcome(sessionId, attemptResult(attempt.signal, false)) : undefined;

  // A hook process waits for the file locks no longer than the SessionEnd budget, never the 10 s per-lock wait
  const rename = async (id: string): Promise<boolean> => {
    const syncDeadlineMs = options.hookProcess ? sessionEndDeadlineMs(options) : options.deadlineMs;
    return renameSessionFiles(id, lockBoundsOf({ syncDeadlineMs, abortSignal: options.abortSignal, hookProcess: options.hookProcess }));
  };

  // 5. Rename files LAST, and only once delivered
  if (await isDeliveryDone(sessionId, config)) {
    if (!await rename(sessionId)) {
      logger.warn(`[hook:SessionEnd] Session ${sessionId} not renamed; kept live for a later start pass`);
    }
  } else if (reported?.spent) {
    // The budget of a record that kept failing is spent: it leaves the queue marked, with its data unsent
    if (!await leaveQueue(reported.record, reported.spent, Date.now(), rename)) {
      logger.warn(`[hook:SessionEnd] Session ${sessionId} not renamed; kept live for a later start pass`);
    }
  } else {
    logger.info(`[hook:SessionEnd] Session ${sessionId} is not completed or not fully delivered yet; kept as ${sessionId}.json for a later run`);
  }
}

/** A signal of this delivery alone, following the SessionEnd's own abort: the outcomes its requests note stay apart from other work's. */
export function attemptSignal(options: SessionEndOptions): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const parent = options.abortSignal;
  const follow = (): void => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener('abort', follow, { once: true });
  return { signal: controller.signal, release: () => parent?.removeEventListener('abort', follow) };
}

/** Saves one more real attempt on the record before the send, so a kill during it spends it. */
export async function beginAttempt(sessionId: string): Promise<void> {
  try {
    const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
    const store = new SessionStore();
    const record = await store.loadSession(sessionId);
    if (record) await store.saveSession(beginRealAttempt(record));
  } catch (error) {
    logger.warn(`[hook:SessionEnd] Cannot record the delivery attempt of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reports the delivery's outcome to the delivery budget: the record is saved with the clock and the real-attempt counter
 * as `noteOutcome` leaves them. `spent` is why the budget lets a completed record leave the queue now.
 */
export async function reportOutcome(sessionId: string, outcome: RequestOutcome): Promise<{ record: Session; spent: DropReason | undefined } | undefined> {
  try {
    const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
    const store = new SessionStore();
    const latest = await store.loadSession(sessionId);
    if (!latest) return undefined;
    const now = Date.now();
    const record = noteOutcome(latest, outcome, now);
    await store.saveSession(record);
    return { record, spent: latest.status === 'completed' ? budgetSpent(record, outcome, now) : undefined };
  } catch (error) {
    logger.warn(`[hook:SessionEnd] Cannot report the delivery outcome of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Deliver a completed `{id}.json` record now (end metric, pending data, rename when done).
 * The caller holds the session's reconcile lock.
 */
export async function deliverSession(sessionId: string, config: HookProcessingConfig): Promise<void> {
  const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
  const record = await new SessionStore().loadSession(sessionId);
  if (!record) {
    logger.warn(`[hook] Session not found for delivery: ${sessionId}`);
    return;
  }
  const options = { ...sessionEndOptions(config), holdsReconcileLock: true };
  await logger.runWithContext(
    { agentName: config.agentName, sessionId: config.sessionId, profileName: config.profileName },
    () => deliverSessionRecord(sessionId, nativeSessionId(record), record.reason, config, options)
  );
}

/** The agent's own session id of a record, else its CodeMie id. */
export function nativeSessionId(record: { sessionId: string; correlation?: { agentSessionId?: string } }): string {
  const agentSessionId = record.correlation?.agentSessionId;
  return agentSessionId && agentSessionId !== 'unknown' ? agentSessionId : record.sessionId;
}

/**
 * Delivery is done when the record is `completed` (a close whose status write failed stays live
 * for the stranded path) and holds no undelivered data (the one predicate, {@link hasUndeliveredData}).
 */
export async function isDeliveryDone(sessionId: string, config?: HookProcessingConfig): Promise<boolean> {
  const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
  const record = await new SessionStore().loadSession(sessionId);
  if (!record) return false;
  // A record whose close did not complete stays live for the stranded path
  if (record.status !== 'completed') return false;
  // Without a sync, only the end metric's own mark is left to wait for
  if (!syncApplies(config)) return record.endMetricSentAt !== undefined || record.endMetricSkipped !== undefined;
  return !(await hasUndeliveredData(record));
}

/**
 * Sync pending data to API using SessionSyncer
 * Same service used by plugin timer - ensures consistency
 *
 * @param sessionId - CodeMie session ID
 * @param agentSessionId - Agent session ID for context
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 * @param options - The SessionEnd's bounds: a hook process and a caller without bounds get the
 *   2 s budget; an in-process caller with a deadline or abort signal is bounded by those alone
 */
async function syncPendingDataToAPI(sessionId: string, agentSessionId: string, config: HookProcessingConfig | undefined, options: SessionEndOptions): Promise<void> {
  try {
    if (!syncApplies(config)) {
      logger.debug('[hook:SessionEnd] Skipping API sync (CodeMie analytics auth not configured)');
      return;
    }

    logger.info(`[hook:SessionEnd] Syncing pending data to API`);

    // Build processing context
    const context = await buildProcessingContext(sessionId, agentSessionId, '', config);
    if (!context.apiBaseUrl) {
      logger.debug('[hook:SessionEnd] Skipping API sync (no send path: no sync API URL, no started proxy)');
      return;
    }

    // Bound the sync. Sync loops check the deadline between items, the clients abort a
    // request in flight at it; the rest stays pending for a later run.
    applySessionEndOptions(context, options);

    // Use SessionSyncer service (same as plugin)
    const { SessionSyncer } = await import(
      '../../../providers/plugins/sso/session/SessionSyncer.js'
    );
    const syncer = new SessionSyncer();

    // Sync pending data
    const result = await syncer.sync(sessionId, context);

    if (result.success) {
      logger.info(`[hook:SessionEnd] API sync complete: ${result.message}`);
    } else {
      logger.warn(`[hook:SessionEnd] API sync had failures: ${result.message}`);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook:SessionEnd] Failed to sync pending data: ${errorMessage}`);
    // Don't throw - sync failure should not block session end
  }
}

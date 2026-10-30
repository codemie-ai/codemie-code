import { logger } from '@/utils/logger.js';
import { getSessionMetricsPath, getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { markDroppedIfUndelivered } from '@/agents/core/session/stale-session-reconciliation.js';
import { hasSendPath } from '@/agents/core/session/send-path.js';
import { renameSessionFiles } from '@/agents/core/session/session-generation.js';
import type { HookProcessingConfig } from '../hook.js';
import { syncApplies } from './config-value.js';
import { sessionEndOptions, type SessionEndOptions } from './session-end-options.js';
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
  // 3. Send session end metrics (only reads the session file, which still exists —
  //    the rename stays last)
  await sendSessionEndMetrics(sessionId, agentSessionId, reason, config, options);

  // 4. API SYNC: Sync pending data to API using SessionSyncer (deadline-bounded,
  //    abortable; unfinished work stays pending)
  await syncPendingDataToAPI(sessionId, agentSessionId, config, options);

  // 5. Rename files LAST, and only once delivered
  if (await isDeliveryDone(sessionId, config)) {
    // A line past its sync-attempt cap counts as done: it leaves the queue unsent
    if (syncApplies(config)) await markDroppedIfUndelivered(sessionId);
    await renameSessionFiles(sessionId);
  } else {
    logger.info(`[hook:SessionEnd] Session ${sessionId} is not fully delivered yet; kept as ${sessionId}.json for a later run`);
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
 * Delivery is done when the end metric is sent or does not apply, and — for a matched
 * record whose sync applies — no metric line is pending / retryable and no conversation
 * payload is waiting.
 */
async function isDeliveryDone(sessionId: string, config?: HookProcessingConfig): Promise<boolean> {
  const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
  const record = await new SessionStore().loadSession(sessionId);
  if (!record) return false;
  if (record.endMetricSentAt === undefined && record.endMetricSkipped === undefined) return false;
  // An unmatched record has no transcript data to sync: not applicable, never a failed delivery
  if (record.correlation?.status !== 'matched' || !syncApplies(config)) return true;

  try {
    const { readJSONL } = await import('../../../providers/plugins/sso/session/utils/jsonl-reader.js');
    const { isDeltaSendCandidate } = await import('../../../providers/plugins/sso/session/processors/metrics/metrics-sync-processor.js');
    const deltas = await readJSONL<Parameters<typeof isDeltaSendCandidate>[0]>(getSessionMetricsPath(sessionId));
    if (deltas.some(isDeltaSendCandidate)) {
      return false;
    }
    const { isSendCandidate } = await import('../../../providers/plugins/sso/session/processors/conversations/payload-queue.js');
    const payloads = await readJSONL<Parameters<typeof isSendCandidate>[0]>(getSessionConversationPath(sessionId));
    return !payloads.some(isSendCandidate);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook:SessionEnd] Cannot read the pending data of ${sessionId}; kept undelivered: ${msg}`);
    return false;
  }
}

/**
 * Default budget (ms) for the SessionEnd API sync. Claude Code kills the hook
 * process quickly at exit, so the sync must stop sending and defer leftovers
 * instead of blocking teardown.
 * Override via CODEMIE_SESSION_END_SYNC_BUDGET_MS (invalid or non-positive
 * values fall back to this default).
 */
const DEFAULT_SESSION_END_SYNC_BUDGET_MS = 2000;

function resolveSessionEndSyncBudgetMs(): number {
  const parsed = Number.parseInt(process.env.CODEMIE_SESSION_END_SYNC_BUDGET_MS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_END_SYNC_BUDGET_MS;
  }
  return parsed;
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
    const callerBounded = !options.hookProcess && (options.deadlineMs !== undefined || options.abortSignal !== undefined);
    const budgetDeadlineMs = Date.now() + resolveSessionEndSyncBudgetMs();
    context.syncDeadlineMs = callerBounded
      ? options.deadlineMs
      : Math.min(budgetDeadlineMs, options.deadlineMs ?? budgetDeadlineMs);
    context.abortSignal = options.abortSignal;
    context.hookProcess = options.hookProcess === true;

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

/**
 * The close of a previous `/clear` generation: its delivery attempt, and what becomes of its set afterwards (kept in the
 * delivery queue, or set aside under its generation name). Used by the SessionStart that replaces the generation.
 */
import { logger } from '@/utils/logger.js';
import type { Session } from '@/agents/core/session/types.js';
import { attemptResult, lastRecordedActivityAt, readLiveRecord } from '@/agents/core/session/stale-session-reconciliation.js';
import type { RequestOutcome } from '@/providers/plugins/sso/session/bounded-request.js';
import { budgetSpent, hasUndeliveredData, leaveQueue } from '@/agents/core/session/delivery-budget.js';
import { sameHost } from '@/agents/core/session/send-path.js';
import { moveSetToGeneration, requeueSetUnderNewId } from '@/agents/core/session/session-generation.js';
import type { LockBounds } from '@/providers/plugins/sso/session/utils/locked-jsonl.js';
import type { HookProcessingConfig } from '../hook.js';
import { configSendPathApiUrl, getConfigValue } from './config-value.js';
import type { SessionEndOptions } from './session-end-options.js';
import { attemptSignal, beginAttempt, reportOutcome } from './delivery.js';

/** How long a new generation's close may spend delivering the generation it closes before moving it aside. */
export const GENERATION_CLOSE_BUDGET_MS = 2_000;

/**
 * Closes a generation its full close left unclosed: `completed`, `interrupted`, ending at its last
 * recorded activity, nothing flushed or sent here (the flush is what failed). The save alone is the
 * close: a failed dropped mark is only logged. The mark is written only when the delivery budget is
 * spent after `outcome`, the outcome of the close's own delivery attempt (`not-attempt` when nothing was
 * sent); otherwise the generation stays queued. Returns the end written; undefined when the save failed.
 */
export async function closeUnclosedLocally(live: Session, config: HookProcessingConfig | undefined, outcome: RequestOutcome = 'not-attempt'): Promise<number | undefined> {
  let endTime: number;
  try {
    const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
    endTime = await lastRecordedActivityAt(live);
    await new SessionStore().saveSession({ ...live, status: 'completed', reason: 'interrupted', endTime });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook] New generation: the previous generation of ${live.sessionId} could not be closed locally; the fresh record is not written: ${errorMessage}`);
    return undefined;
  }
  logger.warn(`[hook] New generation: the previous generation of ${live.sessionId} was still active; closed locally at its last recorded activity, not flushed here`);
  if (sendsThroughThisLaunch(live, config)) {
    await markIfBudgetSpent(live.sessionId, outcome).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[hook] New generation: the previous generation of ${live.sessionId} could not be marked dropped: ${errorMessage}`);
    });
  }
  return endTime;
}

/**
 * Marks the closed live record dropped when its delivery budget is spent after `outcome` — the outcome of the close's
 * own delivery attempt, already reported to the record (see `budgetSpent`) — and data is unsent; the set is moved by
 * the caller. Only a counted failure (or the retention) spends it: an outage, an auth answer or a deadline cut never marks.
 */
export async function markIfBudgetSpent(sessionId: string, outcome: RequestOutcome): Promise<void> {
  const record = await readLiveRecord(sessionId);
  if (!record || record.status !== 'completed') return;
  const now = Date.now();
  const reason = budgetSpent(record, outcome, now);
  if (reason) await leaveQueue(record, reason, now, async () => true);
}

/**
 * Sets the live set of the previous generation aside, so the fresh record can take `{id}.json`. A generation of this launch
 * that still holds undelivered data and whose budget is not spent after `outcome` (the close's own delivery attempt,
 * `not-attempt` when nothing was sent) stays in the delivery queue: re-keyed under a fresh session id, which the start
 * pass lists by its name. Any other moves to its generation name.
 */
export async function setGenerationAside(sessionId: string, ours: boolean, bounds: LockBounds, outcome: RequestOutcome = 'not-attempt'): Promise<string | undefined> {
  const record = await readLiveRecord(sessionId);
  if (ours && record?.status === 'completed' && !budgetSpent(record, outcome, Date.now()) && (await hasUndeliveredData(record))) {
    const queuedAs = await requeueSetUnderNewId(sessionId, bounds);
    if (queuedAs) return queuedAs;
  }
  return moveSetToGeneration(sessionId, '', bounds);
}

/** Whether this launch delivers the record: it has a send path and the record is of its CodeMie host. */
export function sendsThroughThisLaunch(record: Session, config: HookProcessingConfig | undefined): boolean {
  return !!configSendPathApiUrl(config) && sameHost(record, { CODEMIE_URL: getConfigValue('CODEMIE_URL', config) });
}

/**
 * Sets a completed `{id}.json` set the previous generation's close left in place aside (see
 * {@link setGenerationAside}): queued when it is of this launch and its budget is not spent, else at its
 * generation name as it is. Its file locks are waited for within {@link GENERATION_CLOSE_BUDGET_MS}
 * and the SessionEnd's bounds. False when the move failed or a lock stayed held: the set is kept and no
 * fresh record is written.
 */
export async function moveUnclosedGeneration(
  sessionId: string,
  live: Session,
  config: HookProcessingConfig | undefined,
  options: SessionEndOptions
): Promise<boolean> {
  try {
    const moved = await setGenerationAside(sessionId, sendsThroughThisLaunch(live, config), {
      deadlineMs: Math.min(Date.now() + GENERATION_CLOSE_BUDGET_MS, options.deadlineMs ?? Infinity),
      signal: options.abortSignal,
      pidOnlyLiveness: options.hookProcess === true,
    });
    logger.warn(`[hook] New generation: the previous generation of ${sessionId} could not be closed; it is kept as ${moved}, unsent`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook] New generation: the previous generation of ${sessionId} could not be closed; the fresh record is not written: ${errorMessage}`);
    return false;
  }
}

/**
 * Runs `close` as one delivery attempt when this launch sends the generation (`ours`): saved before the send, its outcome
 * reported to the delivery budget after it, a throw included (a local failure gives the attempt back). Returns the
 * outcome, `not-attempt` when nothing was sent.
 */
export async function runCloseAttempt(
  sessionId: string,
  ours: boolean,
  options: SessionEndOptions,
  deadlineMs: number,
  close: (bounded: SessionEndOptions) => Promise<void>
): Promise<RequestOutcome> {
  const attempt = ours ? attemptSignal(options) : undefined;
  const bounded: SessionEndOptions = {
    ...options, deadlineMs, holdsReconcileLock: true, localOnly: !ours, ...(attempt && { abortSignal: attempt.signal }),
  };
  let outcome: RequestOutcome = 'not-attempt';
  let thrown = false;
  try {
    if (attempt) await beginAttempt(sessionId);
    await close(bounded);
  } catch (error) {
    thrown = true;
    throw error;
  } finally {
    attempt?.release();
    if (attempt) {
      outcome = attemptResult(attempt.signal, thrown);
      await reportOutcome(sessionId, outcome);
    }
  }
  return outcome;
}

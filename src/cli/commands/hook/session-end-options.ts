import type { HookProcessingConfig } from '../hook.js';
import { EXIT_DEADLINE_ENV } from '@/agents/core/session/stale-session-reconciliation.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';

/** The bounds and mode of one SessionEnd. */
export interface SessionEndOptions {
  /** True only inside a `codemie hook` process */
  hookProcess?: boolean;
  abortSignal?: AbortSignal;
  /** Set → no 2 s sync budget; the network work stops at this epoch ms */
  deadlineMs?: number;
  holdsReconcileLock?: boolean;
  localOnly?: boolean;
}

export function sessionEndOptions(config?: HookProcessingConfig, abortSignal?: AbortSignal, hookProcess = false): SessionEndOptions {
  if (!config) return { hookProcess, abortSignal };
  const envDeadline = Number(config.env?.[EXIT_DEADLINE_ENV]);
  return {
    hookProcess,
    abortSignal: config.abortSignal ?? abortSignal,
    deadlineMs: config.deadlineMs ?? (Number.isFinite(envDeadline) && envDeadline > 0 ? envDeadline : undefined),
    holdsReconcileLock: config.holdsReconcileLock,
    localOnly: config.localOnly,
  };
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
 * The deadline of a SessionEnd step starting now: a hook process and a caller without bounds get the
 * sync budget; an in-process caller with a deadline or abort signal is bounded by those alone.
 */
export function sessionEndDeadlineMs(options: SessionEndOptions): number | undefined {
  const callerBounded = !options.hookProcess && (options.deadlineMs !== undefined || options.abortSignal !== undefined);
  const budgetDeadlineMs = Date.now() + resolveSessionEndSyncBudgetMs();
  return callerBounded
    ? options.deadlineMs
    : Math.min(budgetDeadlineMs, options.deadlineMs ?? budgetDeadlineMs);
}

/** Bounds a processing run by the hook's options: its deadline by {@link sessionEndDeadlineMs}, the abort, the mode. */
export function applySessionEndOptions(context: ProcessingContext, options: SessionEndOptions): void {
  context.syncDeadlineMs = sessionEndDeadlineMs(options);
  context.abortSignal = options.abortSignal;
  context.hookProcess = options.hookProcess === true;
}

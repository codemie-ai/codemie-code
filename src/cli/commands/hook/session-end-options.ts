import type { HookProcessingConfig } from '../hook.js';
import { EXIT_DEADLINE_ENV } from '@/agents/core/session/stale-session-reconciliation.js';

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

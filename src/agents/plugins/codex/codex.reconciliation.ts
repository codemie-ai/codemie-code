// src/agents/plugins/codex/codex.reconciliation.ts
/**
 * Codex Stale-Session Reconciliation
 *
 * Codex 0.129.0 has no graceful-shutdown guarantee, so a hard kill strands the
 * CodeMie session record as `status: "active"` with no terminal lifecycle metric.
 * Every codex `onSessionStart` reconciles those leftovers.
 *
 * The logic is agent-generic and lives in
 * `@/agents/core/session/stale-session-reconciliation.js`; this module only binds it
 * to the `codex` agent name.
 */
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
import {
  findStaleSessions,
  reconcileStaleSessions,
  type ReconcileOptions,
  type ReconciliationOptions,
  type StaleSession,
} from '../../core/session/stale-session-reconciliation.js';

export type { ReconcileOptions, ReconciliationOptions };

export type StaleCodexSession = StaleSession;

/** Find codex sessions in `~/.codemie/sessions/` that look stranded. */
export function findStaleCodexSessions(
  opts: ReconciliationOptions = {},
): Promise<StaleCodexSession[]> {
  return findStaleSessions('codex', opts);
}

/** Synthesise a SessionEnd for each stale codex session. */
export function reconcileStaleCodexSessions(
  env: NodeJS.ProcessEnv,
  buildHookConfig: (env: NodeJS.ProcessEnv, sessionId: string) => HookProcessingConfig,
  opts: ReconcileOptions = {},
): Promise<{ reconciled: number; failed: number }> {
  return reconcileStaleSessions('codex', env, buildHookConfig, opts);
}

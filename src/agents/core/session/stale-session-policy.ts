/**
 * Shared Staleness Policy
 *
 * Every runtime that reconciles abandoned sessions (CLI onSessionStart reconciliation,
 * Claude Desktop restart reconciliation) must agree on what "stale" means. Each runtime
 * keeps its own trigger (relaunch vs daemon start) and finalizer (synthetic SessionEnd vs
 * finalizeSession), but the cutoff math lives here once so the two runtimes cannot silently
 * diverge on the same backlog.
 *
 * Staleness is inactivity alone, with no cap on how long a session may have been inactive.
 * A cap would permanently exempt exactly the sessions most overdue for reconciliation: one
 * abandoned Monday and not restarted into until Wednesday is >24h inactive by the time the
 * next launch finally runs reconciliation, and the longer that gap, the more it needs
 * finalizing, not less.
 */

export const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;

export interface StalenessCheckOptions {
  now: number;
  lastActivityMs: number;
  inactivityThresholdMs: number;
}

export function isSessionStale(opts: StalenessCheckOptions): boolean {
  const { now, lastActivityMs, inactivityThresholdMs } = opts;
  return lastActivityMs <= now - inactivityThresholdMs;
}

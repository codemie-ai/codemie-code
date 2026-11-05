import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SessionStatus } from './session-status.js';

/** Sessions already told about a discard; bounded so a long-lived daemon cannot grow it without limit. */
const MAX_WARNED_SESSIONS = 1000;
const warnedDiscards = new Set<string>();

export function warnDiscardOnce(sessionId: string, ...args: unknown[]): void {
  if (warnedDiscards.has(sessionId)) return;
  if (warnedDiscards.size >= MAX_WARNED_SESSIONS) {
    // Set iteration order is insertion order: drop the oldest entry, not everyone warned so far.
    const oldest = warnedDiscards.values().next().value;
    if (oldest !== undefined) warnedDiscards.delete(oldest);
  }
  warnedDiscards.add(sessionId);
  logger.warn('[otlp-spool] session project conflict: unsent analytics discarded', ...sanitizeLogArgs(...args));
}

/** Single place that reports the none-or-bound -> conflict transition (live ingest and legacy scan). */
export function warnConflictStarted(sessionId: string, status: SessionStatus): void {
  logger.warn(
    '[otlp-spool] session switched project: only hooks recorded for the first project before the switch ' +
      'can still be sent; hooks of other projects and all OTLP logs/metrics/traces of this session are not sent',
    ...sanitizeLogArgs({
      sessionId,
      project: status.project ?? null,
      otherNames: Math.max(0, (status.projectConflict?.length ?? 0) - (status.project ? 1 : 0)),
      sealed: Boolean(status.projectSeal),
    })
  );
}

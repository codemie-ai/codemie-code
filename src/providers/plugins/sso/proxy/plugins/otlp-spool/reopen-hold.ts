import { stat } from 'node:fs/promises';
import { isReopenedIdle, loadParseState } from '@/agents/plugins/claude-code-otlp/transcript/parse-state.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { advanceCursor, readStatus } from './session-status.js';
import { abandonedSessionGraceMs, reopenSettleMs } from './spool-config.js';
import { OTEL_JSON_STREAMS, OTEL_STREAMS, streamFile, type SpoolStream } from './spool-paths.js';

/**
 * Claude Code's own OTel exports (hooks registered, plugins loaded, MCP connected, ...) are written
 * every time a session is opened, stamped with the time of the open. For a session reopened without
 * a prompt they are the only thing that happens, and delivering them moves the session's end to the
 * reopen (EPMCDME-16993). The hook path already stays silent for such a session
 * (`isReopenedIdle`); this is the same rule for the OTel streams.
 *
 * Held records stay in the spool with their cursor untouched: once the session has activity of its
 * own (its parse state leaves the idle state at the next `Stop`) they are forwarded as usual, so a
 * session that goes on to work loses nothing. Only a reopen that stays idle past the abandoned
 * grace is let go, unsent.
 *
 * The parse state is written by the hook process; it is read here without its lock. A stale read
 * can only delay a release by one tick or, in the first moments of an open, let the earliest
 * records through before the `SessionStart` hook has marked the reopen.
 */

const OTEL_SPOOL_STREAMS: readonly SpoolStream[] = [...OTEL_STREAMS, ...OTEL_JSON_STREAMS];

/** Whether the OTel streams of `sessionId` must stay unsent this tick. */
export async function holdForIdleReopen(sessionId: string, now: number = Date.now()): Promise<boolean> {
  const state = await loadParseState(sessionId);
  if (state.reopened === true && !isReopenedIdle(state)) return false; // reopened and working: nothing to hold

  const files: { stream: SpoolStream; size: number; modifiedAt: number }[] = [];
  for (const stream of OTEL_SPOOL_STREAMS) {
    try {
      const info = await stat(streamFile(sessionId, stream));
      if (info.size > 0) files.push({ stream, size: info.size, modifiedAt: info.mtimeMs });
    } catch {
      // No file for this stream.
    }
  }
  const lastWrite = files.length > 0 ? Math.max(...files.map((entry) => entry.modifiedAt)) : 0;

  if (!isReopenedIdle(state)) {
    // Not marked as a reopen (yet). Bytes written after the session ended are a reopen's startup records
    // if its hook has not run yet: give the hook a moment to mark the session before they go out.
    const endedAt = (await readStatus(sessionId))?.endedAt;
    return endedAt !== undefined && lastWrite > endedAt && now - lastWrite < reopenSettleMs();
  }

  if (files.length === 0) return true;
  // Still being written: the session is open, keep waiting for its activity.
  if (now - lastWrite < abandonedSessionGraceMs()) return true;

  for (const { stream, size } of files) {
    await advanceCursor(sessionId, stream, size, { reason: 'idle_reopen_expired', stream, bytes: size, at: now });
  }
  logger.debug('[otlp-forwarder] idle reopened session: held otel records dropped unsent', ...sanitizeLogArgs({ sessionId }));
  return true;
}

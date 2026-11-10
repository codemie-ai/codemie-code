import { open, stat } from 'node:fs/promises';
import { getCodemiePath } from '@/utils/paths.js';
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
 * A reopen that goes on to work is released as soon as a record of real work (a model request or a tool
 * result) shows up in its own spool, without waiting for a `Stop`: otherwise a session killed before any
 * hook pass would lose everything it did. Claude Code's startup records never contain those two.
 *
 * The parse state is written by the hook process; it is read here without its lock. A stale read
 * can only delay a release by one tick or, in the first moments of an open, let the earliest
 * records through before the `SessionStart` hook has marked the reopen.
 */

const OTEL_SPOOL_STREAMS: readonly SpoolStream[] = [...OTEL_STREAMS, ...OTEL_JSON_STREAMS];

/** Records only a session that really works produces (startup records never carry these names). */
const WORK_RECORD = /claude_code\.(?:api_request|tool_result)|"(?:api_request|tool_result)"/;
const SCAN_OVERLAP = 48;
const SCAN_LIMIT = 8 * 1024 * 1024;
const MEMO_LIMIT = 1000;

/** Daemon-lifetime memory: when a reopened session was seen working, and how far each stream was scanned. */
const workSeenAt = new Map<string, number>();
const scannedTo = new Map<string, number>();

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Whether the spool bytes after the cursor hold a record of real work. Streams are scanned once, from the
 * cursor or the last scanned offset (a small overlap catches a name split between two reads).
 */
async function seesOwnWork(
  sessionId: string,
  files: readonly { stream: SpoolStream; size: number }[],
  cursors: Partial<Record<SpoolStream, number>> | undefined,
  now: number
): Promise<boolean> {
  for (const { stream, size } of files) {
    const key = `${sessionId}:${stream}`;
    const from = Math.max(scannedTo.get(key) ?? 0, cursors?.[stream] ?? 0);
    const to = Math.min(size, from + SCAN_LIMIT);
    if (to <= from) continue;
    let handle;
    try {
      handle = await open(streamFile(sessionId, stream), 'r');
      const buffer = Buffer.alloc(to - from);
      const { bytesRead } = await handle.read(buffer, 0, to - from, from);
      if (WORK_RECORD.test(buffer.subarray(0, bytesRead).toString('latin1'))) {
        if (workSeenAt.size >= MEMO_LIMIT) workSeenAt.clear();
        workSeenAt.set(sessionId, now);
        return true;
      }
      if (scannedTo.size >= MEMO_LIMIT) scannedTo.clear();
      scannedTo.set(key, Math.max(from, from + bytesRead - SCAN_OVERLAP));
    } catch {
      // Unreadable now: the next tick looks again.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return false;
}

/** Whether the OTel streams of `sessionId` must stay unsent this tick. */
export async function holdForIdleReopen(sessionId: string, now: number = Date.now()): Promise<boolean> {
  const state = await loadParseState(sessionId);
  if (state.reopened === true && !isReopenedIdle(state)) return false; // reopened and working: nothing to hold

  const files: { stream: SpoolStream; size: number; modifiedAt: number; bornAt: number }[] = [];
  for (const stream of OTEL_SPOOL_STREAMS) {
    try {
      const info = await stat(streamFile(sessionId, stream));
      if (info.size > 0) files.push({ stream, size: info.size, modifiedAt: info.mtimeMs, bornAt: info.birthtimeMs });
    } catch {
      // No file for this stream.
    }
  }
  const lastWrite = files.length > 0 ? Math.max(...files.map((entry) => entry.modifiedAt)) : 0;

  if (!isReopenedIdle(state)) {
    // Not marked as a reopen (yet). Records of a reopen's startup can reach the spool before its hook has
    // marked the session: give the hook a moment before they go out. Two ways to recognise them:
    // bytes written after the session ended, or (the status was swept, days later) a spool file that was
    // created just now for a session whose saved state is much older than the file.
    if (files.length === 0 || now - lastWrite >= reopenSettleMs()) return false;
    const endedAt = (await readStatus(sessionId))?.endedAt;
    if (endedAt !== undefined) return lastWrite > endedAt;
    if (state.sessionStartedAt === undefined) return false;
    const bornAt = Math.min(...files.map((entry) => entry.bornAt));
    const stateAt = await modifiedAt(getCodemiePath('analytics', 'state', `${sessionId}.json`));
    return bornAt > 0 && stateAt > 0 && now - bornAt < reopenSettleMs() && bornAt - stateAt > reopenSettleMs();
  }

  if (files.length === 0) return true;
  const status = await readStatus(sessionId);
  // The session works (its own model requests or tool results are in the spool): release what was held.
  const seenAt = workSeenAt.get(sessionId);
  if (seenAt !== undefined && seenAt >= (await modifiedAt(getCodemiePath('analytics', 'state', `${sessionId}.json`)))) return false;
  if (await seesOwnWork(sessionId, files, status?.cursors, now)) return false;
  // Still being written: the session is open, keep waiting for its activity.
  if (now - lastWrite < abandonedSessionGraceMs()) return true;

  // Let go only of what this reopen left unsent, and only whole lines: a stream whose earlier records still
  // wait for a retry (a delivery range from before the reopen) keeps them, and the cut never lands inside a line.
  for (const { stream, size } of files) {
    if (status?.delivery?.[stream]) continue;
    const cut = await lastNewlineOffset(streamFile(sessionId, stream), size);
    if (cut <= (status?.cursors?.[stream] ?? 0)) continue;
    await advanceCursor(sessionId, stream, cut, { reason: 'idle_reopen_expired', stream, bytes: cut, at: now });
  }
  logger.debug('[otlp-forwarder] idle reopened session: held otel records dropped unsent', ...sanitizeLogArgs({ sessionId }));
  return true;
}

/** Offset just after the last newline within the first `size` bytes of `path`; 0 when there is none. */
async function lastNewlineOffset(path: string, size: number): Promise<number> {
  const CHUNK = 64 * 1024;
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(CHUNK);
    for (let end = size; end > 0; end -= CHUNK) {
      const start = Math.max(0, end - CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const index = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (index >= 0) return start + index + 1;
    }
    return 0;
  } catch {
    return 0; // Unreadable now: leave the records held rather than cut blindly.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

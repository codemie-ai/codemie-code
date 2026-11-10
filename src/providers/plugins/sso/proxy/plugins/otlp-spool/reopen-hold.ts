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
 * result) shows up in its own log stream, without waiting for a `Stop`: otherwise a session killed before
 * any hook pass would lose everything it did. A record counts only by its exact event name
 * (`api_request` / `tool_result`), never by the words appearing somewhere in a payload.
 *
 * The parse state is written by the hook process; it is read here without its lock. A stale read
 * can only delay a release by one tick or, in the first moments of an open, let the earliest
 * records through before the `SessionStart` hook has marked the reopen.
 */

const OTEL_SPOOL_STREAMS: readonly SpoolStream[] = [...OTEL_STREAMS, ...OTEL_JSON_STREAMS];

/** Only the log streams carry events; metrics and traces are never looked at for work. */
const WORK_STREAMS: readonly SpoolStream[] = ['logs', 'logsJson'];
const WORK_EVENTS: readonly string[] = ['api_request', 'tool_result'];
/** Protobuf strings are raw UTF-8 in the bytes: the event is found by its prefixed body text. */
const WORK_TOKENS: readonly string[] = WORK_EVENTS.map((name) => `claude_code.${name}`);
const SCAN_CHUNK = 8 * 1024 * 1024;
const SCAN_OVERLAP = 64;
const MEMO_LIMIT = 1000;

/**
 * Daemon-lifetime memory. `workSeenAt`: when a reopened session was seen working. `scannedTo`: how far
 * each stream was scanned. Both are an optimisation and a bridge between ticks: after a restart the scan
 * starts again at the cursor (records already forwarded are not looked at again).
 */
const workSeenAt = new Map<string, number>();
const scannedTo = new Map<string, number>();

function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MEMO_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

interface AnyValue {
  stringValue?: string;
}
interface LogRecordShape {
  body?: AnyValue;
  attributes?: { key?: string; value?: AnyValue }[];
}

/** One OTLP/JSON export (one spool line): does it hold a log record of a model request or tool result? */
function exportHoldsWork(line: string): boolean {
  let parsed: { resourceLogs?: { scopeLogs?: { logRecords?: LogRecordShape[] }[] }[] };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return false;
  }
  for (const resource of parsed.resourceLogs ?? []) {
    for (const scope of resource.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const body = record.body?.stringValue;
        if (body !== undefined && WORK_TOKENS.includes(body)) return true;
        const name = record.attributes?.find((attribute) => attribute.key === 'event.name')?.value?.stringValue;
        if (name !== undefined && WORK_EVENTS.includes(name)) return true;
      }
    }
  }
  return false;
}

/**
 * Scan one stream from `from` up to one chunk. Returns whether work was found and where the next scan
 * starts: NDJSON streams advance by whole lines only; protobuf streams advance with a small overlap so a
 * name split between two reads is still found.
 */
async function scanChunk(
  path: string,
  json: boolean,
  from: number,
  size: number
): Promise<{ found: boolean; next: number }> {
  const to = Math.min(size, from + SCAN_CHUNK);
  if (to <= from) return { found: false, next: from };
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(to - from);
    const { bytesRead } = await handle.read(buffer, 0, to - from, from);
    const bytes = buffer.subarray(0, bytesRead);
    if (!json) {
      const text = bytes.toString('latin1');
      const found = WORK_TOKENS.some((token) => text.includes(token));
      return { found, next: to >= size ? from + bytesRead : Math.max(from + 1, from + bytesRead - SCAN_OVERLAP) };
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return { found: false, next: to < size ? to : from }; // one huge line: skip it; else wait for its end
    const lines = bytes.subarray(0, lastNewline).toString('utf8').split('\n');
    return { found: lines.some(exportHoldsWork), next: from + lastNewline + 1 };
  } catch {
    return { found: false, next: from }; // Unreadable now: the next tick looks again.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** One tick: look at the new bytes after the cursor (or the last scanned offset) of the log streams. */
async function seesOwnWork(
  sessionId: string,
  files: readonly { stream: SpoolStream; size: number }[],
  cursors: Partial<Record<SpoolStream, number>> | undefined,
  now: number
): Promise<boolean> {
  for (const { stream, size } of files) {
    if (!WORK_STREAMS.includes(stream)) continue;
    const key = `${sessionId}:${stream}`;
    const from = Math.max(scannedTo.get(key) ?? 0, cursors?.[stream] ?? 0);
    const { found, next } = await scanChunk(streamFile(sessionId, stream), stream === 'logsJson', from, size);
    if (found) {
      remember(workSeenAt, sessionId, now);
      return true;
    }
    remember(scannedTo, key, next);
  }
  return false;
}

/** Before giving up on a reopen: look at everything that is still unsent, not just the next chunk. */
async function holdsWorkAnywhere(
  sessionId: string,
  files: readonly { stream: SpoolStream; size: number }[],
  cursors: Partial<Record<SpoolStream, number>> | undefined
): Promise<boolean> {
  for (const { stream, size } of files) {
    if (!WORK_STREAMS.includes(stream)) continue;
    let from = cursors?.[stream] ?? 0;
    while (from < size) {
      const { found, next } = await scanChunk(streamFile(sessionId, stream), stream === 'logsJson', from, size);
      if (found) return true;
      if (next <= from) break;
      from = next;
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
  // The release stands until the next reopen marks the state again (`reopenedAt`), whatever else the
  // hook passes save in between.
  const seenAt = workSeenAt.get(sessionId);
  if (seenAt !== undefined && seenAt >= (state.reopenedAt ?? 0)) return false;
  if (await seesOwnWork(sessionId, files, status?.cursors, now)) return false;
  // Still being written: the session is open, keep waiting for its activity.
  if (now - lastWrite < abandonedSessionGraceMs()) return true;
  // About to give up: make sure no work is hiding in bytes the ticks have not reached yet.
  if (await holdsWorkAnywhere(sessionId, files, status?.cursors)) {
    remember(workSeenAt, sessionId, now);
    return false;
  }

  // Let go only of what this reopen left unsent: a stream whose earlier records still wait for a retry (a
  // delivery range from before the reopen) keeps them. NDJSON streams are cut at the last whole line;
  // protobuf streams at their end (a newline byte can occur inside a message, and nothing is written now).
  for (const { stream, size } of files) {
    if (status?.delivery?.[stream]) continue;
    const json = (OTEL_JSON_STREAMS as readonly SpoolStream[]).includes(stream);
    const cut = json ? await lastNewlineOffset(streamFile(sessionId, stream), size) : size;
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

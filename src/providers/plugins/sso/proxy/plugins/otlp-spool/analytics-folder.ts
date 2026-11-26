/**
 * The move of the local mode: a session past its grace leaves the local spool for the analytics folder, its hook
 * events as OTLP hook records and its JSON telemetry as it came, every line carrying its line id — the folder file's
 * name and a hash of the spool line, the same at every move of that line. A move is written down first
 * (`<sessionId>.moving` in the folder), so a move cut at any step repeats to the same files. The folder is only
 * appended to.
 */
import { appendFile, open, readFile, readdir, stat, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { writeJsonFileAtomic } from '@/utils/atomic-write.js';
import {
  FOLDER_STREAMS,
  MOVING_SUFFIX,
  analyticsFolderRoot,
  ensureAnalyticsFolder,
  folderFileName,
  type FolderStream,
} from './analytics-folder-paths.js';
import { isSessionExcluded } from './analytics-exclusion-mark.js';
import { encodeHookRecord, addLineId, hookRecordEventId, lineIdOf, parseHookEnvelope } from './hook-record-format.js';
import { OTEL_STREAMS, SPOOL_STREAMS, listSessionIds, streamFile } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { createStatus, readStatus, writeStatus } from './session-status.js';
import { isSessionDrained, lastActivityMs, readSpoolState } from './spool-state.js';
import { deleteSession, isPastGrace } from './sweep.js';

/** The spool streams a move copies, each into its folder stream; the `.bin` streams are not copied. */
const MOVED_STREAMS = ['hooks', 'logsJson', 'metricsJson', 'tracesJson'] as const;
type MovedStream = (typeof MOVED_STREAMS)[number];
const FOLDER_STREAM_OF: Record<MovedStream, FolderStream> = {
  hooks: 'hooks',
  logsJson: 'logs',
  metricsJson: 'metrics',
  tracesJson: 'traces',
};

/** Input bytes a copy reads, converts and appends before it yields to the event loop. */
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** A move written down before its first write to the folder. */
interface MoveMarker {
  /** Each folder file's size before the move (0 when absent): a repeated move starts by cutting it back to this. */
  lengths: Record<string, number>;
  /** The spool byte range a move copies of each stream: `[from, upto)`. */
  from: Record<MovedStream, number>;
  upto: Record<MovedStream, number>;
  /** The time of an event whose own `timestamp` does not parse. */
  nowMs: number;
}

let sweeping = false;

const markerPath = (sessionId: string): string => join(analyticsFolderRoot(), sessionId + MOVING_SUFFIX);
const folderPath = (sessionId: string, stream: FolderStream): string =>
  join(analyticsFolderRoot(), folderFileName(sessionId, stream));

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Session ids with a move marker in the folder. */
async function markedSessionIds(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(analyticsFolderRoot());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.length > MOVING_SUFFIX.length && name.endsWith(MOVING_SUFFIX))
    .map((name) => name.slice(0, -MOVING_SUFFIX.length));
}

/** A marker file whose content does not parse or does not have the marker's shape. */
class NotAMarkerError extends Error {}

const isSize = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** An object whose values are all sizes: non-negative integers. */
const isSizeRecord = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isSize);

const isStreamRange = (value: unknown): value is Record<MovedStream, number> =>
  isSizeRecord(value) && MOVED_STREAMS.every((stream) => isSize(value[stream]));

/** The session's marker; a read error is thrown as it is, content that is no marker as a `NotAMarkerError`. */
async function readMarker(sessionId: string): Promise<MoveMarker> {
  const raw = await readFile(markerPath(sessionId), 'utf-8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new NotAMarkerError(`the move marker of ${sessionId} does not parse`);
  }
  const marker = value as Partial<MoveMarker> | null;
  if (
    typeof marker !== 'object' || marker === null ||
    !isSizeRecord(marker.lengths) || !isStreamRange(marker.from) || !isStreamRange(marker.upto) ||
    !Number.isFinite(marker.nowMs)
  ) {
    throw new NotAMarkerError(`the move marker of ${sessionId} is not a move marker`);
  }
  return marker as MoveMarker;
}

/**
 * Cuts each folder file of the session back to its length in the marker; a file not longer than that, or gone, is
 * left as it is.
 */
async function cutToLengths(sessionId: string, marker: MoveMarker): Promise<void> {
  for (const stream of FOLDER_STREAMS) {
    const length = marker.lengths[folderFileName(sessionId, stream)] ?? 0;
    const path = folderPath(sessionId, stream);
    if ((await fileSize(path)) > length) await truncate(path, length);
  }
}

/**
 * Calls `onLines` with the lines of `[start, end)` of `path`, at most `CHUNK_BYTES` of input per call (a longer
 * line is one call of its own), and yields to the event loop after each call. Bytes after the last newline are the
 * last line.
 */
async function forEachChunk(
  path: string,
  start: number,
  end: number,
  onLines: (lines: string[]) => Promise<void>
): Promise<void> {
  if (end <= start) return;
  const handle = await open(path, 'r');
  try {
    let position = start;
    let carry = Buffer.alloc(0);
    while (position < end) {
      const length = Math.min(end - position, carry.length < CHUNK_BYTES ? CHUNK_BYTES - carry.length : CHUNK_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const lastNewline = data.lastIndexOf(NEWLINE);
      if (lastNewline < 0) {
        carry = data;
        continue;
      }
      carry = data.subarray(lastNewline + 1);
      await onLines(data.subarray(0, lastNewline).toString('utf-8').split('\n'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (carry.length > 0) await onLines([carry.toString('utf-8')]);
  } finally {
    await handle.close();
  }
}

/** The `event_id`s of the hook records in the first `length` bytes of the folder hooks file. */
async function eventIdsBelow(path: string, length: number): Promise<Set<string>> {
  const ids = new Set<string>();
  await forEachChunk(path, 0, length, async (lines) => {
    for (const line of lines) {
      const id = hookRecordEventId(line);
      if (id !== undefined) ids.add(id);
    }
  });
  return ids;
}

/**
 * Appends one spool stream's `[from, upto)` to its folder file, each line converted by `convert` with its line id; a
 * line `convert` answers `null` for is dropped.
 */
async function copyStream(
  sessionId: string,
  stream: MovedStream,
  marker: MoveMarker,
  convert: (line: string, lineId: string) => string | null
): Promise<void> {
  const folderStream = FOLDER_STREAM_OF[stream];
  const name = folderFileName(sessionId, folderStream);
  const target = folderPath(sessionId, folderStream);
  await forEachChunk(streamFile(sessionId, stream), marker.from[stream], marker.upto[stream], async (lines) => {
    let out = '';
    for (const line of lines) {
      const record = convert(line, lineIdOf(name, line));
      if (record === null) continue;
      out += record + '\n';
    }
    if (out.length > 0) await appendFile(target, out, { mode: 0o600 });
  });
}

/**
 * The copy of a written-down move: the folder files cut back to their lengths, then each stream's range appended.
 * The telemetry streams are appended only when the folder's hooks file holds a hook event once the hooks range is
 * copied, so a session whose hook lines were all dropped leaves nothing in the folder.
 */
async function copy(sessionId: string, marker: MoveMarker): Promise<void> {
  await ensureAnalyticsFolder();
  await cutToLengths(sessionId, marker);

  const hooksName = folderFileName(sessionId, 'hooks');
  const seen = await eventIdsBelow(folderPath(sessionId, 'hooks'), marker.lengths[hooksName] ?? 0);
  await copyStream(sessionId, 'hooks', marker, (line, lineId) => {
    const envelope = parseHookEnvelope(line);
    if (!envelope) return null;
    const eventId = envelope.event['event_id'];
    if (typeof eventId === 'string') {
      if (seen.has(eventId)) return null;
      seen.add(eventId);
    }
    return encodeHookRecord(envelope.event, {
      ...(envelope.evidenceV === 1 ? { evidenceV: 1 as const } : {}),
      lineId,
      nowMs: marker.nowMs,
    });
  });
  if ((await fileSize(folderPath(sessionId, 'hooks'))) === 0) return;
  for (const stream of ['logsJson', 'metricsJson', 'tracesJson'] as const) {
    await copyStream(sessionId, stream, marker, (line, lineId) => addLineId(line, lineId));
  }
}

/**
 * The end of a move, under the session lock: each moved stream's cursor at its `upto`, each `.bin` stream's at its
 * size, the marker removed, and the session deleted when nothing new arrived meanwhile.
 */
async function finish(sessionId: string, marker: MoveMarker): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const status = (await readStatus(sessionId)) ?? createStatus();
    for (const stream of MOVED_STREAMS) status.cursors[stream] = marker.upto[stream];
    for (const stream of OTEL_STREAMS) status.cursors[stream] = await fileSize(streamFile(sessionId, stream));
    await writeStatus(sessionId, status);
    await unlink(markerPath(sessionId));
    if (isSessionDrained(await readSpoolState(sessionId, status))) await deleteSession(sessionId);
  });
}

/** A session found in the spool with no marker: dropped when excluded, else moved when past its grace. */
async function startMove(sessionId: string): Promise<void> {
  const marker = await withSessionLock(sessionId, async (): Promise<MoveMarker | null> => {
    // Nothing of an excluded session is moved, so what of it arrives is dropped at every sweep, grace or not.
    if (await isSessionExcluded(sessionId)) {
      await deleteSession(sessionId);
      return null;
    }
    const status = (await readStatus(sessionId)) ?? createStatus();
    const spool = await readSpoolState(sessionId, status);
    const activityMs = await lastActivityMs(spool);
    if (activityMs === null || !isPastGrace(status, activityMs)) return null;
    const hooksInFolder = (await fileSize(folderPath(sessionId, 'hooks'))) > 0;
    if (spool.streams.hooks.size === 0 && !hooksInFolder) {
      // A session with no hook event is not kept.
      await deleteSession(sessionId);
      return null;
    }
    const lengths: Record<string, number> = {};
    for (const stream of FOLDER_STREAMS) {
      lengths[folderFileName(sessionId, stream)] = await fileSize(folderPath(sessionId, stream));
    }
    const from = {} as Record<MovedStream, number>;
    const upto = {} as Record<MovedStream, number>;
    for (const stream of MOVED_STREAMS) {
      upto[stream] = spool.streams[stream].size;
      from[stream] = Math.min(status.cursors[stream], upto[stream]);
    }
    const written: MoveMarker = { lengths, from, upto, nowMs: spool.streams.hooks.mtimeMs ?? activityMs };
    await writeJsonFileAtomic(markerPath(sessionId), written, { directoryMode: 0o700 });
    return written;
  });
  if (!marker) return;
  await copy(sessionId, marker);
  await finish(sessionId, marker);
}

/**
 * A marker found at a sweep's start: the move repeated from it, or undone when the session left the spool; a session
 * excluded meanwhile is undone and dropped from the spool.
 */
async function resumeMove(sessionId: string): Promise<void> {
  // A marker that does not parse throws here and the session stays where it is: without its lengths a repeated move
  // would write the telemetry streams' lines a second time.
  const marker = await readMarker(sessionId);
  if (await isSessionExcluded(sessionId)) {
    await cutToLengths(sessionId, marker);
    await withSessionLock(sessionId, () => deleteSession(sessionId));
    await unlink(markerPath(sessionId));
    return;
  }
  const left = await Promise.all(
    SPOOL_STREAMS.map((stream) => stat(streamFile(sessionId, stream)).then(() => true, () => false))
  );
  if (!left.some(Boolean)) {
    await cutToLengths(sessionId, marker);
    await unlink(markerPath(sessionId));
    return;
  }
  await copy(sessionId, marker);
  await finish(sessionId, marker);
}

async function guarded(sessionId: string, step: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn(`[analytics-folder] ${step} failed`, ...sanitizeLogArgs({ sessionId, err: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Moves every session of the spool that is past its grace into the analytics folder; a call while one runs returns
 * at once. Moves left half-done are finished first. A failure of one session is logged and the sweep goes on.
 */
export async function sweepToFolder(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const sessionId of await markedSessionIds()) await guarded(sessionId, 'resume', () => resumeMove(sessionId));
    const marked = new Set(await markedSessionIds());
    for (const sessionId of await listSessionIds()) {
      if (marked.has(sessionId)) continue;
      await guarded(sessionId, 'move', () => startMove(sessionId));
    }
  } finally {
    sweeping = false;
  }
}

/**
 * Undoes every move left half-done: the folder files cut back to the marker's lengths, the marker removed. A marker
 * file that does not parse or is no marker is warned of and removed, its session's folder files left as they are.
 */
export async function resolveMarkers(): Promise<void> {
  for (const sessionId of await markedSessionIds()) {
    let marker: MoveMarker;
    try {
      marker = await readMarker(sessionId);
    } catch (err) {
      if (!(err instanceof NotAMarkerError)) throw err;
      logger.warn('[analytics-folder] a move marker that is no marker was removed', ...sanitizeLogArgs({ sessionId }));
      await unlink(markerPath(sessionId));
      continue;
    }
    await cutToLengths(sessionId, marker);
    await unlink(markerPath(sessionId));
  }
}

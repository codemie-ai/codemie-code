/**
 * Continued Claude Code sessions (EPMCDME-16992).
 *
 * When Claude Code continues session P into a new session C, P's transcript gets a
 * `{ type: 'continued-in', continuedInSessionId: C }` record and C's transcript starts with P's
 * lines copied (same `uuid`, `sessionId` rewritten to C). The copies are not C's own work, so the
 * uuids of P's lines are resolved here and excluded from C's usage events and summary.
 */

import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from '@/utils/logger.js';

/** Most recently modified sibling transcripts inspected for a parent. */
const MAX_SIBLING_FILES = 200;

/**
 * Bytes read from the end of each sibling in the first, cheap look for the `continued-in` record.
 * Claude Code appends that record when it continues a session, so it usually sits at the end of the
 * parent. A parent worked on again afterwards can have it further back: a sibling whose tail does
 * not hold it is then streamed whole (see {@link fileNamesSession}).
 */
const TAIL_BYTES = 256 * 1024;

/** Most `stat` calls in flight at once, so a large project directory cannot exhaust file handles. */
const STAT_BATCH = 32;

interface TranscriptRecord {
  type?: unknown;
  uuid?: unknown;
  continuedInSessionId?: unknown;
}

interface SiblingFile {
  name: string;
  mtime: number;
  size: number;
  /** `stat` failed: the file may be the parent, so a scan that skips it is not complete. */
  unknown: boolean;
}

async function statSiblings(directory: string, names: string[]): Promise<SiblingFile[]> {
  const files: SiblingFile[] = [];
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = await Promise.all(
      names.slice(i, i + STAT_BATCH).map(async (name): Promise<SiblingFile> => {
        try {
          const info = await stat(join(directory, name));
          // Not a regular file (e.g. a directory named like a transcript): it cannot be read as one.
          return { name, mtime: info.mtimeMs, size: info.size, unknown: !info.isFile() };
        } catch {
          return { name, mtime: 0, size: 0, unknown: true };
        }
      })
    );
    files.push(...batch);
  }
  return files;
}

/** The last {@link TAIL_BYTES} of `path` (the whole file when smaller). May start mid-line. */
async function readTail(path: string, size: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf-8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Whether `tail` holds a `continued-in` record naming `sessionId`. */
function tailNamesSession(tail: string, sessionId: string): boolean {
  // Cheap pre-filter: skip JSON parsing for the (many) unrelated transcripts.
  if (!tail.includes('continued-in') || !tail.includes(sessionId)) return false;
  for (const line of tail.split('\n')) {
    if (!line.includes('continued-in')) continue;
    try {
      const record = JSON.parse(line) as TranscriptRecord;
      if (record.type === 'continued-in' && record.continuedInSessionId === sessionId) return true;
    } catch {
      // A partial first line of the tail or a malformed line: not the record.
    }
  }
  return false;
}

/** Whether the file at `path` holds a `continued-in` record naming `sessionId`; streamed, so size does not matter. */
async function fileNamesSession(path: string, sessionId: string): Promise<boolean> {
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('continued-in') || !line.includes(sessionId)) continue;
      try {
        const record = JSON.parse(line) as TranscriptRecord;
        if (record.type === 'continued-in' && record.continuedInSessionId === sessionId) return true;
      } catch {
        // Malformed line: not the record.
      }
    }
    return false;
  } finally {
    lines.close();
    // Closing the interface does not close its input: after an early match the file stays open
    // (and blocks deleting its directory on Windows) until the stream is garbage collected.
    stream.destroy();
  }
}

/**
 * Every uuid of the parent transcript at `path`, streamed so its size does not matter. Not only the
 * counted lines: a copied line with a uuid that the parent did not count must still be told as a copy,
 * or it would pass for the continuation's own first line.
 */
async function readUuids(path: string): Promise<string[]> {
  const uuids: string[] = [];
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: TranscriptRecord;
      try {
        record = JSON.parse(line) as TranscriptRecord;
      } catch {
        continue;
      }
      if (record.type !== 'continued-in' && typeof record.uuid === 'string') {
        uuids.push(record.uuid);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return uuids;
}

/**
 * The uuids of the lines `sessionId` inherited from the session it was continued from.
 *
 * Looks at the tail of the sibling `*.jsonl` transcripts of `transcriptPath` (newest first, capped)
 * for a `continued-in` record naming `sessionId`; when no tail holds it, streams the siblings whole
 * (a parent worked on again after it was continued has the record further back). The parent found
 * is then streamed for its uuids. File times are never used to rule a sibling out (copies
 * and restores reset them). Resolves `[]` when the scan was complete and there is no parent,
 * `null` when it could not be completed (unreadable directory or sibling, more candidates than
 * the scan covers). Never throws.
 *
 * Known limit: more than {@link MAX_SIBLING_FILES} siblings stay "incomplete" and are retried on
 * every pass; a parent outside the newest ones is not found.
 */
export async function resolveInheritedUuids(transcriptPath: string, sessionId: string): Promise<string[] | null> {
  // dirname('') is '.', which would scan the process working directory.
  if (!transcriptPath || !sessionId) return null;
  const directory = dirname(transcriptPath);
  const own = basename(transcriptPath);
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl') && name !== own);
    const siblings = await statSiblings(directory, names);

    // "No parent" is only a definitive answer for a complete scan: a truncated or partly unreadable
    // one must not be taken as final, or the parent's copies are counted for good.
    let complete = !siblings.some((file) => file.unknown) && siblings.length <= MAX_SIBLING_FILES;
    const candidates = [...siblings].sort((a, b) => b.mtime - a.mtime);

    const scanned = candidates.slice(0, MAX_SIBLING_FILES).filter((file) => !file.unknown);

    // Pass 1: the tail of every sibling, which finds the usual parent at a fraction of the cost.
    const tailMissed: SiblingFile[] = [];
    for (const file of scanned) {
      const path = join(directory, file.name);
      try {
        if (tailNamesSession(await readTail(path, file.size), sessionId)) return await readUuids(path);
        // A file that fits in the tail window was read whole: nothing more to find in it.
        if (file.size > TAIL_BYTES) tailMissed.push(file);
      } catch {
        complete = false;
      }
    }
    // Pass 2: the larger siblings whose tail did not hold the record, read whole.
    for (const file of tailMissed) {
      const path = join(directory, file.name);
      try {
        if (await fileNamesSession(path, sessionId)) return await readUuids(path);
      } catch {
        complete = false;
      }
    }
    if (!complete) {
      logger.debug('[claude-code-otlp] parent lookup of a continued session was incomplete', { sessionId });
      return null;
    }
    return [];
  } catch (error) {
    logger.debug('[claude-code-otlp] could not look up the parent of a continued session', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Bytes read from the start of the transcript to look at the first timestamps. */
const HEAD_BYTES = 64 * 1024;

/** A copy is at least this much older than the continuation's own start, so a smaller gap is not one. */
const COPY_AGE_MARGIN_MS = 60 * 1000;

/**
 * Whether the transcript can hold lines copied from a parent: some line in its first bytes is stamped
 * well before the session's own start (`sessionStartedAt`, the wall-clock of its `SessionStart`).
 * Copies keep the parent's timestamps and a parent history starts long before the continuation, so a
 * fresh session never has one. This only decides whether the (costly) parent lookup is worth doing;
 * every doubt answers `true`: no saved start, an unreadable file, no timestamped line yet.
 */
export async function mayHoldCopiedLines(transcriptPath: string, sessionStartedAt: string | undefined): Promise<boolean> {
  const startedAt = Date.parse(sessionStartedAt ?? '');
  if (!Number.isFinite(startedAt)) return true;
  let handle;
  try {
    handle = await open(transcriptPath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf-8').split('\n');
    lines.pop(); // the last piece is a partial line (or empty)
    let sawTimestamp = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: { timestamp?: unknown };
      try {
        record = JSON.parse(line) as { timestamp?: unknown };
      } catch {
        continue;
      }
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (!Number.isFinite(at)) continue;
      sawTimestamp = true;
      if (at < startedAt - COPY_AGE_MARGIN_MS) return true;
    }
    return !sawTimestamp;
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

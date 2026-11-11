/**
 * The Cowork producer's own cursor of one session, `~/.codemie/analytics/state/<cliSessionId>.cowork.json`, beside
 * (and independent of) the transcript orchestrator's parse state. Saved only after the session's events are in the
 * spool: a cursor that is lost or not saved makes the next read append the same events with the same ids.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { emptyCoworkEventState, type CoworkEventState } from './cowork-events.js';

export interface CoworkCursor {
  /** Byte offset read so far, per file name (the inner transcript and each `agent-*.jsonl`). */
  offsets: Record<string, number>;
  /** Size and mtime of each file at the last processing, per file name. */
  fingerprints: Record<string, string>;
  /** Time of the last transcript line an `agent.session.end` was appended for; `''` before the first end. */
  lastEndedAt: string;
  events: CoworkEventState;
}

export function emptyCoworkCursor(): CoworkCursor {
  return { offsets: {}, fingerprints: {}, lastEndedAt: '', events: emptyCoworkEventState() };
}

export function coworkCursorPath(cliSessionId: string): string {
  return getCodemiePath('analytics', 'state', `${cliSessionId}.cowork.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every field of the merged cursor is of its declared kind; a missing field was filled from the empty cursor. */
function isWellFormed(cursor: CoworkCursor): boolean {
  const { events } = cursor;
  return isPlainObject(cursor.offsets)
    && isPlainObject(cursor.fingerprints)
    && typeof cursor.lastEndedAt === 'string'
    && Array.isArray(events.seenUuids)
    && isPlainObject(events.openTools)
    && Array.isArray(events.agentResults)
    && isPlainObject(events.subagents)
    && typeof events.sessionStarted === 'boolean'
    && typeof events.lastLineAt === 'string'
    && typeof events.entrypoint === 'string'
    && typeof events.clientVersion === 'string';
}

/** The cursor a file holds, its missing fields filled from the empty cursor; null when it is not JSON or of another shape. */
function parseCursor(raw: string): CoworkCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || (parsed['events'] !== undefined && !isPlainObject(parsed['events']))) return null;
  const empty = emptyCoworkCursor();
  const cursor = { ...empty, ...parsed, events: { ...empty.events, ...parsed['events'] } } as CoworkCursor;
  return isWellFormed(cursor) ? cursor : null;
}

/**
 * The saved cursor; null when there is none. A file that does not parse, or parses to a cursor whose fields are not of
 * their declared kinds, counts as none, with a warning.
 */
export async function loadCoworkCursor(cliSessionId: string): Promise<CoworkCursor | null> {
  let raw: string;
  try {
    raw = await readFile(coworkCursorPath(cliSessionId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const cursor = parseCursor(raw);
  if (!cursor) logger.warn('[cowork-producer] Unparsable cursor; the session is read again from its start', { cliSessionId });
  return cursor;
}

/** Writes the cursor through a temp file and a rename, so a reader never sees half of it. */
export async function saveCoworkCursor(cliSessionId: string, cursor: CoworkCursor): Promise<void> {
  const path = coworkCursorPath(cliSessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(cursor), 'utf-8');
  await rename(`${path}.tmp`, path);
}

/**
 * "Last sent" marker for `codemie analytics sync` — collector-compatible.
 *
 * A single file at `getCodemiePath('analytics-last-sent')` (no per-target markers), mode
 * `0o600`, re-chmod'd after every write, since the marker records when data last left the
 * machine. Content is an ISO timestamp, matching the standalone collector's marker so a
 * collector-written marker is honoured by the first CLI run.
 *
 * `readMarker` falls back to the file's mtime — same as the collector — when the content is
 * empty or not a valid timestamp, and returns `null` (treated as absent) when the resolved
 * timestamp lies in the future relative to the injected `now`, or when the file does not
 * exist.
 */

import { chmod, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { getCodemiePath } from '@/utils/paths.js';

const MARKER_FILE_MODE = 0o600;

function defaultMarkerPath(): string {
  return getCodemiePath('analytics-last-sent');
}

/**
 * Read the "last sent" marker.
 *
 * Missing file -> `null`. Empty or unparseable content -> the file's mtime (collector
 * behaviour). A resolved timestamp later than `now` -> `null` (treated as absent).
 */
export async function readMarker(now: Date, path: string = defaultMarkerPath()): Promise<Date | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const trimmed = raw.trim();
  let resolved: Date;
  if (trimmed === '') {
    resolved = (await stat(path)).mtime;
  } else {
    const parsed = new Date(trimmed);
    resolved = Number.isNaN(parsed.getTime()) ? (await stat(path)).mtime : parsed;
  }

  if (resolved.getTime() > now.getTime()) {
    return null;
  }

  return resolved;
}

/**
 * Write the "last sent" marker as an ISO timestamp, mode `0o600`.
 */
export async function writeMarker(at: Date, path: string = defaultMarkerPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, at.toISOString(), { mode: MARKER_FILE_MODE });
  await chmod(path, MARKER_FILE_MODE);
}

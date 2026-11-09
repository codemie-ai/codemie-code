/**
 * Continued Claude Code sessions (EPMCDME-16992).
 *
 * When Claude Code continues session P into a new session C, P's transcript gets a
 * `{ type: 'continued-in', continuedInSessionId: C }` record and C's transcript starts with P's
 * lines copied (same `uuid`, `sessionId` rewritten to C). The copies are not C's own work, so the
 * uuids of P's counted lines are resolved here and excluded from C's usage events and summary.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isCountedTranscriptLine } from '@/agents/plugins/claude/session/transcript-lines.js';
import { logger } from '@/utils/logger.js';

/** Most recently modified sibling transcripts inspected for a parent. */
const MAX_SIBLING_FILES = 200;

interface TranscriptRecord {
  type?: unknown;
  uuid?: unknown;
  continuedInSessionId?: unknown;
}

/** The counted uuids of `raw` when it holds a `continued-in` record naming `sessionId`, else `null`. */
function parentUuids(raw: string, sessionId: string): string[] | null {
  // Cheap pre-filter: skip JSON parsing for the (many) unrelated transcripts.
  if (!raw.includes('continued-in') || !raw.includes(sessionId)) return null;

  const uuids: string[] = [];
  let continuedIntoSession = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (record.type === 'continued-in' && record.continuedInSessionId === sessionId) {
      continuedIntoSession = true;
    } else if (typeof record.uuid === 'string' && isCountedTranscriptLine(record)) {
      uuids.push(record.uuid);
    }
  }
  return continuedIntoSession ? uuids : null;
}

interface SiblingFile {
  name: string;
  mtime: number;
  size: number;
  /** `stat` failed: the file may be the parent, so a scan that skips it is not complete. */
  unknown: boolean;
}

/** Most `stat` calls in flight at once, so a large project directory cannot exhaust file handles. */
const STAT_BATCH = 32;

/** Larger sibling transcripts are not read in the hook path; skipping one makes the scan incomplete. */
const MAX_SIBLING_BYTES = 64 * 1024 * 1024;

async function statSiblings(directory: string, names: string[]): Promise<SiblingFile[]> {
  const files: SiblingFile[] = [];
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = await Promise.all(
      names.slice(i, i + STAT_BATCH).map(async (name): Promise<SiblingFile> => {
        try {
          const info = await stat(join(directory, name));
          return { name, mtime: info.mtimeMs, size: info.size, unknown: false };
        } catch {
          return { name, mtime: 0, size: 0, unknown: true };
        }
      })
    );
    files.push(...batch);
  }
  return files;
}

/**
 * The uuids of the lines `sessionId` inherited from the session it was continued from.
 *
 * Scans the sibling `*.jsonl` transcripts of `transcriptPath` (newest first, capped) for the one
 * holding a `continued-in` record naming `sessionId`. Only a bounded number of files and bytes are read, newest
 * first (file times are never used to rule a sibling out: copies and restores reset them). Resolves `[]` when the
 * scan was complete and there is no parent, `null` when it could not be completed (unreadable
 * directory or sibling, too many or too large candidates). Never throws.
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
    let complete = true;
    if (siblings.some((file) => file.unknown)) complete = false;
    const candidates = [...siblings].sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > MAX_SIBLING_FILES) complete = false;

    for (const { name, size } of candidates.slice(0, MAX_SIBLING_FILES)) {
      if (size > MAX_SIBLING_BYTES) {
        complete = false;
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(join(directory, name), 'utf-8');
      } catch {
        complete = false;
        continue;
      }
      const uuids = parentUuids(raw, sessionId);
      if (uuids) return uuids;
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

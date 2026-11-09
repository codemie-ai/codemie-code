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

/**
 * The uuids of the lines `sessionId` inherited from the session it was continued from.
 *
 * Scans the sibling `*.jsonl` transcripts of `transcriptPath` (newest first, capped) for the one
 * holding a `continued-in` record naming `sessionId`. Resolves `[]` when the directory was scanned
 * and there is no parent, `null` when the directory cannot be read. Never throws.
 */
export async function resolveInheritedUuids(transcriptPath: string, sessionId: string): Promise<string[] | null> {
  const directory = dirname(transcriptPath);
  const own = basename(transcriptPath);
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl') && name !== own);
    const dated = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, mtime: (await stat(join(directory, name))).mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
    );
    dated.sort((a, b) => b.mtime - a.mtime);

    for (const { name } of dated.slice(0, MAX_SIBLING_FILES)) {
      let raw: string;
      try {
        raw = await readFile(join(directory, name), 'utf-8');
      } catch {
        continue;
      }
      const uuids = parentUuids(raw, sessionId);
      if (uuids) return uuids;
    }
    return [];
  } catch (error) {
    logger.debug('[claude-code-otlp] could not look up the parent of a continued session', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

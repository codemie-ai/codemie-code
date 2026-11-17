/**
 * The served mark of a Cowork session, `~/.codemie/analytics/state/<cliSessionId>.cowork-served`, beside the
 * session's cursor: left by the proxy daemon at the first request of the session it serves. The Cowork producer takes
 * a session only with a mark or a cursor, so a session whose requests went through another gateway is never sent.
 * Kept apart from the cursor module, whose event-state imports the proxy's request path must not load.
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';

const SERVED_MARK_SUFFIX = '.cowork-served';

/** The file that marks a session as served by this machine's proxy daemon; it counts by existing alone. */
export function coworkServedMarkPath(cliSessionId: string): string {
  return getCodemiePath('analytics', 'state', `${cliSessionId}${SERVED_MARK_SUFFIX}`);
}

/** The marks written by this process, by path: the later requests of a marked session touch no file. */
const servedMarks = new Map<string, Promise<void>>();

/**
 * Marks a session (its id already checked safe) as served, once per process; requests at the same time share the
 * write. A failed write rejects and is forgotten, so the next call tries again.
 */
export function markCoworkSessionServed(cliSessionId: string): Promise<void> {
  const path = coworkServedMarkPath(cliSessionId);
  let mark = servedMarks.get(path);
  if (!mark) {
    mark = mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, new Date().toISOString(), 'utf-8'));
    servedMarks.set(path, mark);
    mark.catch(() => servedMarks.delete(path));
  }
  return mark;
}

/**
 * The served marks in the state directory, each with its modification time; empty when the directory is missing or
 * unreadable, and a mark gone before its `stat` is left out. Never throws.
 */
export async function listCoworkServedMarks(): Promise<Array<{ cliSessionId: string; mtimeMs: number }>> {
  const dir = getCodemiePath('analytics', 'state');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const marks: Array<{ cliSessionId: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(SERVED_MARK_SUFFIX)) continue;
    const cliSessionId = name.slice(0, -SERVED_MARK_SUFFIX.length);
    try {
      marks.push({ cliSessionId, mtimeMs: (await stat(coworkServedMarkPath(cliSessionId))).mtimeMs });
    } catch {
      // Removed since the listing
    }
  }
  return marks;
}

/** The marks whose failed removal was warned about: a removal that keeps failing is not warned about at every call. */
const removalWarned = new Set<string>();

/**
 * Removes a session's served mark (a missing one is not an error) and forgets this process's write of it, so the next
 * {@link markCoworkSessionServed} of the session writes it again. A failed removal is logged at warn level, once per
 * mark until the mark is gone; the write is forgotten all the same. Never throws.
 */
export async function forgetCoworkServedMark(cliSessionId: string): Promise<void> {
  const path = coworkServedMarkPath(cliSessionId);
  try {
    await unlink(path);
    removalWarned.delete(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      removalWarned.delete(path);
    } else if (!removalWarned.has(path)) {
      removalWarned.add(path);
      logger.warn('[cowork-served-mark] Served mark not removed', {
        cliSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    servedMarks.delete(path);
  }
}

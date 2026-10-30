/**
 * The wrapper's exit notice about its own record and the records dropped since it started.
 */
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import type { Session } from './types.js';
import { readLiveRecord } from './stale-session-reconciliation.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';

/** Slack for a file system whose mtime is coarser than the clock that stamped `droppedAt`. */
const MTIME_SLACK_MS = 2_000;

/** Records in the sessions folder marked dropped at or after `since`; only files written since then are read. */
async function countDroppedSince(since: number): Promise<number> {
  const sessionsDir = getCodemiePath('sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(sessionsDir, name);
    try {
      if ((await stat(path)).mtimeMs < since - MTIME_SLACK_MS) continue;
      const { droppedAt } = JSON.parse(await readFile(path, 'utf-8')) as Session;
      if (droppedAt !== undefined && droppedAt >= since) count++;
    } catch {
      // Moved or rewritten mid-scan: not a record of this launch's notice
    }
  }
  return count;
}

const PENDING_EXIT_NOTICE =
  "CodeMie: this session's analytics are not delivered yet; they will be sent at the next codemie start. Nothing is lost.";

function droppedExitNotice(count: number): string {
  return `CodeMie: analytics of ${count} session(s) could not be delivered and were dropped. ` +
    'Check the connection to CodeMie with `codemie doctor`.';
}

/**
 * The wrapper's exit notice, after its own record step: its own record still `{id}.json` with a
 * CodeMie host (the only kind the next start queues) → one line that it waits for the next start;
 * records marked dropped since this wrapper started → one line with their count. Logged, and printed to stderr when `print`; nothing when neither. A failure is logged only.
 */
export async function noticeDeliveryAtExit(sessionId: string, startedAt: number, print: boolean): Promise<void> {
  try {
    const lines: string[] = [];
    if ((await readLiveRecord(sessionId))?.codemieUrl) lines.push(PENDING_EXIT_NOTICE);
    const dropped = await countDroppedSince(startedAt);
    if (dropped > 0) lines.push(droppedExitNotice(dropped));
    for (const line of lines) {
      logger.warn(`[exit] ${line}`);
      if (print) console.error(chalk.yellow(`⚠  ${line}`));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[exit] Delivery notice skipped: ${msg}`);
  }
}

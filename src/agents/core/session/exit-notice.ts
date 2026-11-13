/**
 * The wrapper's exit notice: what became of its own analytics record and of earlier sessions' records since it started.
 */
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import type { DropReason, Session } from './types.js';
import { isLiveRecordFileName } from './stale-session-reconciliation.js';
import { notDroppedBefore } from './delivery-budget.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';

/** Slack for a file system whose mtime is coarser than the clock that stamped `droppedAt`. */
const MTIME_SLACK_MS = 2_000;

/** Sessions named in the dropped line; the rest are counted. */
const MAX_NAMED_DROPS = 3;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ExitDeliveryEntry {
  kind: 'pending' | 'queued' | 'dropped';
  sessionId: string;
  agent: string;
  startTime: number;
  /** pending and queued: the earliest moment the retry window alone could drop the data */
  notDroppedBefore?: number;
  /** dropped: why the data left the queue */
  reason?: DropReason;
  /** dropped: the record is still queued with its other data (lines the server rejected are the part dropped) */
  partial?: boolean;
}

/** `d Mon HH:mm` in local time. */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The session records (live, completed_ and generation files) written since `since`; unreadable ones are skipped. */
async function readRecentRecords(since: number): Promise<Array<{ name: string; record: Session }>> {
  const sessionsDir = getCodemiePath('sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const records: Array<{ name: string; record: Session }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(sessionsDir, name);
    try {
      if ((await stat(path)).mtimeMs < since - MTIME_SLACK_MS) continue;
      const record = JSON.parse(await readFile(path, 'utf-8')) as Session;
      if (record && typeof record.sessionId === 'string') records.push({ name, record });
    } catch {
      // Moved or rewritten mid-scan: not a record of this launch's notice
    }
  }
  return records;
}

/** Keeps one entry per session id: the one with the newest start. */
function newestPerSession(entries: ExitDeliveryEntry[]): ExitDeliveryEntry[] {
  const byId = new Map<string, ExitDeliveryEntry>();
  for (const entry of entries) {
    const known = byId.get(entry.sessionId);
    if (!known || entry.startTime > known.startTime) byId.set(entry.sessionId, entry);
  }
  return [...byId.values()];
}

/** Keeps one entry per session id: the one that can be dropped first, so the notice never promises more time than a generation has. */
function earliestPerSession(entries: ExitDeliveryEntry[]): ExitDeliveryEntry[] {
  const byId = new Map<string, ExitDeliveryEntry>();
  for (const entry of entries) {
    const known = byId.get(entry.sessionId);
    if (!known || (entry.notDroppedBefore ?? Infinity) < (known.notDroppedBefore ?? Infinity)) byId.set(entry.sessionId, entry);
  }
  return [...byId.values()];
}

/**
 * What the sessions folder says about delivery since `since` (the wrapper's start): the wrapper's own record still
 * waiting (`pending`), earlier sessions' closed records this launch attempted since then and still live (`queued`), and records marked dropped at or
 * after `since`, own or earlier (`dropped`). A live record marked dropped by a rejected line is still queued, so it can
 * be listed both as dropped and as pending or queued. A `/clear` generation re-keyed to stay queued is listed under the
 * session id it was known by (`originSessionId`), and as the wrapper's own when that id is. A session is listed once per
 * kind: a pending or queued one with its earliest `notDroppedBefore`, a dropped one with its newest generation's start.
 */
export async function listExitDelivery(ownSessionId: string, since: number, now: number): Promise<ExitDeliveryEntry[]> {
  const pending: ExitDeliveryEntry[] = [];
  const queued: ExitDeliveryEntry[] = [];
  const dropped: ExitDeliveryEntry[] = [];
  for (const { name, record } of await readRecentRecords(since)) {
    const sessionId = record.originSessionId ?? record.sessionId;
    const base = { sessionId, agent: record.agentName, startTime: record.startTime };
    const live = isLiveRecordFileName(name);
    if (record.droppedAt !== undefined && record.droppedAt >= since) {
      dropped.push({ ...base, kind: 'dropped', reason: record.droppedReason, partial: live && record.droppedReason === 'rejected by the server' });
    }
    if (!live || (record.droppedAt !== undefined && record.droppedReason !== 'rejected by the server')) continue;
    if (sessionId === ownSessionId) {
      if (record.codemieUrl) pending.push({ ...base, kind: 'pending', notDroppedBefore: notDroppedBefore(record, now) });
    } else if (
      // Queued only when this launch's own pass tried a closed record: another wrapper's live record, or one only
      // rewritten since the start, is not this launch's to report
      record.status === 'completed' && (record.deliveryAttemptedAt ?? 0) >= since &&
      (record.deliveryFailingSince != null || (record.deliveryRealAttempts ?? 0) > 0)
    ) {
      queued.push({ ...base, kind: 'queued', notDroppedBefore: notDroppedBefore(record, now) });
    }
  }
  return [...earliestPerSession(pending), ...earliestPerSession(queued), ...newestPerSession(dropped)];
}

function droppedLine(dropped: ExitDeliveryEntry[]): string {
  const ordered = [...dropped].sort((a, b) => a.startTime - b.startTime);
  const named = ordered.slice(0, MAX_NAMED_DROPS).map((e) =>
    `${e.agent} ${e.sessionId.slice(0, 8)} (started ${formatDate(e.startTime)})${e.reason ? ` — ${e.reason}` : ''}` +
    (e.partial ? ', the rest is still queued' : ''));
  const more = ordered.length > MAX_NAMED_DROPS ? `; … and ${ordered.length - MAX_NAMED_DROPS} more` : '';
  return `CodeMie: analytics of these sessions were dropped: ${named.join('; ')}${more}. ` +
    'Check the connection to CodeMie with `codemie doctor`.';
}

/** The notice lines for the entries; none when everything was delivered. */
export function formatExitDelivery(entries: ExitDeliveryEntry[]): string[] {
  const lines: string[] = [];
  const pending = entries.find((e) => e.kind === 'pending');
  if (pending && pending.notDroppedBefore !== undefined) {
    lines.push(
      "CodeMie: this session's analytics are not delivered yet; they will be retried at later `codemie` starts " +
      `and are not dropped before ${formatDate(pending.notDroppedBefore)}.`);
  }
  const queued = entries.filter((e) => e.kind === 'queued' && e.notDroppedBefore !== undefined);
  if (queued.length > 0) {
    const earliest = Math.min(...queued.map((e) => e.notDroppedBefore as number));
    lines.push(
      `CodeMie: analytics of ${queued.length} earlier session(s) are still queued for retry; ` +
      `none is dropped before ${formatDate(earliest)}.`);
  }
  const dropped = entries.filter((e) => e.kind === 'dropped');
  if (dropped.length > 0) lines.push(droppedLine(dropped));
  return lines;
}

/**
 * The wrapper's exit notice, after its own record step. Logged, and printed to stderr when `print`; nothing when all
 * data was delivered. A failure is logged only.
 */
export async function noticeDeliveryAtExit(sessionId: string, startedAt: number, print: boolean): Promise<void> {
  try {
    const lines = formatExitDelivery(await listExitDelivery(sessionId, startedAt, Date.now()));
    for (const line of lines) {
      logger.warn(`[exit] ${line}`);
      if (print) console.error(chalk.yellow(`⚠  ${line}`));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[exit] Delivery notice skipped: ${msg}`);
  }
}

/**
 * Cross-process pid-lock: an exclusive-create file naming the process that holds it.
 */

import { link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { isOwnerAlive, isProcessAlive, processStartedAt, type ProcessIdentity } from './processes.js';

const PID_LOCK_POLL_MS = 25;
export const PID_LOCK_WAIT_BUDGET_MS = 10_000;
const PID_LOCK_EMPTY_STALE_MS = 5_000;
// Windows reports EPERM/EACCES/EBUSY, not EEXIST, when creating a lock whose deletion is pending.
const PID_LOCK_CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

export interface PidLockOptions {
  /** `try`: one attempt; `wait`: poll until acquired, the budget, the deadline or the abort. */
  mode: 'try' | 'wait';
  /** Wait budget in ms (`wait` mode); default 10 000. */
  budgetMs?: number;
  /** Epoch ms after which `wait` mode gives up; the earlier of this and the budget wins. */
  deadlineMs?: number;
  /** Stops `wait` mode at once. */
  signal?: AbortSignal;
  /**
   * Judges the holder by its pid alone, never spawning `ps`: for a caller inside a tight budget (an agent
   * hook). A dead holder whose pid was reused keeps the lock until a caller without this option reclaims it.
   */
  pidOnlyLiveness?: boolean;
}

export interface PidLock {
  /** Removes the lock file only while it still names this process. Idempotent. */
  release(): Promise<void>;
}

/** The holder written in a pid-lock file; a bare number is a pid alone. Undefined when unparsable. */
export function parsePidLockHolder(raw: string): ProcessIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed === 'number') {
    return Number.isInteger(parsed) && parsed > 0 ? { pid: parsed } : undefined;
  }
  if (parsed && typeof parsed === 'object') {
    const { pid, startedAt } = parsed as { pid?: unknown; startedAt?: unknown };
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      return { pid, ...(typeof startedAt === 'number' && { startedAt }) };
    }
  }
  return undefined;
}

async function createPidLockFile(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (PID_LOCK_CONTENTION_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      return false;
    }
    throw error;
  }
}

/**
 * Removes a lock whose holder is dead, or an empty / unparsable one older than 5 s. True when removed.
 * `seen.aliveContent` is the content last judged alive by {@link isOwnerAlive}: the same content again
 * needs only the pid check, so a wait runs `ps` once per holder, not once per poll.
 */
async function removeStalePidLock(path: string, seen: { aliveContent?: string }, pidOnly: boolean): Promise<boolean> {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (raw === null) return false;
  const holder = parsePidLockHolder(raw);
  if (holder) {
    const alive = pidOnly || raw === seen.aliveContent ? isProcessAlive(holder.pid) : await isOwnerAlive(holder);
    if (alive) {
      seen.aliveContent = raw;
      return false;
    }
  } else {
    const info = await stat(path).catch(() => null);
    if (!info || Date.now() - info.mtimeMs <= PID_LOCK_EMPTY_STALE_MS) return false;
  }
  return reclaimStaleLock(path, raw);
}

/**
 * Removes a lock file judged stale while it held `stale` (null: unreadable then). The lock is renamed to a
 * unique name first, so of two reclaimers only one moves it; the moved file is removed only when it still
 * holds `stale` — a fresh lock another process created meanwhile is moved back, unless a third one took the path by
 * then. True when the lock path is free; false when the lock stays (put back, a third one kept, or the rename
 * failed, e.g. a Windows delete still pending).
 */
export async function reclaimStaleLock(path: string, stale: string | null): Promise<boolean> {
  const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if ((await readFile(aside, 'utf-8').catch(() => null)) === stale) {
    await rm(aside, { force: true }).catch((error: unknown) => logger.debug(`[reclaimStaleLock] Could not remove ${aside}:`, error));
    return true;
  }
  try {
    await putBackLock(aside, path);
  } catch (error) {
    logger.debug(`[reclaimStaleLock] Could not put ${aside} back to ${path}:`, error);
  }
  return false;
}

/**
 * Moves a lock set aside back to `path` without replacing one a third process created there meanwhile: a hard
 * link fails with EEXIST where a rename would overwrite. Rename only where hard links are unsupported.
 */
async function putBackLock(aside: string, path: string): Promise<void> {
  try {
    await link(aside, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTSUP' || code === 'EPERM' || code === 'EXDEV') {
      await rename(aside, path);
      return;
    }
    if (code !== 'EEXIST') throw error;
  }
  await unlink(aside);
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Cross-process lock: an exclusive-create file holding `{pid, startedAt}` of this process. A lock is
 * reclaimed only when its holder is dead by {@link isOwnerAlive} (never by age), or when it is empty /
 * unparsable and older than 5 s. Returns null when the lock stays held (`try` at once; `wait` at the
 * budget, the deadline or the abort).
 */
export async function acquirePidLock(path: string, options: PidLockOptions): Promise<PidLock | null> {
  const content = JSON.stringify({ pid: process.pid, startedAt: processStartedAt() });
  const waitUntil = Math.min(Date.now() + (options.budgetMs ?? PID_LOCK_WAIT_BUDGET_MS), options.deadlineMs ?? Infinity);
  const seen: { aliveContent?: string } = {};
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) return null;
    if (await createPidLockFile(path, content)) {
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          const raw = await readFile(path, 'utf-8').catch(() => null);
          if (raw !== null && parsePidLockHolder(raw)?.pid === process.pid) {
            await rm(path, { force: true }).catch(() => {});
          }
        },
      };
    }
    if ((options.mode === 'wait' || attempt === 0) && await removeStalePidLock(path, seen, options.pidOnlyLiveness === true)) continue;
    const remaining = waitUntil - Date.now();
    if (options.mode === 'try' || remaining <= 0) return null;
    await sleepUnlessAborted(Math.min(PID_LOCK_POLL_MS, remaining), options.signal);
  }
}

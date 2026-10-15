import { existsSync } from 'node:fs';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath, getDirname } from '@/utils/paths.js';
import { isProcessAlive, spawnDetached } from '@/utils/processes.js';
import { logger } from '@/utils/logger.js';

export type DetachedLoginOutcome = 'started' | 'in-progress' | 'cooldown' | 'failed';

const LOCK_MAX_AGE_MS = 150_000;
const COOLDOWN_MS = 30_000;
const UNREADABLE_LOCK_GRACE_MS = 5_000;

interface LoginLock {
  pid: number;
  startedAt: number;
}

function getLockPath(): string {
  return getCodemiePath('sso-login.lock');
}

async function readLock(lockPath: string): Promise<LoginLock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf-8')) as Partial<LoginLock> | null;
    if (typeof lock?.pid !== 'number' || typeof lock.startedAt !== 'number') {
      return null;
    }
    return { pid: lock.pid, startedAt: lock.startedAt };
  } catch {
    return null;
  }
}

/**
 * Lock writes are not atomic (`wx` open and write, the child-pid rewrite truncates
 * first), so a concurrent reader can briefly see an empty lock.
 */
async function isRecentlyModified(lockPath: string): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockPath);
    return Date.now() - mtimeMs < UNREADABLE_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

async function removeLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Already gone
  }
}

/**
 * Atomically creates the lock; returns false if it already exists.
 * Writes the full content to a private temp file first, then publishes it
 * with `link` (fails EEXIST like `wx`, but atomically — a concurrent reader
 * can never observe the lock path existing with partial/empty content, which
 * a plain `writeFile(path, data, { flag: 'wx' })` cannot guarantee: open and
 * write are separate syscalls, so another caller can read an empty file in
 * between, decide the lock is corrupt, and steal it from the real owner).
 */
async function tryCreateLock(lockPath: string): Promise<boolean> {
  const lock: LoginLock = { pid: process.pid, startedAt: Date.now() };
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(lock));
    await link(tmpPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/** Returns null when the lock was acquired, otherwise the outcome that blocks a new login. */
async function acquireLock(lockPath: string): Promise<DetachedLoginOutcome | null> {
  try {
    if (await tryCreateLock(lockPath)) {
      return null;
    }

    const existing = await readLock(lockPath);
    if (existing) {
      const age = Date.now() - existing.startedAt;
      if (age < LOCK_MAX_AGE_MS && isProcessAlive(existing.pid)) {
        return 'in-progress';
      }
      if (age < COOLDOWN_MS) {
        return 'cooldown';
      }
    } else if (await isRecentlyModified(lockPath)) {
      // Unreadable but just written: its owner is mid-write, not a corrupt lock.
      return 'in-progress';
    }

    // Stale or corrupt: replace it. Losing this race means another login just started.
    await removeLock(lockPath);
    return (await tryCreateLock(lockPath)) ? null : 'in-progress';
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to acquire lock:', error);
    return 'failed';
  }
}

/**
 * Called by the detached sign-in process after a successful sign-in, so the next
 * expiry can sign in immediately. Only the lock's owner removes it. After a
 * failure the lock is left in place and expires on its own (cooldown).
 */
export async function releaseLoginLockOnSuccess(): Promise<void> {
  try {
    const lockPath = getLockPath();
    const lock = await readLock(lockPath);
    if (lock?.pid === process.pid) {
      await removeLock(lockPath);
    }
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to release lock:', error);
  }
}

/**
 * Start a browser SSO sign-in in a detached process without waiting for it.
 * A lock file prevents concurrent sign-ins and enforces a cooldown after a
 * failed attempt. Never throws.
 */
export async function startDetachedSsoLogin(codeMieUrl: string): Promise<DetachedLoginOutcome> {
  const lockPath = getLockPath();

  const blocked = await acquireLock(lockPath);
  if (blocked) {
    return blocked;
  }

  try {
    const script = join(getDirname(import.meta.url), '../../../bin/sso-login.js');
    if (!existsSync(script)) {
      throw new Error(`Child script not found: ${script}`);
    }

    const pid = spawnDetached(process.execPath, [script, '--url', codeMieUrl], { windowsHide: true });
    if (pid <= 0) {
      throw new Error('Failed to spawn sign-in process');
    }

    await writeFile(lockPath, JSON.stringify({ pid, startedAt: Date.now() } satisfies LoginLock));
    return 'started';
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to start sign-in:', error);
    await removeLock(lockPath);
    return 'failed';
  }
}

export function describeLogin(outcome: DetachedLoginOutcome = 'failed'): string {
  switch (outcome) {
    case 'started':
      return 'A browser sign-in window has been opened automatically.\nComplete the sign-in, then re-send your prompt.\nIf you closed the browser window, run `codemie profile login`.';
    case 'in-progress':
      return 'A browser sign-in is already in progress.\nComplete the sign-in, then re-send your prompt.\nIf you closed the browser window, run `codemie profile login`.';
    case 'cooldown':
      return 'The previous sign-in attempt did not complete. Run `codemie profile login`, then re-send your prompt.';
    default:
      return 'Could not open the browser sign-in automatically. Run `codemie profile login`, then re-send your prompt.';
  }
}

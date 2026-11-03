import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getCodemiePath, getDirname } from '@/utils/paths.js';
import { isProcessAlive, spawnDetached } from '@/utils/processes.js';
import { logger } from '@/utils/logger.js';
import type { PlatformUrlSource } from '@/providers/core/codemie-auth-helpers.js';
import { normalizeUrlForKey } from '@/utils/credential-crypto.js';

export type DetachedLoginOutcome = 'started' | 'in-progress' | 'cooldown' | 'signed-in-recently' | 'failed';

const LOCK_MAX_AGE_MS = 150_000;
const COOLDOWN_MS = 30_000;
const UNREADABLE_LOCK_GRACE_MS = 5_000;
/**
 * Minimum age before `sweepOrphanedTmpFiles` removes a lock-update tmp file (see
 * `writeLockAtomically`). Far longer than a `writeFile`+`rename` pair ever takes, so a tmp file
 * from an in-flight call elsewhere is never touched — only one orphaned by a crash between the
 * `writeFile` and the `rename` gets swept.
 */
const ORPHANED_TMP_MAX_AGE_MS = 60_000;

interface LoginLock {
  pid: number;
  startedAt: number;
  /** CodeMie URL this lock's own sign-in was started for; absent in locks written by older versions. */
  url?: string;
  /** Epoch millis when this lock's own sign-in succeeded, if it has (see releaseLoginLockOnSuccess). */
  succeededAt?: number;
  /**
   * `succeededAt` of the sign-in this lock replaced. Read only by `getLastSignInAt`: the cooldown
   * and in-progress decisions in `acquireLock` look at `succeededAt` alone, so a carried stamp can
   * neither trigger nor extend them.
   */
  lastSucceededAt?: number;
  /** CodeMie URL of the sign-in `lastSucceededAt` belongs to; absent when that lock had none. */
  lastSucceededUrl?: string;
  /** Epoch millis when this lock's own sign-in failed, if it has (see releaseLoginLockOnFailure). */
  failedAt?: number;
  /** The sign-in child's failure reason, stamped with failedAt. */
  error?: string;
}

/** How long a hook waits for a detached sign-in; stays below the 180s UserPromptSubmit hook timeout. */
export const SSO_LOGIN_WAIT_MS = 150_000;
const LOGIN_WAIT_POLL_MS = 1_000;

export type LoginWaitResult = { status: 'succeeded' } | { status: 'failed'; error?: string } | { status: 'timeout' };

function getLockPath(): string {
  return getCodemiePath('sso-login.lock');
}

async function readLock(lockPath: string): Promise<LoginLock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf-8')) as Partial<LoginLock> | null;
    if (typeof lock?.pid !== 'number' || typeof lock.startedAt !== 'number') {
      return null;
    }
    return {
      pid: lock.pid,
      startedAt: lock.startedAt,
      ...(typeof lock.url === 'string' && { url: lock.url }),
      ...(typeof lock.succeededAt === 'number' && { succeededAt: lock.succeededAt }),
      ...(typeof lock.lastSucceededAt === 'number' && { lastSucceededAt: lock.lastSucceededAt }),
      ...(typeof lock.lastSucceededUrl === 'string' && { lastSucceededUrl: lock.lastSucceededUrl }),
      ...(typeof lock.failedAt === 'number' && { failedAt: lock.failedAt }),
      ...(typeof lock.error === 'string' && { error: lock.error }),
    };
  } catch {
    return null;
  }
}

interface CompletedSignIn {
  at: number;
  /** URL the sign-in was for; undefined when the lock that recorded it predates URL tracking. */
  url?: string;
}

/** The most recent completed sign-in a lock knows about: its own, else the one it replaced. */
function lastSignInOf(lock: LoginLock | null): CompletedSignIn | undefined {
  if (lock?.succeededAt !== undefined) {
    return { at: lock.succeededAt, ...(lock.url !== undefined && { url: lock.url }) };
  }
  if (lock?.lastSucceededAt !== undefined) {
    return { at: lock.lastSucceededAt, ...(lock.lastSucceededUrl !== undefined && { url: lock.lastSucceededUrl }) };
  }
  return undefined;
}

/** The lock fields that carry a replaced sign-in over to the next lock. */
function carriedFields(signIn: CompletedSignIn | undefined): Pick<LoginLock, 'lastSucceededAt' | 'lastSucceededUrl'> {
  return signIn
    ? { lastSucceededAt: signIn.at, ...(signIn.url !== undefined && { lastSucceededUrl: signIn.url }) }
    : {};
}

/**
 * Time of the last completed sign-in for the CodeMie URL `source` resolves to, which survives a
 * newer in-progress or failed attempt taking over the lock; null when none is known. The lock
 * holds one sign-in, so a sign-in recorded for another URL is not returned. A sign-in without a
 * recorded URL, or a source that resolves to no URL, always matches.
 */
export async function getLastSignInAt(source: PlatformUrlSource): Promise<number | null> {
  try {
    const signIn = lastSignInOf(await readLock(getLockPath()));
    if (!signIn) {
      return null;
    }
    if (signIn.url !== undefined && !(await resolvesToUrl(source, signIn.url))) {
      return null;
    }
    return signIn.at;
  } catch {
    return null;
  }
}

/**
 * Whether the CodeMie URL `source` resolves to is `url`. Anything that cannot be told counts as a
 * match, so a sign-in is never hidden by a failure here. The resolver is loaded on demand: its
 * module pulls in the HTTP client, which this module (used by every hook) must not load up front.
 */
async function resolvesToUrl(source: PlatformUrlSource, url: string): Promise<boolean> {
  try {
    const { getPlatformUrl } = await import('@/providers/core/codemie-auth-helpers.js');
    const wanted = getPlatformUrl(source);
    return wanted === undefined || normalizeUrlForKey(wanted) === normalizeUrlForKey(url);
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to resolve the sign-in URL of a source:', error);
    return true;
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
 * Best-effort cleanup of `<lockPath>.<pid>.<ts>.tmp` files left behind by a `tryCreateLock` call
 * that crashed (killed process, OOM) between `link()` publishing the lock and its own `finally`
 * block's `unlink()` running — the only way such a tmp file can outlive its own call. Only
 * removes files older than `ORPHANED_TMP_MAX_AGE_MS` so an in-flight call's own tmp file, on
 * another process, is never touched.
 */
async function sweepOrphanedTmpFiles(lockPath: string): Promise<void> {
  try {
    const dir = dirname(lockPath);
    const prefix = `${basename(lockPath)}.`;
    for (const entry of await readdir(dir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) {
        continue;
      }
      const tmpPath = join(dir, entry);
      try {
        const { mtimeMs } = await stat(tmpPath);
        if (Date.now() - mtimeMs > ORPHANED_TMP_MAX_AGE_MS) {
          await unlink(tmpPath).catch(() => {});
        }
      } catch {
        // Already gone or unreadable — ignore.
      }
    }
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to sweep orphaned lock tmp files:', error);
  }
}

/**
 * Creates the lock; returns false if it already exists. `wx` fails EEXIST if the path is
 * already taken, same guarantee a prior `link()`-based dance here aimed for, but a concurrent
 * reader can briefly see the file after `open` but before `write` completes (open and write are
 * separate syscalls). That race was investigated in #624 and concluded not to be the actual
 * cause of the lock-stealing bug it was fixing — `isRecentlyModified`'s grace period below
 * already treats an unreadable-but-just-written lock as "in-progress" rather than corrupt, which
 * is the only consequence this race can have. Simplified back to `wx` rather than keep machinery
 * guarding a race that grace period already covers.
 */
async function tryCreateLock(lockPath: string, replacedSignIn?: CompletedSignIn): Promise<boolean> {
  const lock: LoginLock = {
    pid: process.pid,
    startedAt: Date.now(),
    ...carriedFields(replacedSignIn),
  };
  try {
    await writeFile(lockPath, JSON.stringify(lock), { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/**
 * Atomically replaces an EXISTING lock's content (`releaseLoginLockOnSuccess`, and
 * `startDetachedSsoLogin` stamping in the real child pid once spawned). A plain
 * `writeFile(path, data)` truncates before writing, so a concurrent reader can observe empty/
 * partial content during the rewrite — the same class of race `tryCreateLock`'s grace period
 * tolerates for a brand-new lock, but there is no need to tolerate it here too: `rename()` is
 * atomic on the same filesystem, so a reader always sees either the old content or the new one,
 * never a partial write.
 *
 * The temp filename includes a `randomUUID()`, not just pid+timestamp: several requests
 * redirected at once race into this same process's event loop, and `${pid}.${Date.now()}`
 * alone collides when two such calls land in the same millisecond — the second `writeFile`
 * would overwrite the first caller's temp file out from under its still-pending `rename()`.
 */
async function writeLockAtomically(lockPath: string, lock: LoginLock): Promise<void> {
  const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(lock));
  await rename(tmpPath, lockPath).catch(async (error) => {
    await unlink(tmpPath).catch(() => {});
    throw error;
  });
}

/** Returns null when the lock was acquired, otherwise the outcome that blocks a new login. */
async function acquireLock(lockPath: string, url: string): Promise<DetachedLoginOutcome | null> {
  await sweepOrphanedTmpFiles(lockPath);
  try {
    if (await tryCreateLock(lockPath)) {
      return null;
    }

    const existing = await readLock(lockPath);
    const replacedSignIn = lastSignInOf(existing);
    if (existing?.succeededAt !== undefined) {
      // This attempt already resolved (succeeded) — never fall into the isProcessAlive/
      // LOCK_MAX_AGE_MS branch below, which is for an UNRESOLVED attempt only. Without this
      // split, a succeeded sign-in whose process lingers past COOLDOWN_MS but still within
      // LOCK_MAX_AGE_MS (150s) would be misread as "still in progress", extending the intended
      // 30s post-success cooldown to as long as 150s (caught by blind review). Damp repeated
      // sign-ins for a short cooldown after the most recent success instead (PR #655 review).
      // The cooldown damps repeated sign-ins for the URL that just signed in; a sign-in for another
      // URL is not a repeat. A lock without a URL (older versions) damps every URL.
      const sameUrl = existing.url === undefined || normalizeUrlForKey(existing.url) === normalizeUrlForKey(url);
      if (sameUrl && Date.now() - existing.succeededAt < COOLDOWN_MS) {
        return 'signed-in-recently';
      }
      // Cooldown elapsed, or the success was for another URL: fall through to the replace path below.
    } else if (existing) {
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
    return (await tryCreateLock(lockPath, replacedSignIn)) ? null : 'in-progress';
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to acquire lock:', error);
    return 'failed';
  }
}

/**
 * Called by the detached sign-in process after a successful sign-in. Only the lock's owner may
 * update it. Marks the lock as succeeded (stamping `succeededAt`) rather than removing it
 * outright: a bare removal let every subsequent redirected response open a brand new browser
 * sign-in immediately, so a burst of still-ongoing redirects (e.g. the other proxied-request
 * consumers that don't yet pick up fresh credentials, or any other misconfiguration) opened the
 * browser again after every single one of them (PR #655 review). `acquireLock` damps repeated
 * sign-ins for the same URL for `COOLDOWN_MS` after `succeededAt`; after that window the lock is treated as stale
 * and replaced, so a genuinely NEW expiry later is never blocked for longer than one cooldown.
 */
export async function releaseLoginLockOnSuccess(): Promise<void> {
  try {
    const lockPath = getLockPath();
    const lock = await readLock(lockPath);
    if (lock?.pid === process.pid) {
      await writeLockAtomically(lockPath, {
        pid: lock.pid,
        startedAt: lock.startedAt,
        ...(lock.url !== undefined && { url: lock.url }),
        succeededAt: Date.now(),
      });
    }
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to release lock:', error);
  }
}

/**
 * Called by the detached sign-in process after a failed sign-in, so a waiting hook can report the
 * child's error. Owner-only, like releaseLoginLockOnSuccess; acquireLock still treats the lock by
 * its (soon dead) pid, so cooldown/replace semantics are unchanged.
 */
export async function releaseLoginLockOnFailure(error: string): Promise<void> {
  try {
    const lockPath = getLockPath();
    const lock = await readLock(lockPath);
    if (lock?.pid === process.pid) {
      await writeLockAtomically(lockPath, { ...lock, failedAt: Date.now(), error });
    }
  } catch (err) {
    logger.debug('[sso-detached-login] Failed to stamp lock failure:', err);
  }
}

/**
 * Polls the sign-in lock until the detached login succeeds, fails (stamped, lock gone, or child
 * died without stamping) or the deadline passes. Never throws.
 */
export async function waitForDetachedSsoLogin(
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<LoginWaitResult> {
  const { timeoutMs = SSO_LOGIN_WAIT_MS, pollMs = LOGIN_WAIT_POLL_MS } = opts;
  const deadline = Date.now() + timeoutMs;
  const lockPath = getLockPath();
  for (;;) {
    try {
      const lock = await readLock(lockPath);
      if (lock?.succeededAt !== undefined) {
        return { status: 'succeeded' };
      }
      if (lock?.failedAt !== undefined) {
        return { status: 'failed', ...(lock.error !== undefined && { error: lock.error }) };
      }
      // A mid-write lock reads as null briefly; only call it gone when it is not freshly modified.
      if (lock ? !isProcessAlive(lock.pid) : !(await isRecentlyModified(lockPath))) {
        return { status: 'failed', error: 'the sign-in process exited without completing' };
      }
    } catch (error) {
      logger.debug('[sso-detached-login] Failed to poll sign-in lock:', error);
    }
    if (Date.now() >= deadline) {
      return { status: 'timeout' };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * Drops the lock of an attempt that never started. When an earlier sign-in is on record the lock
 * is kept as a failed attempt with no process behind it (an old `startedAt` makes `acquireLock`
 * replace it at once), so that sign-in time is not lost with the file.
 */
async function discardAttempt(lockPath: string, replacedSignIn: CompletedSignIn | undefined): Promise<void> {
  if (replacedSignIn === undefined) {
    await removeLock(lockPath);
    return;
  }
  try {
    await writeLockAtomically(lockPath, {
      pid: process.pid,
      startedAt: 0,
      failedAt: Date.now(),
      error: 'the sign-in process could not be started',
      ...carriedFields(replacedSignIn),
    });
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to keep the earlier sign-in time:', error);
    await removeLock(lockPath);
  }
}

/**
 * Start a browser SSO sign-in in a detached process without waiting for it.
 * A lock file prevents concurrent sign-ins and enforces a cooldown after a
 * failed attempt — or after a successful one (see releaseLoginLockOnSuccess).
 * Never throws.
 */
export async function startDetachedSsoLogin(codeMieUrl: string): Promise<DetachedLoginOutcome> {
  const lockPath = getLockPath();

  const blocked = await acquireLock(lockPath, codeMieUrl);
  if (blocked) {
    return blocked;
  }

  const replacedSignIn = lastSignInOf(await readLock(lockPath));

  try {
    const script = join(getDirname(import.meta.url), '../../../bin/sso-login.js');
    if (!existsSync(script)) {
      throw new Error(`Child script not found: ${script}`);
    }

    const pid = spawnDetached(process.execPath, [script, '--url', codeMieUrl], { windowsHide: true });
    if (pid <= 0) {
      throw new Error('Failed to spawn sign-in process');
    }

    await writeLockAtomically(lockPath, { pid, startedAt: Date.now(), url: codeMieUrl, ...carriedFields(replacedSignIn) });
    return 'started';
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to start sign-in:', error);
    await discardAttempt(lockPath, replacedSignIn);
    return 'failed';
  }
}

const EXPIRED_LEAD = 'Your CodeMie sign-in session has expired — this is expected and not a problem with your prompt.';
const MANUAL_RESUME = 'After login completes, re-send your prompt.';
const OPEN_FAILED = `${EXPIRED_LEAD}\nCould not open the browser sign-in automatically. Run \`codemie profile login\`. ${MANUAL_RESUME}`;

/**
 * All user-facing re-auth text lives here. `resume: 'auto'` is for hooks that wait for the sign-in.
 * An undefined outcome means no browser sign-in was attempted (API key, unexpected gate error), so
 * the expiry is not assumed and no `codemie profile login` is suggested.
 */
export function describeLogin(
  outcome: DetachedLoginOutcome | undefined,
  opts: { resume?: 'auto' | 'manual'; wait?: LoginWaitResult } = {}
): string {
  const { resume = 'manual', wait } = opts;
  if (outcome === undefined && !wait) {
    return 'CodeMie could not verify your credentials. Check your CodeMie API key or profile configuration, then re-send your prompt.';
  }
  if (wait?.status === 'failed') {
    return `${EXPIRED_LEAD}\nThe browser sign-in did not complete: ${wait.error ?? 'unknown error'}.\nRun \`codemie profile login\` to sign in. ${MANUAL_RESUME}`;
  }
  if (wait?.status === 'succeeded') {
    // Reached only when the post-sign-in re-check still failed, e.g. the login was for another profile/URL.
    return `${EXPIRED_LEAD}\nThe browser sign-in finished, but this CodeMie profile is still not authenticated (the sign-in may have been for a different profile or URL).\nRun \`codemie profile login\` for this profile. ${MANUAL_RESUME}`;
  }
  if (wait?.status === 'timeout') {
    return `${EXPIRED_LEAD}\nThe browser sign-in did not finish in time.\nComplete it, or run \`codemie profile login\`. ${MANUAL_RESUME}`;
  }
  switch (outcome) {
    case 'started':
    case 'in-progress': {
      const opened =
        outcome === 'started'
          ? 'A browser sign-in window has been opened automatically.'
          : 'A browser sign-in is already in progress.';
      const next =
        resume === 'auto'
          ? 'Finish signing in and your prompt will continue automatically.'
          : `Complete the sign-in. ${MANUAL_RESUME}\nIf you closed the browser window, run \`codemie profile login\`.`;
      return `${EXPIRED_LEAD}\n${opened}\n${next}`;
    }
    case 'cooldown':
      return `${EXPIRED_LEAD}\nThe previous sign-in attempt did not complete. Run \`codemie profile login\`. ${MANUAL_RESUME}`;
    case 'signed-in-recently':
      return `A sign-in finished moments ago; re-send your prompt. If it is rejected again, wait about ${Math.round(COOLDOWN_MS / 1000)} seconds and re-send: a new sign-in then opens automatically.`;
    case 'failed':
    case undefined:
      return OPEN_FAILED;
    default: {
      // Compile-time exhaustiveness only: the caller must never see a throw for an unexpected value.
      const unexpected: never = outcome;
      void unexpected;
      return OPEN_FAILED;
    }
  }
}

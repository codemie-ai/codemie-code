/**
 * Cross-process lock that serializes interactive MCP OAuth logins.
 *
 * Claude Code spawns one mcp-proxy process per MCP server, so several proxies can need a browser
 * login at the same moment. Concurrent logins against the same auth gateway clobber each other's
 * session/CSRF state in the browser, and all but the last tab fail with "CSRF token mismatch".
 * Holding this lock while a login is pending makes the proxies take turns.
 *
 * Best effort by design: if the lock cannot be taken within `maxWaitMs`, the caller proceeds
 * without it, so a stuck lock can never be worse than the previous unserialized behavior.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getCodemieHome } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

const LOCK_FILE_NAME = 'mcp-auth.lock';
const POLL_INTERVAL_MS = 250;
/**
 * Stale age assumed for lock files written before the age was recorded per lock
 * (they were created with the former fixed 150s limit).
 */
const LEGACY_STALE_AFTER_MS = 150_000;

/**
 * Timings come from the caller, derived from the single MCP auth timeout
 * (see `getMcpAuthTimings()`); this module does not read the environment.
 */
export interface AuthLockOptions {
  /** How long to wait for another login to finish before proceeding without the lock. */
  maxWaitMs: number;
  /** Age after which the lock this call creates is considered abandoned; recorded in the lock file. */
  staleAfterMs: number;
}

interface LockInfo {
  pid: number;
  createdAt: number;
  /** Absent in lock files written by older versions. */
  staleAfterMs?: number;
}

function readLock(lockPath: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(info: LockInfo | undefined): boolean {
  // Unreadable/partial content: the owner is mid-write, or the file is garbage. Age decides below.
  if (!info) return false;
  // The lock's own recorded age wins, so a short-timeout caller never expires a long-timeout holder
  const staleAfterMs = info.staleAfterMs ?? LEGACY_STALE_AFTER_MS;
  return !isProcessAlive(info.pid) || Date.now() - info.createdAt > staleAfterMs;
}

function tryCreate(lockPath: string, staleAfterMs: number): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(
        fd,
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), staleAfterMs } satisfies LockInfo)
      );
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Wait for the login lock and take it. Resolves with a release function (idempotent).
 * Resolves with a no-op release if the lock could not be taken within `maxWaitMs` or on any
 * unexpected filesystem error.
 */
export async function acquireAuthLock(options: AuthLockOptions): Promise<() => void> {
  const { maxWaitMs, staleAfterMs } = options;
  const lockPath = join(getCodemieHome(), LOCK_FILE_NAME);
  const noop = () => {};

  try {
    mkdirSync(getCodemieHome(), { recursive: true });

    const deadline = Date.now() + maxWaitMs;
    let announced = false;

    while (true) {
      if (tryCreate(lockPath, staleAfterMs)) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          // Only remove our own lock, never one a successor created after ours went stale
          if (readLock(lockPath)?.pid === process.pid) {
            try {
              unlinkSync(lockPath);
            } catch {
              // already gone
            }
          }
        };
      }

      const info = readLock(lockPath);
      if (isStale(info)) {
        logger.debug(`[mcp-proxy] Removing stale auth lock (pid ${info?.pid})`);
        try {
          unlinkSync(lockPath);
        } catch {
          // lost the race to another proxy removing it
        }
        continue;
      }

      if (Date.now() >= deadline) {
        logger.debug('[mcp-proxy] Timed out waiting for auth lock, proceeding without it');
        return noop;
      }

      if (!announced) {
        announced = true;
        console.error('[mcp-proxy] Waiting for another MCP server login to finish before opening the browser...');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } catch (error) {
    logger.debug(`[mcp-proxy] Auth lock unavailable, proceeding without it: ${error}`);
    return noop;
  }
}

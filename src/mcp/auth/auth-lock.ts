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
/** A lock older than this is considered abandoned (callback server gives up after 120s). */
const STALE_AFTER_MS = 150_000;
/**
 * Must stay below the callback server's 120s timeout, which starts before the lock wait: its
 * rejection is only observed once the browser has opened and the bridge awaits the callback.
 */
const DEFAULT_MAX_WAIT_MS = 90_000;

interface LockInfo {
  pid: number;
  createdAt: number;
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
  return !isProcessAlive(info.pid) || Date.now() - info.createdAt > STALE_AFTER_MS;
}

function tryCreate(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() } satisfies LockInfo));
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
export async function acquireAuthLock(maxWaitMs = DEFAULT_MAX_WAIT_MS): Promise<() => void> {
  const lockPath = join(getCodemieHome(), LOCK_FILE_NAME);
  const noop = () => {};

  try {
    mkdirSync(getCodemieHome(), { recursive: true });

    const deadline = Date.now() + maxWaitMs;
    let announced = false;

    while (true) {
      if (tryCreate(lockPath)) {
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

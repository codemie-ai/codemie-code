/**
 * Lock Manager - File-Based Locking for Concurrency Control
 *
 * Implements file-based locking to ensure only one RemoteAnalyticsSubmitter
 * runs at a time across multiple concurrent proxy instances.
 *
 * Features:
 * - Exclusive lock acquisition with retries
 * - Stale lock detection and recovery
 * - Process liveness checking
 * - Heartbeat to prevent false stale detection
 * - Graceful cleanup on exit signals
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import type { LockInfo } from './types.js';
import { logger } from '../../utils/logger.js';

const LOCK_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const RETRY_DELAY = 2000; // 2 seconds
const HEARTBEAT_INTERVAL = 30 * 1000; // 30 seconds

/**
 * Lock Manager
 */
export class LockManager {
  private lockPath: string;
  private lockInfo: LockInfo | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(analyticsDir?: string) {
    const baseDir = analyticsDir || join(homedir(), '.codemie', 'analytics');
    this.lockPath = join(baseDir, '.lock');
  }

  /**
   * Ensure analytics directory exists
   */
  private async ensureDir(): Promise<void> {
    const dir = join(this.lockPath, '..');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Check if a process is alive
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // kill(pid, 0) doesn't actually kill, just checks if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read lock file
   */
  private async readLock(): Promise<LockInfo | null> {
    if (!existsSync(this.lockPath)) {
      return null;
    }

    try {
      const content = await readFile(this.lockPath, 'utf-8');
      return JSON.parse(content) as LockInfo;
    } catch (error) {
      logger.debug(`Failed to read lock file: ${error}`);
      return null;
    }
  }

  /**
   * Write lock file
   */
  private async writeLock(lockInfo: LockInfo): Promise<void> {
    await this.ensureDir();
    const content = JSON.stringify(lockInfo, null, 2);
    await writeFile(this.lockPath, content, 'utf-8');
  }

  /**
   * Remove lock file
   */
  private async removeLock(): Promise<void> {
    if (existsSync(this.lockPath)) {
      try {
        await unlink(this.lockPath);
      } catch (error) {
        logger.debug(`Failed to remove lock: ${error}`);
      }
    }
  }

  /**
   * Check if lock is stale (old or process dead)
   */
  private async isLockStale(lockInfo: LockInfo): Promise<boolean> {
    // Check age
    const age = Date.now() - new Date(lockInfo.timestamp).getTime();
    if (age > LOCK_TIMEOUT) {
      return true;
    }

    // Check if process is alive
    if (!this.isProcessAlive(lockInfo.pid)) {
      return true;
    }

    return false;
  }

  /**
   * Start heartbeat to refresh lock timestamp
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      if (this.lockInfo) {
        this.lockInfo.timestamp = new Date().toISOString();
        try {
          await this.writeLock(this.lockInfo);
        } catch (error) {
          logger.debug(`Heartbeat failed: ${error}`);
        }
      }
    }, HEARTBEAT_INTERVAL);

    // Ensure heartbeat doesn't prevent process exit
    this.heartbeatTimer.unref();
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Acquire lock with retry
   *
   * @param name Lock name (for logging)
   * @param maxRetries Maximum number of retries
   * @returns true if lock acquired, false if failed
   */
  async acquire(name: string, maxRetries = 3): Promise<boolean> {
    let attempts = 0;

    while (attempts < maxRetries) {
      attempts++;

      // Check existing lock
      const existingLock = await this.readLock();

      if (existingLock) {
        // Check if stale
        if (await this.isLockStale(existingLock)) {
          logger.debug(`Removing stale lock from ${existingLock.agent} (PID ${existingLock.pid})`);
          await this.removeLock();
        } else {
          // Lock is valid, wait and retry
          if (attempts < maxRetries) {
            logger.debug(
              `Lock held by ${existingLock.agent} (PID ${existingLock.pid}), ` +
              `waiting ${RETRY_DELAY}ms (attempt ${attempts}/${maxRetries})`
            );
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            continue;
          } else {
            logger.debug(`Could not acquire lock after ${maxRetries} attempts`);
            return false;
          }
        }
      }

      // Try to acquire lock
      this.lockInfo = {
        pid: process.pid,
        timestamp: new Date().toISOString(),
        hostname: hostname(),
        agent: name
      };

      try {
        await this.writeLock(this.lockInfo);

        // Verify we own the lock (race condition check)
        const verifyLock = await this.readLock();
        if (verifyLock?.pid === process.pid) {
          logger.debug(`Lock acquired by ${name} (PID ${process.pid})`);
          this.startHeartbeat();
          this.setupExitHandlers();
          return true;
        } else {
          // Someone else got the lock first
          this.lockInfo = null;
          if (attempts < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            continue;
          } else {
            return false;
          }
        }
      } catch (error) {
        logger.debug(`Failed to acquire lock: ${error}`);
        this.lockInfo = null;
        if (attempts < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        } else {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Release lock
   */
  async release(): Promise<void> {
    this.stopHeartbeat();

    if (this.lockInfo) {
      // Verify we still own the lock
      const currentLock = await this.readLock();
      if (currentLock?.pid === process.pid) {
        await this.removeLock();
        logger.debug(`Lock released by ${this.lockInfo.agent} (PID ${process.pid})`);
      }

      this.lockInfo = null;
    }
  }

  /**
   * Setup exit handlers to release lock on process termination
   */
  private setupExitHandlers(): void {
    const cleanup = async () => {
      await this.release();
    };

    // Handle various exit signals
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);
  }
}

// src/agents/plugins/opencode/opencode.storage-utils.ts
/**
 * OpenCode Storage Utilities
 *
 * Shared utilities for reading OpenCode storage files.
 * Used by both session adapter and metrics processor to avoid coupling.
 * Per tech spec ADR-11.
 */

import { readFile } from 'fs/promises';
import { logger } from '../../../utils/logger.js';

// Retry config per tech spec "F10 FIX":
// - 1 initial read + 3 retries = 4 total read attempts
// - Retry on ENOENT (file not found during concurrent write) and SyntaxError (partial JSON)
// - Sleep delays AFTER each failed attempt: 50ms, 100ms, 200ms
const RETRY_CONFIG = {
  maxAttempts: 4,           // 1 initial + 3 retries
  delays: [50, 100, 200],   // Sleep after attempts 1, 2, 3 (not after attempt 4)
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read JSON file with retry on transient errors (ENOENT, SyntaxError from partial write).
 * Shared by session adapter and metrics processor.
 *
 * Per tech spec "F10 FIX":
 * - 1 initial + 3 retries = 4 total attempts
 * - Sleep 50/100/200ms after each failed attempt (except last)
 */
export async function readJsonWithRetry<T>(
  filePath: string,
  maxRetries = RETRY_CONFIG.maxAttempts,
  retryDelayMs = RETRY_CONFIG.delays[0]
): Promise<T | null> {
  const delays = [retryDelayMs, retryDelayMs * 2, retryDelayMs * 4];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      // Check for retryable errors:
      // - ENOENT: file temporarily missing during concurrent write
      // - SyntaxError: partial JSON from interrupted write
      const isRetryable = err.code === 'ENOENT' || err.name === 'SyntaxError';

      if (!isRetryable) {
        // Non-retryable error, fail immediately
        logger.debug(`[opencode-storage] Failed to read ${filePath}: ${err.message}`);
        return null;
      }

      // Sleep before next attempt (if not last attempt)
      if (attempt < maxRetries - 1) {
        await sleep(delays[attempt] || delays[delays.length - 1]);
      }
    }
  }
  // All attempts exhausted
  logger.debug(`[opencode-storage] All ${maxRetries} attempts exhausted for ${filePath}`);
  return null;
}

/**
 * Tolerant JSONL reading - skips corrupted lines instead of failing.
 * Per tech spec ADR-5 for deduplication robustness.
 *
 * @param filePath Path to JSONL file
 * @returns Array of parsed records (corrupted lines skipped)
 */
export async function readJsonlTolerant<T>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const results: T[] = [];
    let corruptedCount = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        results.push(JSON.parse(line) as T);
      } catch {
        corruptedCount++;
      }
    }

    if (corruptedCount > 0) {
      logger.warn(`[opencode-storage] Skipped ${corruptedCount} corrupted JSONL lines in ${filePath}`);
    }
    return results;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      // File doesn't exist, return empty array
      return [];
    }
    logger.debug(`[opencode-storage] Failed to read JSONL ${filePath}: ${err.message}`);
    return [];
  }
}

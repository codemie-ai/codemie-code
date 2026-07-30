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
import { readJSONLTolerant } from '../../core/session/utils/jsonl-reader.js';

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
  return readJSONLTolerant<T>(filePath, '[opencode-storage]');
}

/**
 * Load the parts belonging to one message, from either backend.
 *
 * SQLite-backed sessions arrive with every part pre-loaded in `partsMap` (one
 * bulk query per session); file-backed sessions read storage/part/{messageID}/.
 * Parts are validated against their owning message and session before use —
 * OpenCode's storage has been observed to retain orphaned part files.
 *
 * @param storagePath - Path to the OpenCode `storage/` directory
 * @param messageId - Message whose parts to load
 * @param expectedSessionId - When set, drop parts belonging to another session
 * @param partsMap - Pre-loaded parts keyed by message id (SQLite path)
 * @returns Parts sorted by id (their creation order)
 */
export async function loadPartsForMessage<T extends { id: string; messageID: string; sessionID: string }>(
  storagePath: string,
  messageId: string,
  expectedSessionId?: string,
  partsMap?: Record<string, T[]>
): Promise<T[]> {
  const isValid = (part: T): boolean => {
    if (part.messageID !== messageId) {
      logger.debug(`[opencode-storage] Skipping orphaned part ${part.id}: messageID mismatch`);
      return false;
    }
    if (expectedSessionId && part.sessionID !== expectedSessionId) {
      logger.debug(`[opencode-storage] Skipping part ${part.id}: sessionID mismatch`);
      return false;
    }
    return true;
  };

  if (partsMap?.[messageId]) {
    return partsMap[messageId].filter(isValid).sort((a, b) => a.id.localeCompare(b.id));
  }

  const { existsSync } = await import('fs');
  const { readdir } = await import('fs/promises');
  const { join } = await import('path');

  const partsDir = join(storagePath, 'part', messageId);
  if (!existsSync(partsDir)) {
    return [];
  }

  const parts: T[] = [];
  try {
    for (const file of await readdir(partsDir)) {
      if (!file.endsWith('.json')) continue;
      const part = await readJsonWithRetry<T>(join(partsDir, file));
      if (part && isValid(part)) parts.push(part);
    }
  } catch (error) {
    logger.debug(`[opencode-storage] Error loading parts from ${partsDir}:`, error);
  }

  return parts.sort((a, b) => a.id.localeCompare(b.id));
}

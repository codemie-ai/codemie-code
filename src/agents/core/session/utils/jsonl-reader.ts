/**
 * JSONL Reader Utility
 *
 * Generic JSONL file reading with type safety.
 * Shared by all session processors and adapters.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';

/**
 * Read all records from JSONL file, skipping corrupted lines.
 *
 * @param filePath - Absolute path to JSONL file
 * @param logPrefix - Log prefix for warnings (e.g. '[codex-storage]')
 * @returns Array of parsed records (empty if file doesn't exist; corrupted lines skipped)
 */
export async function readJSONLTolerant<T>(filePath: string, logPrefix = '[jsonl-reader]'): Promise<T[]> {
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
      logger.warn(`${logPrefix} Skipped ${corruptedCount} corrupted JSONL lines in ${filePath}`);
    }

    return results;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    logger.debug(`${logPrefix} Failed to read JSONL ${filePath}: ${err.message}`);
    return [];
  }
}

/**
 * Read all records from JSONL file.
 *
 * @param filePath - Absolute path to JSONL file
 * @returns Array of parsed records (empty if file doesn't exist)
 * @throws Error if file exists but cannot be read/parsed
 */
export async function readJSONL<T>(filePath: string): Promise<T[]> {
  try {
    if (!existsSync(filePath)) {
      return [];
    }

    const content = await readFile(filePath, 'utf8');

    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as T);

  } catch (error) {
    logger.error('[jsonl-reader] Failed to read JSONL:', error);
    throw error;
  }
}

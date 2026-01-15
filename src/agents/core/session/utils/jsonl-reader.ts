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

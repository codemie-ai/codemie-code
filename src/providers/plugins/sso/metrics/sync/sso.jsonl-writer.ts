/**
 * JSONL Atomic Write Utility
 *
 * Provides safe JSONL file operations with atomic writes.
 * Used by MetricsSyncPlugin to mark deltas as synced.
 *
 * Safety guarantees:
 * - Atomic rename ensures no partial writes
 * - Fsync ensures durability before rename
 * - Temp file cleanup on error
 * - No data loss on crash/power failure
 */

import { writeFile, rename, unlink, readFile, open } from 'fs/promises';
import { existsSync } from 'fs';
import type { MetricDelta } from '../../../../../agents/core/metrics/types.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * Read all deltas from JSONL file
 */
export async function readJSONL(filePath: string): Promise<MetricDelta[]> {
  try {
    if (!existsSync(filePath)) {
      return [];
    }

    const content = await readFile(filePath, 'utf8');

    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as MetricDelta);

  } catch (error) {
    logger.error('[jsonl-writer] Failed to read JSONL:', error);
    throw error;
  }
}

/**
 * Atomically write deltas to JSONL file
 *
 * Process:
 * 1. Write to temporary file
 * 2. Fsync to ensure data is on disk
 * 3. Atomic rename to target file
 * 4. Cleanup temp file on error
 */
export async function writeJSONLAtomic(
  filePath: string,
  deltas: MetricDelta[]
): Promise<void> {
  const tempPath = `${filePath}.tmp`;

  try {
    // 1. Write to temporary file
    const lines = deltas.map(d => JSON.stringify(d)).join('\n') + '\n';
    await writeFile(tempPath, lines, 'utf8');

    // 2. Fsync to ensure data is on disk
    const fd = await open(tempPath, 'r+');
    await fd.sync();
    await fd.close();

    // 3. Atomic rename (overwrites target)
    await rename(tempPath, filePath);

    logger.debug(`[jsonl-writer] Atomically wrote ${deltas.length} deltas to ${filePath}`);

  } catch (error) {
    // Cleanup temp file on error
    try {
      if (existsSync(tempPath)) {
        await unlink(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    logger.error('[jsonl-writer] Failed to write JSONL:', error);
    throw error;
  }
}

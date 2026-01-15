/**
 * JSONL Atomic Write Utility
 *
 * Generic JSONL file writing with atomic guarantees.
 * Shared by all session processors and adapters.
 *
 * Safety guarantees:
 * - Atomic rename ensures no partial writes
 * - Fsync ensures durability before rename
 * - Temp file cleanup on error
 * - No data loss on crash/power failure
 */

import { writeFile, rename, unlink, open } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';

/**
 * Atomically write records to JSONL file.
 *
 * Process:
 * 1. Write to temporary file
 * 2. Fsync to ensure data is on disk
 * 3. Atomic rename to target file
 * 4. Cleanup temp file on error
 *
 * @param filePath - Absolute path to target JSONL file
 * @param records - Array of records to write
 */
export async function writeJSONLAtomic<T>(
  filePath: string,
  records: T[]
): Promise<void> {
  const tempPath = `${filePath}.tmp`;

  try {
    // 1. Write to temporary file
    const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(tempPath, lines, 'utf8');

    // 2. Fsync to ensure data is on disk
    const fd = await open(tempPath, 'r+');
    await fd.sync();
    await fd.close();

    // 3. Atomic rename (overwrites target)
    await rename(tempPath, filePath);

    logger.debug(`[jsonl-writer] Atomically wrote ${records.length} records to ${filePath}`);

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

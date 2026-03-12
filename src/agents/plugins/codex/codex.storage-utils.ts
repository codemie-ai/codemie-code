// src/agents/plugins/codex/codex.storage-utils.ts
/**
 * Codex Storage Utilities
 *
 * Tolerant JSONL reader for Codex rollout files.
 * Mirrors opencode.storage-utils.ts readJsonlTolerant pattern exactly.
 * Skips malformed lines and logs the count at warn level.
 */

import { readFile } from 'fs/promises';
import { logger } from '../../../utils/logger.js';

/**
 * Tolerant JSONL reader for Codex rollout files.
 * Skips corrupted lines instead of failing; logs count of skipped lines at warn level.
 *
 * @param filePath Absolute path to .jsonl rollout file
 * @returns Array of parsed records (corrupted lines are skipped)
 */
export async function readCodexJsonlTolerant<T>(filePath: string): Promise<T[]> {
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
      logger.warn(`[codex-storage] Skipped ${corruptedCount} corrupted JSONL lines in ${filePath}`);
    }

    return results;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    logger.debug(`[codex-storage] Failed to read JSONL ${filePath}: ${err.message}`);
    return [];
  }
}

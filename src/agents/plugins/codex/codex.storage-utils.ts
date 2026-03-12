// src/agents/plugins/codex/codex.storage-utils.ts
/**
 * Codex Storage Utilities
 *
 * Tolerant JSONL reader for Codex rollout files.
 * Delegates to the shared readJSONLTolerant utility (Critical #3 fix).
 */

import { readJSONLTolerant } from '../../core/session/utils/jsonl-reader.js';

/**
 * Tolerant JSONL reader for Codex rollout files.
 * Skips corrupted lines instead of failing; logs count of skipped lines at warn level.
 *
 * @param filePath Absolute path to .jsonl rollout file
 * @returns Array of parsed records (corrupted lines are skipped)
 */
export async function readCodexJsonlTolerant<T>(filePath: string): Promise<T[]> {
  return readJSONLTolerant<T>(filePath, '[codex-storage]');
}

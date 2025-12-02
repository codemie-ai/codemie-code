/**
 * JSONL User Prompt Source
 *
 * Generic implementation for reading user prompts from JSONL files.
 * Used by Claude Code and other agents that store history in JSONL format.
 *
 * Format: One JSON object per line, chronologically ordered.
 */

import { existsSync } from 'node:fs';
import {
  UserPromptSource,
  UserPrompt,
  PromptQueryOptions
} from '../user-prompt-source.js';
import { readJSONL } from '../streaming.js';

/**
 * Mapper function type - converts raw JSONL entry to UserPrompt
 */
export type JSONLMapper = (entry: unknown) => UserPrompt;

/**
 * JSONL User Prompt Source
 *
 * Reads user prompts from a single JSONL file with a custom mapper function.
 * The mapper function converts agent-specific entry format to standard UserPrompt.
 *
 * Example usage:
 * ```typescript
 * const source = new JSONLUserPromptSource(
 *   '~/.claude/history.jsonl',
 *   (entry) => ({
 *     prompt: entry.display,
 *     timestamp: new Date(entry.timestamp),
 *     sessionId: entry.sessionId,
 *     projectPath: entry.project,
 *     metadata: { pastedContents: entry.pastedContents }
 *   })
 * );
 * ```
 */
export class JSONLUserPromptSource extends UserPromptSource {
  constructor(
    filePath: string,
    private mapper: JSONLMapper
  ) {
    super({ filePath, format: 'jsonl' });
  }

  /**
   * Read all prompts from JSONL file
   * Applies mapper to each line, then filters
   */
  async readPrompts(options?: PromptQueryOptions): Promise<UserPrompt[]> {
    const filePath = this.config.filePath as string;

    // Check if file exists
    if (!existsSync(filePath)) {
      return [];
    }

    // Read and parse all lines
    const entries = await readJSONL(filePath);
    let prompts = entries.map(this.mapper);

    // Apply filters
    prompts = this.applyFilters(prompts, options);

    return prompts;
  }
}

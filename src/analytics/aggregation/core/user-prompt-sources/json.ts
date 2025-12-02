/**
 * JSON User Prompt Source
 *
 * Generic implementation for reading user prompts from JSON array files.
 * Used by Gemini CLI and other agents that store history in JSON format.
 *
 * Format: JSON array of prompt objects, or single JSON object.
 * Supports multiple files via pattern matching.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  UserPromptSource,
  UserPrompt,
  PromptQueryOptions
} from '../user-prompt-source.js';

/**
 * Mapper function type - converts raw JSON entry to UserPrompt
 */
export type JSONMapper = (entry: unknown) => UserPrompt;

/**
 * JSON User Prompt Source
 *
 * Reads user prompts from JSON files with a custom mapper function.
 * The mapper function converts agent-specific entry format to standard UserPrompt.
 *
 * Supports:
 * - Single JSON array: [{ prompt: "...", ... }, ...]
 * - Single JSON object: { prompt: "...", ... }
 * - Multiple files via directory scanning
 *
 * Example usage:
 * ```typescript
 * const source = new JSONUserPromptSource(
 *   '~/.gemini/tmp/project-hash/logs.json',
 *   (entry) => ({
 *     prompt: entry.prompt,
 *     timestamp: new Date(entry.timestamp),
 *     sessionId: entry.sessionId || 'unknown',
 *     projectPath: entry.project,
 *     metadata: { projectHash: 'abc123' }
 *   })
 * );
 * ```
 */
export class JSONUserPromptSource extends UserPromptSource {
  constructor(
    filePath: string,
    private mapper: JSONMapper
  ) {
    super({ filePath, format: 'json' });
  }

  /**
   * Read all prompts from JSON file(s)
   * Applies mapper to each entry, then filters
   */
  async readPrompts(options?: PromptQueryOptions): Promise<UserPrompt[]> {
    const filePath = this.config.filePath as string;

    // Check if file exists
    if (!existsSync(filePath)) {
      return [];
    }

    // Read and parse file
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    // Handle both array and single object
    const entries = Array.isArray(parsed) ? parsed : [parsed];

    // Map to UserPrompt objects
    let prompts = entries.map(this.mapper);

    // Apply filters
    prompts = this.applyFilters(prompts, options);

    return prompts;
  }
}

/**
 * JSONL Streaming Utilities
 *
 * Provides efficient streaming for reading large JSONL (JSON Lines) files
 * commonly used by agents like Claude, Codex, and CodeMie Native.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Stream JSONL file line by line
 * @param filePath Path to JSONL file
 * @yields Parsed JSON objects, one per line
 */
export async function* streamJSONL(filePath: string): AsyncGenerator<any> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        yield JSON.parse(trimmed);
      } catch (error) {
        // Skip invalid JSON lines
        console.error(`Failed to parse JSONL line: ${error}`);
      }
    }
  }
}

/**
 * Read entire JSONL file into memory (for smaller files)
 * @param filePath Path to JSONL file
 * @param limit Optional limit on number of lines to read
 * @returns Array of parsed JSON objects
 */
export async function readJSONL(filePath: string, limit?: number): Promise<any[]> {
  const results: any[] = [];
  let count = 0;
  for await (const obj of streamJSONL(filePath)) {
    results.push(obj);
    count++;
    if (limit && count >= limit) {
      break;
    }
  }
  return results;
}

/**
 * Read JSON file
 * @param filePath Path to JSON file
 * @returns Parsed JSON object
 */
export async function readJSON(filePath: string): Promise<any> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

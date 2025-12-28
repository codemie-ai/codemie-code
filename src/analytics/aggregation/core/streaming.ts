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
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const iterator = rl[Symbol.asyncIterator]();
  try {
    while (true) {
      const res = await iterator.next();
      if (res.done) break;
      let line = res.value as string;
      let trimmed = line.trim();
      if (!trimmed) continue;

      // Attempt a direct parse first
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) yield item;
        } else {
          yield parsed;
        }
        continue;
      } catch {
        // fall through to recovery attempts
      }

      // If the line is a JSON array, yield each item
      if (trimmed.startsWith('[')) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr)) {
            for (const item of arr) yield item;
            continue;
          }
        } catch {
          // ignore and try other recovery strategies
        }
      }

      // If multiple JSON objects were concatenated on a single line (}{), split and parse
      if (trimmed.includes('}{')) {
        const parts = trimmed.split(/}\s*{/);
        for (let i = 0; i < parts.length; i++) {
          const piece = i === 0
            ? parts[i] + '}'
            : i === parts.length - 1
              ? '{' + parts[i]
              : '{' + parts[i] + '}';

          try {
            yield JSON.parse(piece);
          } catch (pieceErr) {
            console.error(`Failed to parse JSONL fragment: ${pieceErr}`);
          }
        }
        continue;
      }

      // Otherwise attempt to accumulate subsequent lines (handles pretty-printed / multi-line JSON)
      let buffer = trimmed;
      const MAX_LINES = 1000;
      let appended = 0;
      let lastError: unknown = null;
      while (appended < MAX_LINES) {
        const next = await iterator.next();
        if (next.done) break;
        buffer += '\n' + (next.value as string);
        appended++;
        try {
          yield JSON.parse(buffer);
          buffer = '';
          break;
        } catch (bufErr) {
          lastError = bufErr;
          // continue appending
        }
      }

      if (buffer) {
        console.error(`Failed to parse JSONL line: ${lastError}`);
      }
    }
  } finally {
    try { rl.close(); } catch {
      // ignore close errors
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

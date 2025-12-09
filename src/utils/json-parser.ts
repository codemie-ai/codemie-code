/**
 * JSON Parsing Utilities
 * 
 * Common utilities for parsing different JSON formats.
 */

import { logger } from './logger.js';

/**
 * Parse multi-line JSON objects from a string
 * Handles pretty-printed JSON where each object spans multiple lines
 * 
 * Example input:
 * ```
 * {
 *   "field": "value"
 * }
 * {
 *   "field2": "value2"
 * }
 * ```
 * 
 * @param content - String containing multiple JSON objects
 * @returns Array of parsed objects
 */
export function parseMultiLineJSON(content: string): any[] {
  const jsonObjects: any[] = [];
  let currentObject = '';
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    // Track string state
    if (char === '"' && !escapeNext) {
      inString = !inString;
    }
    escapeNext = char === '\\' && !escapeNext;

    // Track brace depth only outside strings
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
      }
    }

    currentObject += char;

    // Complete object when braces balance
    if (braceCount === 0 && currentObject.trim().length > 0) {
      try {
        const parsed = JSON.parse(currentObject.trim());
        jsonObjects.push(parsed);
      } catch (e) {
        // Skip malformed objects
        logger.debug('[parseMultiLineJSON] Skipped malformed JSON object');
      }
      currentObject = '';
    }
  }

  return jsonObjects;
}

/**
 * Parse line-delimited JSON (JSONL format)
 * Each line contains a complete JSON object
 * 
 * @param content - String containing JSONL data
 * @returns Array of parsed objects
 */
export function parseJSONL(content: string): any[] {
  const lines = content.trim().split('\n').filter(line => line.trim());
  const objects: any[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      objects.push(parsed);
    } catch (e) {
      logger.debug('[parseJSONL] Skipped malformed JSON line');
    }
  }

  return objects;
}

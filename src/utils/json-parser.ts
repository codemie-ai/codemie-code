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
      } catch {
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
    } catch {
      logger.debug('[parseJSONL] Skipped malformed JSON line');
    }
  }

  return objects;
}

/**
 * Normalize LLM model names from different provider formats
 *
 * Handles various model name formats:
 * - AWS Bedrock Converse: converse/region.provider.model-v1:0 -> model
 * - AWS Bedrock Direct: region.provider.model-v1:0 -> model
 * - Standard Claude: claude-sonnet-4-5-20250929 (unchanged)
 * - OpenAI: gpt-4.1-turbo (unchanged)
 * - Google: gemini-1.5-pro (unchanged)
 *
 * Examples:
 * - converse/global.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001
 * - eu.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001
 * - us-east-1.anthropic.claude-opus-4-20250514-v1:0 -> claude-opus-4-20250514
 * - claude-sonnet-4-5-20250929 -> claude-sonnet-4-5-20250929
 *
 * @param modelName - Raw model name from analytics data
 * @returns Normalized model name for display
 */
export function normalizeModelName(modelName: string): string {
  // Extract model from AWS Bedrock converse format
  // Format: converse/region.provider.model-v1:0
  // Example: converse/global.anthropic.claude-haiku-4-5-20251001-v1:0
  if (modelName.startsWith('converse/')) {
    const match = modelName.match(/anthropic\.(claude-[a-z0-9-]+)-v\d+:/);
    if (match) {
      return match[1];
    }
  }

  // Extract model from AWS Bedrock direct format (without converse/ prefix)
  // Format: region.provider.model-v1:0
  // Examples:
  // - eu.anthropic.claude-haiku-4-5-20251001-v1:0
  // - us-east-1.anthropic.claude-opus-4-20250514-v1:0
  // - global.anthropic.claude-sonnet-4-5-20250929-v1:0
  // Requires at least one dot before 'anthropic' (i.e., region prefix)
  const bedrockMatch = modelName.match(/^[a-z0-9-]+\.anthropic\.(claude-[a-z0-9-]+)-v\d+:/);
  if (bedrockMatch) {
    return bedrockMatch[1]; // Return the model name part
  }

  // Return as-is for standard formats (Claude, OpenAI, Google, etc.)
  return modelName;
}

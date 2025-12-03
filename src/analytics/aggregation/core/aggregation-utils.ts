/**
 * Aggregation Utilities
 *
 * Shared utility functions for aggregating file modification statistics.
 * Used by all analytics adapters to calculate consistent statistics.
 */

import { CodemieFileModification } from '../types.js';

/**
 * Aggregate file modifications by a specific key
 */
function aggregateByKey<T extends string | undefined>(
  modifications: CodemieFileModification[],
  keyExtractor: (mod: CodemieFileModification) => T
): Record<string, {
  filesCreated: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
}> {
  const result: Record<string, {
    filesCreated: number;
    filesModified: number;
    linesAdded: number;
    linesRemoved: number;
  }> = {};

  for (const mod of modifications) {
    const key = keyExtractor(mod) || 'other';
    if (!result[key]) {
      result[key] = { filesCreated: 0, filesModified: 0, linesAdded: 0, linesRemoved: 0 };
    }

    if (mod.wasNewFile) {
      result[key].filesCreated++;
    } else {
      result[key].filesModified++;
    }

    result[key].linesAdded += mod.linesAdded;
    result[key].linesRemoved += mod.linesRemoved;
  }

  return result;
}

/**
 * Aggregate file modifications by language
 */
export function aggregateByLanguage(modifications: CodemieFileModification[]): Record<string, {
  filesCreated: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
}> {
  return aggregateByKey(modifications, mod => mod.language);
}

/**
 * Aggregate file modifications by format
 */
export function aggregateByFormat(modifications: CodemieFileModification[]): Record<string, {
  filesCreated: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
}> {
  return aggregateByKey(modifications, mod => mod.format);
}

/**
 * Aggregate file modifications by tool
 */
export function aggregateByTool(modifications: CodemieFileModification[]): Record<string, {
  count: number;
  linesAdded: number;
  linesRemoved: number;
}> {
  const result: Record<string, {
    count: number;
    linesAdded: number;
    linesRemoved: number;
  }> = {};

  for (const mod of modifications) {
    const key = mod.toolName;
    if (!result[key]) {
      result[key] = { count: 0, linesAdded: 0, linesRemoved: 0 };
    }

    result[key].count++;
    result[key].linesAdded += mod.linesAdded;
    result[key].linesRemoved += mod.linesRemoved;
  }

  return result;
}

/**
 * Calculate file statistics from modifications
 */
export function calculateFileStats(modifications: CodemieFileModification[]) {
  if (modifications.length === 0) {
    return undefined;
  }

  return {
    filesCreated: modifications.filter(fm => fm.wasNewFile).length,
    filesModified: modifications.filter(fm => !fm.wasNewFile && fm.operation !== 'delete').length,
    filesDeleted: modifications.filter(fm => fm.operation === 'delete').length,
    totalLinesAdded: modifications.reduce((sum, fm) => sum + fm.linesAdded, 0),
    totalLinesRemoved: modifications.reduce((sum, fm) => sum + fm.linesRemoved, 0),
    totalLinesModified: modifications.reduce((sum, fm) => sum + (fm.linesModified || 0), 0),
    byLanguage: aggregateByLanguage(modifications),
    byFormat: aggregateByFormat(modifications),
    byTool: aggregateByTool(modifications)
  };
}

/**
 * Calculate duration between two dates
 */
export function calculateDuration(startTime: Date | string, endTime: Date | string): number {
  const start = typeof startTime === 'string' ? new Date(startTime) : startTime;
  const end = typeof endTime === 'string' ? new Date(endTime) : endTime;
  return end.getTime() - start.getTime();
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

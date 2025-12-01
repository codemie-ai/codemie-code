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

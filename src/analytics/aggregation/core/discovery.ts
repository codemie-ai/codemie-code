/**
 * File Discovery Utilities
 *
 * Provides utilities for discovering session files across different agent formats
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

/**
 * Resolve path with home directory expansion
 * @param path Path to resolve (supports ~ expansion)
 * @returns Absolute resolved path
 */
export function resolvePath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Find all files matching a glob pattern (simplified)
 * @param dir Directory to search
 * @param pattern File pattern (e.g., "*.json", "session-*.jsonl")
 * @returns Array of absolute file paths
 */
export async function findFiles(dir: string, pattern: string | RegExp): Promise<string[]> {
  const results: string[] = [];

  if (!existsSync(dir)) {
    return results;
  }

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively search subdirectories
        const subResults = await findFiles(fullPath, pattern);
        results.push(...subResults);
      } else if (entry.isFile()) {
        // Check if file matches pattern
        if (typeof pattern === 'string') {
          // Simple glob pattern support
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          if (regex.test(entry.name)) {
            results.push(fullPath);
          }
        } else if (pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dir}: ${error}`);
  }

  return results;
}

/**
 * Find directories matching a pattern
 * @param baseDir Base directory to search
 * @param pattern Directory name pattern
 * @returns Array of absolute directory paths
 */
export async function findDirectories(baseDir: string, pattern?: string | RegExp): Promise<string[]> {
  const results: string[] = [];

  if (!existsSync(baseDir)) {
    return results;
  }

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(baseDir, entry.name);

        if (!pattern) {
          results.push(fullPath);
        } else if (typeof pattern === 'string') {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          if (regex.test(entry.name)) {
            results.push(fullPath);
          }
        } else if (pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${baseDir}: ${error}`);
  }

  return results;
}

/**
 * Get file modification time
 * @param filePath Path to file
 * @returns Date of last modification or null if file doesn't exist
 */
export async function getFileModTime(filePath: string): Promise<Date | null> {
  try {
    const stats = await stat(filePath);
    return stats.mtime;
  } catch {
    return null;
  }
}

/**
 * Filter files by date range
 * @param filePaths Array of file paths
 * @param dateFrom Start date (inclusive)
 * @param dateTo End date (inclusive)
 * @returns Filtered array of file paths
 */
export async function filterFilesByDate(
  filePaths: string[],
  dateFrom?: Date,
  dateTo?: Date
): Promise<string[]> {
  const results: string[] = [];

  for (const filePath of filePaths) {
    const modTime = await getFileModTime(filePath);
    if (!modTime) continue;

    if (dateFrom && modTime < dateFrom) continue;
    if (dateTo && modTime > dateTo) continue;

    results.push(filePath);
  }

  return results;
}

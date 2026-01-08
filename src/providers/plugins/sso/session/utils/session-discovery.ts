/**
 * Session Discovery Utility
 *
 * Agent-agnostic session file discovery using adapters.
 * Handles nested directory structures and filters via adapter patterns.
 */

import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { SessionAdapter } from '../adapters/base/BaseSessionAdapter.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * Discover all session files for an adapter.
 *
 * Process:
 * 1. Get session paths from adapter
 * 2. Search all subdirectories in base directory
 * 3. Filter files using adapter's pattern matching
 *
 * @param adapter - Session adapter (defines paths and patterns)
 * @returns Array of absolute paths to session files
 */
export async function discoverSessionFiles(
  adapter: SessionAdapter
): Promise<string[]> {
  try {
    const { baseDir, projectDirs } = adapter.getSessionPaths();

    if (!existsSync(baseDir)) {
      logger.debug(`[session-discovery] Base directory not found: ${baseDir}`);
      return [];
    }

    const sessionFiles: string[] = [];

    // If specific project directories provided, search only those
    if (projectDirs && projectDirs.length > 0) {
      for (const projectDir of projectDirs) {
        const fullPath = join(baseDir, projectDir);
        if (existsSync(fullPath)) {
          const files = await discoverInDirectory(fullPath, adapter);
          sessionFiles.push(...files);
        }
      }
    } else {
      // Search all subdirectories in base directory
      const entries = await readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = join(baseDir, entry.name);
          const files = await discoverInDirectory(dirPath, adapter);
          sessionFiles.push(...files);
        } else if (entry.isFile()) {
          // Also check files directly in base directory
          const filePath = join(baseDir, entry.name);
          if (adapter.matchesSessionPattern(filePath)) {
            sessionFiles.push(filePath);
          }
        }
      }
    }

    logger.debug(
      `[session-discovery] Found ${sessionFiles.length} session files for ${adapter.agentName}`
    );

    return sessionFiles;

  } catch (error) {
    logger.error('[session-discovery] Failed to discover session files:', error);
    throw error;
  }
}

/**
 * Discover session files in a specific directory.
 *
 * @param dirPath - Absolute path to directory
 * @param adapter - Session adapter for pattern matching
 * @returns Array of absolute paths to session files
 */
async function discoverInDirectory(
  dirPath: string,
  adapter: SessionAdapter
): Promise<string[]> {
  try {
    const sessionFiles: string[] = [];
    const files = await readdir(dirPath);

    for (const file of files) {
      const filePath = join(dirPath, file);
      if (adapter.matchesSessionPattern(filePath)) {
        sessionFiles.push(filePath);
      }
    }

    return sessionFiles;

  } catch (error) {
    logger.warn(`[session-discovery] Failed to read directory ${dirPath}:`, error);
    return [];
  }
}

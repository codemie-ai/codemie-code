/**
 * File Snapshotter
 *
 * Takes snapshots of directory state and computes diffs.
 * Used to detect new files created by agent processes.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { FileSnapshot, FileInfo } from '../types.js';
import { logger } from '../../../../utils/logger.js';

export class FileSnapshotter {
  /**
   * Take snapshot of directory
   */
  async snapshot(dirPath: string): Promise<FileSnapshot> {
    const files = await this.scanDirectory(dirPath);

    return {
      timestamp: Date.now(),
      files
    };
  }

  /**
   * Compute diff between snapshots (new files only)
   */
  diff(before: FileSnapshot, after: FileSnapshot): FileInfo[] {
    const beforePaths = new Set(before.files.map(f => f.path));
    const newFiles = after.files.filter(f => !beforePaths.has(f.path));

    logger.debug(`[FileSnapshotter] Diff: ${newFiles.length} new files detected`);
    return newFiles;
  }

  /**
   * Scan directory recursively and collect file information
   */
  private async scanDirectory(dirPath: string): Promise<FileInfo[]> {
    // Check if directory exists
    if (!existsSync(dirPath)) {
      logger.debug(`[FileSnapshotter] Directory does not exist: ${dirPath}`);
      return [];
    }

    const files: FileInfo[] = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isFile()) {
          try {
            const stats = await stat(fullPath);
            files.push({
              path: fullPath,
              size: stats.size,
              createdAt: stats.birthtimeMs,
              modifiedAt: stats.mtimeMs
            });
          } catch (error) {
            // Skip files that can't be stat'd (permissions, etc.)
            logger.debug(`[FileSnapshotter] Failed to stat file: ${fullPath}`, error);
          }
        } else if (entry.isDirectory()) {
          // Recursively scan subdirectories
          const subFiles = await this.scanDirectory(fullPath);
          files.push(...subFiles);
        }
      }
    } catch (error) {
      logger.error(`[FileSnapshotter] Failed to scan directory: ${dirPath}`, error);
      throw error;
    }

    return files;
  }
}

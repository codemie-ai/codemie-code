import * as fs from 'fs/promises';
import * as path from 'path';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { logger } from '../utils/logger.js';
import { getCodemieHome } from '../utils/paths.js';

/**
 * Migration 002: Consolidate session storage
 *
 * Migrates session files from old structure to new consolidated structure:
 * - OLD: ~/.codemie/sessions/*.json + *.jsonl
 * - OLD: ~/.codemie/conversations/sessions/*.jsonl
 * - NEW: ~/.codemie/sessions/*.json + *.jsonl (all files)
 */
class ConsolidateSessionsMigration implements Migration {
  id = '002-consolidate-sessions';
  description = 'Consolidate session storage under ~/.codemie/sessions/';
  minVersion = '0.0.28';

  private readonly CODEMIE_HOME = getCodemieHome();
  private readonly OLD_METRICS_DIR = path.join(this.CODEMIE_HOME, 'metrics', 'sessions');
  private readonly OLD_CONVERSATIONS_DIR = path.join(this.CODEMIE_HOME, 'conversations', 'sessions');
  private readonly NEW_SESSIONS_DIR = path.join(this.CODEMIE_HOME, 'sessions');

  async up(): Promise<MigrationResult> {
    logger.info('[002-consolidate-sessions] consolidate: phase=start');

    let metricsCount = 0;
    let conversationsCount = 0;

    // Migrate metrics sessions
    const metricsResult = await this.migrateDirectory(
      this.OLD_METRICS_DIR,
      'metrics'
    );
    metricsCount = metricsResult.count;

    // Migrate conversation sessions
    const conversationsResult = await this.migrateDirectory(
      this.OLD_CONVERSATIONS_DIR,
      'conversations'
    );
    conversationsCount = conversationsResult.count;

    const totalMigrated = metricsCount + conversationsCount;

    // Clean up empty directories
    if (totalMigrated > 0) {
      await this.cleanupEmptyDirectories();
    }

    if (totalMigrated > 0) {
      logger.info(`[002-consolidate-sessions] consolidate: phase=complete migrated=${totalMigrated} metrics=${metricsCount} conversations=${conversationsCount}`);
      return {
        success: true,
        migrated: true,
        details: {
          metrics: metricsCount,
          conversations: conversationsCount,
          total: totalMigrated
        }
      };
    }

    logger.debug('[002-consolidate-sessions] consolidate: phase=complete reason=no_files');
    return {
      success: true,
      migrated: false,
      reason: 'no-old-sessions'
    };
  }

  /**
   * Migrate all files from source directory to new sessions directory
   */
  private async migrateDirectory(
    sourceDir: string,
    type: 'metrics' | 'conversations'
  ): Promise<{ count: number }> {
    logger.debug(`[002-consolidate-sessions] migrate_dir: type=${type} source=${sourceDir}`);

    // Check if source directory exists
    if (!await this.directoryExists(sourceDir)) {
      logger.debug(`[002-consolidate-sessions] migrate_dir: type=${type} status=skip reason=not_found`);
      return { count: 0 };
    }

    // Ensure destination directory exists
    await fs.mkdir(this.NEW_SESSIONS_DIR, { recursive: true });

    // List all files in source directory
    const files = await fs.readdir(sourceDir);
    logger.debug(`[002-consolidate-sessions] migrate_dir: type=${type} files_found=${files.length}`);

    let migratedCount = 0;

    for (const file of files) {
      // Skip non-session files
      if (!this.isSessionFile(file)) {
        logger.debug(`[002-consolidate-sessions] skip: type=${type} file=${file} reason=not_session_file`);
        continue;
      }

      const sourcePath = path.join(sourceDir, file);
      const destPath = path.join(this.NEW_SESSIONS_DIR, file);

      // Check if destination file already exists
      if (await this.fileExists(destPath)) {
        // File already exists in new location - check if we should merge or skip
        const shouldMigrate = await this.shouldMigrateFile(sourcePath, destPath);

        if (!shouldMigrate) {
          logger.debug(`[002-consolidate-sessions] skip: type=${type} file=${file} reason=already_exists`);
          continue;
        }
      }

      // Move file to new location
      try {
        await fs.rename(sourcePath, destPath);
        logger.debug(`[002-consolidate-sessions] move: type=${type} file=${file} status=success`);
        migratedCount++;
      } catch (error: any) {
        logger.error(`[002-consolidate-sessions] move: type=${type} file=${file} status=error`, error);
      }
    }

    logger.info(`[002-consolidate-sessions] migrate_dir: type=${type} status=complete migrated=${migratedCount}`);
    return { count: migratedCount };
  }

  /**
   * Clean up empty directories after migration
   */
  private async cleanupEmptyDirectories(): Promise<void> {
    logger.debug('[002-consolidate-sessions] cleanup: phase=start');

    // Try to remove old directories if they're empty
    for (const dir of [this.OLD_METRICS_DIR, this.OLD_CONVERSATIONS_DIR]) {
      try {
        const isEmpty = await this.isDirectoryEmpty(dir);
        if (isEmpty) {
          await fs.rmdir(dir);
          logger.debug(`[002-consolidate-sessions] cleanup: removed_dir=${dir}`);
        } else {
          logger.debug(`[002-consolidate-sessions] cleanup: skipped_dir=${dir} reason=not_empty`);
        }
      } catch {
        // Ignore errors - directory might not exist or have permissions issues
        logger.debug(`[002-consolidate-sessions] cleanup: skipped_dir=${dir} reason=error`);
      }
    }

    // Try to remove parent directories if they're empty
    try {
      const metricsParent = path.dirname(this.OLD_METRICS_DIR);
      const isEmpty = await this.isDirectoryEmpty(metricsParent);
      if (isEmpty) {
        await fs.rmdir(metricsParent);
        logger.debug(`[002-consolidate-sessions] cleanup: removed_dir=${metricsParent}`);
      }
    } catch {
      // Ignore
    }

    try {
      const conversationsParent = path.dirname(this.OLD_CONVERSATIONS_DIR);
      const isEmpty = await this.isDirectoryEmpty(conversationsParent);
      if (isEmpty) {
        await fs.rmdir(conversationsParent);
        logger.debug(`[002-consolidate-sessions] cleanup: removed_dir=${conversationsParent}`);
      }
    } catch {
      // Ignore
    }

    logger.debug('[002-consolidate-sessions] cleanup: phase=complete');
  }

  /**
   * Check if directory is empty
   */
  private async isDirectoryEmpty(dirPath: string): Promise<boolean> {
    try {
      const files = await fs.readdir(dirPath);
      return files.length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if file is a session file (*.json or *.jsonl)
   */
  private isSessionFile(filename: string): boolean {
    return filename.endsWith('.json') || filename.endsWith('.jsonl');
  }

  /**
   * Determine if we should migrate a file when destination already exists
   * Strategy: Compare file sizes - migrate if source is newer/larger
   */
  private async shouldMigrateFile(sourcePath: string, destPath: string): Promise<boolean> {
    try {
      const [sourceStats, destStats] = await Promise.all([
        fs.stat(sourcePath),
        fs.stat(destPath)
      ]);

      // If source is newer and larger, migrate it
      if (sourceStats.mtime > destStats.mtime && sourceStats.size > destStats.size) {
        logger.debug(`[002-consolidate-sessions] compare: source_newer=true source_larger=true decision=migrate`);
        return true;
      }

      // Otherwise, keep destination file
      logger.debug(`[002-consolidate-sessions] compare: source_newer=${sourceStats.mtime > destStats.mtime} source_larger=${sourceStats.size > destStats.size} decision=skip`);
      return false;
    } catch (error) {
      logger.debug('[002-consolidate-sessions] compare: status=error decision=skip', error);
      return false;
    }
  }

  /**
   * Check if directory exists
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// Auto-register the migration
MigrationRegistry.register(new ConsolidateSessionsMigration());

// Export for testing
export { ConsolidateSessionsMigration };

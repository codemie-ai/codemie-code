import * as fs from 'fs/promises';
import * as path from 'path';
import type { Migration, MigrationHistory, MigrationRecord } from './types.js';
import { MigrationRegistry } from './registry.js';
import { logger } from '../utils/logger.js';
import { getCodemiePath } from '../utils/codemie-home.js';

/**
 * Migration tracker
 * Manages migration history file and tracks which migrations have been applied
 */
export class MigrationTracker {
  private static readonly HISTORY_FILE = getCodemiePath('migrations.json');

  /**
   * Load migration history from file
   * Returns empty history for new installations
   */
  static async loadHistory(): Promise<MigrationHistory> {
    try {
      const content = await fs.readFile(this.HISTORY_FILE, 'utf-8');
      const history = JSON.parse(content);
      logger.debug(`[MigrationTracker] Loaded history: ${history.migrations.length} migration(s) recorded`);
      return history;
    } catch {
      // File doesn't exist or is invalid - return empty history
      logger.debug('[MigrationTracker] No history file found, starting fresh');
      return {
        version: 1,
        migrations: []
      };
    }
  }

  /**
   * Save migration history to file
   */
  static async saveHistory(history: MigrationHistory): Promise<void> {
    await fs.mkdir(path.dirname(this.HISTORY_FILE), { recursive: true });
    await fs.writeFile(
      this.HISTORY_FILE,
      JSON.stringify(history, null, 2),
      'utf-8'
    );
    logger.debug(`[MigrationTracker] Saved history: ${history.migrations.length} migration(s)`);
  }

  /**
   * Check if a migration has been applied
   */
  static async hasBeenApplied(migrationId: string): Promise<boolean> {
    const history = await this.loadHistory();
    return history.migrations.some(m => m.id === migrationId && m.success);
  }

  /**
   * Record a migration as applied
   */
  static async recordMigration(migrationId: string, success: boolean): Promise<void> {
    const history = await this.loadHistory();

    // Check if already recorded (avoid duplicates)
    const exists = history.migrations.some(m => m.id === migrationId);
    if (exists) {
      logger.debug(`[MigrationTracker] Migration ${migrationId} already recorded, skipping`);
      return;
    }

    logger.info(`[MigrationTracker] Recording migration ${migrationId} (success: ${success})`);

    history.migrations.push({
      id: migrationId,
      appliedAt: new Date().toISOString(),
      success
    });

    await this.saveHistory(history);
  }

  /**
   * Get pending migrations
   * Returns migrations that haven't been successfully applied yet
   */
  static async getPendingMigrations(): Promise<Migration[]> {
    const history = await this.loadHistory();
    const appliedIds = new Set(
      history.migrations
        .filter(m => m.success)
        .map(m => m.id)
    );

    const allMigrations = MigrationRegistry.getAll();
    const pending = allMigrations.filter(m => !appliedIds.has(m.id));

    logger.debug(`[MigrationTracker] Pending migrations: ${pending.length} of ${allMigrations.length} total`);

    return pending;
  }

  /**
   * Clean up deprecated migrations from history
   * Removes migrations that are deprecated in versions before current major version
   */
  static async cleanupDeprecated(currentVersion: string): Promise<number> {
    const history = await this.loadHistory();
    const currentMajor = parseInt(currentVersion.split('.')[0], 10);

    // Get migrations that are deprecated before current major version
    const migrations = MigrationRegistry.getAll();
    const deprecatedIds = new Set(
      migrations
        .filter(m => {
          if (!m.deprecatedIn) return false;
          const deprecatedMajor = parseInt(m.deprecatedIn.split('.')[0], 10);
          return deprecatedMajor < currentMajor;
        })
        .map(m => m.id)
    );

    // Filter out deprecated migrations
    const originalCount = history.migrations.length;
    history.migrations = history.migrations.filter(
      m => !deprecatedIds.has(m.id)
    );

    // Save updated history if changes were made
    if (history.migrations.length < originalCount) {
      await this.saveHistory(history);
    }

    return originalCount - history.migrations.length;
  }

  /**
   * Get all migration records
   */
  static async getAll(): Promise<MigrationRecord[]> {
    const history = await this.loadHistory();
    return history.migrations;
  }
}

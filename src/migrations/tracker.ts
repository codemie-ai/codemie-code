import * as fs from 'fs/promises';
import * as path from 'path';
import type { Migration, MigrationHistory, MigrationRecord } from './types.js';
import { MigrationRegistry } from './registry.js';
import { logger } from '../utils/logger.js';
import { getCodemiePath } from '../utils/paths.js';
import { writeJsonFileAtomic } from '../utils/atomic-write.js';

/**
 * Migration tracker
 * Manages migration history file and tracks which migrations have been applied
 */
export class MigrationTracker {
  private static get HISTORY_FILE(): string {
    return getCodemiePath('migrations.json');
  }

  /** Where an unparsable ledger is moved aside; its presence means "history unknown". */
  static get CORRUPT_HISTORY_FILE(): string {
    return `${this.HISTORY_FILE}.corrupt`;
  }

  /**
   * Load migration history from file.
   * A missing file is a new installation (empty history). An unparsable file is
   * moved aside to `migrations.json.corrupt` (never overwritten in place) and an
   * empty history is returned; migrations that care ask ledgerWasUnparsable().
   */
  static async loadHistory(): Promise<MigrationHistory> {
    let content: string;
    try {
      content = await fs.readFile(this.HISTORY_FILE, 'utf-8');
    } catch {
      logger.debug('[MigrationTracker] No history file found, starting fresh');
      return { version: 1, migrations: [] };
    }
    try {
      const history = JSON.parse(content) as MigrationHistory;
      if (!history || !Array.isArray(history.migrations)) throw new Error('missing migrations array');
      logger.debug(`[MigrationTracker] Loaded history: ${history.migrations.length} migration(s) recorded`);
      return history;
    } catch {
      await this.moveAsideUnparsable();
      return { version: 1, migrations: [] };
    }
  }

  private static async moveAsideUnparsable(): Promise<void> {
    try {
      await fs.rename(this.HISTORY_FILE, this.CORRUPT_HISTORY_FILE);
      logger.warn(`[MigrationTracker] Migration history was unreadable; moved it to ${this.CORRUPT_HISTORY_FILE}`);
    } catch (error) {
      // A concurrent process may have moved it already
      logger.debug('[MigrationTracker] Could not move unparsable history aside', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Whether the ledger was found unparsable (now or by an earlier run) and moved aside. */
  static async ledgerWasUnparsable(): Promise<boolean> {
    try {
      await fs.access(this.CORRUPT_HISTORY_FILE);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the ledger holds a record of `migrationId` (successful or not). */
  static async hasRecord(migrationId: string): Promise<boolean> {
    const history = await this.loadHistory();
    return history.migrations.some(m => m.id === migrationId);
  }

  /**
   * Save migration history to file (atomic; never over an unparsable file).
   */
  static async saveHistory(history: MigrationHistory): Promise<void> {
    await fs.mkdir(path.dirname(this.HISTORY_FILE), { recursive: true });
    await writeJsonFileAtomic(this.HISTORY_FILE, history, {
      refuseUnparsable: true,
      label: 'CodeMie migration history',
    });
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

import chalk from 'chalk';
import { MigrationTracker } from './tracker.js';
import { logger } from '../utils/logger.js';

/**
 * Migration runner
 * Executes pending migrations and displays progress
 */
export class MigrationRunner {
  /**
   * Run all pending migrations
   * @param options Configuration options
   * @returns Statistics about migrations executed
   */
  static async runPending(options?: {
    silent?: boolean;
    dryRun?: boolean;
    autoCleanup?: boolean;
  }): Promise<{ total: number; applied: number; skipped: number; failed: number }> {
    const silent = options?.silent ?? false;
    const dryRun = options?.dryRun ?? false;

    logger.debug('[MigrationRunner] Starting migration check');

    const pending = await MigrationTracker.getPendingMigrations();

    if (pending.length === 0) {
      logger.debug('[MigrationRunner] No pending migrations');
      return { total: 0, applied: 0, skipped: 0, failed: 0 };
    }

    logger.info(`[MigrationRunner] Found ${pending.length} pending migration(s): ${pending.map(m => m.id).join(', ')}`);

    if (!silent) {
      console.log(chalk.bold(`\n🔄 Running ${pending.length} migration(s)...\n`));
    }

    let applied = 0;
    let skipped = 0;
    let failed = 0;

    // Execute each migration in order
    for (const migration of pending) {
      logger.debug(`[MigrationRunner] Starting migration: ${migration.id}`);

      if (!silent) {
        console.log(chalk.cyan(`[${migration.id}]`), chalk.dim(migration.description));
      }

      try {
        const result = await migration.up();

        if (result.success) {
          if (result.migrated) {
            // Migration was applied successfully
            applied++;
            logger.info(`[MigrationRunner] Migration ${migration.id} applied successfully`, result.details);
            if (!silent) {
              console.log(chalk.green('✓'), chalk.dim('Applied'));
            }
            if (!dryRun) {
              await MigrationTracker.recordMigration(migration.id, true);
            }
          } else {
            // Migration was skipped (already done or not applicable)
            skipped++;
            logger.debug(`[MigrationRunner] Migration ${migration.id} skipped: ${result.reason}`);
            if (!silent) {
              console.log(chalk.yellow('⊘'), chalk.dim(`Skipped: ${result.reason}`));
            }
            if (!dryRun) {
              // Record as successful (even though skipped) to prevent re-running
              await MigrationTracker.recordMigration(migration.id, true);
            }
          }
        } else {
          // Migration failed
          failed++;
          logger.error(`[MigrationRunner] Migration ${migration.id} failed: ${result.reason}`, result.details);
          if (!silent) {
            console.log(chalk.red('✗'), chalk.dim(`Failed: ${result.reason}`));
          }
          // Don't record failed migrations - they can be retried
        }
      } catch (error: any) {
        // Unexpected error during migration
        failed++;
        logger.error(`[MigrationRunner] Unexpected error in migration ${migration.id}:`, error);
        if (!silent) {
          console.log(chalk.red('✗'), chalk.dim(`Error: ${error.message}`));
        }
      }

      if (!silent) {
        console.log(); // Empty line between migrations
      }
    }

    if (!silent && applied > 0) {
      console.log(chalk.dim(`→ ${applied} migration(s) applied\n`));
    }

    // Log summary
    logger.info(`[MigrationRunner] Migration complete: ${applied} applied, ${skipped} skipped, ${failed} failed`);

    // Auto-cleanup deprecated migrations if requested
    if (options?.autoCleanup && !dryRun) {
      try {
        logger.debug('[MigrationRunner] Auto-cleanup requested but not yet implemented');
        // Get package version for cleanup
        // Note: readPackageJson implementation will be needed
        // For now, we'll skip auto-cleanup unless manually invoked
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      total: pending.length,
      applied,
      skipped,
      failed
    };
  }

  /**
   * Check if any migrations are pending
   */
  static async hasPending(): Promise<boolean> {
    const pending = await MigrationTracker.getPendingMigrations();
    return pending.length > 0;
  }
}

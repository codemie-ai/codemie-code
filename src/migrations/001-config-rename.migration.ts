import * as fs from 'fs/promises';
import * as path from 'path';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { isMultiProviderConfig, isLegacyConfig } from '../env/types.js';
import { logger } from '../utils/logger.js';
import { getCodemieHome } from '../utils/codemie-home.js';

/**
 * Migration 001: Rename config.json to codemie-cli.config.json
 *
 * Migrates both global and project-local configs
 * Only migrates configs that belong to CodeMie CLI (validates ownership)
 */
class ConfigRenameMigration implements Migration {
  id = '001-config-rename';
  description = 'Rename config.json to codemie-cli.config.json';
  minVersion = '0.1.0';
  deprecatedIn = '1.0.0';

  private readonly GLOBAL_DIR = getCodemieHome();
  private readonly PROJECT_DIR = path.join(process.cwd(), '.codemie');

  private readonly OLD_FILENAME = 'config.json';
  private readonly NEW_FILENAME = 'codemie-cli.config.json';

  async up(): Promise<MigrationResult> {
    logger.info('[001-config-rename] Starting config file rename migration');

    let globalMigrated = false;
    let projectMigrated = false;

    // Migrate global config
    logger.debug('[001-config-rename] Checking global config for migration');
    const globalResult = await this.migrateConfigInDirectory(this.GLOBAL_DIR);
    if (globalResult.success && globalResult.migrated) {
      globalMigrated = true;
      logger.info('[001-config-rename] Global config migrated successfully');
    } else if (!globalResult.success) {
      logger.error(`[001-config-rename] Global config migration failed: ${globalResult.reason}`);
    } else {
      logger.debug(`[001-config-rename] Global config skipped: ${globalResult.reason}`);
    }

    // Migrate project-local config
    logger.debug('[001-config-rename] Checking project-local config for migration');
    const projectResult = await this.migrateConfigInDirectory(this.PROJECT_DIR);
    if (projectResult.success && projectResult.migrated) {
      projectMigrated = true;
      logger.info('[001-config-rename] Project-local config migrated successfully');
    } else if (!projectResult.success) {
      logger.error(`[001-config-rename] Project-local config migration failed: ${projectResult.reason}`);
    } else {
      logger.debug(`[001-config-rename] Project-local config skipped: ${projectResult.reason}`);
    }

    // Determine overall result
    if (globalMigrated || projectMigrated) {
      const details = {
        global: globalMigrated,
        project: projectMigrated
      };
      logger.info('[001-config-rename] Migration completed successfully', details);
      return {
        success: true,
        migrated: true,
        details
      };
    }

    // If neither migrated, return the reason from global (most common)
    logger.debug(`[001-config-rename] No configs migrated: ${globalResult.reason}`);
    return globalResult;
  }

  /**
   * Migrate config in a specific directory
   */
  private async migrateConfigInDirectory(configDir: string): Promise<MigrationResult> {
    const oldPath = path.join(configDir, this.OLD_FILENAME);
    const newPath = path.join(configDir, this.NEW_FILENAME);

    logger.debug(`[001-config-rename] Checking ${oldPath}`);

    // Check if old config exists
    if (!await this.fileExists(oldPath)) {
      logger.debug(`[001-config-rename] Old config not found at ${oldPath}`);
      return {
        success: true,
        migrated: false,
        reason: 'no-old-config'
      };
    }

    logger.debug(`[001-config-rename] Found old config at ${oldPath}`);

    // Check if new config already exists (migration already done)
    if (await this.fileExists(newPath)) {
      logger.debug(`[001-config-rename] New config already exists at ${newPath}`);
      return {
        success: true,
        migrated: false,
        reason: 'already-migrated'
      };
    }

    // Read and validate old config
    let oldConfig: any;
    try {
      const content = await fs.readFile(oldPath, 'utf-8');
      oldConfig = JSON.parse(content);
      logger.debug(`[001-config-rename] Successfully read and parsed config`);
    } catch (error: any) {
      logger.error(`[001-config-rename] Failed to read/parse config: ${error.message}`);
      return {
        success: false,
        migrated: false,
        reason: 'invalid-json'
      };
    }

    // Validate config ownership
    const isOurs = this.isCodeMieConfig(oldConfig);
    logger.debug(`[001-config-rename] Config ownership check: ${isOurs ? 'CodeMie CLI' : 'other tool'}`);

    if (!isOurs) {
      logger.info(`[001-config-rename] Config at ${oldPath} does not belong to CodeMie CLI, skipping`);
      return {
        success: true,
        migrated: false,
        reason: 'not-codemie-config'
      };
    }

    // Perform migration
    try {
      // Ensure directory exists
      await fs.mkdir(configDir, { recursive: true });
      logger.debug(`[001-config-rename] Created/verified directory: ${configDir}`);

      // Write to new location
      await fs.writeFile(
        newPath,
        JSON.stringify(oldConfig, null, 2),
        'utf-8'
      );
      logger.debug(`[001-config-rename] Wrote new config to ${newPath}`);

      // Delete old config
      await fs.unlink(oldPath);
      logger.debug(`[001-config-rename] Deleted old config at ${oldPath}`);

      logger.info(`[001-config-rename] Successfully migrated ${oldPath} → ${newPath}`);

      return {
        success: true,
        migrated: true
      };
    } catch (error: any) {
      logger.error(`[001-config-rename] Migration failed: ${error.message}`, error);
      return {
        success: false,
        migrated: false,
        reason: `migration-failed: ${error.message}`
      };
    }
  }

  /**
   * Check if config belongs to CodeMie CLI
   * Validates by checking for known CodeMie config fields
   */
  private isCodeMieConfig(config: any): boolean {
    if (!config || typeof config !== 'object') {
      return false;
    }

    // Check for multi-provider format (version 2)
    if (isMultiProviderConfig(config)) {
      return true;
    }

    // Check for legacy format (version 1)
    if (isLegacyConfig(config)) {
      return true;
    }

    // Check for known CodeMie CLI fields
    // Require at least 2 matching fields to avoid false positives
    const codeMieFields = [
      'provider',
      'baseUrl',
      'apiKey',
      'model',
      'timeout',
      'authMethod',
      'codeMieUrl',
      'codeMieProject',
      'codeMieIntegration',
      'ssoConfig',
      'profiles',
      'activeProfile',
      'version',
      'awsProfile',
      'awsRegion',
      'metrics',
      'debug',
      'allowedDirs',
      'ignorePatterns'
    ];

    const matchingFields = codeMieFields.filter(field => field in config);
    return matchingFields.length >= 2;
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
MigrationRegistry.register(new ConfigRenameMigration());

// Export for testing
export { ConfigRenameMigration };

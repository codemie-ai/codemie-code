import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { logger } from '../utils/logger.js';

/**
 * Migration 003: Remove hooks node from ~/.gemini/settings.json
 * 
 * Removes the legacy hooks configuration node:
 * hooks: {
 *   enabled: true
 * }
 */
class RemoveHooksNodeMigration implements Migration {
  id = '003-remove-hooks-node';
  description = 'Remove legacy hooks configuration from ~/.gemini/settings.json';
  minVersion = '0.1.0';

  private readonly SETTINGS_PATH = path.join(homedir(), '.gemini', 'settings.json');

  async up(): Promise<MigrationResult> {
    logger.info('[003-remove-hooks-node] Starting hooks node removal migration');

    // Check if settings file exists
    if (!await this.fileExists(this.SETTINGS_PATH)) {
      logger.debug(`[003-remove-hooks-node] Settings file not found at ${this.SETTINGS_PATH}`);
      return {
        success: true,
        migrated: false,
        reason: 'file-not-found'
      };
    }

    logger.debug(`[003-remove-hooks-node] Found settings file at ${this.SETTINGS_PATH}`);

    // Read and parse config
    let config: any;
    let content: string;
    try {
      content = await fs.readFile(this.SETTINGS_PATH, 'utf-8');
      config = JSON.parse(content);
    } catch (error: any) {
      logger.error(`[003-remove-hooks-node] Failed to read/parse settings: ${error.message}`);
      return {
        success: false,
        migrated: false,
        reason: 'invalid-json'
      };
    }

    // Check if hooks node exists
    if (!config || typeof config !== 'object' || !config.hooks) {
      logger.debug('[003-remove-hooks-node] No hooks node found');
      return {
        success: true,
        migrated: false,
        reason: 'no-hooks-node'
      };
    }

    // Check if it matches the target structure
    // We strictly check for enabled: true, but we'll remove the whole hooks node
    // as requested "remove this node hooks: { enabled: true }"
    const hooks = config.hooks;
    if (hooks.enabled === true) {
        // Prepare new config without hooks
        const { hooks: _hooks, ...newConfig } = config;

        try {
            await fs.writeFile(
                this.SETTINGS_PATH,
                JSON.stringify(newConfig, null, 2),
                'utf-8'
            );
            logger.info('[003-remove-hooks-node] Successfully removed hooks node');
            return {
                success: true,
                migrated: true
            };
        } catch (error: any) {
            logger.error(`[003-remove-hooks-node] Failed to write settings: ${error.message}`);
            return {
                success: false,
                migrated: false,
                reason: `write-failed: ${error.message}`
            };
        }
    }
    
    logger.debug('[003-remove-hooks-node] Hooks node found but does not match target criteria (enabled: true)');
    return {
        success: true,
        migrated: false,
        reason: 'criteria-mismatch'
    };
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
MigrationRegistry.register(new RemoveHooksNodeMigration());

// Export for testing
export { RemoveHooksNodeMigration };

/**
 * Base Extension Installer
 *
 * Abstract base class providing common installation logic for agent extensions/plugins.
 * Uses Template Method pattern - subclasses override agent-specific parts.
 *
 * Common logic (~220 lines):
 * - Version detection from manifest JSON
 * - Check if already installed (compare versions)
 * - Copy files recursively from source to target
 * - Verify installation (check critical files, validate JSON)
 * - Return installation result with detailed info
 * - Logging with agent-specific context
 *
 * Agent-specific parts (4 methods to override):
 * - getSourcePath(): Where extension files are bundled
 * - getTargetPath(): Where to install in user's home
 * - getManifestPath(): Relative path to manifest file
 * - getCriticalFiles(): List of files to verify
 *
 * @module agents/core/extension/BaseExtensionInstaller
 */

import { mkdir, cp, access, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { constants } from 'fs';
import { logger } from '../../../utils/logger.js';

/**
 * Common result type for extension installation
 */
export interface ExtensionInstallationResult {
  /** Whether installation succeeded */
  success: boolean;
  /** Target directory path where extension was installed */
  targetPath: string;
  /** Action taken during installation */
  action: 'copied' | 'updated' | 'already_exists' | 'failed';
  /** Error message if installation failed */
  error?: string;
  /** Source extension version */
  sourceVersion?: string;
  /** Installed extension version (before update) */
  installedVersion?: string;
}

/**
 * Base Extension Installer Abstract Class
 *
 * Provides common installation logic shared across all agent extensions.
 * Subclasses provide agent-specific paths and configuration.
 */
export abstract class BaseExtensionInstaller {
  /**
   * Constructor
   * @param agentName - Agent name from metadata (e.g., 'claude', 'gemini')
   */
  constructor(protected readonly agentName: string) {}

  // ==========================================
  // Agent-specific methods (must override)
  // ==========================================

  /**
   * Get the source extension directory path
   * Where extension files are bundled in the CLI
   *
   * @returns Absolute path to source extension directory
   * @example
   * ```typescript
   * // Claude
   * return join(dirname(fileURLToPath(import.meta.url)), 'plugin');
   *
   * // Gemini
   * return join(dirname(fileURLToPath(import.meta.url)), 'extension');
   * ```
   */
  protected abstract getSourcePath(): string;

  /**
   * Get the target installation directory
   * Where to install extension in user's home
   *
   * @returns Absolute path to target directory
   * @example
   * ```typescript
   * // Claude: ~/.codemie/claude-plugin
   * return join(homedir(), '.codemie', 'claude-plugin');
   *
   * // Gemini: ~/.gemini/extensions/codemie
   * return join(homedir(), '.gemini', 'extensions', 'codemie');
   * ```
   */
  abstract getTargetPath(): string;

  /**
   * Get the manifest file path (relative to base directory)
   *
   * @returns Relative path to manifest file from base directory
   * @example
   * ```typescript
   * // Claude: .claude-plugin/plugin.json
   * return '.claude-plugin/plugin.json';
   *
   * // Gemini: gemini-extension.json
   * return 'gemini-extension.json';
   * ```
   */
  protected abstract getManifestPath(): string;

  /**
   * Get list of critical files that must exist after installation
   * Used for verification
   *
   * @returns Array of relative file paths from base directory
   * @example
   * ```typescript
   * // Claude
   * return ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'README.md'];
   *
   * // Gemini
   * return ['gemini-extension.json', 'hooks/hooks.json', 'README.md'];
   * ```
   */
  protected abstract getCriticalFiles(): string[];

  // ==========================================
  // Common logic (shared across all agents)
  // ==========================================

  /**
   * Get version from manifest JSON file
   *
   * @param basePath - Base directory path (source or target)
   * @returns Version string or null if not found
   */
  protected async getVersion(basePath: string): Promise<string | null> {
    try {
      const manifestPath = join(basePath, this.getManifestPath());
      const content = await readFile(manifestPath, 'utf-8');
      const json = JSON.parse(content);
      return json.version || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if extension is already installed and get version info
   *
   * Verifies:
   * - Target directory exists
   * - Manifest file exists and is readable
   * - Hooks file exists and is readable
   *
   * @returns Object with installation status and version, or null if not installed
   */
  protected async getInstalledInfo(): Promise<{ installed: boolean; version: string | null } | null> {
    try {
      const targetPath = this.getTargetPath();

      // Check if directory exists
      await access(targetPath, constants.F_OK);

      // Verify manifest exists
      const manifestPath = join(targetPath, this.getManifestPath());
      await access(manifestPath, constants.R_OK);

      // Verify hooks exist (critical for extension functionality)
      const hooksPath = join(targetPath, 'hooks', 'hooks.json');
      await access(hooksPath, constants.R_OK);

      // Get installed version
      const version = await this.getVersion(targetPath);

      return { installed: true, version };
    } catch {
      return null;
    }
  }

  /**
   * Verify extension structure after installation
   *
   * Validates:
   * - Critical files exist
   * - JSON files are valid
   *
   * @param targetPath - Path to installed extension directory
   * @returns True if extension structure is valid
   */
  protected async verifyInstallation(targetPath: string): Promise<boolean> {
    try {
      const criticalFiles = this.getCriticalFiles();

      for (const file of criticalFiles) {
        const filePath = join(targetPath, file);
        await access(filePath, constants.R_OK);

        // Verify JSON files are valid
        if (file.endsWith('.json')) {
          const content = await readFile(filePath, 'utf-8');
          JSON.parse(content); // Throws if invalid JSON
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install extension to target directory with version-aware updates
   *
   * Installation process:
   * 1. Verify source exists
   * 2. Get source and installed versions (from manifest, not hardcoded)
   * 3. Compare versions - skip if identical
   * 4. Copy files from source to target
   * 5. Verify installation integrity
   * 6. Log results with agent-specific context
   * 7. Return detailed result
   *
   * @returns Installation result with status, action, and version info
   */
  async install(): Promise<ExtensionInstallationResult> {
    logger.info(`[${this.agentName}] Checking CodeMie extension...`);

    try {
      const sourcePath = this.getSourcePath();
      const targetPath = this.getTargetPath();
      logger.info(`[${this.agentName}] Extension paths: source=${sourcePath}, target=${targetPath}`);

      // 1. Verify source exists
      logger.info(`[${this.agentName}] Step 1: Verifying source path exists...`);
      try {
        await access(sourcePath, constants.R_OK);
        logger.info(`[${this.agentName}] Source path verified: ${sourcePath}`);
      } catch {
        throw new Error(`Source path not found: ${sourcePath}`);
      }

      // 2. Get source and installed versions (from manifest, not hardcoded)
      logger.info(`[${this.agentName}] Step 2: Getting versions...`);
      const sourceVersion = await this.getVersion(sourcePath);
      logger.info(`[${this.agentName}] Source version: ${sourceVersion || 'not found'}`);

      const installedInfo = await this.getInstalledInfo();
      logger.info(`[${this.agentName}] Installed info: ${JSON.stringify(installedInfo)}`);

      // 3. Compare versions - skip if identical
      logger.info(`[${this.agentName}] Step 3: Comparing versions...`);
      let action: 'copied' | 'updated' | 'already_exists';

      if (!installedInfo?.installed) {
        action = 'copied';
        logger.info(`[${this.agentName}] Action determined: copied (not installed)`);
      } else if (sourceVersion && installedInfo.version && sourceVersion !== installedInfo.version) {
        action = 'updated';
        logger.info(`[${this.agentName}] Action determined: updated (${installedInfo.version} → ${sourceVersion})`);
      } else {
        action = 'already_exists';
        logger.info(`[${this.agentName}] Action determined: already_exists (version ${sourceVersion || 'unknown'})`);
      }

      // 4. Copy files from source to target (if needed)
      if (action !== 'already_exists') {
        logger.info(`[${this.agentName}] Step 4: Copying extension files...`);
        // Ensure parent directory exists
        await mkdir(dirname(targetPath), { recursive: true });

        // Copy entire extension directory (recursive, force overwrite)
        await cp(sourcePath, targetPath, {
          recursive: true,
          force: true,
          errorOnExist: false
        });
        logger.info(`[${this.agentName}] Files copied successfully`);

        // 5. Verify installation integrity
        logger.info(`[${this.agentName}] Step 5: Verifying installation...`);
        const isValid = await this.verifyInstallation(targetPath);
        logger.info(`[${this.agentName}] Verification result: ${isValid}`);

        if (!isValid) {
          logger.warn(`[${this.agentName}] Installation verification failed`);
          return {
            success: false,
            targetPath,
            action: 'failed',
            error: 'Extension structure verification failed after copy',
            sourceVersion: sourceVersion || undefined
          };
        }
      } else {
        logger.info(`[${this.agentName}] Skipping copy - extension already up-to-date`);
      }

      // Build result
      logger.info(`[${this.agentName}] Step 6: Building result object...`);
      const result: ExtensionInstallationResult = {
        success: true,
        targetPath,
        action,
        sourceVersion: sourceVersion || undefined,
        installedVersion: installedInfo?.version || undefined
      };

      // 6. Log result inside installer (agent-specific context)
      logger.info(`[${this.agentName}] Step 7: Logging final result (action=${action})...`);
      if (result.action === 'copied') {
        const versionInfo = result.sourceVersion ? ` (v${result.sourceVersion})` : '';
        logger.info(`[${this.agentName}] Extension installed to ${result.targetPath}${versionInfo}`);
      } else if (result.action === 'updated') {
        const versionInfo = result.installedVersion && result.sourceVersion
          ? ` (v${result.installedVersion} → v${result.sourceVersion})`
          : '';
        logger.info(`[${this.agentName}] Extension updated at ${result.targetPath}${versionInfo}`);
      } else {
        const versionInfo = result.sourceVersion ? ` (v${result.sourceVersion})` : '';
        logger.debug(`[${this.agentName}] Extension already up-to-date at ${result.targetPath}${versionInfo}`);
      }

      // 7. Return detailed result
      logger.info(`[${this.agentName}] Installation complete - returning result`);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`[${this.agentName}] Extension installation failed: ${errorMsg}`);
      if (errorStack) {
        logger.debug(`[${this.agentName}] Error stack: ${errorStack}`);
      }
      logger.warn(`[${this.agentName}] Continuing without extension - hooks will not be available`);

      return {
        success: false,
        targetPath: this.getTargetPath(),
        action: 'failed',
        error: errorMsg
      };
    }
  }
}

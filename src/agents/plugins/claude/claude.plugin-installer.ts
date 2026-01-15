/**
 * Claude Plugin Installer
 *
 * Handles automatic installation of Claude plugin to user's home directory
 * for SSO provider integration.
 *
 * Architecture:
 * - Copies plugin from source (bundled in CLI) to ~/.codemie/claude-plugin/
 * - Validates plugin structure after installation
 * - Idempotent: Safe to call multiple times
 * - Works in both npm package and development contexts
 *
 * @module agents/plugins/claude/plugin-installer
 */

import { mkdir, cp, access, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { constants } from 'fs';

/**
 * Result of plugin installation operation
 */
export interface PluginInstallationResult {
  /** Whether installation succeeded */
  success: boolean;
  /** Target directory path where plugin was installed */
  targetPath: string;
  /** Action taken during installation */
  action: 'copied' | 'updated' | 'already_exists' | 'failed';
  /** Error message if installation failed */
  error?: string;
  /** Source plugin version */
  sourceVersion?: string;
  /** Installed plugin version (before update) */
  installedVersion?: string;
}

/**
 * Claude Plugin Installer
 *
 * Installs CodeMie plugin for Claude Code to enable session tracking,
 * metrics collection, and conversation sync.
 */
export class ClaudePluginInstaller {
  /** Target installation directory: ~/.codemie/claude-plugin */
  private static readonly TARGET_DIR = join(homedir(), '.codemie', 'claude-plugin');

  /**
   * Get the source plugin directory path
   *
   * Works in both development and npm package contexts:
   * - Development: src/agents/plugins/claude/plugin/
   * - NPM package: dist/agents/plugins/claude/plugin/
   *
   * @returns Absolute path to source plugin directory
   */
  private static getSourcePath(): string {
    // Get path to current file (claude.plugin-installer.ts or .js)
    const currentFile = fileURLToPath(import.meta.url);

    // Navigate up to plugins directory
    // Current: plugins/claude/plugin-installer.js
    // Target:  plugins/claude/plugin/
    const claudePluginDir = dirname(currentFile); // plugins/claude/
    return join(claudePluginDir, 'plugin');
  }

  /**
   * Get the target installation directory
   *
   * @returns Absolute path to target directory (~/.codemie/claude-plugin)
   */
  static getTargetPath(): string {
    return this.TARGET_DIR;
  }

  /**
   * Get version from plugin.json
   *
   * @param pluginJsonPath - Path to plugin.json file
   * @returns Version string or null if not found
   */
  private static async getPluginVersion(pluginJsonPath: string): Promise<string | null> {
    try {
      const content = await readFile(pluginJsonPath, 'utf-8');
      const json = JSON.parse(content);
      return json.version || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if plugin is already installed and get version info
   *
   * Verifies:
   * - Target directory exists
   * - plugin.json exists and is readable
   * - hooks.json exists and is readable
   *
   * @returns Object with installation status and version, or null if not installed
   */
  private static async getInstalledInfo(): Promise<{ installed: boolean; version: string | null } | null> {
    try {
      // Check if directory exists
      await access(this.TARGET_DIR, constants.F_OK);

      // Verify plugin.json exists
      const pluginJsonPath = join(this.TARGET_DIR, '.claude-plugin', 'plugin.json');
      await access(pluginJsonPath, constants.R_OK);

      // Verify hooks.json exists
      const hooksJsonPath = join(this.TARGET_DIR, 'hooks', 'hooks.json');
      await access(hooksJsonPath, constants.R_OK);

      // Get installed version
      const version = await this.getPluginVersion(pluginJsonPath);

      return { installed: true, version };
    } catch {
      return null;
    }
  }

  /**
   * Verify plugin structure after installation
   *
   * Validates:
   * - Critical files exist
   * - JSON files are valid
   *
   * @param targetPath - Path to installed plugin directory
   * @returns True if plugin structure is valid
   */
  private static async verifyInstallation(targetPath: string): Promise<boolean> {
    try {
      // Critical files that must exist
      const criticalFiles = [
        '.claude-plugin/plugin.json',
        'hooks/hooks.json',
        'README.md'
      ];

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
   * Install plugin to target directory with version-aware updates
   *
   * Installation process:
   * 1. Check if already installed and get version
   * 2. Compare source vs installed version
   * 3. Skip if versions match, force update if different
   * 4. Copy plugin from source to ~/.codemie/claude-plugin/
   * 5. Verify installation integrity
   *
   * @returns Installation result with status, action, and version info
   */
  static async install(): Promise<PluginInstallationResult> {
    try {
      // Get source path
      const sourcePath = this.getSourcePath();

      // Verify source exists
      try {
        await access(sourcePath, constants.R_OK);
      } catch {
        return {
          success: false,
          targetPath: this.TARGET_DIR,
          action: 'failed',
          error: `Source plugin directory not found: ${sourcePath}`
        };
      }

      // Get source version
      const sourcePluginJsonPath = join(sourcePath, '.claude-plugin', 'plugin.json');
      const sourceVersion = await this.getPluginVersion(sourcePluginJsonPath);

      // Check if already installed and get version
      const installedInfo = await this.getInstalledInfo();

      if (installedInfo?.installed) {
        const installedVersion = installedInfo.version;

        // Compare versions
        if (sourceVersion && installedVersion && sourceVersion === installedVersion) {
          // Same version - skip installation
          return {
            success: true,
            targetPath: this.TARGET_DIR,
            action: 'already_exists',
            sourceVersion,
            installedVersion
          };
        }

        // Different versions - force update
        // Continue with installation (will overwrite)
      }

      // Ensure parent directory exists
      await mkdir(dirname(this.TARGET_DIR), { recursive: true });

      // Copy entire plugin directory (recursive, force overwrite)
      await cp(sourcePath, this.TARGET_DIR, {
        recursive: true,
        force: true,
        errorOnExist: false
      });

      // Verify installation
      const isValid = await this.verifyInstallation(this.TARGET_DIR);

      if (!isValid) {
        return {
          success: false,
          targetPath: this.TARGET_DIR,
          action: 'failed',
          error: 'Plugin structure verification failed after copy',
          sourceVersion: sourceVersion || undefined
        };
      }

      // Determine action: copied (new install) or updated (version change)
      const action = installedInfo?.installed ? 'updated' : 'copied';

      return {
        success: true,
        targetPath: this.TARGET_DIR,
        action,
        sourceVersion: sourceVersion || undefined,
        installedVersion: installedInfo?.version || undefined
      };
    } catch (error) {
      return {
        success: false,
        targetPath: this.TARGET_DIR,
        action: 'failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

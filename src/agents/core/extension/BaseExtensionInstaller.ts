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

import { mkdir, cp, access, readFile, writeFile, readdir, stat, rm } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { constants, existsSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import { normalizePathSeparators } from '../../../utils/paths.js';

/**
 * Configuration for selective local file copying
 * Read from manifest's localCopy section
 */
export interface LocalCopyConfig {
  /** Whether local copy is enabled */
  enabled: boolean;
  /** Pattern matching strategy: whitelist, blacklist, or hybrid */
  strategy: 'whitelist' | 'blacklist' | 'hybrid';
  /** Glob patterns to include */
  includes: string[];
  /** Glob patterns to exclude */
  excludes: string[];
  /** Target directory name */
  targetDir: string;
  /** Preserve directory tree structure */
  preserveStructure: boolean;
  /** File overwrite policy: always, never, or newer */
  overwritePolicy: 'always' | 'never' | 'newer';
}

/**
 * Result of local copy operation
 */
export interface LocalCopyResult {
  /** Whether local copy succeeded */
  success: boolean;
  /** Target path where files were copied */
  targetPath: string;
  /** List of files that were copied */
  copiedFiles: string[];
  /** List of files that were skipped */
  skippedFiles: string[];
  /** List of errors encountered */
  errors: string[];
}

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
  /** Local copy result (optional - only if localCopy is enabled in manifest) */
  localCopy?: LocalCopyResult;
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
   * Read local copy configuration from manifest
   *
   * Reads from local-install.json first (preferred), with fallback to plugin.json
   * for backward compatibility.
   *
   * @returns LocalCopyConfig if enabled, null otherwise
   */
  protected async readLocalCopyFromManifest(): Promise<LocalCopyConfig | null> {
    try {
      const sourcePath = this.getSourcePath();
      const manifestDir = dirname(join(sourcePath, this.getManifestPath()));

      // Try reading from separate local-install.json file first (preferred)
      const localInstallPath = join(manifestDir, 'local-install.json');
      try {
        const localInstallContent = await readFile(localInstallPath, 'utf-8');
        const localConfig = JSON.parse(localInstallContent);

        if (!localConfig.enabled) return null;

        logger.debug(`[${this.agentName}] Loaded local copy config from local-install.json`);

        // Apply defaults
        return {
          enabled: true,
          strategy: localConfig.strategy || 'hybrid',
          includes: localConfig.includes || [],
          excludes: localConfig.excludes || [],
          targetDir: localConfig.targetDir || '.codemie',
          preserveStructure: localConfig.preserveStructure ?? true,
          overwritePolicy: localConfig.overwritePolicy || 'newer'
        };
      } catch {
        // Fallback to reading from plugin.json (backward compatibility)
        logger.debug(`[${this.agentName}] local-install.json not found, checking plugin.json`);

        const manifestPath = join(sourcePath, this.getManifestPath());
        const content = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content);

        if (!manifest.localCopy?.enabled) return null;

        logger.debug(`[${this.agentName}] Loaded local copy config from plugin.json (deprecated)`);

        // Apply defaults
        return {
          enabled: true,
          strategy: manifest.localCopy.strategy || 'hybrid',
          includes: manifest.localCopy.includes || [],
          excludes: manifest.localCopy.excludes || [],
          targetDir: manifest.localCopy.targetDir || '.codemie',
          preserveStructure: manifest.localCopy.preserveStructure ?? true,
          overwritePolicy: manifest.localCopy.overwritePolicy || 'newer'
        };
      }
    } catch (error) {
      logger.debug(`[${this.agentName}] Failed to read local copy config: ${error}`);
      return null;
    }
  }

  /**
   * Install extension files to local working directory
   *
   * @param sourcePath - Source directory path (global installation)
   * @param config - Local copy configuration
   * @returns Result with copied files, skipped files, and errors
   */
  protected async installLocal(
    sourcePath: string,
    config: LocalCopyConfig
  ): Promise<LocalCopyResult> {
    const { resolveLocalTargetPath } = await import('../../../utils/paths.js');

    const result: LocalCopyResult = {
      success: false,
      targetPath: '',
      copiedFiles: [],
      skippedFiles: [],
      errors: []
    };

    try {
      // 1. Resolve target directory
      result.targetPath = resolveLocalTargetPath(config.targetDir);
      logger.info(`[${this.agentName}] Local copy target: ${result.targetPath}`);

      // 2. Check version (skip if up-to-date)
      const sourceVersion = await this.getVersion(sourcePath);
      if (!await this.shouldUpdateLocal(result.targetPath, sourceVersion || 'unknown')) {
        result.success = true;
        result.skippedFiles.push('All files (already up-to-date)');
        return result;
      }

      // 3. Ensure target directory exists
      await mkdir(result.targetPath, { recursive: true });

      // 4. Walk source directory and copy selectively
      const filesInfo = await this.walkDirectory(sourcePath, sourcePath, config);

      for (const file of filesInfo.include) {
        try {
          const sourceFull = join(sourcePath, file);
          const targetFull = join(result.targetPath, file);

          // Ensure parent directory exists
          await mkdir(dirname(targetFull), { recursive: true });

          // Copy with overwrite policy
          if (await this.shouldCopyFile(sourceFull, targetFull, config.overwritePolicy)) {
            await cp(sourceFull, targetFull, { force: true });
            result.copiedFiles.push(file);
            logger.debug(`[${this.agentName}] Copied: ${file}`);
          } else {
            result.skippedFiles.push(file);
          }
        } catch (error) {
          const errorMsg = `Failed to copy ${file}: ${error}`;
          result.errors.push(errorMsg);
          logger.warn(`[${this.agentName}] ${errorMsg}`);
        }
      }

      // 5. Write version tracking file
      await this.writeVersionFile(result.targetPath, sourceVersion);

      result.success = result.errors.length === 0;

      // Enhanced logging with Windows-specific guidance
      if (result.copiedFiles.length === 0 && result.errors.length === 0) {
        logger.warn(
          `[${this.agentName}] Local copy: 0 files copied from templates. ` +
          `This may indicate a path separator issue on Windows or incorrect pattern matching.`
        );
        logger.debug(
          `[${this.agentName}] Pattern config: strategy=${config.strategy}, ` +
          `includes=${JSON.stringify(config.includes)}, excludes=${JSON.stringify(config.excludes)}`
        );
      } else {
        logger.info(
          `[${this.agentName}] Local copy: ${result.copiedFiles.length} copied, ` +
          `${result.skippedFiles.length} skipped, ${result.errors.length} errors`
        );
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      logger.error(`[${this.agentName}] Local copy failed: ${errorMsg}`);
    }

    return result;
  }

  /**
   * Recursively walk directory and filter files
   *
   * @param basePath - Base source path
   * @param currentPath - Current directory being walked
   * @param config - Local copy configuration
   * @returns Lists of included and excluded files
   */
  protected async walkDirectory(
    basePath: string,
    currentPath: string,
    config: LocalCopyConfig
  ): Promise<{ include: string[]; exclude: string[] }> {
    const result = { include: [] as string[], exclude: [] as string[] };
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      const relativePath = relative(basePath, fullPath);

      if (entry.isDirectory()) {
        // Recurse into directory
        const nested = await this.walkDirectory(basePath, fullPath, config);
        result.include.push(...nested.include);
        result.exclude.push(...nested.exclude);
      } else {
        // Apply filter
        if (this.shouldIncludeFile(relativePath, config)) {
          result.include.push(relativePath);
        } else {
          result.exclude.push(relativePath);
        }
      }
    }

    return result;
  }

  /**
   * Check if file should be included based on pattern matching strategy
   * Normalizes path separators to forward slashes for cross-platform compatibility
   *
   * @param relativePath - File path relative to base (may use platform-specific separators)
   * @param config - Local copy configuration
   * @returns true if file should be included
   */
  protected shouldIncludeFile(relativePath: string, config: LocalCopyConfig): boolean {
    // CRITICAL: Normalize path separators for Windows compatibility
    // Windows paths use backslashes, but glob patterns use forward slashes
    // Without normalization, all files are excluded on Windows
    const normalizedPath = normalizePathSeparators(relativePath);

    // Simple glob matching - handles * and ? wildcards
    // Note: Patterns and paths now both use forward slashes
    const matchesPattern = (path: string, pattern: string): boolean => {
      const regexPattern = pattern
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${regexPattern}$`).test(path);
    };

    if (config.strategy === 'whitelist') {
      return config.includes.some(pattern => matchesPattern(normalizedPath, pattern));
    }

    if (config.strategy === 'blacklist') {
      return !config.excludes.some(pattern => matchesPattern(normalizedPath, pattern));
    }

    // Hybrid: match includes, then apply excludes
    const included = config.includes.some(pattern => matchesPattern(normalizedPath, pattern));
    if (!included) return false;

    const excluded = config.excludes.some(pattern => matchesPattern(normalizedPath, pattern));
    return !excluded;
  }

  /**
   * Check if file should be copied based on overwrite policy
   *
   * @param sourcePath - Source file path
   * @param targetPath - Target file path
   * @param policy - Overwrite policy
   * @returns true if file should be copied
   */
  protected async shouldCopyFile(
    sourcePath: string,
    targetPath: string,
    policy: 'always' | 'never' | 'newer'
  ): Promise<boolean> {
    if (policy === 'always') return true;
    if (policy === 'never' && existsSync(targetPath)) return false;

    // 'newer' policy: compare timestamps
    if (policy === 'newer' && existsSync(targetPath)) {
      try {
        const [sourceStats, targetStats] = await Promise.all([
          stat(sourcePath),
          stat(targetPath)
        ]);
        return sourceStats.mtime > targetStats.mtime;
      } catch {
        return true; // Copy if stat fails
      }
    }

    return true; // Copy if target doesn't exist
  }

  /**
   * Write version file to track local installation
   *
   * @param targetPath - Target directory path
   * @param version - Extension version
   */
  protected async writeVersionFile(
    targetPath: string,
    version: string | null
  ): Promise<void> {
    const versionFile = join(targetPath, `${this.agentName}.extension.json`);

    const versionInfo = {
      version: version || 'unknown',
      installedAt: new Date().toISOString()
    };

    try {
      await writeFile(versionFile, JSON.stringify(versionInfo, null, 2), 'utf-8');
      logger.debug(`[${this.agentName}] Version file written: ${versionFile}`);
    } catch (error) {
      logger.warn(`[${this.agentName}] Failed to write version file: ${error}`);
    }
  }

  /**
   * Check if local extension should be updated
   *
   * Performs integrity checks before trusting version file:
   * 1. Verifies target directory exists
   * 2. Verifies directory contains actual files (not just version file)
   * 3. Compares versions only if directory is valid
   *
   * @param targetPath - Target directory path
   * @param sourceVersion - Source extension version
   * @returns true if update is needed
   */
  protected async shouldUpdateLocal(
    targetPath: string,
    sourceVersion: string
  ): Promise<boolean> {
    const versionFile = join(targetPath, `${this.agentName}.extension.json`);

    try {
      // 1. Check if target directory exists
      const dirExists = existsSync(targetPath);
      if (!dirExists) {
        logger.debug(`[${this.agentName}] Target directory doesn't exist, will install`);
        return true;
      }

      // 2. Verify directory has actual content (not just version file)
      const entries = await readdir(targetPath);
      const actualFiles = entries.filter(entry => entry !== `${this.agentName}.extension.json`);

      if (actualFiles.length === 0) {
        logger.debug(`[${this.agentName}] Target directory is empty (no files besides version), will install`);
        return true;
      }

      // 3. Now check version file (directory exists and has files)
      const content = await readFile(versionFile, 'utf-8');
      const versionInfo = JSON.parse(content);

      if (versionInfo.version === sourceVersion) {
        logger.debug(`[${this.agentName}] Local extension already at v${sourceVersion} with ${actualFiles.length} files`);
        return false;
      }

      logger.info(`[${this.agentName}] Updating local: v${versionInfo.version} → v${sourceVersion}`);
      return true;
    } catch (error) {
      // No version file, invalid JSON, or read error = first install or corrupted state
      logger.debug(`[${this.agentName}] Version check failed (${error}), will install`);
      return true;
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

        // Clean install: remove old directory to prevent stale files
        // This ensures version updates don't leave orphaned files from previous versions
        if (existsSync(targetPath)) {
          logger.info(`[${this.agentName}] Removing old installation at ${targetPath}`);
          await rm(targetPath, { recursive: true, force: true });
          logger.info(`[${this.agentName}] Old installation removed`);
        }

        // Ensure parent directory exists
        await mkdir(dirname(targetPath), { recursive: true });

        // Copy entire extension directory (clean copy to empty location)
        await cp(sourcePath, targetPath, {
          recursive: true,
          force: false, // No need for force since we deleted old directory
          errorOnExist: false
        });
        logger.info(`[${this.agentName}] Files copied successfully (clean install)`);

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

      // 7. Perform local copy to working directory (NEW)
      logger.info(`[${this.agentName}] Checking local copy configuration...`);
      const localConfig = await this.readLocalCopyFromManifest();

      if (localConfig?.enabled) {
        logger.info(`[${this.agentName}] Local copy enabled, copying to working directory...`);
        const localResult = await this.installLocal(sourcePath, localConfig);
        result.localCopy = localResult;

        if (localResult.success && localResult.copiedFiles.length > 0) {
          logger.info(
            `[${this.agentName}] Local copy: ${localResult.copiedFiles.length} files copied to ${localResult.targetPath}`
          );
        } else if (localResult.success && localResult.copiedFiles.length === 0) {
          // Check if it's "already up-to-date" or actually no files matched
          const hasSkippedFiles = localResult.skippedFiles.length > 0 &&
            localResult.skippedFiles[0] === 'All files (already up-to-date)';

          if (hasSkippedFiles) {
            logger.debug(`[${this.agentName}] Local copy: already up-to-date`);
          } else {
            logger.warn(
              `[${this.agentName}] Local copy: 0 files copied (no files matched patterns). ` +
              `Check pattern configuration in local-install.json`
            );
          }
        } else {
          logger.warn(`[${this.agentName}] Local copy failed with ${localResult.errors.length} errors`);
        }
      } else {
        logger.debug(`[${this.agentName}] Local copy not enabled, skipping`);
      }

      // 8. Return detailed result
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

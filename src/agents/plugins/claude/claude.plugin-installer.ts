/**
 * Claude Plugin Installer
 *
 * Handles automatic installation of Claude plugin to user's home directory
 * for SSO provider integration.
 *
 * Extends BaseExtensionInstaller to provide Claude-specific paths.
 * All installation logic is inherited from the base class.
 *
 * @module agents/plugins/claude/plugin-installer
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { isDeepStrictEqual } from 'util';
import { access, readFile, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getDirname } from '../../../utils/paths.js';

/**
 * Re-export result type for backward compatibility
 */
export type { ExtensionInstallationResult as PluginInstallationResult } from '../../core/extension/BaseExtensionInstaller.js';

/**
 * Claude Plugin Installer
 *
 * Installs CodeMie plugin for Claude Code to enable session tracking,
 * metrics collection, and conversation sync.
 *
 * Reduces from 260 lines to ~40 lines by extending BaseExtensionInstaller.
 */
export class ClaudePluginInstaller extends BaseExtensionInstaller {
  /**
   * Constructor
   * @param metadata - Agent metadata containing name, displayName, etc.
   */
  constructor(metadata: AgentMetadata) {
    super(metadata.name); // Pass agent name to parent
  }

  /**
   * Get the source plugin directory path
   * Works in both development and npm package contexts
   */
  protected getSourcePath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const claudePluginDir = dirname(currentFile);
    return join(claudePluginDir, 'plugin');
  }

  /**
   * Get the target installation directory
   * @returns ~/.codemie/claude-plugin
   */
  getTargetPath(): string {
    return join(homedir(), '.codemie', 'claude-plugin');
  }

  /**
   * Get the manifest file path (relative to base directory)
   * @returns .claude-plugin/plugin.json
   */
  protected getManifestPath(): string {
    return '.claude-plugin/plugin.json';
  }

  /**
   * Get list of critical files that must exist after installation
   * @returns Array of relative file paths
   */
  protected getCriticalFiles(): string[] {
    return ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'README.md'];
  }

  /**
   * Get the CodeMie CLI entry script of this package
   * @returns Absolute path of bin/codemie.js
   */
  protected getCodemieScriptPath(): string {
    return join(getDirname(import.meta.url), '../../../../bin/codemie.js');
  }

  /**
   * On Windows, keep the installed hooks file in exec form: generated from the bundled
   * hooks with the current node binary and CLI script, and written only when the
   * installed content differs. Does nothing on other platforms. Failures are logged
   * and leave the installed file as it was.
   *
   * @param targetPath - Installed plugin directory
   */
  protected async refreshInstalledHooks(targetPath: string): Promise<void> {
    if (process.platform !== 'win32') return;

    try {
      const { toExecFormHooks } = await import('../../../utils/hook-command.js');
      const scriptPath = this.getCodemieScriptPath();
      await access(scriptPath, constants.R_OK);
      const bundled: unknown = JSON.parse(
        await readFile(join(this.getSourcePath(), 'hooks', 'hooks.json'), 'utf-8')
      );
      const expected = toExecFormHooks(bundled, process.execPath, scriptPath);

      const hooksFile = join(targetPath, 'hooks', 'hooks.json');
      let installed: unknown;
      try {
        installed = JSON.parse(await readFile(hooksFile, 'utf-8'));
      } catch {
        // A missing or unparseable installed file counts as different.
      }

      if (!isDeepStrictEqual(installed, expected)) {
        await writeFile(hooksFile, JSON.stringify(expected, null, 2), 'utf-8');
        logger.info(`[${this.agentName}] Refreshed hook commands to exec form`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[${this.agentName}] Could not refresh hook commands (non-fatal): ${msg}`);
    }
  }
}

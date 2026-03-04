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
import { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { AgentMetadata } from '../../core/types.js';

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
}

/**
 * Gemini Extension Installer
 *
 * Handles automatic installation of Gemini extension to user's home directory
 * for SSO provider integration.
 *
 * Extends BaseExtensionInstaller to provide Gemini-specific paths.
 * All installation logic is inherited from the base class.
 *
 * @module agents/plugins/gemini/extension-installer
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { AgentMetadata } from '../../core/types.js';

/**
 * Gemini Extension Installer
 *
 * Installs CodeMie extension for Gemini CLI to enable session tracking,
 * metrics collection, and conversation sync.
 *
 * Reduces implementation to ~40 lines by extending BaseExtensionInstaller.
 */
export class GeminiExtensionInstaller extends BaseExtensionInstaller {
  /**
   * Constructor
   * @param metadata - Agent metadata containing name, displayName, etc.
   */
  constructor(metadata: AgentMetadata) {
    super(metadata.name); // Pass agent name to parent
  }

  /**
   * Get the source extension directory path
   * Works in both development and npm package contexts
   */
  protected getSourcePath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const geminiPluginDir = dirname(currentFile);
    return join(geminiPluginDir, 'extension');
  }

  /**
   * Get the target installation directory
   * @returns ~/.gemini/extensions/codemie
   */
  getTargetPath(): string {
    return join(homedir(), '.gemini', 'extensions', 'codemie');
  }

  /**
   * Get the manifest file path (relative to base directory)
   * @returns gemini-extension.json
   */
  protected getManifestPath(): string {
    return 'gemini-extension.json';
  }

  /**
   * Get list of critical files that must exist after installation
   * @returns Array of relative file paths
   */
  protected getCriticalFiles(): string[] {
    return ['gemini-extension.json', 'hooks/hooks.json', 'README.md'];
  }
}

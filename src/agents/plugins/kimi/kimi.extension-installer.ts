/**
 * Kimi Extension Installer
 *
 * Handles installation of the bundled CodeMie skill into Kimi's user skills
 * directory at ~/.kimi-code/skills/codemie-kimi.
 *
 * Extends BaseExtensionInstaller to provide Kimi-specific paths.
 * All installation logic is inherited from the base class.
 *
 * @module agents/plugins/kimi/extension-installer
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { AgentMetadata } from '../../core/types.js';

/**
 * Kimi Extension Installer
 *
 * Installs the bundled CodeMie skill for Kimi Code CLI.
 */
export class KimiExtensionInstaller extends BaseExtensionInstaller {
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
    return join(dirname(fileURLToPath(import.meta.url)), 'extension');
  }

  /**
   * Get the target installation directory
   * @returns ~/.kimi-code/skills/codemie-kimi
   */
  getTargetPath(): string {
    return join(homedir(), '.kimi-code', 'skills', 'codemie-kimi');
  }

  /**
   * Get the manifest file path (relative to base directory)
   * @returns manifest.json
   */
  protected getManifestPath(): string {
    return 'manifest.json';
  }

  /**
   * Get list of critical files that must exist after installation
   * @returns Array of relative file paths
   */
  protected getCriticalFiles(): string[] {
    return ['manifest.json', 'SKILL.md'];
  }
}

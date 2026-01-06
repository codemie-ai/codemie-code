/**
 * Base Framework Adapter
 *
 * Abstract base class providing common functionality for framework adapters.
 * Similar to BaseAgentAdapter pattern in src/agents/core/BaseAgentAdapter.ts
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { exec } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import type {
  FrameworkAdapter,
  FrameworkMetadata,
  FrameworkInitOptions
} from './types.js';

export abstract class BaseFrameworkAdapter implements FrameworkAdapter {
  constructor(public readonly metadata: FrameworkMetadata) {}

  /**
   * Default implementation: Check if CLI command exists
   * Override for custom installation logic
   */
  async isInstalled(): Promise<boolean> {
    if (!this.metadata.cliCommand) {
      // Frameworks without CLI (npx-on-demand) are always "installed"
      return this.metadata.installMethod === 'npx-on-demand';
    }

    try {
      // Try running version command
      const result = await exec(this.metadata.cliCommand, ['--version'], { timeout: 5000 });
      return result.code === 0;
    } catch {
      // Try 'which' command
      try {
        const result = await exec('which', [this.metadata.cliCommand], { timeout: 2000 });
        return result.code === 0;
      } catch {
        return false;
      }
    }
  }

  /**
   * Default implementation: Check for init directory
   * Override for custom detection logic
   */
  async isInitialized(cwd: string = process.cwd()): Promise<boolean> {
    if (!this.metadata.initDirectory) {
      return false;
    }

    const initPath = join(cwd, this.metadata.initDirectory);
    return existsSync(initPath);
  }

  /**
   * Default implementation: Get version from CLI
   * Override for custom version retrieval
   */
  async getVersion(): Promise<string | null> {
    if (!this.metadata.cliCommand) {
      return null;
    }

    try {
      const result = await exec(this.metadata.cliCommand, ['--version'], { timeout: 5000 });
      // Extract version number from output
      const match = result.stdout.match(/\d+\.\d+\.\d+/);
      return match ? match[0] : result.stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Default implementation: No agent mapping (framework-agnostic)
   * Override for agent-specific frameworks
   */
  getAgentMapping(codemieAgentName: string): string | null {
    // Default: no mapping, use agent name as-is
    return codemieAgentName;
  }

  /**
   * Install framework CLI - must be implemented by subclasses
   */
  abstract install(): Promise<void>;

  /**
   * Uninstall framework CLI - must be implemented by subclasses
   */
  abstract uninstall(): Promise<void>;

  /**
   * Initialize framework - must be implemented by subclasses
   */
  abstract init(agentName: string, options?: FrameworkInitOptions): Promise<void>;

  /**
   * Helper: Log installation start
   */
  protected logInstallStart(): void {
    logger.info(`Installing ${this.metadata.displayName}...`);
  }

  /**
   * Helper: Log installation success
   */
  protected logInstallSuccess(version?: string): void {
    const versionStr = version ? ` (v${version})` : '';
    logger.success(`${this.metadata.displayName} installed successfully${versionStr}`);
  }

  /**
   * Helper: Log installation error
   */
  protected logInstallError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to install ${this.metadata.displayName}: ${message}`);
  }

  /**
   * Helper: Log uninstallation start
   */
  protected logUninstallStart(): void {
    logger.info(`Uninstalling ${this.metadata.displayName}...`);
  }

  /**
   * Helper: Log uninstallation success
   */
  protected logUninstallSuccess(): void {
    logger.success(`${this.metadata.displayName} uninstalled successfully`);
  }

  /**
   * Helper: Log uninstallation error
   */
  protected logUninstallError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to uninstall ${this.metadata.displayName}: ${message}`);
  }

  /**
   * Helper: Log initialization start
   */
  protected logInitStart(agentName?: string): void {
    const agentStr = agentName ? ` for ${agentName}` : '';
    logger.info(`Initializing ${this.metadata.displayName}${agentStr}...`);
  }

  /**
   * Helper: Log initialization success
   */
  protected logInitSuccess(directory: string): void {
    logger.success(`${this.metadata.displayName} initialized in ${directory}`);
  }

  /**
   * Helper: Log initialization error
   */
  protected logInitError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to initialize ${this.metadata.displayName}: ${message}`);
  }

  /**
   * Helper: Check if agent is supported
   */
  protected isAgentSupported(agentName: string): boolean {
    if (!this.metadata.supportedAgents || this.metadata.supportedAgents.length === 0) {
      return true; // Framework supports all agents
    }
    return this.metadata.supportedAgents.includes(agentName);
  }

  /**
   * Helper: Throw error if agent not supported
   */
  protected assertAgentSupported(agentName: string): void {
    if (!this.isAgentSupported(agentName)) {
      throw new Error(
        `Agent '${agentName}' is not supported by ${this.metadata.displayName}. ` +
        `Supported agents: ${this.metadata.supportedAgents?.join(', ') || 'none'}`
      );
    }
  }
}

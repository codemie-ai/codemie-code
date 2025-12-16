/**
 * BMAD Framework Plugin
 *
 * Integration for BMAD (Business Methodology for Agile Development)
 * Enterprise development methodology with AI agent support
 *
 * Installation: npx-on-demand (no global install needed)
 * Initialization: npx bmad-method@alpha install
 */

import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';
import { BaseFrameworkAdapter } from '../core/BaseFrameworkAdapter.js';
import type { FrameworkMetadata, FrameworkInitOptions } from '../core/types.js';

/**
 * BMAD Framework Metadata
 */
export const BmadMetadata: FrameworkMetadata = {
  name: 'bmad',
  displayName: 'BMAD Method',
  description: 'Business Methodology for Agile Development with AI agents',
  docsUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
  repoUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
  requiresInstallation: false, // Uses npx on-demand
  installMethod: 'npx-on-demand',
  packageName: 'bmad-method@alpha',
  cliCommand: undefined, // No global CLI, uses npx
  isAgentSpecific: false, // Framework-agnostic
  supportedAgents: [], // Empty means all agents
  initDirectory: '.bmad'
};

/**
 * BMAD Framework Plugin
 */
export class BmadPlugin extends BaseFrameworkAdapter {
  constructor() {
    super(BmadMetadata);
  }

  /**
   * Install BMAD - Not needed (npx-on-demand)
   */
  async install(): Promise<void> {
    logger.info('BMAD uses npx on-demand. No installation required.');
    logger.info('Run initialization with: codemie-<agent> init bmad');
  }

  /**
   * Uninstall BMAD - Not needed (npx-on-demand)
   */
  async uninstall(): Promise<void> {
    logger.info('BMAD uses npx on-demand. Nothing to uninstall.');
    logger.info('To remove BMAD from a project, delete the .bmad/ directory.');
  }

  /**
   * Initialize BMAD in current directory
   */
  async init(agentName: string, options?: FrameworkInitOptions): Promise<void> {
    const cwd = options?.cwd || process.cwd();
    const force = options?.force ?? false;

    // Check if already initialized
    if (!force && (await this.isInitialized(cwd))) {
      throw new Error(
        `BMAD already initialized in ${cwd} (.bmad/ exists). Use --force to re-initialize.`
      );
    }

    this.logInitStart();

    try {
      // Run npx bmad-method@alpha install
      logger.info('Running BMAD installation via npx (this may take a minute)...');

      const args = ['bmad-method@alpha', 'install'];

      // Add --force if specified
      if (force) {
        args.push('--force');
      }

      await exec('npx', args, {
        cwd,
        timeout: 300000, // 5 minutes for npm download + user input
        interactive: true // Allow user to answer prompts
      });

      this.logInitSuccess(cwd);
      logger.info('Next: Run /workflow-init inside your AI agent to start using BMAD');
    } catch (error) {
      this.logInitError(error);
      throw error;
    }
  }

  /**
   * Check if BMAD is installed - always true (npx-on-demand)
   */
  async isInstalled(): Promise<boolean> {
    // BMAD doesn't require installation, npx handles it on-demand
    return true;
  }

  /**
   * Get BMAD version
   */
  async getVersion(): Promise<string | null> {
    try {
      const result = await exec('npx', ['bmad-method@alpha', '--version'], { timeout: 10000 });
      const match = result.stdout.match(/\d+\.\d+\.\d+/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Get agent mapping - framework-agnostic, all agents supported
   */
  getAgentMapping(codemieAgentName: string): string | null {
    // BMAD is framework-agnostic, no specific mapping needed
    return codemieAgentName;
  }
}

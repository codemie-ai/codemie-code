/**
 * BMAD Framework Plugin
 *
 * Integration for BMAD (Business Methodology for Agile Development)
 * Enterprise development methodology with AI agent support
 *
 * Installation: npx-on-demand (no global install needed)
 * Initialization: npx bmad-method@alpha install
 */

import { existsSync } from 'fs';
import { join } from 'path';
import * as npm from '../../utils/processes.js';
import { exec } from '../../utils/processes.js';
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
  initDirectory: '_bmad' // Primary directory, but we check for .bmad too
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
   * Check if BMAD is initialized (checks both .bmad and configured init directory)
   */
  async isInitialized(cwd: string = process.cwd()): Promise<boolean> {
    const dotBmadExists = existsSync(join(cwd, '.bmad'));
    const initDirExists = this.metadata.initDirectory 
      ? existsSync(join(cwd, this.metadata.initDirectory))
      : false;
      
    return dotBmadExists || initDirExists;
  }

  /**
   * Uninstall BMAD - Remove .bmad or configured init directory if initialized
   */
  async uninstall(): Promise<void> {
    const cwd = process.cwd();
    const { rm } = await import('fs/promises');

    let removed = false;

    // Check and remove .bmad
    const dotBmad = join(cwd, '.bmad');
    if (existsSync(dotBmad)) {
      await rm(dotBmad, { recursive: true, force: true });
      logger.info(`Removed ${dotBmad}`);
      removed = true;
    }

    // Check and remove configured init directory (e.g. _bmad) if different from .bmad
    if (this.metadata.initDirectory && this.metadata.initDirectory !== '.bmad') {
      const initDir = join(cwd, this.metadata.initDirectory);
      if (existsSync(initDir)) {
        await rm(initDir, { recursive: true, force: true });
        logger.info(`Removed ${initDir}`);
        removed = true;
      }
    }

    if (!removed) {
      logger.info('BMAD is not initialized in the current directory.');
    }
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
        `BMAD already initialized in ${cwd} (.bmad/ or _bmad/ exists). Use --force to re-initialize.`
      );
    }

    this.logInitStart();

    try {
      // Run npx bmad-method@alpha install
      logger.info('Running BMAD installation via npx (this may take a minute)...');

      await npm.npxRun('bmad-method@alpha', ['install', ...(force ? ['--force'] : [])], {
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
   * Check if BMAD is installed or initialized
   * For npx-on-demand frameworks, check if initialized in current project
   */
  async isInstalled(): Promise<boolean> {
    // Check if initialized in current directory
    const isInit = await this.isInitialized(process.cwd());

    if (isInit) {
      return true;
    }

    // Check if bmad-method is globally installed via npm
    return await npm.listGlobal('bmad-method');
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

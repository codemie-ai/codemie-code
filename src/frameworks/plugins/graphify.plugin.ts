/**
 * Graphify Documentation Tool Plugin
 *
 * Integration for Graphify (https://github.com/safishamsi/graphify) — builds a
 * queryable knowledge graph from a codebase (tree-sitter AST + Claude for docs
 * and images) and ships it as a Claude Code skill (`/graphify`).
 *
 * Note: the PyPI package is temporarily named `graphifyy` while the `graphify`
 * name is being reclaimed; the CLI command is `graphify`.
 */

import { commandExists, exec } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import { BaseFrameworkAdapter } from '../core/BaseFrameworkAdapter.js';
import type { FrameworkInitOptions, FrameworkMetadata } from '../core/types.js';

const PIP_PACKAGE = 'graphifyy';

export const GraphifyMetadata: FrameworkMetadata = {
  name: 'graphify',
  displayName: 'Graphify',
  description: 'Queryable knowledge graph for your codebase, docs and images (Claude Code skill)',
  docsUrl: 'https://github.com/safishamsi/graphify',
  repoUrl: 'https://github.com/safishamsi/graphify',
  requiresInstallation: true,
  installMethod: 'pip',
  packageName: PIP_PACKAGE,
  cliCommand: 'graphify',
  isAgentSpecific: true,
  supportedAgents: ['claude'],
  initDirectory: 'graphify-out',
  group: 'documentation',
};

export class GraphifyPlugin extends BaseFrameworkAdapter {
  constructor() {
    super(GraphifyMetadata);
  }

  async install(): Promise<void> {
    this.logInstallStart();

    try {
      // pipx keeps the CLI isolated and handles PATH on macOS/Windows;
      // fall back to a user-level pip install when pipx is unavailable.
      if (await commandExists('pipx')) {
        await exec('pipx', ['install', PIP_PACKAGE], { timeout: 300000 });
      } else if (await commandExists('pip3')) {
        await exec('pip3', ['install', '--user', PIP_PACKAGE], { timeout: 300000 });
      } else {
        throw new Error('Neither pipx nor pip3 found. Install Python 3.10+ first.');
      }

      const version = await this.getVersion();
      this.logInstallSuccess(version || undefined);
    } catch (error) {
      this.logInstallError(error);
      throw error;
    }
  }

  async uninstall(): Promise<void> {
    this.logUninstallStart();

    try {
      if (await commandExists('pipx')) {
        await exec('pipx', ['uninstall', PIP_PACKAGE], { timeout: 120000 });
      } else {
        await exec('pip3', ['uninstall', '-y', PIP_PACKAGE], { timeout: 120000 });
      }
      this.logUninstallSuccess();
    } catch (error) {
      this.logUninstallError(error);
      throw error;
    }
  }

  async init(agentName: string, options?: FrameworkInitOptions): Promise<void> {
    const cwd = options?.cwd || process.cwd();

    this.assertAgentSupported(agentName);
    this.logInitStart(agentName);

    if (!(await this.isInstalled())) {
      logger.warn('Graphify not found. Installing...');
      await this.install();
    }

    try {
      // Installs the /graphify skill into Claude Code (global, idempotent)
      await exec('graphify', ['install'], { cwd, timeout: 60000 });

      this.logInitSuccess(cwd);
      logger.info('Next step: open Claude Code in this directory and run: /graphify .');
    } catch (error) {
      this.logInitError(error);
      throw error;
    }
  }
}

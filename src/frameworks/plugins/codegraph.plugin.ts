/**
 * CodeGraph Documentation Tool Plugin
 *
 * Integration for @colbymchenry/codegraph — local-first code intelligence
 * (knowledge graph + MCP server) for AI agents. Deterministic local tooling;
 * no model access required, so it is a documentation tool, not an agent.
 */

import { exec, installGlobal } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import { BaseFrameworkAdapter } from '../core/BaseFrameworkAdapter.js';
import type { FrameworkInitOptions, FrameworkMetadata } from '../core/types.js';

const NPM_PACKAGE = '@colbymchenry/codegraph';

export const CodegraphMetadata: FrameworkMetadata = {
  name: 'codegraph',
  displayName: 'CodeGraph',
  description: 'Local-first code intelligence graph and MCP server for AI agents',
  docsUrl: 'https://www.npmjs.com/package/@colbymchenry/codegraph',
  requiresInstallation: true,
  installMethod: 'npm',
  packageName: NPM_PACKAGE,
  cliCommand: 'codegraph',
  isAgentSpecific: false,
  supportedAgents: [],
  initDirectory: '.codegraph',
  group: 'documentation',
};

export class CodegraphPlugin extends BaseFrameworkAdapter {
  constructor() {
    super(CodegraphMetadata);
  }

  async install(): Promise<void> {
    this.logInstallStart();

    try {
      await installGlobal(NPM_PACKAGE);
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
      await exec('npm', ['uninstall', '-g', NPM_PACKAGE], { timeout: 120000 });
      this.logUninstallSuccess();
    } catch (error) {
      this.logUninstallError(error);
      throw error;
    }
  }

  async init(_agentName: string, options?: FrameworkInitOptions): Promise<void> {
    const cwd = options?.cwd || process.cwd();

    this.logInitStart();

    if (!(await this.isInstalled())) {
      logger.warn('CodeGraph not found. Installing...');
      await this.install();
    }

    try {
      // Builds the initial index and creates .codegraph/ in the project
      await exec('codegraph', ['init', cwd], { cwd, timeout: 600000 });

      this.logInitSuccess(cwd);
      logger.info('Next steps:');
      logger.info('  - Wire the MCP server into your agents: codegraph install');
      logger.info('  - Refresh the index after changes: codegraph sync');
    } catch (error) {
      this.logInitError(error);
      throw error;
    }
  }
}

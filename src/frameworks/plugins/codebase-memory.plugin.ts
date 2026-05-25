/**
 * Codebase Memory MCP Framework Plugin
 *
 * Integration for DeusData/codebase-memory-mcp with the graph visualization UI.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { exec, commandExists } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import { BaseFrameworkAdapter } from '../core/BaseFrameworkAdapter.js';
import type { FrameworkInitOptions, FrameworkMetadata } from '../core/types.js';

const INSTALLER_URL = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh';
const WINDOWS_INSTALLER_URL = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1';

export const CodebaseMemoryMetadata: FrameworkMetadata = {
  name: 'codebase-memory',
  displayName: 'Codebase Memory MCP',
  description: 'Persistent code intelligence graph with MCP tools and 3D visualization UI',
  docsUrl: 'https://github.com/DeusData/codebase-memory-mcp',
  repoUrl: 'https://github.com/DeusData/codebase-memory-mcp',
  requiresInstallation: true,
  installMethod: 'manual',
  packageName: 'codebase-memory-mcp',
  cliCommand: 'codebase-memory-mcp',
  isAgentSpecific: false,
  supportedAgents: [],
  initDirectory: '.codebase-memory',
};

export class CodebaseMemoryPlugin extends BaseFrameworkAdapter {
  constructor() {
    super(CodebaseMemoryMetadata);
  }

  async install(): Promise<void> {
    this.logInstallStart();

    try {
      if (process.platform === 'win32') {
        await exec(
          'powershell',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `$installer = Join-Path $env:TEMP 'codebase-memory-install.ps1'; ` +
              `Invoke-WebRequest -Uri '${WINDOWS_INSTALLER_URL}' -OutFile $installer; ` +
              `& $installer --ui`,
          ],
          { timeout: 300000 }
        );
      } else {
        await exec(
          'bash',
          ['-c', `curl -fsSL ${INSTALLER_URL} | bash -s -- --ui`],
          { timeout: 300000 }
        );
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
      await exec('codebase-memory-mcp', ['uninstall'], { timeout: 60000 });
      this.logUninstallSuccess();
      logger.info('The codebase-memory-mcp binary and local graph databases were left in place.');
    } catch (error) {
      this.logUninstallError(error);
      throw error;
    }
  }

  async init(agentName: string, options?: FrameworkInitOptions): Promise<void> {
    const cwd = options?.cwd || process.cwd();

    this.logInitStart(agentName);

    if (!(await this.isInstalled())) {
      logger.warn('Codebase Memory MCP not found. Installing the UI variant...');
      await this.install();
    }

    try {
      await exec('codebase-memory-mcp', ['install', '-y'], {
        cwd,
        timeout: 120000,
      });
      await exec('codebase-memory-mcp', ['config', 'set', 'auto_index', 'true'], {
        cwd,
        timeout: 30000,
      });
      await exec(
        'codebase-memory-mcp',
        ['cli', 'index_repository', JSON.stringify({ repo_path: cwd })],
        {
          cwd,
          timeout: 300000,
        }
      );

      this.logInitSuccess(cwd);
      logger.info('Open the graph UI with: codemie codebase ui');
    } catch (error) {
      this.logInitError(error);
      throw error;
    }
  }

  async isInitialized(cwd: string = process.cwd()): Promise<boolean> {
    if (existsSync(join(cwd, '.codebase-memory'))) {
      return true;
    }

    if (!(await this.isInstalled())) {
      return false;
    }

    try {
      const result = await exec(
        'codebase-memory-mcp',
        ['cli', 'index_status', JSON.stringify({ repo_path: cwd })],
        { cwd, timeout: 10000 }
      );
      return result.code === 0 && /indexed|ready|complete|success/i.test(result.stdout);
    } catch {
      return false;
    }
  }

  async isInstalled(): Promise<boolean> {
    if (!(await commandExists('codebase-memory-mcp'))) {
      return false;
    }

    try {
      const result = await exec('codebase-memory-mcp', ['--help'], { timeout: 5000 });
      const helpText = `${result.stdout}\n${result.stderr}`;
      if (result.code !== 0 || !/--ui|ui=true|graph visualization/i.test(helpText)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  getAgentMapping(codemieAgentName: string): string | null {
    return codemieAgentName;
  }
}

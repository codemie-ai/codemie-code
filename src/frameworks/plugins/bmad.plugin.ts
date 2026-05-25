/**
 * BMAD Framework Plugin
 *
 * Integration for BMAD (Business Methodology for Agile Development)
 * Enterprise development methodology with AI agent support
 *
 * Installation: npx-on-demand (no global install needed)
 * Initialization: npx bmad-method install --yes --modules bmm,tea --tools <tool>
 */

import { existsSync } from 'fs';
import { join } from 'path';
import * as npm from '../../utils/processes.js';
import { exec } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import { BaseFrameworkAdapter } from '../core/BaseFrameworkAdapter.js';
import type { FrameworkMetadata, FrameworkInitOptions } from '../core/types.js';

type BmadPreset = 'sdlc' | 'minimal' | 'interactive';

const DEFAULT_OUTPUT_FOLDER = '_bmad-output';

const BMAD_TOOL_MAPPING: Record<string, string> = {
  claude: 'claude-code',
  'claude-acp': 'claude-code',
  codex: 'codex',
  'codemie-code': 'opencode',
  gemini: 'gemini',
  opencode: 'opencode',
};

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
  packageName: 'bmad-method',
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
    const initialized = await this.isInitialized(cwd);

    // Check if already initialized
    if (!force && initialized) {
      throw new Error(
        `BMAD already initialized in ${cwd} (.bmad/ or _bmad/ exists). Use --force to re-initialize.`
      );
    }

    this.logInitStart();

    try {
      let preset = this.getPreset(options);
      if (preset !== 'interactive' && !this.hasToolSelection(agentName, options)) {
        logger.warn(
          `BMAD tool mapping for agent '${agentName}' is unknown. Falling back to interactive install.`
        );
        preset = 'interactive';
      }
      const packageName = this.getPackageName(options);
      const args = this.buildInstallArgs(agentName, cwd, preset, options, initialized && force);
      const interactive = preset === 'interactive';

      logger.info(
        interactive
          ? 'Running BMAD interactive installation via npx (this may take a minute)...'
          : `Running BMAD ${preset} preset via npx (this may take a minute)...`
      );

      await npm.npxRun(packageName, args, {
        cwd,
        timeout: 300000, // 5 minutes for npm download + user input
        interactive
      });

      this.logInitSuccess(cwd);
      logger.info('Next: Run bmad-help inside your AI agent to start using BMAD');
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
      const result = await exec('npx', ['bmad-method', '--version'], { timeout: 10000 });
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

  private buildInstallArgs(
    agentName: string,
    cwd: string,
    preset: BmadPreset,
    options: FrameworkInitOptions | undefined,
    updateExisting: boolean
  ): string[] {
    if (preset === 'interactive') {
      return ['install'];
    }

    const modules = this.getModules(preset, options);
    const tools = this.getTools(agentName, options);
    const setValues = this.getSetValues(options);

    const args = [
      'install',
      '--yes',
      '--directory',
      cwd,
      '--modules',
      modules,
      '--tools',
      tools,
    ];

    if (updateExisting) {
      args.push('--action', 'update');
    }

    for (const value of setValues) {
      args.push('--set', value);
    }

    return args;
  }

  private getPreset(options: FrameworkInitOptions | undefined): BmadPreset {
    const preset = options?.preset;
    if (preset === 'minimal' || preset === 'interactive' || preset === 'sdlc') {
      return preset;
    }
    return 'sdlc';
  }

  private getPackageName(options: FrameworkInitOptions | undefined): string {
    const channel = options?.bmadChannel;
    if (channel === 'next') {
      return 'bmad-method@next';
    }
    return 'bmad-method';
  }

  private getModules(preset: BmadPreset, options: FrameworkInitOptions | undefined): string {
    const modules = this.asString(options?.bmadModules);
    if (modules) {
      return modules;
    }

    return preset === 'minimal' ? 'bmm' : 'bmm,tea';
  }

  private getTools(agentName: string, options: FrameworkInitOptions | undefined): string {
    const tools = this.asString(options?.bmadTools);
    if (tools) {
      return tools;
    }

    const mappedTool = BMAD_TOOL_MAPPING[agentName];
    if (!mappedTool) {
      throw new Error(
        `BMAD tool mapping for agent '${agentName}' is unknown. ` +
        'Pass --bmad-tools <tool-id> or use --interactive to select a tool manually.'
      );
    }

    return mappedTool;
  }

  private hasToolSelection(agentName: string, options: FrameworkInitOptions | undefined): boolean {
    return Boolean(this.asString(options?.bmadTools) || BMAD_TOOL_MAPPING[agentName]);
  }

  private getSetValues(options: FrameworkInitOptions | undefined): string[] {
    const configured = this.asStringArray(options?.bmadSet);
    if (configured.length > 0) {
      return configured;
    }
    return [`core.output_folder=${DEFAULT_OUTPUT_FOLDER}`];
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }

    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }

    return [];
  }
}

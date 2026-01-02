/**
 * SpecKit Framework Plugin
 *
 * Integration for GitHub's SpecKit framework - spec-driven development toolkit
 * https://github.com/github/spec-kit
 *
 * Installation: uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
 * Initialization: specify init <project> --ai <agent> --here --script <sh|ps> --force
 */

import { platform } from 'os';
import { exec } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import { BaseFrameworkAdapter } from '../core/BaseFrameworkAdapter.js';
import type { FrameworkMetadata, FrameworkInitOptions } from '../core/types.js';

/**
 * SpecKit Framework Metadata
 */
export const SpeckitMetadata: FrameworkMetadata = {
  name: 'speckit',
  displayName: 'SpecKit',
  description: 'GitHub\'s spec-driven development toolkit',
  docsUrl: 'https://github.com/github/spec-kit',
  repoUrl: 'https://github.com/github/spec-kit',
  requiresInstallation: true,
  installMethod: 'uv',
  packageName: 'specify-cli',
  cliCommand: 'specify',
  isAgentSpecific: true,
  supportedAgents: ['claude', 'codex', 'gemini'], // Per tech-spec: not supported for codemie-code, deepagents
  initDirectory: '.specify' // SpecKit creates .specify/ directory, not .speckit/
};

/**
 * Agent name mapping: CodeMie → SpecKit
 */
const AGENT_MAPPING: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini'
};

/**
 * SpecKit Framework Plugin
 */
export class SpeckitPlugin extends BaseFrameworkAdapter {
  constructor() {
    super(SpeckitMetadata);
  }

  /**
   * Install SpecKit CLI via uv
   */
  async install(): Promise<void> {
    this.logInstallStart();

    try {
      // Check if uv is installed
      const hasUv = await this.checkUvInstalled();
      if (!hasUv) {
        throw new Error(
          'uv is not installed. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh'
        );
      }

      // Check if git is installed (required by uv tool install --from git+...)
      const hasGit = await this.checkGitInstalled();
      if (!hasGit) {
        throw new Error('git is not installed. SpecKit installation requires git.');
      }

      // Install via uv tool install
      logger.info('Installing SpecKit via uv (this may take a minute)...');
      await exec(
        'uv',
        ['tool', 'install', 'specify-cli', '--from', 'git+https://github.com/github/spec-kit.git'],
        { timeout: 120000 } // 2 minutes timeout for git clone + install
      );

      const version = await this.getVersion();
      this.logInstallSuccess(version || undefined);
    } catch (error) {
      this.logInstallError(error);
      throw error;
    }
  }

  /**
   * Uninstall SpecKit CLI via uv
   */
  async uninstall(): Promise<void> {
    this.logUninstallStart();

    try {
      // Check if uv is installed
      const hasUv = await this.checkUvInstalled();
      if (!hasUv) {
        throw new Error('uv is not installed. Cannot uninstall SpecKit.');
      }

      // Uninstall via uv tool uninstall
      await exec('uv', ['tool', 'uninstall', 'specify-cli'], { timeout: 30000 });

      this.logUninstallSuccess();
    } catch (error) {
      this.logUninstallError(error);
      throw error;
    }
  }

  /**
   * Initialize SpecKit in current directory
   */
  async init(agentName: string, options?: FrameworkInitOptions): Promise<void> {
    this.assertAgentSupported(agentName);

    const cwd = options?.cwd || process.cwd();
    const force = options?.force ?? false;

    // Check if already initialized
    if (!force && (await this.isInitialized(cwd))) {
      throw new Error(
        `SpecKit already initialized in ${cwd} (.specify/ exists). Use --force to re-initialize.`
      );
    }

    // Ensure SpecKit CLI is installed
    const installed = await this.isInstalled();
    let specifyCommand = 'specify';

    if (!installed) {
      logger.warn('SpecKit CLI not found. Installing...');
      await this.install();

      // After installation, use full path since PATH may not be updated
      const { homedir } = await import('os');
      const { join } = await import('path');
      specifyCommand = join(homedir(), '.local', 'bin', 'specify');
    }

    this.logInitStart(agentName);

    try {
      // Get framework agent name
      const frameworkAgent = this.getAgentMapping(agentName);
      if (!frameworkAgent) {
        throw new Error(`Agent '${agentName}' is not supported by SpecKit`);
      }

      // Detect OS for script type
      const scriptType = this.detectScriptType();

      // Build specify init command
      // Note: When using --here, we don't provide a project name
      const args = [
        'init',
        '--here', // Initialize in current directory
        '--ai',
        frameworkAgent,
        '--script',
        scriptType,
        '--force' // Always force to avoid interactive prompts
      ];

      // Run specify init (use full path if just installed)
      await exec(specifyCommand, args, { cwd, timeout: 60000 });

      this.logInitSuccess(cwd);
    } catch (error) {
      this.logInitError(error);
      throw error;
    }
  }

  /**
   * Get agent name mapping
   */
  getAgentMapping(codemieAgentName: string): string | null {
    return AGENT_MAPPING[codemieAgentName] || null;
  }

  /**
   * Override: SpecKit doesn't support --version
   * Check installation via `specify --help` instead
   */
  async isInstalled(): Promise<boolean> {
    try {
      const result = await exec('specify', ['--help'], { timeout: 5000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Override: SpecKit uses `specify version` command instead of --version flag
   */
  async getVersion(): Promise<string | null> {
    try {
      const result = await exec('specify', ['version'], { timeout: 5000 });
      if (result.code === 0 && result.stdout) {
        // Extract version from output
        const match = result.stdout.match(/Version:\s*(\S+)/i) || result.stdout.match(/(\d+\.\d+\.\d+)/);
        return match ? match[1] : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if uv is installed
   */
  private async checkUvInstalled(): Promise<boolean> {
    try {
      await exec('uv', ['--version'], { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if git is installed
   */
  private async checkGitInstalled(): Promise<boolean> {
    try {
      await exec('git', ['--version'], { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect script type based on OS
   */
  private detectScriptType(): 'sh' | 'ps' {
    const os = platform();
    return os === 'win32' ? 'ps' : 'sh';
  }
}

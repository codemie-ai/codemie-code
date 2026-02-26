import { AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { ClaudeSessionAdapter } from './claude.session.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { ClaudePluginInstaller } from './claude.plugin-installer.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { installNativeAgent } from '../../../utils/native-installer.js';
import { isValidSemanticVersion } from '../../../utils/version-utils.js';
import {
  AgentInstallationError,
  createErrorContext,
  getErrorMessage,
} from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import chalk from 'chalk';
import { resolveHomeDir, getDirname } from '../../../utils/paths.js';
import {
  detectInstallationMethod,
  type InstallationMethod,
} from '../../../utils/installation-detector.js';

// Module-level flag to track statusline management within a session.
// Using module scope (not env var) avoids leaking internal state into subprocess environments.
let statuslineManagedThisSession = false;

/**
 * Supported Claude Code version
 * Latest version tested and verified with CodeMie backend
 *
 * **UPDATE THIS WHEN BUMPING CLAUDE VERSION**
 */
const CLAUDE_SUPPORTED_VERSION = '2.1.56';

/**
 * Minimum supported Claude Code version
 * Versions below this are known to be incompatible and will be blocked from starting
 * Rule: always 10 patch versions below CLAUDE_SUPPORTED_VERSION
 * e.g. supported = 2.1.56 → minimum = 2.1.41
 *
 * **UPDATE THIS WHEN BUMPING CLAUDE VERSION**
 */
const CLAUDE_MINIMUM_SUPPORTED_VERSION = '2.1.41';

/**
 * Claude Code installer URLs
 * Official Anthropic installer scripts for native installation
 */
const CLAUDE_INSTALLER_URLS = {
  macOS: 'https://claude.ai/install.sh',
  windows: 'https://claude.ai/install.cmd',
  linux: 'https://claude.ai/install.sh',
};

/**
 * Claude Code Plugin Metadata
 */
export const ClaudePluginMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Claude Code - official Anthropic CLI tool',

  npmPackage: '@anthropic-ai/claude-code',
  cliCommand: 'claude',

  // Version management configuration
  supportedVersion: CLAUDE_SUPPORTED_VERSION,       // Latest version tested with CodeMie backend
  minimumSupportedVersion: CLAUDE_MINIMUM_SUPPORTED_VERSION, // Minimum version required to run

  // Native installer URLs (used by installNativeAgent utility)
  installerUrls: CLAUDE_INSTALLER_URLS,

  // Data paths (used by lifecycle hooks and analytics)
  dataPaths: {
    home: '.claude',
  },

  envMapping: {
    baseUrl: ['ANTHROPIC_BASE_URL'],
    apiKey: ['ANTHROPIC_AUTH_TOKEN'],
    model: ['ANTHROPIC_MODEL'],
    haikuModel: ['ANTHROPIC_DEFAULT_HAIKU_MODEL'],
    sonnetModel: ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'],
    opusModel: ['ANTHROPIC_DEFAULT_OPUS_MODEL'],
  },

  supportedProviders: ['litellm', 'ai-run-sso', 'bedrock'],
  blockedModelPatterns: [],
  recommendedModels: ['claude-4-5-sonnet', 'claude-4-opus', 'gpt-4.1'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-claude',
  },

  flagMappings: {
    '--task': {
      type: 'flag',
      target: '-p',
    },
  },

  // Metrics configuration: exclude Bash tool errors from API metrics
  metricsConfig: {
    excludeErrorsFromTools: ['Bash'],
  },

  // MCP configuration paths for Claude Code
  // - Local: ~/.claude.json → projects[cwd].mcpServers (project-specific, private)
  // - Project: .mcp.json → mcpServers (shared with team)
  // - User: ~/.claude.json → mcpServers (top-level, available across all projects)
  mcpConfig: {
    local: {
      path: '~/.claude.json',
      jsonPath: 'projects.{cwd}.mcpServers',
    },
    project: {
      path: '.mcp.json',
      jsonPath: 'mcpServers',
    },
    user: {
      path: '~/.claude.json',
      jsonPath: 'mcpServers',
    },
  },

  lifecycle: {
    // Default hooks for ALL providers (provider-agnostic)
    async beforeRun(env) {
      // Disable experimental betas if not already set
      if (!env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) {
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
      }

      // Disable Claude Code telemetry to prevent 404s on /api/event_logging/batch
      // when using proxy (telemetry endpoint doesn't exist on CodeMie backend)
      // https://code.claude.com/docs/en/settings
      if (!env.CLAUDE_CODE_ENABLE_TELEMETRY) {
        env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
      }

      // CRITICAL: Disable Claude Code auto-updater to maintain version control
      // CodeMie manages Claude versions explicitly via installVersion() for compatibility
      // Auto-updates could break version compatibility with CodeMie backend
      // https://code.claude.com/docs/en/settings
      if (!env.DISABLE_AUTOUPDATER) {
        env.DISABLE_AUTOUPDATER = '1';
      }

      // Statusline setup: when --status flag is passed, configure Claude Code
      // status bar with a multi-line display showing model, context, git, cost
      // https://code.claude.com/docs/en/statusline
      if (env.CODEMIE_STATUS === '1') {
        const { writeFile, readFile, mkdir, chmod } = await import('fs/promises');
        const { existsSync } = await import('fs');
        const { join } = await import('path');

        const claudeHome = resolveHomeDir('.claude');
        const scriptPath = join(claudeHome, 'codemie-statusline.mjs');
        const settingsPath = join(claudeHome, 'settings.json');

        // Read the statusline script from the compiled output directory
        const scriptContent = await readFile(
          join(getDirname(import.meta.url), 'plugin/codemie-statusline.mjs'),
          'utf-8'
        );

        // Ensure ~/.claude directory exists
        if (!existsSync(claudeHome)) {
          await mkdir(claudeHome, { recursive: true });
        }

        // Write script (always update to latest version)
        await writeFile(scriptPath, scriptContent, 'utf-8');

        // Make script executable on Unix systems
        if (process.platform !== 'win32') {
          await chmod(scriptPath, 0o755);
        }

        // Inject statusLine into ~/.claude/settings.json if not already configured
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          try {
            const raw = await readFile(settingsPath, 'utf-8');
            settings = JSON.parse(raw) as Record<string, unknown>;
          } catch (parseError) {
            // Abort injection to prevent overwriting potentially valid settings
            // that are temporarily unreadable (e.g., concurrent write, partial flush)
            logger.warn(
              '[Claude] Could not parse settings.json, skipping statusline injection to avoid data loss',
              ...sanitizeLogArgs({
                settingsPath,
                error: parseError instanceof Error ? parseError.message : String(parseError),
              })
            );
            return env;
          }
        }

        if (!settings.statusLine) {
          settings.statusLine = {
            type: 'command',
            // Quote the path to handle spaces in home directory (e.g. /Users/John Doe/)
            command: `node "${scriptPath}"`,
          };
          await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
          // Use module-level flag (not env var) to avoid leaking into subprocess env
          statuslineManagedThisSession = true;
          logger.debug('[Claude] Statusline configured', { scriptPath });
        }
      }

      return env;
    },

    // Clean up injected statusLine from settings.json after the session ends
    async afterRun(_exitCode, _env) {
      if (!statuslineManagedThisSession) return;
      statuslineManagedThisSession = false;

      const { readFile, writeFile } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const { join } = await import('path');

      const settingsPath = join(resolveHomeDir('.claude'), 'settings.json');

      if (existsSync(settingsPath)) {
        try {
          const raw = await readFile(settingsPath, 'utf-8');
          const settings = JSON.parse(raw) as Record<string, unknown>;

          if (settings.statusLine) {
            delete settings.statusLine;
            await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            logger.debug('[Claude] Statusline config removed from settings.json');
          }
        } catch (error) {
          logger.warn(
            '[Claude] Failed to clean up statusLine from settings.json',
            ...sanitizeLogArgs({
              settingsPath,
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      }
    },
  },
};

/**
 * Claude Code Adapter
 */
export class ClaudePlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;
  private extensionInstaller: BaseExtensionInstaller;

  constructor() {
    super(ClaudePluginMetadata);
    // Initialize session adapter with metadata for unified session sync
    this.sessionAdapter = new ClaudeSessionAdapter(ClaudePluginMetadata);
    // Initialize extension installer with metadata (agent name from metadata)
    this.extensionInstaller = new ClaudePluginInstaller(ClaudePluginMetadata);
  }

  /**
   * Get session adapter for this agent (used by unified session sync)
   */
  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /**
   * Get extension installer for this agent
   * Returns installer to handle plugin installation
   */
  getExtensionInstaller(): BaseExtensionInstaller {
    return this.extensionInstaller;
  }

  /**
   * Get Claude version (override from BaseAgentAdapter)
   * Parses version from 'claude --version' output
   * Claude outputs: '2.1.23 (Claude Code)' - we need just '2.1.23'
   *
   * Checks full path first on Unix systems (for native installations),
   * then falls back to command in PATH for other installation methods
   *
   * @returns Version string or null if not installed
   */
  async getVersion(): Promise<string | null> {
    if (!this.metadata.cliCommand) {
      return null;
    }

    const { exec } = await import('../../../utils/processes.js');

    // Try full path first on Unix systems (native installer places binary at ~/.local/bin/claude)
    if (process.platform !== 'win32') {
      const fullPath = resolveHomeDir('.local/bin/claude');
      try {
        const result = await exec(fullPath, ['--version']);

        // Parse version from output like '2.1.23 (Claude Code)'
        const versionMatch = result.stdout.trim().match(/^(\d+\.\d+\.\d+)/);
        if (versionMatch) {
          return versionMatch[1];
        }

        return result.stdout.trim();
      } catch {
        // Full path check failed, fall through to PATH check
      }
    }

    // Fall back to command in PATH (works for npm installations, Windows, etc.)
    try {
      const result = await exec(this.metadata.cliCommand, ['--version']);

      // Parse version from output like '2.1.23 (Claude Code)'
      // Extract just the version number
      const versionMatch = result.stdout.trim().match(/^(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        return versionMatch[1];
      }

      return result.stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Detect how Claude was installed (npm vs native)
   * Returns installation method for informational purposes
   *
   * @returns Installation method: 'npm', 'native', or 'unknown'
   */
  async getInstallationMethod(): Promise<InstallationMethod> {
    if (!this.metadata.cliCommand) {
      return 'unknown';
    }

    return await detectInstallationMethod(this.metadata.cliCommand);
  }

  /**
   * Check if Claude is installed (override from BaseAgentAdapter)
   * Checks full path first (for native installations to ~/.local/bin/claude),
   * then falls back to PATH check for compatibility with other installation methods
   *
   * @returns true if Claude is installed and accessible
   */
  async isInstalled(): Promise<boolean> {
    if (!this.metadata.cliCommand) {
      return true; // Built-in agents are always "installed"
    }

    // On Unix systems, check full path first (native installer places binary at ~/.local/bin/claude)
    // This avoids PATH issues where ~/.local/bin is not in user's PATH
    if (process.platform !== 'win32') {
      const fullPath = resolveHomeDir('.local/bin/claude');
      try {
        const { exec } = await import('../../../utils/processes.js');
        const result = await exec(fullPath, ['--version']);
        if (result.code === 0) {
          return true;
        }
      } catch {
        // Full path check failed, fall through to PATH check
      }
    }

    // Fall back to base implementation (checks if command is in PATH)
    // This handles:
    // 1. npm global installations (in PATH)
    // 2. Windows installations
    // 3. Other installation methods
    return super.isInstalled();
  }

  /**
   * Install Claude Code using native installer (override from BaseAgentAdapter)
   * Installs latest available version from native installer
   * For version-specific installs, use installVersion() method
   *
   * @throws {AgentInstallationError} If installation fails
   */
  async install(): Promise<void> {
    // Install latest available version (no version specified)
    await this.installVersion(undefined);
  }

  /**
   * Install specific version of Claude Code
   * Uses native installer with version parameter
   * Special handling for version parameter:
   * - undefined/'latest': Install latest available version
   * - 'supported': Install version from metadata.supportedVersion
   * - Semantic version string (e.g., '2.0.30'): Install specific version
   *
   * @param version - Version string (e.g., '2.0.30', 'latest', 'supported')
   * @throws {AgentInstallationError} If installation fails
   */
  async installVersion(version?: string): Promise<void> {
    const metadata = this.metadata;

    // Resolve 'supported' to actual version from metadata
    let resolvedVersion: string | undefined = version;
    if (version === 'supported') {
      if (!metadata.supportedVersion) {
        throw new AgentInstallationError(
          metadata.name,
          'No supported version defined in metadata',
        );
      }
      resolvedVersion = metadata.supportedVersion;
      logger.debug('Resolved version', {
        from: 'supported',
        to: resolvedVersion,
      });
    }

    // SECURITY: Validate version format to prevent command injection
    // Only allow semantic versions (e.g., '2.0.30') or special channels
    if (resolvedVersion) {
      const allowedChannels = ['latest', 'stable'];
      const isValidChannel = allowedChannels.includes(
        resolvedVersion.toLowerCase(),
      );
      const isValidVersion = isValidSemanticVersion(resolvedVersion);

      if (!isValidChannel && !isValidVersion) {
        throw new AgentInstallationError(
          metadata.name,
          `Invalid version format: '${resolvedVersion}'. Expected semantic version (e.g., '2.0.30'), 'latest', or 'stable'.`,
        );
      }

      logger.debug('Version validation passed', {
        version: resolvedVersion,
        isValidChannel,
        isValidVersion,
      });
    }

    // Validate installer URLs are configured
    if (!metadata.installerUrls) {
      throw new AgentInstallationError(
        metadata.name,
        'No installer URLs configured for native installation',
      );
    }

    logger.info(
      `Installing ${metadata.displayName} ${resolvedVersion || 'latest'}...`,
    );

    // Execute native installer
    const result = await installNativeAgent(
      metadata.name,
      metadata.installerUrls,
      resolvedVersion,
      {
        timeout: 300000, // 5 minute timeout
        verifyCommand: metadata.cliCommand || undefined,
        // Use full path for verification to avoid PATH refresh issues
        // Claude installer places binary at ~/.local/bin/claude on macOS/Linux
        verifyPath: process.platform === 'win32' ? undefined : resolveHomeDir('.local/bin/claude'),
        installFlags: ['--force'], // Force installation to overwrite existing version
      },
    );

    if (!result.success) {
      throw new AgentInstallationError(
        metadata.name,
        `Installation failed. Output: ${result.output}`,
      );
    }

    // Log success with version verification status
    if (result.installedVersion) {
      logger.success(
        `${metadata.displayName} ${result.installedVersion} installed successfully`,
      );
    } else {
      // Installation succeeded but verification failed (common on Windows due to PATH refresh)
      const isWindows = process.platform === 'win32';
      logger.success(
        `${metadata.displayName} ${resolvedVersion || 'latest'} installation completed`,
      );

      if (isWindows) {
        logger.info(
          'Note: Command verification requires restarting your terminal on Windows.',
        );
        logger.info(
          `After restart, verify with: ${metadata.cliCommand} --version`,
        );
      } else {
        logger.warn(
          'Installation completed but command verification failed.',
        );
        logger.info(
          'Possible causes: PATH not updated, slow filesystem, or permission issues.',
        );
        logger.info(
          `Try: 1) Restart your shell/terminal, or 2) Run: ${metadata.cliCommand} --version`,
        );
      }
    }
  }

  /**
   * Additional installation steps for Claude Code
   * Handles optional features like sounds installation
   *
   * @param options - Typed installation options
   */
  async additionalInstallation(options?: import('../../core/types.js').AgentInstallationOptions): Promise<void> {
    // Install sounds if requested
    if (options?.sounds) {
      try {
        logger.info('Installing sounds...', { agent: 'claude' });
        const { installSounds, isSoundsInstalled } = await import('./sounds-installer.js');

        // Check if already installed
        if (!isSoundsInstalled()) {
          const result = await installSounds();
          if (result === null) {
            // Installation failed (no audio player or other error)
            logger.warn('Sounds installation skipped or failed (no audio player)', {
              agent: 'claude'
            });
            console.error(chalk.yellow('\n⚠️  Sounds installation failed (optional feature)'));
            console.error(chalk.dim('You can try installing sounds later with: codemie install claude --sounds\n'));
          } else {
            logger.info('Sounds installed successfully', { agent: 'claude' });
          }
        } else {
          logger.info('Sounds already installed, skipping', { agent: 'claude' });
          console.log(chalk.blue('\nℹ️  Sounds already installed, skipping\n'));
        }
      } catch (error) {
        const errorContext = createErrorContext(error, {
          agent: 'claude'
        });

        logger.error('Sounds installation failed', errorContext);

        // Don't throw - sounds are optional, allow installation to continue
        console.error(chalk.yellow('\n⚠️  Sounds installation failed (optional feature)'));
        console.error(chalk.dim(`Error: ${getErrorMessage(error)}`));
        console.error(chalk.dim('You can try installing sounds later with: codemie install claude --sounds\n'));
      }
    }
  }

}

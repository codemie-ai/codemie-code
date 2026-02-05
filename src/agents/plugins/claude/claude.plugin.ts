import { AgentMetadata, VersionCompatibilityResult } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { ClaudeSessionAdapter } from './claude.session.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { ClaudePluginInstaller } from './claude.plugin-installer.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { installNativeAgent } from '../../../utils/native-installer.js';
import {
  compareVersions,
  isValidSemanticVersion,
} from '../../../utils/version-utils.js';
import {
  AgentInstallationError,
  createErrorContext,
} from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import {
  detectInstallationMethod,
  type InstallationMethod,
} from '../../../utils/installation-detector.js';

/**
 * Supported Claude Code version
 * Latest version tested and verified with CodeMie backend
 *
 * **UPDATE THIS WHEN BUMPING CLAUDE VERSION**
 */
const CLAUDE_SUPPORTED_VERSION = '2.1.29';

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
  supportedVersion: CLAUDE_SUPPORTED_VERSION, // Latest version tested with CodeMie backend

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

      return env;
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
   * @returns Version string or null if not installed
   */
  async getVersion(): Promise<string | null> {
    if (!this.metadata.cliCommand) {
      return null;
    }

    try {
      const { exec } = await import('../../../utils/processes.js');
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
   * Check if installed version is compatible with CodeMie
   * Compares against metadata.supportedVersion
   *
   * @returns Version compatibility result with status and version info
   */
  async checkVersionCompatibility(): Promise<VersionCompatibilityResult> {
    const metadata = this.metadata;
    const supportedVersion = metadata.supportedVersion || 'latest';

    // Get installed version
    const installedVersion = await this.getVersion();

    logger.debug('Checking version compatibility', {
      installedVersion,
      supportedVersion,
    });

    // If not installed, return incompatible
    if (!installedVersion) {
      return {
        compatible: false,
        installedVersion: null,
        supportedVersion,
        isNewer: false,
        hasUpdate: false,
      };
    }

    // If no supported version configured, consider compatible
    if (!metadata.supportedVersion) {
      return {
        compatible: true,
        installedVersion,
        supportedVersion: 'latest',
        isNewer: false,
        hasUpdate: false,
      };
    }

    // Compare versions
    try {
      const comparison = compareVersions(installedVersion, supportedVersion);

      // Determine if update is available: installed < supported
      const hasUpdate = comparison < 0;

      logger.debug('Version comparison result', {
        comparison,
        installedVersion,
        supportedVersion,
        compatible: comparison <= 0,
        isNewer: comparison > 0,
        hasUpdate,
      });

      return {
        compatible: comparison <= 0, // Compatible if installed <= supported
        installedVersion,
        supportedVersion,
        isNewer: comparison > 0, // Newer if installed > supported (warning case)
        hasUpdate, // Update available if installed < supported
      };
    } catch (error) {
      // If version comparison fails, provide comprehensive error context for debugging
      const errorContext = createErrorContext(error, {
        agent: metadata.name,
      });

      // Differentiate between parse errors (non-standard format) and unexpected errors
      const isParseError =
        error instanceof Error &&
        error.message.includes('Invalid semantic version');

      if (isParseError) {
        // Parse error: version format not recognized (e.g., '2.1.22 (Claude Code)' or custom format)
        logger.warn(
          'Non-standard version format detected, treating as incompatible',
          {
            ...errorContext,
            operation: 'checkVersionCompatibility',
            phase: 'version_comparison',
            installedVersion,
            supportedVersion,
            reason: 'parse_error',
          },
        );
      } else {
        // Unexpected error: something went wrong during comparison
        logger.error('Version compatibility check failed unexpectedly', {
          ...errorContext,
          operation: 'checkVersionCompatibility',
          phase: 'version_comparison',
          installedVersion,
          supportedVersion,
          reason: 'unexpected_error',
        });
      }

      // Return incompatible (safer default) - users should be aware of version issues
      // Don't throw - this would break user experience during setup/execution
      return {
        compatible: false,
        installedVersion,
        supportedVersion,
        isNewer: false,
        hasUpdate: false,
      };
    }
  }
}

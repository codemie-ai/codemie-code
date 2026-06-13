import type { AgentMetadata, HookTransformer } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { KimiSessionAdapter } from './kimi.session.js';
import { KimiExtensionInstaller } from './kimi.extension-installer.js';
import { KimiHookTransformer } from './kimi.hook-transformer.js';
import { installNativeAgent } from '../../../utils/native-installer.js';
import {
  AgentInstallationError,
  createErrorContext,
  getErrorMessage,
} from '../../../utils/errors.js';
import { compareVersions, isValidSemanticVersion } from '../../../utils/version-utils.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { commandExists, exec } from '../../../utils/processes.js';
import { resolveHomeDir } from '../../../utils/paths.js';

const KIMI_SUPPORTED_VERSION = '1.0.0';
const KIMI_MINIMUM_SUPPORTED_VERSION = '0.9.0';
const KIMI_MINIMUM_NODE_VERSION_FOR_NPM = '22.19.0';

const KIMI_INSTALLER_URLS = {
  macOS: 'https://code.kimi.com/kimi-code/install.sh',
  windows: 'https://code.kimi.com/kimi-code/install.ps1',
  linux: 'https://code.kimi.com/kimi-code/install.sh',
};

export const KimiPluginMetadata: AgentMetadata = {
  name: 'kimi',
  displayName: 'Kimi Code',
  description: 'Kimi Code CLI - Moonshot AI coding agent',
  npmPackage: '@moonshot-ai/kimi-code',
  cliCommand: 'kimi',
  supportedVersion: KIMI_SUPPORTED_VERSION,
  minimumSupportedVersion: KIMI_MINIMUM_SUPPORTED_VERSION,
  installerUrls: KIMI_INSTALLER_URLS,
  dataPaths: { home: '.kimi-code' },
  envMapping: {},
  supportedProviders: ['moonshot-subscription'],
  blockedModelPatterns: [],
  recommendedModels: ['kimi-for-coding', 'kimi-k2'],
  ssoConfig: { enabled: true, clientType: 'codemie-kimi' },
  flagMappings: {
    '--task': { type: 'flag', target: '-p' },
    '--model': { type: 'flag', target: '--model' },
  },
  metricsConfig: {
    excludeErrorsFromTools: ['Bash'],
  },
  extensionsConfig: {
    project: '.kimi-code',
    global: '~/.kimi-code',
    skillsEntryFile: 'SKILL.md',
  },
  hookConfig: {
    eventNameMapping: {
      'SessionStart': 'SessionStart',
      'SessionEnd': 'SessionEnd',
      'UserPromptSubmit': 'UserPromptSubmit',
      'Stop': 'Stop',
      'SubagentStop': 'SubagentStop',
      'PreCompact': 'PreCompact',
      'PermissionRequest': 'PermissionRequest',
      'PermissionResult': 'PermissionRequest',
    },
  },
};

export class KimiPlugin extends BaseAgentAdapter {
  private sessionAdapter?: SessionAdapter;
  private extensionInstaller?: BaseExtensionInstaller;
  private hookTransformer?: HookTransformer;

  constructor(metadata: AgentMetadata = KimiPluginMetadata) {
    super(metadata);
  }

  getSessionAdapter(): SessionAdapter {
    if (!this.sessionAdapter) {
      this.sessionAdapter = new KimiSessionAdapter(this.metadata);
    }
    return this.sessionAdapter;
  }

  getExtensionInstaller(): BaseExtensionInstaller {
    if (!this.extensionInstaller) {
      this.extensionInstaller = new KimiExtensionInstaller(this.metadata);
    }
    return this.extensionInstaller;
  }

  getHookTransformer(): HookTransformer {
    if (!this.hookTransformer) {
      this.hookTransformer = new KimiHookTransformer();
    }
    return this.hookTransformer;
  }

  override async isInstalled(): Promise<boolean> {
    if (!this.metadata.cliCommand) {
      return true;
    }

    if (await commandExists(this.metadata.cliCommand)) {
      return true;
    }

    if (process.platform !== 'win32') {
      const fullPath = resolveHomeDir('.local/bin/kimi');
      try {
        const result = await exec(fullPath, ['--version']);
        return result.code === 0;
      } catch {
        // Full path check failed, fall through to PATH check already performed
      }
    }

    logger.debug('[kimi-plugin] Kimi not installed. Install with:');
    logger.debug('[kimi-plugin]   codemie install kimi');

    return false;
  }

  private async installNative(version?: string): Promise<void> {
    if (!this.metadata.installerUrls) {
      throw new AgentInstallationError(
        this.metadata.name,
        'No installer URLs configured for native installation',
      );
    }

    try {
      const result = await installNativeAgent(
        this.metadata.name,
        this.metadata.installerUrls,
        version,
        {
          timeout: 300000,
          verifyCommand: this.metadata.cliCommand || undefined,
          verifyPath:
            process.platform === 'win32' ? undefined : resolveHomeDir('.local/bin/kimi'),
          installFlags: ['--force'],
        },
      );

      if (!result.success) {
        throw new AgentInstallationError(
          this.metadata.name,
          `Installation failed. Output: ${result.output}`,
        );
      }

      logger.success(`${this.metadata.displayName} installed successfully`);
    } catch (error) {
      if (error instanceof AgentInstallationError) {
        throw error;
      }

      const errorContext = createErrorContext(error, {
        agent: this.metadata.name,
      });
      logger.error('Kimi installation failed', ...sanitizeLogArgs(errorContext));

      throw new AgentInstallationError(
        this.metadata.name,
        `Failed to install ${this.metadata.displayName}: ${getErrorMessage(error)}`,
      );
    }
  }

  override async install(): Promise<void> {
    return this.installVersion(undefined);
  }

  /**
   * Get Kimi version by parsing 'kimi --version' output.
   * Extracts the first semantic version found in the output.
   *
   * Checks the native installer full path first on Unix systems, then falls
   * back to the command in PATH for other installation methods.
   */
  override async getVersion(): Promise<string | null> {
    if (!this.metadata.cliCommand) {
      return null;
    }

    const parseVersion = (output: string): string | null => {
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : output.trim() || null;
    };

    // Try full path first on Unix systems (native installer places binary at ~/.local/bin/kimi)
    if (process.platform !== 'win32') {
      const fullPath = resolveHomeDir('.local/bin/kimi');
      try {
        const result = await exec(fullPath, ['--version']);
        return parseVersion(result.stdout);
      } catch {
        // Full path check failed, fall through to PATH check
      }
    }

    // Fall back to command in PATH
    try {
      const result = await exec(this.metadata.cliCommand, ['--version']);
      return parseVersion(result.stdout);
    } catch {
      return null;
    }
  }

  override async installVersion(version?: string): Promise<void> {
    // Resolve 'supported' to the version from metadata
    let resolvedVersion: string | undefined = version;
    if (version === 'supported') {
      if (!this.metadata.supportedVersion) {
        throw new AgentInstallationError(
          this.metadata.name,
          'No supported version defined in metadata',
        );
      }
      resolvedVersion = this.metadata.supportedVersion;
      logger.debug('Resolved version', {
        from: 'supported',
        to: resolvedVersion,
      });
    } else if (version === 'npm' || version === 'latest' || version === 'stable') {
      // The 'npm', 'latest', and 'stable' channels request the latest build.
      // Kimi uses the native installer, so passing undefined installs the
      // latest version.
      resolvedVersion = undefined;
    }

    // Reject unknown channels and invalid semantic versions.
    if (version) {
      const allowedChannels = ['latest', 'stable', 'supported', 'npm'];
      const isAllowedChannel = allowedChannels.includes(version);
      const isValidVersion = isValidSemanticVersion(version);

      if (!isAllowedChannel && !isValidVersion) {
        throw new AgentInstallationError(
          this.metadata.name,
          `Invalid version format: '${version}'. Expected semantic version (e.g., '1.0.0'), 'latest', 'stable', 'supported', or 'npm'.`,
        );
      }
    }

    // npm-channel, supported-channel, and explicit semantic-version installs
    // require a recent Node runtime because the installer internally resolves
    // package metadata.
    const isSemverInstall = resolvedVersion !== undefined && isValidSemanticVersion(resolvedVersion);
    const isNpmChannel = version === 'npm';
    if (
      (isNpmChannel || isSemverInstall) &&
      compareVersions(process.version, KIMI_MINIMUM_NODE_VERSION_FOR_NPM) < 0
    ) {
      throw new AgentInstallationError(
        this.metadata.name,
        `Kimi installs from the npm channel, the supported version, or explicit versions require Node.js >= ${KIMI_MINIMUM_NODE_VERSION_FOR_NPM} (current: ${process.version})`,
      );
    }

    await this.installNative(resolvedVersion);
  }
}

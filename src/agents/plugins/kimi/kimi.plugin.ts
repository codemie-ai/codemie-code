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
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import chalk from 'chalk';
import { commandExists, exec } from '../../../utils/processes.js';
import { resolveHomeDir } from '../../../utils/paths.js';

const KIMI_SUPPORTED_VERSION = '1.0.0';
const KIMI_MINIMUM_SUPPORTED_VERSION = '0.9.0';

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

  override async install(): Promise<void> {
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
        undefined,
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

  override async installVersion(version?: string): Promise<void> {
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
    } else if (resolvedVersion && resolvedVersion !== 'latest' && resolvedVersion !== 'stable') {
      logger.warn(
        chalk.yellow(
          `${this.metadata.displayName} does not support installing version ${resolvedVersion}. ` +
            'Installing the latest version instead.',
        ),
      );
    }

    await this.install();
  }
}

import type { AgentConfig, AgentMetadata, HookTransformer } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { KimiSessionAdapter } from './kimi.session.js';
import { KimiExtensionInstaller } from './kimi.extension-installer.js';
import { KimiHookTransformer } from './kimi.hook-transformer.js';
import { assertExplicitKimiModelAllowed, resolveKimiModel } from './kimi.models.js';
import { installNativeAgent } from '../../../utils/native-installer.js';
import {
  AgentInstallationError,
  createErrorContext,
  getErrorMessage,
} from '../../../utils/errors.js';
import { isValidSemanticVersion } from '../../../utils/version-utils.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { commandExists, exec, getCommandPath } from '../../../utils/processes.js';
import { resolveHomeDir } from '../../../utils/paths.js';

const KIMI_SUPPORTED_VERSION = '0.15.0';
const KIMI_MINIMUM_SUPPORTED_VERSION = '0.14.0';
const KIMI_NATIVE_BINARY_PATH = '.kimi-code/bin/kimi';

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
  dataPaths: {
    home: '.kimi-code',
    binary: KIMI_NATIVE_BINARY_PATH,
  },
  envMapping: {
    baseUrl: ['KIMI_MODEL_BASE_URL'],
    apiKey: ['KIMI_MODEL_API_KEY'],
    model: ['KIMI_MODEL_NAME'],
  },
  supportedProviders: ['moonshot-subscription', 'ai-run-sso'],
  blockedModelPatterns: [],
  recommendedModels: ['kimi-k2.6', 'kimi-for-coding', 'kimi-k2'],
  ssoConfig: { enabled: true, clientType: 'codemie-kimi' },
  flagMappings: {
    '--task': { type: 'flag', target: '-p' },
    '--model': { type: 'flag', target: '--model' },
  },
  lifecycle: {
    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const explicitModel = getExplicitModelArg(args);
      if (!explicitModel) {
        return args;
      }

      const availableModels = (process.env.CODEMIE_KIMI_AVAILABLE_MODELS || '')
        .split(',')
        .map(model => model.trim())
        .filter(Boolean);

      assertExplicitKimiModelAllowed(explicitModel, availableModels);
      return args;
    },
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
      // Native installer location
      const nativePath = resolveHomeDir(KIMI_NATIVE_BINARY_PATH);
      try {
        const result = await exec(nativePath, ['--version']);
        if (result.code === 0) {
          return true;
        }
      } catch {
        // Native path check failed, fall through
      }

      // Legacy / npm location
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
            process.platform === 'win32' ? undefined : resolveHomeDir(KIMI_NATIVE_BINARY_PATH),
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
   * Uninstall Kimi Code native binary and npm wrapper package.
   *
   * The native installer places the binary at ~/.kimi-code/bin/kimi, while the
   * inherited base uninstall only removes the npm package wrapper. We remove
   * both so that subsequent installs don't incorrectly report Kimi as already
   * installed.
   */
  override async uninstall(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'kimi.exe' : 'kimi';
    const possibleBinaries = new Set<string>();

    // Known native install locations
    possibleBinaries.add(resolveHomeDir(`.kimi-code/bin/${binaryName}`));
    possibleBinaries.add(resolveHomeDir(`.local/bin/${binaryName}`));

    // Also remove any binary found on PATH that belongs to the user
    const pathBinary = await getCommandPath('kimi');
    if (pathBinary) {
      possibleBinaries.add(pathBinary);
    }

    for (const binaryPath of possibleBinaries) {
      try {
        if (existsSync(binaryPath)) {
          await rm(binaryPath, { force: true });
          logger.debug(`[kimi-plugin] Removed binary: ${binaryPath}`);
        }
      } catch (error) {
        logger.warn(
          `[kimi-plugin] Could not remove binary ${binaryPath}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Remove the native install directory if it is now empty
    const installDir = resolveHomeDir('.kimi-code');
    try {
      if (existsSync(installDir)) {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(installDir);
        if (entries.length === 0) {
          await rm(installDir, { recursive: true, force: true });
          logger.debug(`[kimi-plugin] Removed empty install directory: ${installDir}`);
        }
      }
    } catch (error) {
      logger.warn(
        `[kimi-plugin] Could not remove install directory ${installDir}`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Remove npm wrapper package if present
    await super.uninstall();
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

    // Try native installer full path first on Unix systems
    // (native installer places binary at ~/.kimi-code/bin/kimi)
    if (process.platform !== 'win32') {
      const nativePath = resolveHomeDir(KIMI_NATIVE_BINARY_PATH);
      try {
        const result = await exec(nativePath, ['--version']);
        return parseVersion(result.stdout);
      } catch {
        // Native path check failed, fall through to legacy path
      }

      // Legacy / npm location
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

    await this.installNative(resolvedVersion);
  }

  protected override async setupProxy(env: NodeJS.ProcessEnv): Promise<void> {
    if (env.CODEMIE_PROVIDER === 'ai-run-sso' || env.CODEMIE_AUTH_METHOD === 'jwt') {
      // Resolve before BaseAgentAdapter builds the proxy config because CODEMIE_MODEL
      // is part of the proxy startup contract.
      const resolution = await resolveKimiModel(env);
      env.CODEMIE_MODEL = resolution.selectedModel;
      env.CODEMIE_KIMI_AVAILABLE_MODELS = resolution.availableModels.join(',');
    }

    await super.setupProxy(env);
  }
}

function getExplicitModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') {
      return args[i + 1];
    }
    if (arg.startsWith('--model=')) {
      return arg.slice('--model='.length);
    }
  }

  return undefined;
}

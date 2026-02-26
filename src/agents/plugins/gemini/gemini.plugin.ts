import type { AgentMetadata, HookTransformer } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { GeminiHookTransformer } from './gemini.hook-transformer.js';
import { GeminiSessionAdapter } from './gemini.session-adapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { GeminiExtensionInstaller } from './gemini.extension-installer.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';

/**
 * Supported Gemini CLI version
 * Latest version tested and verified with CodeMie backend
 *
 * **UPDATE THIS WHEN BUMPING GEMINI VERSION**
 */
const GEMINI_SUPPORTED_VERSION = '0.29.5';

/**
 * Minimum supported Gemini CLI version
 * Versions below this are known to be incompatible and will be blocked from starting
 * Rule: always 10 patch versions below GEMINI_SUPPORTED_VERSION
 * e.g. supported = 0.29.5 → minimum = 0.29.0 (patch floored at 0 since 5 - 10 < 0)
 *
 * **UPDATE THIS WHEN BUMPING GEMINI VERSION**
 */
const GEMINI_MINIMUM_SUPPORTED_VERSION = '0.29.0';

// Define metadata first (used by both lifecycle and analytics)
const metadata = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  description: 'Google Gemini CLI - AI coding assistant',

  npmPackage: '@google/gemini-cli',
  cliCommand: 'gemini',

  // Version management configuration
  supportedVersion: GEMINI_SUPPORTED_VERSION,            // Latest version tested with CodeMie backend
  minimumSupportedVersion: GEMINI_MINIMUM_SUPPORTED_VERSION, // Minimum version required to run

  envMapping: {
    baseUrl: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL'],
    apiKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    model: ['GEMINI_MODEL']
  },

  supportedProviders: ['ai-run-sso', 'litellm', 'bearer-auth'],
  blockedModelPatterns: [/^claude/i, /^gpt/i], // Gemini models only
  recommendedModels: ['gemini-3-pro'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-gemini'
  },

  flagMappings: {
    '--task': {
      type: 'flag' as const,
      target: '-p'
    }
  },

  // Data paths (used by lifecycle hooks and analytics)
  dataPaths: {
    home: '.gemini',
    settings: 'settings.json'
  },

  // MCP configuration paths for Gemini CLI
  // - User: ~/.gemini/settings.json → mcpServers (available across all projects)
  // - Project: .gemini/settings.json → mcpServers (project-specific)
  // Note: Gemini doesn't have a "local" scope like Claude
  mcpConfig: {
    project: {
      path: '.gemini/settings.json',
      jsonPath: 'mcpServers'
    },
    user: {
      path: '~/.gemini/settings.json',
      jsonPath: 'mcpServers'
    }
  },

  // Hook configuration: event name mapping
  hookConfig: {
    /**
     * Map Gemini event names to internal event names
     * Based on Gemini CLI documentation: https://geminicli.com/docs/hooks/
     *
     * Supported mappings (map to existing 6 internal events):
     * - SessionStart → SessionStart (direct)
     * - SessionEnd → SessionEnd (direct)
     * - PreCompress → PreCompact (Gemini's name for context compression)
     * - AfterAgent → Stop (Gemini's AfterAgent = Claude's Stop)
     * - Notification → PermissionRequest (Gemini's notification system)
     *
     * Unsupported events (silently ignored by router):
     * - BeforeModel, AfterModel, BeforeToolSelection, BeforeTool, AfterTool
     */
    eventNameMapping: {
      // Direct mappings (same name)
      'SessionStart': 'SessionStart',
      'SessionEnd': 'SessionEnd',

      // Renamed mappings
      'PreCompress': 'PreCompact',      // Gemini's PreCompress = Claude's PreCompact
      'AfterAgent': 'Stop',             // Gemini's AfterAgent = Claude's Stop
      'BeforeAgent': 'UserPromptSubmit', // Gemini's BeforeAgent = Claude's UserPromptSubmit
      'Notification': 'PermissionRequest'  // Gemini's Notification = Claude's PermissionRequest
    }
  }
};

/**
 * Gemini CLI Plugin Metadata
 */
export const GeminiPluginMetadata: AgentMetadata = {
  ...metadata,

  // Lifecycle hook to ensure settings file exists
  // Uses BaseAgentAdapter methods for cross-platform file operations
  lifecycle: {
    enrichArgs: (args, config) => {
      // Gemini CLI uses -m flag for model selection
      const hasModelArg = args.some((arg, idx) =>
        (arg === '-m' || arg === '--model') && idx < args.length - 1
      );

      if (!hasModelArg && config.model) {
        return ['-m', config.model, ...args];
      }

      return args;
    },
    beforeRun: async function(this: BaseAgentAdapter, env: NodeJS.ProcessEnv) {
      // Ensure .gemini directory exists (uses base method)
      await this.ensureDirectory(this.resolveDataPath());

      // Ensure settings.json exists with default content (uses base method)
      await this.ensureJsonFile(
        this.resolveDataPath(metadata.dataPaths.settings),
        {
          security: {
            auth: {
              selectedType: 'gemini-api-key'
            }
          },
          tools: {
            enableHooks: true
          }
        }
      );

      return env;
    }
  }
};

/**
 * Gemini CLI Adapter
 */
export class GeminiPlugin extends BaseAgentAdapter {
  private hookTransformer: HookTransformer;
  private sessionAdapter: SessionAdapter;
  private extensionInstaller: BaseExtensionInstaller;

  constructor() {
    super(GeminiPluginMetadata);
    // Initialize hook transformer for Gemini-specific payload transformation
    this.hookTransformer = new GeminiHookTransformer();
    // Initialize session adapter for unified session sync
    this.sessionAdapter = new GeminiSessionAdapter(GeminiPluginMetadata);
    // Initialize extension installer with metadata (agent name from metadata)
    this.extensionInstaller = new GeminiExtensionInstaller(GeminiPluginMetadata);
  }

  /**
   * Get hook transformer for this agent
   * Transforms Gemini hook events to internal format
   */
  getHookTransformer(): HookTransformer {
    return this.hookTransformer;
  }

  /**
   * Get session adapter for this agent (used by unified session sync)
   */
  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /**
   * Get extension installer for this agent
   * Returns installer to handle extension installation
   */
  getExtensionInstaller(): BaseExtensionInstaller {
    return this.extensionInstaller;
  }

  /**
   * Get Gemini CLI version (override from BaseAgentAdapter)
   * Parses version from 'gemini --version' output
   * Extracts just the semver number in case output contains extra text
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

      // Parse semver from output (handles both '0.29.5' and '0.29.5 (Gemini CLI)' formats)
      const versionMatch = result.stdout.trim().match(/^(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        return versionMatch[1];
      }

      return result.stdout.trim();
    } catch {
      return null;
    }
  }

}

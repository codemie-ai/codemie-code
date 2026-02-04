import type {AgentMetadata} from '../../core/types.js';
import {ClaudePlugin, ClaudePluginMetadata} from './claude.plugin.js';
import * as npm from '../../../utils/processes.js';
import {NpmError} from '../../../utils/errors.js';

/**
 * Claude Code ACP Plugin Metadata
 *
 * Extends ClaudePluginMetadata with ACP-specific overrides.
 * ACP (Agent Communication Protocol) adapter for Claude Code.
 * Enables integration with editors like Zed, Emacs, Neovim via stdio JSON-RPC.
 *
 * Uses @zed-industries/claude-code-acp - Zed's official ACP adapter.
 * https://github.com/zed-industries/claude-code-acp
 */
export const ClaudeAcpPluginMetadata: AgentMetadata = {
  // Inherit all from Claude plugin
  ...ClaudePluginMetadata,

  // ACP-specific overrides
  name: 'claude-acp',
  displayName: 'Claude Code ACP',
  description: 'Claude Code ACP adapter for editor integration (Zed, Emacs, etc.)',

  // Zed's ACP adapter package (separate from Claude CLI!)
  npmPackage: '@zed-industries/claude-code-acp',
  cliCommand: 'claude-code-acp',

  // No native installer - npm only
  installerUrls: undefined,

  // SSO config - separate clientType for analytics distinction
  ssoConfig: {
    enabled: true,
    clientType: 'codemie-claude-acp'
  },

  // No flag mappings - ACP protocol handles everything via stdio
  flagMappings: {},

  // Silent mode for ACP - stdout is JSON-RPC protocol
  silentMode: true,

  // Post-install hints for IDE configuration
  postInstallHints: [
    'Configure in your IDE:',
    '',
    'Zed (~/.config/zed/settings.json):',
    '  "agent_servers": { "claude": { "command": "codemie-claude-acp", "args": ["--profile", "work"] } }',
    '',
    'JetBrains (~/.jetbrains/acp.json):',
    '  "agent_servers": { "Claude Code via CodeMie": { "command": "codemie-claude-acp", "args": ["--profile", "work"] } }',
  ],
};

/**
 * Claude Code ACP Plugin
 *
 * Extends ClaudePlugin with ACP-specific metadata.
 * Inherits all functionality (proxy, lifecycle, analytics, session adapter).
 */
export class ClaudeAcpPlugin extends ClaudePlugin {
  constructor() {
    super();
    // Override metadata with ACP-specific values
    (this as any).metadata = ClaudeAcpPluginMetadata;
  }

  /**
   * Skip version check - ACP adapter version not critical
   */
  async getVersion(): Promise<string | null> {
    return null;
  }

  /**
   * Install via npm (override native installation from ClaudePlugin)
   *
   * ClaudeAcpPlugin uses @zed-industries/claude-code-acp which is npm-only.
   * There's no native installer for this package.
   */
  async install(): Promise<void> {
    const npmPackage = this.metadata.npmPackage;
    if (!npmPackage) {
      throw new Error(`${this.displayName} has no npm package configured`);
    }

    try {
      await npm.installGlobal(npmPackage);
    } catch (error: unknown) {
      if (error instanceof NpmError) {
        throw new Error(`Failed to install ${this.displayName}: ${error.message}`);
      }
      throw error;
    }
  }
}

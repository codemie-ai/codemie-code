import type { AgentMetadata } from '../../core/types.js';
import { GeminiPlugin, GeminiPluginMetadata } from './gemini.plugin.js';

/**
 * Gemini CLI ACP Plugin Metadata
 *
 * Extends GeminiPluginMetadata with ACP-specific overrides.
 * ACP (Agent Communication Protocol) adapter for Gemini CLI.
 * Enables integration with editors like Zed, JetBrains, Emacs via stdio JSON-RPC.
 *
 * Unlike Claude/Codex, Gemini CLI has NATIVE ACP support built into the same
 * binary (`gemini --acp`) — no separate npm package needed.
 * https://geminicli.com/docs/cli/acp-mode/
 */
export const GeminiAcpPluginMetadata: AgentMetadata = {
  // Inherit all from Gemini plugin
  ...GeminiPluginMetadata,

  // ACP-specific overrides
  name: 'gemini-acp',
  displayName: 'Gemini CLI ACP',
  description: 'Gemini CLI ACP mode for editor integration (Zed, JetBrains, etc.)',

  // SSO config - separate clientType for analytics distinction
  ssoConfig: {
    enabled: true,
    clientType: 'codemie-gemini-acp',
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
    '  "agent_servers": { "gemini": { "command": "codemie-gemini-acp" } }',
    '',
    'JetBrains (~/.jetbrains/acp.json):',
    '  "agent_servers": { "Gemini CLI via CodeMie": { "command": "codemie-gemini-acp" } }',
    '',
    'JetBrains AIR (~/Library/Application Support/JetBrains/Air/acp.json):',
    '  "agent_servers": { "Gemini CLI via CodeMie": { "command": "codemie-gemini-acp" } }',
  ],

  lifecycle: {
    // beforeRun unchanged — keeps settings.json bootstrap + model validation.
    ...GeminiPluginMetadata.lifecycle,
    // Prepend --acp to switch Gemini CLI into ACP server mode, keeping the
    // inherited model-injection logic (-m <model>, skipped for no-model
    // subcommands) for whatever args the ACP client passes through.
    enrichArgs: (args, config) => ['--acp', ...GeminiPluginMetadata.lifecycle!.enrichArgs!(args, config)],
  },
};

/**
 * Gemini CLI ACP Plugin
 *
 * Extends GeminiPlugin with ACP-specific metadata.
 * Inherits all functionality (proxy, lifecycle beforeRun, analytics, session adapter) —
 * same `gemini` binary as the base plugin, so no install/version overrides needed.
 */
export class GeminiAcpPlugin extends GeminiPlugin {
  constructor() {
    super();
    // Override metadata with ACP-specific values
    (this as any).metadata = GeminiAcpPluginMetadata;
  }
}

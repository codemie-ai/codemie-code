import type { AgentMetadata } from '../../core/types.js';
import { OpenCodePlugin, OpenCodePluginMetadata } from './opencode.plugin.js';

/**
 * OpenCode ACP Plugin Metadata
 *
 * Extends OpenCodePluginMetadata with ACP-specific overrides.
 * ACP (Agent Communication Protocol) adapter for OpenCode.
 * Enables integration with editors like Zed, JetBrains, Emacs via stdio JSON-RPC.
 *
 * Unlike Claude/Codex, OpenCode has NATIVE ACP support built into the same
 * binary (`opencode acp`) — no separate npm package needed.
 * https://opencode.ai/docs/acp/
 */
export const OpenCodeAcpPluginMetadata: AgentMetadata = {
  // Inherit all from OpenCode plugin
  ...OpenCodePluginMetadata,

  // ACP-specific overrides
  name: 'opencode-acp',
  displayName: 'OpenCode ACP',
  description: 'OpenCode ACP mode for editor integration (Zed, JetBrains, etc.)',

  // SSO config - separate clientType for analytics distinction
  ssoConfig: {
    enabled: true,
    clientType: 'codemie-opencode-acp',
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
    '  "agent_servers": { "opencode": { "command": "codemie-opencode-acp" } }',
    '',
    'JetBrains (~/.jetbrains/acp.json):',
    '  "agent_servers": { "OpenCode via CodeMie": { "command": "codemie-opencode-acp" } }',
    '',
    'JetBrains AIR (~/Library/Application Support/JetBrains/Air/acp.json):',
    '  "agent_servers": { "OpenCode via CodeMie": { "command": "codemie-opencode-acp" } }',
  ],

  lifecycle: {
    // beforeRun, onSessionStart, onSessionEnd unchanged — keeps config
    // injection (proxy routing, hooks plugin) and session telemetry.
    ...OpenCodePluginMetadata.lifecycle,
    // Prepend the `acp` subcommand to switch OpenCode into ACP server mode.
    // No --task→run translation here: ACP mode doesn't take that flag, the
    // IDE drives the session over stdio JSON-RPC instead.
    enrichArgs: (args) => ['acp', ...args],
  },
};

/**
 * OpenCode ACP Plugin
 *
 * Extends OpenCodePlugin with ACP-specific metadata.
 * Inherits all functionality (proxy, lifecycle beforeRun, analytics, session adapter) —
 * same `opencode` binary as the base plugin, so no install/version overrides needed.
 */
export class OpenCodeAcpPlugin extends OpenCodePlugin {
  constructor() {
    super();
    // Override metadata with ACP-specific values
    (this as any).metadata = OpenCodeAcpPluginMetadata;
  }
}

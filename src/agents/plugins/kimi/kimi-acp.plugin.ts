import type { AgentMetadata } from '../../core/types.js';
import { KimiPlugin, KimiPluginMetadata } from './kimi.plugin.js';

export const KimiAcpPluginMetadata: AgentMetadata = {
  ...KimiPluginMetadata,
  name: 'kimi-acp',
  displayName: 'Kimi Code ACP',
  description: 'Kimi Code CLI ACP mode for IDE integration',
  silentMode: true,
  flagMappings: {},
  lifecycle: {
    enrichArgs: (args) => ['acp', ...args],
  },
  postInstallHints: [
    'Configure in your IDE:',
    '',
    'Zed (~/.config/zed/settings.json):',
    '  "agent_servers": { "kimi": { "command": "codemie run kimi-acp" } }',
    '',
    'JetBrains (~/.jetbrains/acp.json):',
    '  "agent_servers": { "Kimi Code via CodeMie": { "command": "codemie run kimi-acp" } }',
  ],
};

export class KimiAcpPlugin extends KimiPlugin {
  constructor() {
    super(KimiAcpPluginMetadata);
  }
}

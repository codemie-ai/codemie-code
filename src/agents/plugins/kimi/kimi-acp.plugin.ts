import type { AgentMetadata } from '../../core/types.js';
import { KimiPlugin, KimiPluginMetadata } from './kimi.plugin.js';

export const KimiAcpPluginMetadata: AgentMetadata = {
  ...KimiPluginMetadata,
  name: 'kimi-acp',
  displayName: 'Kimi Code ACP',
  description: 'Kimi Code CLI ACP mode for IDE integration',
  silentMode: true,
  lifecycle: {
    enrichArgs: (args) => ['acp', ...args],
  },
};

export class KimiAcpPlugin extends KimiPlugin {
  constructor() {
    super(KimiAcpPluginMetadata);
  }
}

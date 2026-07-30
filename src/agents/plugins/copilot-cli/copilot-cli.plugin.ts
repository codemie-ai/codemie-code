/**
 * GitHub Copilot CLI — analytics-only agent plugin.
 *
 * CodeMie does NOT install, launch, configure, or proxy Copilot. This plugin exists solely
 * so `AgentRegistry` can hand the analytics pipeline a `SessionAdapter`: `native-loader.ts`
 * resolves adapters via `AgentRegistry.getAgent(name)?.getSessionAdapter?.()`, and there is
 * no analytics-only bypass around the registry.
 *
 * The mutating lifecycle methods inherited from `BaseAgentAdapter` are therefore overridden
 * to refuse. Left inherited, `install()` would npm-install `@github/copilot` and `run()`
 * would launch it — both outside this integration's remit.
 */

import type { AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { CopilotCliSessionAdapter } from './copilot-cli.session.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { COPILOT_CLI_AGENT_NAME, COPILOT_CLI_DISPLAY_NAME } from './copilot-cli.constants.js';

export { COPILOT_CLI_AGENT_NAME, COPILOT_CLI_DISPLAY_NAME };

const NOT_MANAGED =
  'GitHub Copilot CLI is not managed by CodeMie. It is supported for analytics only — ' +
  'install and run it with the `copilot` command directly (npm package `@github/copilot`).';

export const CopilotCliPluginMetadata: AgentMetadata = {
  name: COPILOT_CLI_AGENT_NAME,
  displayName: COPILOT_CLI_DISPLAY_NAME,
  description: 'GitHub Copilot CLI — analytics ingestion only (not managed by CodeMie)',
  // Deliberately null, even though Copilot ships as @github/copilot. `codemie update`
  // bypasses the adapter entirely — updateAgent() reads metadata.npmPackage and runs
  // `npm install -g <pkg> --force`, which would overwrite the user's own Copilot install.
  // Null makes that path fail safe ("cannot be updated") instead of destructively, as
  // defense in depth behind the getManageableAgents() exclusion.
  npmPackage: null,
  cliCommand: 'copilot',
  dataPaths: {
    home: '.copilot',
  },
  // Required by AgentMetadata but inapplicable here: CodeMie never launches Copilot, so
  // there is no environment to map and no provider to route it through.
  envMapping: {},
  supportedProviders: [],
  analyticsOnly: true,
};

export class CopilotCliPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter | null = null;

  constructor() {
    super(CopilotCliPluginMetadata);
  }

  getSessionAdapter(): SessionAdapter {
    if (!this.sessionAdapter) {
      this.sessionAdapter = new CopilotCliSessionAdapter(this.metadata);
    }
    return this.sessionAdapter;
  }

  /** Refused: analytics-only. See {@link NOT_MANAGED}. */
  async install(): Promise<void> {
    throw new ConfigurationError(NOT_MANAGED);
  }

  /** Refused: analytics-only. See {@link NOT_MANAGED}. */
  async uninstall(): Promise<void> {
    throw new ConfigurationError(NOT_MANAGED);
  }

  /** Refused: analytics-only. See {@link NOT_MANAGED}. */
  async run(_args: string[], _env?: Record<string, string>): Promise<void> {
    throw new ConfigurationError(NOT_MANAGED);
  }
}

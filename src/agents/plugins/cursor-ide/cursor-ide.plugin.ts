import type { AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { writeCursorResponse } from './cursor-ide.response.js';
import {
  CURSOR_IDE_AGENT_NAME,
  CURSOR_IDE_CLIENT_TYPE,
  CURSOR_IDE_DISPLAY_NAME,
} from './cursor-ide.constants.js';

export {
  CURSOR_IDE_AGENT_NAME,
  CURSOR_IDE_CLIENT_TYPE,
  CURSOR_IDE_DISPLAY_NAME,
} from './cursor-ide.constants.js';

export const CursorIdePluginMetadata: AgentMetadata = {
  name: CURSOR_IDE_AGENT_NAME,
  displayName: CURSOR_IDE_DISPLAY_NAME,
  description: 'Cursor IDE - analytics-only hook ingestion, never installed or launched by CodeMie',

  // Analytics-only: CodeMie never installs, updates, or launches Cursor.
  npmPackage: null,
  cliCommand: null,

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },
  supportedProviders: [],

  // The sole gate excluding this agent from `codemie install/list/uninstall/update`
  // (src/agents/registry.ts:getManageableAgents, types.ts:analyticsOnly).
  analyticsOnly: true,

  ssoConfig: {
    enabled: false,
    clientType: CURSOR_IDE_CLIENT_TYPE,
  },

  hookConfig: {
    // Exit code 2 is equivalent to `permission: "deny"` in Cursor and blocks
    // the user's action - analytics ingestion must never be capable of that.
    neverBlockingExit: true,
    // Cursor reads a JSON response off stdout for a subset of its events
    // (see cursor-ide.response.ts) - this is the sole gate that calls it,
    // set only for this agent.
    writeStdoutResponse: writeCursorResponse,
    // Fire-and-forget forward raw events to the local proxy daemon's
    // /v1/otlp/hook-events route, bypassing the shared transform/validate/route
    // pipeline and its legacy analytics handlers.
    otlpIngestion: true,
  },
};

export class CursorIdePlugin extends BaseAgentAdapter {
  constructor(metadata: AgentMetadata = CursorIdePluginMetadata) {
    super(metadata);
  }

  override async isInstalled(): Promise<boolean> {
    // Analytics-only: Cursor's installation state is irrelevant to CodeMie.
    return true;
  }

  override async getVersion(): Promise<string | null> {
    return null;
  }
}

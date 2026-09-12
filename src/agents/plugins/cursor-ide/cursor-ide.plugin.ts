import type { AgentMetadata, HookTransformer } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { CursorIdeHookTransformer } from './cursor-ide.hook-transformer.js';
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

/**
 * Cursor's 21 native hook events, mapped onto CodeMie's internal event
 * names. `hook_event_name` is left untouched by the transformer (Cursor's
 * native name survives routing), so this mapping is what makes the
 * many-to-one collapse (e.g. every tool-permission event onto `PreToolUse`)
 * lossless - `normalizeEventName` resolves the internal name into a local
 * variable without mutating the event.
 *
 * See: https://cursor.com/docs/hooks
 */
const CURSOR_IDE_EVENT_NAME_MAPPING = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit',
  stop: 'Stop',
  preCompact: 'PreCompact',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preToolUse: 'PreToolUse',
  beforeShellExecution: 'PreToolUse',
  beforeMCPExecution: 'PreToolUse',
  beforeReadFile: 'PreToolUse',
  beforeTabFileRead: 'PreToolUse',
  postToolUse: 'PostToolUse',
  afterShellExecution: 'PostToolUse',
  afterMCPExecution: 'PostToolUse',
  afterFileEdit: 'PostToolUse',
  afterTabFileEdit: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  afterAgentResponse: 'AgentResponse',
  afterAgentThought: 'AgentThought',
  workspaceOpen: 'WorkspaceOpen',
} as const;

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
    eventNameMapping: CURSOR_IDE_EVENT_NAME_MAPPING,
    // Cursor's transcript_path is nullable ("null if transcripts disabled")
    // for every event, not just SessionStart/SessionEnd.
    transcriptOptional: true,
    // Exit code 2 is equivalent to `permission: "deny"` in Cursor and blocks
    // the user's action - analytics ingestion must never be capable of that.
    neverBlockingExit: true,
  },
};

export class CursorIdePlugin extends BaseAgentAdapter {
  private hookTransformer?: HookTransformer;

  constructor(metadata: AgentMetadata = CursorIdePluginMetadata) {
    super(metadata);
  }

  getHookTransformer(): HookTransformer {
    if (!this.hookTransformer) {
      this.hookTransformer = new CursorIdeHookTransformer();
    }
    return this.hookTransformer;
  }

  override async isInstalled(): Promise<boolean> {
    // Analytics-only: Cursor's installation state is irrelevant to CodeMie.
    return true;
  }

  override async getVersion(): Promise<string | null> {
    return null;
  }
}

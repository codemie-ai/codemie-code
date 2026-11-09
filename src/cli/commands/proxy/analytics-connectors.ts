/**
 * The OTLP analytics connectors `codemie proxy` reports on: Claude Code, Copilot CLI and Copilot Chat.
 * One table so `proxy status` (is any connector connected?) and `proxy analytics status` (what does
 * this connector collect?) share a single definition of each connector's detection, collection and
 * formatting.
 */

import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';
import { logger } from '@/utils/logger.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
import {
  collectClaudeAnalyticsStatus,
  collectCopilotAnalyticsStatus,
  formatClaudeAnalyticsStatus,
  formatCopilotAnalyticsStatus,
  type ClaudeAnalyticsStatus,
  type CopilotAnalyticsStatus,
} from './analytics-status.js';

export type AnalyticsConnectorId =
  | typeof CLAUDE_CODE_OTLP_AGENT_NAME
  | typeof COPILOT_CLI_OTLP_AGENT_NAME
  | typeof COPILOT_CHAT_OTLP_AGENT_NAME;

export type AnalyticsConnectorStatus = ClaudeAnalyticsStatus | CopilotAnalyticsStatus;

export interface AnalyticsConnector {
  id: AnalyticsConnectorId;
  /** The connector's effective analytics configuration for `cwd`. */
  collect: (cwd: string) => Promise<AnalyticsConnectorStatus>;
  /** Renders a status produced by this same connector's `collect`. */
  format: (status: AnalyticsConnectorStatus) => string;
  /** Whether the connector is connected (hooks installed / scope enabled), whatever the collection preference. */
  isActive: () => Promise<boolean>;
}

interface ConnectorSpec<S extends AnalyticsConnectorStatus> {
  id: AnalyticsConnectorId;
  collect: (cwd: string) => Promise<S>;
  format: (status: S) => string;
  isActive: () => Promise<boolean>;
}

/** `format` only ever receives the status its own `collect` returned, so the narrowing is sound. */
function connector<S extends AnalyticsConnectorStatus>(spec: ConnectorSpec<S>): AnalyticsConnector {
  return { ...spec, format: (status) => spec.format(status as S) };
}

function copilotConnector(id: AnalyticsConnectorId): AnalyticsConnector {
  return connector<CopilotAnalyticsStatus>({
    id,
    collect: (cwd) => collectCopilotAnalyticsStatus(id, cwd),
    format: formatCopilotAnalyticsStatus,
    isActive: async () => {
      const scope = await readCopilotConnectorScope(id);
      return scope.kind === 'ok' && scope.value.enabled;
    },
  });
}

export const ANALYTICS_CONNECTORS: readonly AnalyticsConnector[] = [
  connector<ClaudeAnalyticsStatus>({
    id: CLAUDE_CODE_OTLP_AGENT_NAME,
    collect: collectClaudeAnalyticsStatus,
    format: formatClaudeAnalyticsStatus,
    isActive: hasClaudeCodeOtlpHooks,
  }),
  copilotConnector(COPILOT_CLI_OTLP_AGENT_NAME),
  copilotConnector(COPILOT_CHAT_OTLP_AGENT_NAME),
];

/** Whether any connector is connected. A check that fails counts as inactive; never throws. */
export async function hasActiveAnalyticsConnector(): Promise<boolean> {
  const results = await Promise.all(
    ANALYTICS_CONNECTORS.map(async (entry) => {
      try {
        return await entry.isActive();
      } catch (error) {
        logger.debug(`[analytics-connectors] ${entry.id} activity check failed:`, error);
        return false;
      }
    })
  );
  return results.some(Boolean);
}

/**
 * The OTLP analytics connectors `codemie proxy` reports on: Claude Code, Copilot CLI and Copilot Chat.
 * One table so `proxy status` (is any connector connected?) and `proxy analytics status` (what does
 * this connector collect?) share a single definition of each connector's detection, collection and
 * formatting.
 */

import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import {
  addCopilotConnectorProject,
  readCopilotConnectorScope,
  readCopilotConnectorScopeForAnalytics,
} from '@/agents/core/copilot-connector-scope.js';
import type { ConnectorScopeRead } from '@/agents/core/project-allowlist.js';
import { logger } from '@/utils/logger.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
import { addClaudeCodeOtlpProject, readClaudeCodeOtlpScope } from './connectors/claude-code-otlp-scope.js';
import { readDesktopGateway } from './connectors/desktop.js';
import type { DoctorRemedies } from './doctor/plan.js';
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

export type { ConnectorScopeRead };

export interface AnalyticsConnector {
  id: AnalyticsConnectorId;
  /** The connector's effective analytics configuration. */
  collect: () => Promise<AnalyticsConnectorStatus>;
  /** Renders a status produced by this same connector's `collect`. */
  format: (status: AnalyticsConnectorStatus, remedies: DoctorRemedies) => Promise<string>;
  /** Whether the connector is connected (hooks installed / scope enabled), whatever the collection preference. */
  isActive: () => Promise<boolean>;
  /** The connector's tracking scope from its own store; `{invalid}` when it cannot be read. Never throws. */
  readScope: () => Promise<ConnectorScopeRead>;
  /** Adds a project to the connector's own project list (project scope only). */
  addProject: (path: string) => Promise<void>;
}

interface ConnectorSpec<S extends AnalyticsConnectorStatus> {
  id: AnalyticsConnectorId;
  collect: () => Promise<S>;
  format: (status: S, remedies: DoctorRemedies) => Promise<string>;
  isActive: () => Promise<boolean>;
  readScope: () => Promise<ConnectorScopeRead>;
  addProject: (path: string) => Promise<void>;
}

/** `format` only ever receives the status its own `collect` returned, so the narrowing is sound. */
function connector<S extends AnalyticsConnectorStatus>(spec: ConnectorSpec<S>): AnalyticsConnector {
  return { ...spec, format: (status, remedies) => spec.format(status as S, remedies) };
}

function copilotConnector(id: AnalyticsConnectorId): AnalyticsConnector {
  return connector<CopilotAnalyticsStatus>({
    id,
    collect: () => collectCopilotAnalyticsStatus(id),
    format: formatCopilotAnalyticsStatus,
    isActive: async () => {
      const scope = await readCopilotConnectorScope(id);
      return scope.kind === 'ok' && scope.value.enabled;
    },
    readScope: () => readCopilotConnectorScopeForAnalytics(id),
    addProject: (path) => addCopilotConnectorProject(id, path),
  });
}

export const ANALYTICS_CONNECTORS: readonly AnalyticsConnector[] = [
  connector<ClaudeAnalyticsStatus>({
    id: CLAUDE_CODE_OTLP_AGENT_NAME,
    collect: collectClaudeAnalyticsStatus,
    format: formatClaudeAnalyticsStatus,
    isActive: () => hasClaudeCodeOtlpHooks(),
    readScope: readClaudeCodeOtlpScope,
    addProject: addClaudeCodeOtlpProject,
  }),
  copilotConnector(COPILOT_CLI_OTLP_AGENT_NAME),
  copilotConnector(COPILOT_CHAT_OTLP_AGENT_NAME),
];

/** The connectors that are connected, in table order. A check that fails counts as inactive; never throws. */
export async function listActiveAnalyticsConnectors(): Promise<AnalyticsConnector[]> {
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
  return ANALYTICS_CONNECTORS.filter((_, index) => results[index]);
}

/**
 * Whether any connector is connected, or Claude Desktop is connected to a local gateway (its Cowork
 * sessions go through the same delivery). A check that fails counts as inactive; never throws.
 */
export async function hasActiveAnalyticsConnector(): Promise<boolean> {
  if (await readDesktopGateway()) return true;
  return (await listActiveAnalyticsConnectors()).length > 0;
}

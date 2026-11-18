/**
 * The section builders of the `proxy doctor` composition (`compose.ts`) that read client and connector state:
 * connected clients and their config drift, analytics connectors, Claude Desktop collection, Claude Code's OTLP
 * endpoint and an older CLI on PATH. Each builder returns its sections and may throw; `guarded` turns a throw into
 * one section that still carries a fix hint.
 */
import { renderHint } from '@/utils/hint.js';
import { logger } from '@/utils/logger.js';
import { getClaudeSettingsPath } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { getCopilotConnectorsConfigPath } from '@/agents/core/copilot-connector-scope.js';
import type { DaemonState } from '../daemon-manager.js';
import { collectClientNotices, collectDesktopCollection } from '../analytics-delivery-lines.js';
import { CLIENT_TARGETS, type ClientTarget, type ClientTargetState } from '../client-targets.js';
import { findOlderCliOnPath } from '../connect-orchestrator.js';
import { checkClaudeCodeOtlpEndpoint } from '../connectors/claude-code-otlp-endpoint.js';
import { ANALYTICS_CONNECTORS, type AnalyticsConnectorStatus, type ConnectorScopeRead } from '../analytics-connectors.js';
import type { ProxyDoctorSection, ProxyDoctorSectionId } from './compose.js';

export const CONNECT_COMMAND = 'codemie proxy connect';
export const LOGIN_COMMAND = 'codemie profile login';
export const RESTART_COMMAND = 'codemie proxy restart';
export const START_COMMAND = 'codemie proxy start';
export const DOCTOR_COMMAND = 'codemie proxy doctor';
/** Re-runs the diagnosis with the debug log on, which records why a check could not run. */
export const DEBUG_COMMAND = `CODEMIE_DEBUG=true ${DOCTOR_COMMAND}`;
const ANALYTICS_STATUS_COMMAND = 'codemie proxy analytics status';

const CONNECTOR_LABELS: Record<string, string> = {
  'claude-code-otlp': 'Claude Code',
  'copilot-cli-otlp': 'Copilot CLI',
  'copilot-chat-otlp': 'Copilot Chat',
};

export type Sections = ProxyDoctorSection[];

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one section builder; a throw becomes a single section of `failStatus` naming the failure, with a hint. */
export async function guarded(
  id: ProxyDoctorSectionId,
  label: string,
  build: () => Promise<Sections>,
  failStatus: ProxyDoctorSection['status'] = 'error'
): Promise<Sections> {
  try {
    return await build();
  } catch (error) {
    logger.debug(`[proxy-doctor] ${id} check failed:`, error);
    return [{
      id,
      status: failStatus,
      message: `${label} check failed: ${errorText(error)}`,
      hint: renderHint({ reason: 'the check could not run', command: DEBUG_COMMAND }),
    }];
  }
}

export interface ConnectorEntry {
  id: string;
  status?: AnalyticsConnectorStatus;
  /** The tracking scope read through the connector's own store (`AnalyticsConnector.readScope`). */
  scope?: ConnectorScopeRead;
  error?: string;
}

export function isConnected(status: AnalyticsConnectorStatus): boolean {
  return 'hooksInstalled' in status ? status.hooksInstalled : status.connected;
}

export async function collectConnectors(): Promise<ConnectorEntry[]> {
  return Promise.all(ANALYTICS_CONNECTORS.map(async (connector): Promise<ConnectorEntry> => {
    try {
      const [status, scope] = await Promise.all([connector.collect(), connector.readScope()]);
      return { id: connector.id, status, scope };
    } catch (error) {
      logger.debug(`[proxy-doctor] ${connector.id} status failed:`, error);
      return { id: connector.id, error: errorText(error) };
    }
  }));
}

/** The connected targets of the client-target table, in table order. */
export function connectedTargets(states: ClientTargetState[] | null): ClientTarget[] {
  return (states ?? []).filter((state) => state.connected).map((state) => state.target);
}

/**
 * The `connect` flags that repeat a connector's current tracking scope, so a repair never resets a project list:
 * `--overwrite` for an invalid list, nothing when the scope is unknown.
 */
export function scopeFlags(scope: ConnectorScopeRead | undefined): string {
  if (!scope) return '';
  return 'invalid' in scope ? ' --overwrite' : ` --scope ${scope.scope}`;
}

/** The `connect` command that repairs a target; an analytics connector's repeats its current scope. */
function repairCommand(flag: string, id: string, connectors: ConnectorEntry[]): string {
  return `${CONNECT_COMMAND} ${flag}${scopeFlags(connectors.find((entry) => entry.id === id)?.scope)}`;
}

export function connectorSections(entries: ConnectorEntry[]): Sections {
  const sections: Sections = [];
  let anyConnected = false;
  for (const entry of entries) {
    const label = CONNECTOR_LABELS[entry.id] ?? entry.id;
    const flag = `--${entry.id}`;
    if (entry.error !== undefined) {
      sections.push({
        id: 'connectors',
        status: 'error',
        message: `${label} analytics check failed: ${entry.error}`,
        hint: renderHint({ reason: 'the connector state could not be read', command: DEBUG_COMMAND }),
      });
      continue;
    }
    const status = entry.status;
    const scope = entry.scope;
    if (!status || !scope) continue;
    const claudeEntry = 'hooksInstalled' in status;
    if ('invalid' in scope && !claudeEntry) {
      sections.push({
        id: 'connectors',
        status: 'warn',
        message: `${label} analytics: the connector settings cannot be read, so nothing is collected`,
        hint: renderHint({
          reason: 'unreadable connector settings',
          action: `fix or delete ${getCopilotConnectorsConfigPath()}, then run: ${CONNECT_COMMAND} ${flag}`,
        }),
      });
      continue;
    }
    if (!isConnected(status)) continue;
    anyConnected = true;
    if ('invalid' in scope) {
      sections.push({
        id: 'connectors',
        status: 'warn',
        message: `${label} analytics: the tracked-project list in ${getClaudeSettingsPath()} is invalid`,
        hint: renderHint({ reason: 'invalid tracked-project list', command: `${CONNECT_COMMAND} ${flag} --overwrite` }),
      });
    } else {
      const scopeText = scope.scope === 'project'
        ? `scope project (${scope.paths.length} tracked)`
        : 'scope user (all projects)';
      sections.push({ id: 'connectors', status: 'ok', message: `${label} analytics: connected, ${scopeText}` });
    }
    if (status.preferencesCorrupt) {
      sections.push({
        id: 'connectors',
        status: 'warn',
        message: `${label} analytics: preferences cannot be read (${status.preferencesPath})`,
        hint: renderHint({ reason: 'unreadable analytics preferences', action: `fix or delete ${status.preferencesPath}` }),
      });
    } else if (!status.enabled) {
      sections.push({
        id: 'connectors',
        status: 'info',
        message: `${label} analytics: collection is paused`,
        hint: renderHint({ reason: 'collection paused', command: `codemie proxy analytics enable ${flag}` }),
      });
    }
  }
  if (anyConnected) {
    sections.push({
      id: 'connectors',
      status: 'info',
      message: 'Tracked and excluded projects of each connector are listed by the analytics status',
      hint: renderHint({ reason: 'to see the project lists', command: ANALYTICS_STATUS_COMMAND }),
    });
  }
  return sections;
}

export async function cliPathSections(): Promise<Sections> {
  const older = await findOlderCliOnPath();
  if (!older) return [];
  return [{
    id: 'cli-path',
    status: 'warn',
    message: `An older CodeMie CLI is first on PATH: ${older.path} (${older.version}); its hooks start an older proxy`,
    hint: renderHint({ reason: 'older CLI first on PATH', action: 'update or remove it, or put this install first on PATH' }),
  }];
}

function labelOfFlag(flag: string): string {
  return CLIENT_TARGETS.find((target) => target.flag === flag)?.label ?? flag;
}

export async function clientSections(
  state: DaemonState,
  targets: ClientTargetState[] | null,
  connectors: ConnectorEntry[],
  nothingConnected: boolean
): Promise<Sections> {
  const notices = await collectClientNotices(state);
  const sections: Sections = [];
  for (const failed of (targets ?? []).filter((entry) => entry.error !== undefined)) {
    sections.push({
      id: 'clients',
      status: 'warn',
      message: `${failed.target.label} check failed: ${failed.error}`,
      hint: renderHint({ reason: 'its config could not be read', command: repairCommand(failed.target.flag, failed.target.id, connectors) }),
    });
  }
  for (const mismatch of notices.clientPortMismatch) {
    sections.push({
      id: 'clients',
      status: 'warn',
      message: `${labelOfFlag(mismatch.flag)} points at port ${mismatch.configuredPort}, the proxy listens on ${state.port}`,
      hint: renderHint({ reason: 'client points at another port', command: `${CONNECT_COMMAND} ${mismatch.flag}` }),
    });
  }
  for (const shared of notices.clientSharedKey) {
    sections.push(shared.refused
      ? {
        id: 'clients',
        status: 'warn',
        message: `${labelOfFlag(shared.flag)} points at a local gateway with a key this proxy does not accept`,
        hint: renderHint({ reason: 'key not accepted', action: `if it should use CodeMie, run: ${CONNECT_COMMAND} ${shared.flag}` }),
      }
      : {
        id: 'clients',
        status: 'warn',
        message: `${labelOfFlag(shared.flag)} uses the shared key`,
        hint: renderHint({ reason: 'shared key in use', command: `${CONNECT_COMMAND} ${shared.flag}` }),
      });
  }
  for (const hooks of notices.hooksOfAnotherInstall) {
    sections.push({
      id: 'clients',
      status: 'warn',
      message: `${CONNECTOR_LABELS[hooks.connector] ?? hooks.connector} hooks run another install (${hooks.path})`,
      hint: renderHint({ reason: 'hooks of another install', command: repairCommand(hooks.flag, hooks.connector, connectors) }),
    });
  }
  if (sections.length > 0) return sections;
  const connected = connectedTargets(targets);
  if (connected.length > 0) {
    return [{ id: 'clients', status: 'ok', message: `Clients connected: ${connected.map((target) => target.label).join(', ')}` }];
  }
  return [{
    id: 'clients',
    status: 'info',
    message: 'No clients connected',
    ...(nothingConnected && { hint: renderHint({ reason: 'nothing is connected to the proxy', command: CONNECT_COMMAND }) }),
  }];
}

export async function desktopSections(state: DaemonState): Promise<Sections> {
  const desktop = await collectDesktopCollection(state);
  if (!desktop) return [];
  if (desktop.collecting) {
    return [{ id: 'desktop', status: 'ok', message: 'Claude Desktop: collecting' }];
  }
  const command = desktop.remedy?.replace(/^run:\s*/, '');
  return [{
    id: 'desktop',
    status: 'warn',
    message: `Claude Desktop: not collecting — ${desktop.reason ?? 'unknown reason'}`,
    ...(command && { hint: renderHint({ reason: 'Desktop is not collecting', command }) }),
  }];
}

export async function claudeOtlpSections(state: DaemonState, claudeScope: ConnectorScopeRead | undefined): Promise<Sections> {
  const check = await checkClaudeCodeOtlpEndpoint(state);
  if (!check) return [];
  if (check.matches) {
    return [{ id: 'claude-code-otlp', status: 'ok', message: 'Claude Code OTLP endpoint: points at this proxy' }];
  }
  const keyOnly = check.configured === check.expected;
  return [{
    id: 'claude-code-otlp',
    status: 'error',
    message: (keyOnly
      ? 'The gateway key in Claude Code OTEL_EXPORTER_OTLP_HEADERS does not match this proxy; native OTel is rejected'
      : `Claude Code OTLP endpoint ${check.configured} does not match this proxy (${check.expected}); native OTel is not reaching it`) +
      '. After repairing, start a new Claude Code session.',
    hint: renderHint({
      reason: 'Claude Code exports to another proxy',
      command: `${CONNECT_COMMAND} --claude-code-otlp${scopeFlags(claudeScope)}`,
    }),
  }];
}

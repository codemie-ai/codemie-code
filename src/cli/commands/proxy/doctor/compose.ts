/**
 * The `proxy doctor` composition: one report built from the existing read-only proxy collectors, shared by
 * `codemie proxy doctor` and the condensed proxy check of `codemie doctor`.
 *
 * Daemon contact rules: the state is read with `readDaemonStatus` (never `checkStatus`, which deletes state);
 * every `/health` read is checked against `state.pid`; when that reply says the daemon awaits a sign-in
 * (`analytics.credentials === 'stale'`) no keyed request is made, because an awaiting-login daemon opens a
 * browser sign-in on any keyed request. Each section is built in isolation, so a collector that throws becomes an
 * `error` section (`warn` for the verbose detail) and `composeProxyDoctor` itself never rejects. The gateway key
 * never appears in the report.
 */
import type { HealthCheckDetail } from '../../doctor/types.js';
import { renderHint } from '@/utils/hint.js';
import { logger } from '@/utils/logger.js';
import { getClaudeSettingsPath } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { getCopilotConnectorsConfigPath } from '@/agents/core/copilot-connector-scope.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { readDaemonStatus, type DaemonState } from '../daemon-manager.js';
import {
  checkProxyHealth,
  DEEP_TIMEOUT_MS,
  fetchProxyHealth,
  parseAnalyticsReply,
  SHALLOW_TIMEOUT_MS,
  type ProxyHealthResult,
} from '../health-check.js';
import { collectClientNotices, collectDesktopCollection } from '../analytics-delivery-lines.js';
import { CLIENT_TARGETS, readClientTargetStates, type ClientTarget, type ClientTargetState } from '../client-targets.js';
import { collectDeliveryHealth, DELIVERY_REASONS, unknownHint } from '../delivery-health.js';
import { findOlderCliOnPath } from '../connect-orchestrator.js';
import { checkClaudeCodeOtlpEndpoint } from '../connectors/claude-code-otlp-endpoint.js';
import { ANALYTICS_CONNECTORS, type AnalyticsConnectorStatus, type ConnectorScopeRead } from '../analytics-connectors.js';
import type { inspectDesktopProxy } from '../inspect-desktop.js';

/**
 * Stable section ids. An id repeats when a section has several findings (one entry per finding).
 * - `daemon`: the daemon state and its pid-checked `/health`
 * - `auth`: CodeMie sign-in, from `/health` and, when allowed, the authenticated probe
 * - `upstream`: whether the authenticated probe reached CodeMie
 * - `clients`: the connected targets of the client-target table, client configs (port, key) and hooks of another install
 * - `delivery`: analytics delivery to CodeMie
 * - `desktop`: Claude Desktop collection
 * - `claude-code-otlp`: Claude Code's native OTLP endpoint against the live daemon
 * - `connectors`: analytics connectors' scope and collection preferences
 * - `cli-path`: an older CodeMie CLI first on PATH
 * - `verbose`: a failure while gathering the `--verbose` detail
 */
export type ProxyDoctorSectionId =
  | 'daemon'
  | 'auth'
  | 'upstream'
  | 'clients'
  | 'delivery'
  | 'desktop'
  | 'claude-code-otlp'
  | 'connectors'
  | 'cli-path'
  | 'verbose';

export interface ProxyDoctorSection extends HealthCheckDetail {
  id: ProxyDoctorSectionId;
}

export interface ProxyDoctorDesktopSession {
  externalSessionId: string;
  workingDirectory: string;
  createdAt: number;
  updatedAt: number;
  ingested: boolean;
  sessionStatus: string;
  reasons: string[];
}

/** The `--verbose` detail: Desktop inspection without the daemon state, plus the config files the report reads. */
export interface ProxyDoctorVerbose {
  desktop?: {
    directories: { base: string; localSessions: string; codeSessions: string };
    sessions: ProxyDoctorDesktopSession[];
    hasCredentials: boolean;
    credentialsUrl?: string;
  };
  configPaths: {
    claudeSettings: string;
    copilotConnectors: string;
    preferences: Record<string, string>;
  };
}

export interface ProxyDoctorReport {
  sections: ProxyDoctorSection[];
  /** No client and no analytics connector is connected; the report is then informational only. */
  nothingConnected: boolean;
  verbose?: ProxyDoctorVerbose;
}

export interface ProxyDoctorOptions {
  /** Run the authenticated upstream probe (one keyed request) when the daemon is running and signed in. */
  authProbe: boolean;
  verbose: boolean;
}

/** Upper bound of the authenticated probe: its `/health` read plus its keyed request. */
export const AUTH_PROBE_TIMEOUT_MS = SHALLOW_TIMEOUT_MS + DEEP_TIMEOUT_MS;

const CONNECT_COMMAND = 'codemie proxy connect';
const LOGIN_COMMAND = 'codemie profile login';
const RESTART_COMMAND = 'codemie proxy restart';
const START_COMMAND = 'codemie proxy start';

const CONNECTOR_LABELS: Record<string, string> = {
  'claude-code-otlp': 'Claude Code',
  'copilot-cli-otlp': 'Copilot CLI',
  'copilot-chat-otlp': 'Copilot Chat',
};

type Sections = ProxyDoctorSection[];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one section builder; a throw becomes a single section of `failStatus` naming the failure. */
async function guarded(
  id: ProxyDoctorSectionId,
  label: string,
  build: () => Promise<Sections>,
  failStatus: ProxyDoctorSection['status'] = 'error'
): Promise<Sections> {
  try {
    return await build();
  } catch (error) {
    logger.debug(`[proxy-doctor] ${id} check failed:`, error);
    return [{ id, status: failStatus, message: `${label} check failed: ${errorText(error)}` }];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface ConnectorEntry {
  id: string;
  status?: AnalyticsConnectorStatus;
  /** The tracking scope read through the connector's own store (`AnalyticsConnector.readScope`). */
  scope?: ConnectorScopeRead;
  error?: string;
}

function isConnected(status: AnalyticsConnectorStatus): boolean {
  return 'hooksInstalled' in status ? status.hooksInstalled : status.connected;
}

async function collectConnectors(): Promise<ConnectorEntry[]> {
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
function connectedTargets(states: ClientTargetState[] | null): ClientTarget[] {
  return (states ?? []).filter((state) => state.connected).map((state) => state.target);
}

function connectorSections(entries: ConnectorEntry[]): Sections {
  const sections: Sections = [];
  for (const entry of entries) {
    const label = CONNECTOR_LABELS[entry.id] ?? entry.id;
    const flag = `--${entry.id}`;
    if (entry.error !== undefined) {
      sections.push({ id: 'connectors', status: 'error', message: `${label} analytics check failed: ${entry.error}` });
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
  return sections;
}

async function cliPathSections(): Promise<Sections> {
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

async function clientSections(state: DaemonState, targets: ClientTargetState[] | null, nothingConnected: boolean): Promise<Sections> {
  const notices = await collectClientNotices(state);
  const sections: Sections = [];
  for (const failed of (targets ?? []).filter((entry) => entry.error !== undefined)) {
    sections.push({ id: 'clients', status: 'warn', message: `${failed.target.label} check failed: ${failed.error}` });
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
      hint: renderHint({ reason: 'hooks of another install', command: `${CONNECT_COMMAND} ${hooks.flag}` }),
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

async function deliverySections(state: DaemonState, reply: AnalyticsHealthReply | undefined): Promise<Sections> {
  const health = await collectDeliveryHealth(state, reply);
  if (health.status === 'healthy') {
    return [{ id: 'delivery', status: 'ok', message: 'Analytics delivery: healthy' }];
  }
  if (health.status === 'unhealthy') {
    const entry = health.reason ? DELIVERY_REASONS[health.reason] : undefined;
    return [{
      id: 'delivery',
      status: entry?.command ? 'error' : 'warn',
      message: `Analytics delivery: unhealthy${entry ? ` (${entry.label})` : ''}`,
      ...(entry?.command && { hint: renderHint({ reason: entry.label, command: entry.command }) }),
    }];
  }
  return [{ id: 'delivery', status: 'info', message: `Analytics delivery: unknown (${unknownHint(health)})` }];
}

async function desktopSections(state: DaemonState): Promise<Sections> {
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

/** The `connect` flags that repeat Claude Code's current tracking scope. */
function claudeScopeFlags(scope: ConnectorScopeRead | undefined): string {
  if (!scope) return '';
  return 'invalid' in scope ? ' --overwrite' : ` --scope ${scope.scope}`;
}

async function claudeOtlpSections(state: DaemonState, claudeScope: ConnectorScopeRead | undefined): Promise<Sections> {
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
      command: `${CONNECT_COMMAND} --claude-code-otlp${claudeScopeFlags(claudeScope)}`,
    }),
  }];
}

interface DaemonContact {
  sections: Sections;
  /** The daemon answered `/health` with its own pid. */
  verified: boolean;
  reply?: AnalyticsHealthReply;
}

async function contactDaemon(state: DaemonState): Promise<DaemonContact> {
  let body: unknown;
  try {
    const res = await fetchProxyHealth(state.port);
    if (!res.ok) {
      return {
        verified: false,
        sections: [{
          id: 'daemon',
          status: 'error',
          message: `Proxy health endpoint returned ${res.status}`,
          hint: renderHint({ reason: 'the proxy is not healthy', command: RESTART_COMMAND }),
        }],
      };
    }
    body = await res.json().catch(() => undefined);
  } catch (error) {
    return {
      verified: false,
      sections: [{
        id: 'daemon',
        status: 'error',
        message: `Proxy not responding on ${state.url}: ${errorText(error)}`,
        hint: renderHint({ reason: 'the proxy is not responding', command: RESTART_COMMAND }),
      }],
    };
  }
  const replyPid = typeof body === 'object' && body !== null ? (body as { pid?: unknown }).pid : undefined;
  if (replyPid !== state.pid) {
    return {
      verified: false,
      sections: [{
        id: 'daemon',
        status: 'error',
        message: typeof replyPid === 'number'
          ? `Port ${state.port} is answered by another process (pid ${replyPid}), not the proxy (pid ${state.pid})`
          : `The process on port ${state.port} did not confirm it is the proxy (pid ${state.pid})`,
        hint: renderHint({ reason: 'the proxy does not own its port', command: RESTART_COMMAND }),
      }],
    };
  }
  const running = `Running at ${state.url} (pid ${state.pid}, profile ${state.profile}`;
  const daemon: ProxyDoctorSection = state.version
    ? { id: 'daemon', status: 'ok', message: `${running}, version ${state.version})` }
    : {
      id: 'daemon',
      status: 'warn',
      message: `${running}, started by an older CLI)`,
      hint: renderHint({ reason: 'older proxy', command: RESTART_COMMAND }),
    };
  return { verified: true, sections: [daemon], reply: parseAnalyticsReply(body, state.pid) };
}

async function authSections(state: DaemonState, reply: AnalyticsHealthReply | undefined, authProbe: boolean): Promise<Sections> {
  const loginHint = renderHint({ reason: 'CodeMie sign-in required', command: LOGIN_COMMAND });
  if (reply?.credentials === 'stale') {
    // An awaiting-login daemon opens a browser sign-in on any keyed request: never probe it.
    return [{ id: 'auth', status: 'error', message: 'CodeMie sign-in has expired; the proxy is waiting for a sign-in', hint: loginHint }];
  }
  if (!authProbe) {
    return reply?.credentials === 'ok'
      ? [{ id: 'auth', status: 'ok', message: 'Signed in to CodeMie' }]
      : [{ id: 'auth', status: 'info', message: 'Sign-in state not reported by this proxy' }];
  }
  let probe: ProxyHealthResult;
  try {
    probe = await withTimeout(
      checkProxyHealth({ port: state.port, gatewayKey: state.gatewayKey, deep: true, expectedPid: state.pid }),
      AUTH_PROBE_TIMEOUT_MS,
      `no answer within ${AUTH_PROBE_TIMEOUT_MS / 1000}s`
    );
  } catch (error) {
    return [{ id: 'upstream', status: 'error', message: `Authenticated check failed: ${errorText(error)}` }];
  }
  if (probe.healthy) {
    return [
      { id: 'auth', status: 'ok', message: 'Signed in to CodeMie' },
      { id: 'upstream', status: 'ok', message: 'CodeMie reachable through the proxy' },
    ];
  }
  if (probe.code === 'unauthorized') {
    return [{ id: 'auth', status: 'error', message: 'CodeMie rejected the proxy\'s sign-in', hint: loginHint }];
  }
  return [{
    id: 'upstream',
    status: 'error',
    message: probe.reason ?? 'CodeMie did not answer the authenticated check',
    hint: renderHint({ reason: 'CodeMie unreachable', action: 'check your network or VPN, then run the check again' }),
  }];
}

function stoppedSections(nothingConnected: boolean, targets: ClientTargetState[] | null): Sections {
  if (nothingConnected) {
    return [{
      id: 'daemon',
      status: 'info',
      message: 'Proxy is not running',
      hint: renderHint({ reason: 'nothing is connected to the proxy', command: CONNECT_COMMAND }),
    }];
  }
  // Hook-based connectors start the proxy on their next event; every other connected target needs it running.
  const clients = connectedTargets(targets).filter((target) => !target.readHookInstall);
  const startHint = renderHint({ reason: 'the proxy is stopped', command: START_COMMAND });
  return clients.length > 0
    ? [{
      id: 'daemon',
      status: 'error',
      message: `Proxy is not running; set up to use it: ${clients.map((c) => c.label).join(', ')}`,
      hint: startHint,
    }]
    : [{
      id: 'daemon',
      status: 'warn',
      message: 'Proxy is not running; analytics hooks start it on their next event',
      hint: startHint,
    }];
}

async function collectVerbose(
  running: boolean,
  state: DaemonState | null,
  connectors: ConnectorEntry[]
): Promise<{ verbose: ProxyDoctorVerbose; sections: Sections }> {
  const preferences: Record<string, string> = {};
  for (const entry of connectors) {
    if (entry.status) preferences[entry.id] = entry.status.preferencesPath;
  }
  const verbose: ProxyDoctorVerbose = {
    configPaths: { claudeSettings: getClaudeSettingsPath(), copilotConnectors: getCopilotConnectorsConfigPath(), preferences },
  };
  const sections = await guarded('verbose', 'Claude Desktop inspection', async () => {
    // Loaded on demand: the inspection pulls in the session store and SSO modules.
    const { inspectDesktopProxy: inspect } = await import('../inspect-desktop.js');
    verbose.desktop = mapDesktopInspection(await inspect(running, state));
    return [];
  }, 'warn');
  return { verbose, sections };
}

function mapDesktopInspection(result: Awaited<ReturnType<typeof inspectDesktopProxy>>): NonNullable<ProxyDoctorVerbose['desktop']> {
  return {
    directories: { base: result.desktopBaseDir, localSessions: result.localSessionsRoot, codeSessions: result.codeSessionsRoot },
    sessions: result.sessions.map((session) => ({
      externalSessionId: session.discovered.externalSessionId,
      workingDirectory: session.discovered.workingDirectory,
      createdAt: session.discovered.createdAt,
      updatedAt: session.discovered.updatedAt,
      ingested: Boolean(session.codemieSessionId && session.metricsFileExists && session.conversationFileExists),
      sessionStatus: session.sessionStatus,
      reasons: session.reasons,
    })),
    hasCredentials: result.hasCredentials,
    ...(result.credentialsUrl && { credentialsUrl: result.credentialsUrl }),
  };
}

/** Replaces any accidental occurrence of the gateway key in the report's text. */
function scrubKey(sections: Sections, key: string | undefined): Sections {
  if (!key) return sections;
  const scrub = (text: string): string => text.split(key).join('***');
  return sections.map((section) => ({
    ...section,
    message: scrub(section.message),
    ...(section.hint !== undefined && { hint: scrub(section.hint) }),
  }));
}

/** One sign-in message: drops the delivery `credentials_expired` section when `auth` already reports an error. */
function dropDuplicateSignIn(sections: Sections): Sections {
  if (!sections.some((s) => s.id === 'auth' && s.status === 'error')) return sections;
  const label = DELIVERY_REASONS.credentials_expired.label;
  return sections.filter((s) => !(s.id === 'delivery' && s.message.includes(label)));
}

/** Builds the proxy diagnosis. Never rejects. */
export async function composeProxyDoctor(opts: ProxyDoctorOptions): Promise<ProxyDoctorReport> {
  const sections: Sections = [];
  let running = false;
  let state: DaemonState | null = null;
  try {
    ({ running, state } = await readDaemonStatus());
  } catch (error) {
    sections.push({ id: 'daemon', status: 'error', message: `Proxy state could not be read: ${errorText(error)}` });
  }
  if (!running) state = null;

  const [connectors, targets] = await Promise.all([
    collectConnectors(),
    readClientTargetStates().catch((error: unknown): null => {
      sections.push({ id: 'clients', status: 'error', message: `Client configs check failed: ${errorText(error)}` });
      return null;
    }),
  ]);
  const anyConnector = connectors.some((entry) => entry.status && isConnected(entry.status));
  const nothingConnected = targets !== null && connectedTargets(targets).length === 0 && !anyConnector &&
    !targets.some((entry) => entry.error !== undefined) &&
    !connectors.some((entry) => entry.error !== undefined);
  const claudeScope = connectors.find((entry) => entry.status && 'hooksInstalled' in entry.status)?.scope;

  if (!state) {
    if (!sections.some((s) => s.id === 'daemon')) {
      sections.push(...stoppedSections(nothingConnected, targets));
    }
    sections.push(...connectorSections(connectors));
    sections.push(...(await guarded('cli-path', 'CLI path', cliPathSections)));
  } else {
    const live = state;
    let verifiedReply: AnalyticsHealthReply | undefined;
    const contact = await guarded('daemon', 'Proxy health', async () => {
      const result = await contactDaemon(live);
      if (!result.verified) return result.sections;
      verifiedReply = result.reply;
      return [...result.sections, ...(await guarded('auth', 'Sign-in', () => authSections(live, result.reply, opts.authProbe)))];
    });
    sections.push(...contact);
    const analyticsActive = anyConnector || connectedTargets(targets).some((target) => target.carriesAnalytics);
    const rest = await Promise.all([
      guarded('clients', 'Clients', () => clientSections(live, targets, nothingConnected)),
      analyticsActive ? guarded('delivery', 'Analytics delivery', () => deliverySections(live, verifiedReply)) : Promise.resolve([]),
      guarded('desktop', 'Claude Desktop', () => desktopSections(live)),
      guarded('claude-code-otlp', 'Claude Code OTLP endpoint', () => claudeOtlpSections(live, claudeScope)),
      Promise.resolve(connectorSections(connectors)),
      guarded('cli-path', 'CLI path', cliPathSections),
    ]);
    for (const group of rest) sections.push(...group);
  }

  const report: ProxyDoctorReport = { sections: [], nothingConnected };
  if (opts.verbose) {
    const detail = await collectVerbose(running, state, connectors);
    report.verbose = detail.verbose;
    sections.push(...detail.sections);
  }
  report.sections = scrubKey(dropDuplicateSignIn(sections), state?.gatewayKey);
  return report;
}

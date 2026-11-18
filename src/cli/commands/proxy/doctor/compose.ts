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
import { readClientTargetStates, type ClientTargetState } from '../client-targets.js';
import { DELIVERY_REASONS } from '../delivery-health.js';
import type { inspectDesktopProxy } from '../inspect-desktop.js';
import {
  CONNECT_COMMAND,
  DEBUG_COMMAND,
  LOGIN_COMMAND,
  RESTART_COMMAND,
  START_COMMAND,
  claudeOtlpSections,
  clientSections,
  cliPathSections,
  collectConnectors,
  connectedTargets,
  connectorSections,
  desktopSections,
  errorText,
  guarded,
  isConnected,
  type ConnectorEntry,
  type Sections,
} from './sections.js';
import { deliverySections } from './delivery-sections.js';

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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface DaemonContact {
  sections: Sections;
  /** The daemon answered `/health` with its own pid. */
  verified: boolean;
  reply?: AnalyticsHealthReply;
}

/** The last problem the daemon's own watcher recorded in its state, when it marked itself unhealthy. */
function recordedHealthIssue(state: DaemonState): Sections {
  if (state.health !== 'unhealthy' || !state.healthReason) return [];
  return [{
    id: 'daemon',
    status: 'warn',
    message: `The proxy recorded a health problem: ${state.healthReason}`,
    hint: renderHint({ reason: 'the proxy reported itself unhealthy', command: RESTART_COMMAND }),
  }];
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
  const recorded = recordedHealthIssue(state);
  const daemon: ProxyDoctorSection = state.version
    ? { id: 'daemon', status: 'ok', message: `${running}, version ${state.version})` }
    : {
      id: 'daemon',
      status: 'warn',
      message: `${running}, started by an older CLI)`,
      hint: renderHint({ reason: 'older proxy', command: RESTART_COMMAND }),
    };
  return { verified: true, sections: [daemon, ...recorded], reply: parseAnalyticsReply(body, state.pid) };
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
    return [{
      id: 'upstream',
      status: 'error',
      message: `Authenticated check failed: ${errorText(error)}`,
      hint: renderHint({ reason: 'the proxy did not answer the authenticated check', command: RESTART_COMMAND }),
    }];
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

/**
 * One sign-in message: when `auth` already reports an error and the delivery verdict is `credentials_expired`, the
 * delivery group (verdict and its facts) is dropped; the facts only restate what signing in clears.
 */
function dropDuplicateSignIn(sections: Sections): Sections {
  if (!sections.some((s) => s.id === 'auth' && s.status === 'error')) return sections;
  const label = DELIVERY_REASONS.credentials_expired.label;
  if (!sections.some((s) => s.id === 'delivery' && s.message.includes(label))) return sections;
  return sections.filter((s) => s.id !== 'delivery');
}

/** Builds the proxy diagnosis. Never rejects. */
export async function composeProxyDoctor(opts: ProxyDoctorOptions): Promise<ProxyDoctorReport> {
  const sections: Sections = [];
  let running = false;
  let state: DaemonState | null = null;
  try {
    ({ running, state } = await readDaemonStatus());
  } catch (error) {
    sections.push({
      id: 'daemon',
      status: 'error',
      message: `Proxy state could not be read: ${errorText(error)}`,
      hint: renderHint({ reason: 'the proxy state file is unreadable', command: RESTART_COMMAND }),
    });
  }
  if (!running) state = null;

  const [connectors, targets] = await Promise.all([
    collectConnectors(),
    readClientTargetStates().catch((error: unknown): null => {
      sections.push({
        id: 'clients',
        status: 'error',
        message: `Client configs check failed: ${errorText(error)}`,
        hint: renderHint({ reason: 'the client configs could not be read', command: DEBUG_COMMAND }),
      });
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
      guarded('clients', 'Clients', () => clientSections(live, targets, connectors, nothingConnected)),
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

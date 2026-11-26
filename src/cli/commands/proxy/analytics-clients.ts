import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import {
  isDesktopConnectedTo,
  isDesktopPointedAtLocalProxy,
  readDesktopGatewayConfig,
  type DesktopGateway,
} from '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js';
import { getClaudeDesktopAppCandidates } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { CodeMieError, ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { resolveHomeDir } from '@/utils/paths.js';
import { getCommandPath } from '@/utils/processes.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { renderHint } from '@/utils/hint.js';
import { ANALYTICS_CONNECTORS, type AnalyticsConnectorId } from './analytics-connectors.js';
import { CLAUDE_CODE_OTLP_LABEL } from './claude-code-otlp-flow.js';
import type { DoctorRemedies } from './doctor/plan.js';
import { CLAUDE_OTLP_FLAG, COPILOT_OTLP_FLAG, vendorFlag, type FlagRow } from './flag-list.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
import { readCodeMieDesktopGateway, readDesktopGateway } from './connectors/desktop.js';
import { readVsCodeClaudeCodeGateway } from './connectors/vscode-claude-code.js';
import { getVsCodeProductDir, type ConnectorGateway } from './connectors/vscode.js';
import type { DaemonState } from './daemon-manager.js';
import type { ConnectTargets, TargetResult } from './connect-orchestrator.js';

/** A `which` / `where.exe` lookup still running at this deadline is killed and counts as found. */
export const APPLICATION_LOOKUP_TIMEOUT_MS = 3000;

/** The `proxy connect` targets an analytics aggregate sets (keys of `ConnectTargets`). */
export type AnalyticsMember =
  | 'claudeDesktop'
  | 'vscodeClaudeCode'
  | 'claudeCodeOtlp'
  | 'copilotChatOtlp'
  | 'copilotCliOtlp';

export type AggregateId = 'claude-otlp' | 'copilot-otlp';

export interface AnalyticsAggregate {
  id: AggregateId;
  flag: string;
  option: 'claudeOtlp' | 'copilotOtlp';
  members: readonly AnalyticsMember[];
  connectDescription: string;
  disconnectDescription: string;
  /** The text of its row in the bare-connect target list: one short line. */
  connectListLine: string;
  /** The text of its line in the bare-disconnect target list. */
  disconnectListLine: string;
}

export const ANALYTICS_AGGREGATES: readonly AnalyticsAggregate[] = [
  {
    id: 'claude-otlp',
    flag: CLAUDE_OTLP_FLAG,
    option: 'claudeOtlp',
    members: ['claudeDesktop', 'vscodeClaudeCode', 'claudeCodeOtlp'],
    connectDescription:
      'Analytics for every Claude client, found on this machine or not — Claude Code, the VS Code Claude Code extension, ' +
      'Claude Desktop; the extension and Desktop are routed through the proxy only when they are not configured yet ' +
      `(--vscode-claude-code / --claude-desktop route them explicitly), and codemie proxy disconnect ${CLAUDE_OTLP_FLAG} gives them back their Claude login`,
    disconnectDescription:
      'Turn off analytics for every Claude client and remove the CodeMie proxy route of Claude Desktop and the ' +
      'VS Code Claude Code extension',
    connectListLine: 'Analytics for every Claude client: Claude Code, VS Code, Desktop',
    disconnectListLine: 'Every Claude client (analytics, and the Desktop/VS Code proxy route)',
  },
  {
    id: 'copilot-otlp',
    flag: COPILOT_OTLP_FLAG,
    option: 'copilotOtlp',
    members: ['copilotChatOtlp', 'copilotCliOtlp'],
    connectDescription:
      'Analytics for every Copilot client, found on this machine or not — Copilot Chat and Copilot CLI',
    disconnectDescription: 'Turn off analytics for Copilot Chat and Copilot CLI',
    connectListLine: 'Analytics for every Copilot client: Copilot Chat, Copilot CLI',
    disconnectListLine: 'Every Copilot client (Copilot Chat and Copilot CLI analytics)',
  },
];

/** The members of the aggregates given. */
export function membersOf(aggregates: readonly AggregateId[]): ReadonlySet<AnalyticsMember> {
  return new Set(ANALYTICS_AGGREGATES.filter((a) => aggregates.includes(a.id)).flatMap((a) => a.members));
}

/** The flags of the aggregates given, in the order of {@link ANALYTICS_AGGREGATES}. */
export function aggregateFlags(aggregates: readonly AggregateId[]): string {
  return ANALYTICS_AGGREGATES.filter((a) => aggregates.includes(a.id)).map((a) => a.flag).join(' ');
}

/** The flag of the aggregate that holds `member`. */
export function aggregateFlagOf(member: AnalyticsMember): string {
  const aggregate = ANALYTICS_AGGREGATES.find((a) => a.members.includes(member));
  if (!aggregate) throw new CodeMieError(`No analytics aggregate holds ${member}`);
  return aggregate.flag;
}

/** The rows of the aggregates in a bare-command target list: the flag and its one-line text. */
export function aggregateListRows(text: (a: AnalyticsAggregate) => string): FlagRow[] {
  return ANALYTICS_AGGREGATES.map((a) => [a.flag, text(a)] as const);
}

/** The aggregates' lines in the bare-connect examples. */
export function aggregateConnectExamples(): string[] {
  return ANALYTICS_AGGREGATES.map((a) => `  codemie proxy connect ${a.flag}`);
}

export const MEMBER_FLAGS: Record<AnalyticsMember, string> = {
  claudeDesktop: '--claude-desktop',
  vscodeClaudeCode: '--vscode-claude-code',
  claudeCodeOtlp: `--${CLAUDE_CODE_OTLP_AGENT_NAME}`,
  copilotChatOtlp: `--${COPILOT_CHAT_OTLP_AGENT_NAME}`,
  copilotCliOtlp: `--${COPILOT_CLI_OTLP_AGENT_NAME}`,
};

/**
 * The flag that names `member` in a printed command: its aggregate's when an aggregate given holds it, else its own
 * flag's vendor flag (a per-connector analytics flag is deprecated for its vendor flag).
 */
export function memberFlag(member: AnalyticsMember, members: ReadonlySet<AnalyticsMember>): string {
  return members.has(member) ? aggregateFlagOf(member) : vendorFlag(MEMBER_FLAGS[member]);
}

/** `flags` led by the flags of the aggregates given, which stand in for their members' flags. */
export function withAggregateFlags(flags: string[], aggregates: readonly AggregateId[]): string[] {
  if (aggregates.length === 0) return flags;
  const replaced = new Set([...membersOf(aggregates)].map((member) => MEMBER_FLAGS[member]));
  return [aggregateFlags(aggregates), ...flags.filter((f) => !replaced.has(f))];
}

export interface AnalyticsClientRow {
  client: 'claude-code' | 'vscode-claude-code' | 'claude-desktop' | 'copilot-chat' | 'copilot-cli';
  label: string;
  found: boolean;
  /** Its analytics are on: the hooks for Claude Code and the extension, the gateway for Desktop, the scope for Copilot. */
  connected: boolean;
  flag: string;
  /** Desktop's applied config is a loopback gateway with a key this proxy does not accept. */
  otherGateway: boolean;
  /** Its model requests go through the proxy: the extension's route, Desktop's gateway. */
  routed: boolean;
}

/** A lookup that fails counts as found: a member is never skipped, nor a row shown `not found`, on a guess. */
async function lookup(name: string, find: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await find();
  } catch (error) {
    logger.debug(`[proxy] ${name} lookup failed; counted as found`, ...sanitizeLogArgs(error));
    return true;
  }
}

/** A reader that fails reads as not connected. */
async function read<T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.debug(`[proxy] ${name} read failed`, ...sanitizeLogArgs(error));
    return fallback;
  }
}

/** On PATH, or the native installer's binary; the client itself is never run. A lookup with no answer counts as found. */
function findClaudeCodeBinary(): Promise<boolean> {
  return lookup('Claude Code binary', async () =>
    (await getCommandPath('claude', APPLICATION_LOOKUP_TIMEOUT_MS, { throwIfUnanswered: true })) !== null
    || (process.platform !== 'win32' && existsSync(resolveHomeDir('.local/bin/claude'))));
}

/**
 * A `CODEMIE_COPILOT_BIN` that is a path (absolute, or holding `/`, or `\` on Windows) is resolved against the current
 * directory and checked as a file: `where.exe` matches neither an absolute nor a relative path. Only a bare command name
 * is looked up on `PATH`; a lookup with no answer counts as found.
 */
function findCopilotCliBinary(): Promise<boolean> {
  const bin = process.env.CODEMIE_COPILOT_BIN || 'copilot';
  const isPath = isAbsolute(bin) || bin.includes('/') || (process.platform === 'win32' && bin.includes('\\'));
  return lookup('Copilot CLI binary', async () => isPath
    ? existsSync(resolve(bin))
    : (await getCommandPath(bin, APPLICATION_LOOKUP_TIMEOUT_MS, { throwIfUnanswered: true })) !== null);
}

function findVsCodeDir(insiders: boolean): Promise<boolean> {
  return lookup('VS Code user-data directory', () => existsSync(getVsCodeProductDir(insiders)));
}

/** No known install location (an empty candidate list) counts as found. */
function findClaudeDesktopApp(): Promise<boolean> {
  return lookup('Claude Desktop application', () => {
    const candidates = getClaudeDesktopAppCandidates();
    return candidates.length === 0 || candidates.some((candidate) => existsSync(candidate));
  });
}

/** Connected per the connectors table; an id with no entry is not connected. */
async function isConnectorActive(connectorId: AnalyticsConnectorId): Promise<boolean> {
  const entry = ANALYTICS_CONNECTORS.find((connector) => connector.id === connectorId);
  return entry ? entry.isActive() : false;
}

/** Whether the application a member needs in a run is on this machine. Never rejects. */
export async function isMemberFound(member: AnalyticsMember, run: { insiders: boolean }): Promise<boolean> {
  switch (member) {
    case 'claudeDesktop':
      return findClaudeDesktopApp();
    case 'vscodeClaudeCode':
      return findVsCodeDir(run.insiders);
    case 'claudeCodeOtlp': {
      const [binary, vscode] = await Promise.all([findClaudeCodeBinary(), findVsCodeDir(run.insiders)]);
      return binary || vscode;
    }
    case 'copilotChatOtlp':
      return findVsCodeDir(false);
    case 'copilotCliOtlp':
      return findCopilotCliBinary();
  }
}

/**
 * The members of the aggregates given that are set in `targets` and whose application is not found in this run. They
 * are still connected — their config is written as under their own flag and takes effect once the application is
 * installed; the caller names them `configured (not installed yet)`. With no aggregate no lookup runs. Never rejects.
 */
export async function membersNotFound(
  targets: ConnectTargets,
  aggregates: readonly AggregateId[],
  run: { insiders: boolean },
): Promise<Set<AnalyticsMember>> {
  const members = [...membersOf(aggregates)].filter((member) => targets[member]);
  const found = await Promise.all(members.map((member) => isMemberFound(member, run)));
  return new Set(members.filter((_, i) => !found[i]));
}

/** The label a member's `configured (not installed yet)` line names. */
export const MEMBER_LABELS: Record<AnalyticsMember, string> = {
  claudeDesktop: 'Claude Desktop',
  vscodeClaudeCode: 'VS Code Claude Code extension',
  claudeCodeOtlp: 'Claude Code',
  copilotChatOtlp: 'Copilot Chat',
  copilotCliOtlp: 'Copilot CLI',
};

/** The line of a member that was configured while its application is not on this machine. */
export function notInstalledLine(member: AnalyticsMember): string {
  return `${MEMBER_LABELS[member]}: configured (not installed yet — takes effect once installed)`;
}

/**
 * Claude Desktop set under a profile with no CodeMie URL: given by its own flag it throws; set by an aggregate it is
 * unset in `targets`, recorded failed in `results`, and true is returned. False when Desktop is not set or the URL is.
 */
export function failDesktopWithoutCodeMieUrl(
  targets: ConnectTargets,
  members: ReadonlySet<AnalyticsMember>,
  codeMieUrl: string | undefined,
  results: TargetResult[],
): boolean {
  if (!targets.claudeDesktop || codeMieUrl) return false;
  const message = 'Selected profile is missing CodeMie URL.\n' +
    renderHint({ reason: 'Set it up again', action: 'run: codemie setup or codemie profile login' });
  if (!members.has('claudeDesktop')) throw new ConfigurationError(message);
  targets.claudeDesktop = false;
  results.push({ label: 'Claude Desktop', ok: false, error: message.replace('\n', ' ') });
  return true;
}

/** Whether `error` is the invalid stored project list of Claude Code analytics set by an aggregate. */
export function isAggregateInvalidProjectList(
  error: unknown,
  members: ReadonlySet<AnalyticsMember>,
): error is ConfigurationError {
  const invalidList = error instanceof ConfigurationError && error.message.includes('CODEMIE_ANALYTICS_PROJECT_FILTER');
  return members.has('claudeCodeOtlp') && invalidList;
}

/**
 * The catch of Claude Code analytics' confirmation: an invalid stored project list of it set by an aggregate fails it
 * alone — `beforeRecord` runs, the failure joins `results`, undefined is returned; any other error is rethrown.
 */
export function failAggregateInvalidProjectList(
  error: unknown,
  members: ReadonlySet<AnalyticsMember>,
  results: TargetResult[],
  beforeRecord: () => void,
): undefined {
  if (!isAggregateInvalidProjectList(error, members)) throw error;
  beforeRecord();
  results.push({ label: CLAUDE_CODE_OTLP_LABEL, ok: false, error: error.message });
  return undefined;
}

/**
 * Whether a disconnect has something of the member to remove: Claude Desktop, Claude Code and the Copilot members
 * read connected to this proxy; the extension — its VS Code directory exists. Never rejects; a reader that fails
 * reads as configured.
 */
export async function isMemberConfigured(member: AnalyticsMember, run: { insiders: boolean }): Promise<boolean> {
  try {
    switch (member) {
      case 'claudeDesktop':
        // The applied config, or the CodeMie entry while another config is applied: disconnect cleans either.
        return (await readDesktopGateway()) !== null || (await readCodeMieDesktopGateway()) !== null;
      case 'vscodeClaudeCode':
        return existsSync(getVsCodeProductDir(run.insiders));
      case 'claudeCodeOtlp':
        return await hasClaudeCodeOtlpHooks();
      case 'copilotChatOtlp':
        return await isConnectorActive(COPILOT_CHAT_OTLP_AGENT_NAME);
      case 'copilotCliOtlp':
        return await isConnectorActive(COPILOT_CLI_OTLP_AGENT_NAME);
    }
  } catch (error) {
    logger.debug(`[proxy] ${member} configuration read failed; counted as configured`, ...sanitizeLogArgs(error));
    return true;
  }
}

function row({ client, label, lookedUp, connected, aggregateFlag, otherGateway = false, routed = false }: {
  client: AnalyticsClientRow['client'];
  label: string;
  lookedUp: boolean;
  connected: boolean;
  aggregateFlag: string;
  otherGateway?: boolean;
  routed?: boolean;
}): AnalyticsClientRow {
  // The vendor flag connects a client whether or not its application is found.
  return { client, label, found: lookedUp || connected, connected, flag: aggregateFlag, otherGateway, routed };
}

/**
 * Whether the extension's route in VS Code's settings (stable or Insiders) is this proxy's: at the daemon's port with a
 * key it accepts while it runs; any loopback route with no daemon.
 */
function isExtensionRouted(routes: (ConnectorGateway | null)[], state: DaemonState | null): boolean {
  return routes.some((route) =>
    route !== null && (state === null || (route.port === state.port && route.key !== 'refused')));
}

/**
 * The five analytics clients `proxy connect` turns on, found and connected. With `state` null (no daemon) Claude
 * Desktop is not connected and its gateway config is not read. The extension is connected when the hooks are in
 * place; its route in VS Code's settings (routed through the proxy) is `routed`, a
 * separate fact. Reads files only; never rejects.
 */
export async function collectAnalyticsClients(state: DaemonState | null): Promise<AnalyticsClientRow[]> {
  // With no daemon the route's key is not judged.
  const routeKey = state?.gatewayKey ?? '';
  const [claudeBinary, stableDir, insidersDir, desktopApp, copilotBinary, hooks, gateway, chatOn, cliOn, stableRoute,
    insidersRoute] =
    await Promise.all([
      findClaudeCodeBinary(),
      findVsCodeDir(false),
      findVsCodeDir(true),
      findClaudeDesktopApp(),
      findCopilotCliBinary(),
      read('Claude Code hooks', false, hasClaudeCodeOtlpHooks),
      state
        ? read<DesktopGateway | null>('Claude Desktop gateway', null, () => readDesktopGatewayConfig())
        : Promise.resolve(null),
      read('Copilot Chat scope', false, () => isConnectorActive(COPILOT_CHAT_OTLP_AGENT_NAME)),
      read('Copilot CLI scope', false, () => isConnectorActive(COPILOT_CLI_OTLP_AGENT_NAME)),
      readVsCodeClaudeCodeGateway(routeKey, false),
      readVsCodeClaudeCodeGateway(routeKey, true),
    ]);
  const [claude, copilot] = ANALYTICS_AGGREGATES.map((aggregate) => aggregate.flag);
  const vscode = stableDir || insidersDir;
  const desktopConnected = state !== null && isDesktopConnectedTo(gateway, state.gatewayKey, state.port);
  const otherGateway = state !== null && gateway !== null && !isDesktopPointedAtLocalProxy(gateway, state.gatewayKey);
  return [
    row({ client: 'claude-code', label: 'Claude Code', lookedUp: claudeBinary,
      connected: hooks, aggregateFlag: claude }),
    row({ client: 'vscode-claude-code', label: 'VS Code Claude Code extension',
      lookedUp: vscode, connected: hooks, routed: isExtensionRouted([stableRoute, insidersRoute], state),
      aggregateFlag: insidersDir && !stableDir ? `${claude} --insiders` : claude }),
    row({ client: 'claude-desktop', label: 'Claude Desktop', lookedUp: desktopApp,
      connected: desktopConnected, aggregateFlag: claude, otherGateway, routed: desktopConnected }),
    row({ client: 'copilot-chat', label: 'Copilot Chat', lookedUp: stableDir,
      connected: chatOn, aggregateFlag: copilot }),
    row({ client: 'copilot-cli', label: 'Copilot CLI', lookedUp: copilotBinary,
      connected: cliOn, aggregateFlag: copilot }),
  ];
}

/** The client-target row (`proxy clients`) each analytics client is shown on. */
export const ANALYTICS_CLIENT_TARGET_IDS: Record<AnalyticsClientRow['client'], string> = {
  'claude-code': CLAUDE_CODE_OTLP_AGENT_NAME,
  'vscode-claude-code': 'vscode-claude-code',
  'claude-desktop': 'claude-desktop',
  'copilot-chat': COPILOT_CHAT_OTLP_AGENT_NAME,
  'copilot-cli': COPILOT_CLI_OTLP_AGENT_NAME,
};

/** The extension whose hooks are on and whose model route is not CodeMie's. */
export const EXTENSION_ANALYTICS_ON = 'analytics on (uses your Claude login; model routing unchanged)';

/** The note of an extension routed through CodeMie, with the command that gives it back its Claude login. */
export function routedExtensionNote(flag: string, remedies: DoctorRemedies): string {
  const insiders = flag.endsWith('--insiders') ? ' --insiders' : '';
  return 'routed through the proxy — ' +
    `to use your Claude login: ${remedies.disconnect(`--vscode-claude-code${insiders}`)}`;
}

/**
 * The one-line state of an analytics client that is not connected, with the command that connects it: its vendor
 * flag, whether or not the client is found. `commands` false (a daemon of an older CLI, whose restart
 * comes first) names no command for a found client. Undefined for a connected client, except the extension, whose
 * analytics-on state says whether its model route is CodeMie's (and how to give it back).
 */
export function analyticsClientHint(row: AnalyticsClientRow, commands: boolean, remedies: DoctorRemedies): string | undefined {
  if (row.client === 'vscode-claude-code' && row.connected) {
    return row.routed ? routedExtensionNote(row.flag, remedies) : EXTENSION_ANALYTICS_ON;
  }
  if (row.connected) return undefined;
  if (row.found && !commands) return 'not connected';
  const command = remedies.connect(row.flag);
  if (row.otherGateway && commands) {
    return renderHint({
      reason: 'points at a local gateway with a key this proxy does not accept',
      action: `if it should use CodeMie, run: ${command}`,
    });
  }
  return renderHint({ reason: row.found ? 'not connected' : 'not found', command });
}

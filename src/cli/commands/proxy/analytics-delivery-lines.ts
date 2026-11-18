import chalk from 'chalk';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DaemonState } from './daemon-manager.js';
import { hasActiveAnalyticsConnector } from './analytics-connectors.js';
import { moveDesktopToNamedKey, readDesktopGateway } from './connectors/desktop.js';
import { moveVsCodeClaudeCodeToNamedKey, readVsCodeClaudeCodeGateway } from './connectors/vscode-claude-code.js';
import { moveCodexDesktopToNamedKey, readCodexDesktopGateway } from './connectors/codex-desktop-named-key.js';
import { gatewayKeyReading, readVsCodeByokGateway, type ConnectorGateway } from './connectors/vscode.js';
import { readCopilotCliHookInstall } from './connectors/copilot-cli-otlp.js';
import { readCopilotChatHookInstall } from './connectors/copilot-chat-otlp.js';
import { readClaudeCodeHookInstall } from './connectors/claude-code-otlp.js';
import { readDesktopGatewayConfig } from '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js';
import {
  CLAUDE_DESKTOP,
  CODEX_DESKTOP,
  VSCODE_BYOK,
  VSCODE_CLAUDE_CODE,
} from '@/providers/plugins/sso/proxy/proxy-clients.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { findActiveCli, findFirstManifest, resolvePackage } from '@/utils/active-cli.js';
import { getDirname, isSamePath } from '@/utils/paths.js';
import { isWindows } from '@/utils/platform.js';
import {
  collectDeliveryHealth,
  DELIVERY_REASONS,
  formatDropLines,
  unknownHint,
  type DeliveryHealth,
} from './delivery-health.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';

/**
 * Analytics delivery health for `proxy status`, or null when no connector is connected (a connected
 * Claude Desktop counts as one).
 * Leftover unsent spool bytes never make it visible: with nothing connected there is nothing to report.
 */
export async function collectVisibleDeliveryHealth(
  state: DaemonState,
  reply: AnalyticsHealthReply | undefined
): Promise<DeliveryHealth | null> {
  if (!(await hasActiveAnalyticsConnector())) {
    return null;
  }
  return collectDeliveryHealth(state, reply);
}

/**
 * The `Analytics:` headline for `proxy status`, with an indented `Run:` tip only when the user can act,
 * then the `Last dropped:` detail when the spool records a drop.
 */
export function formatAnalyticsLines(delivery: DeliveryHealth): string[] {
  return [...analyticsHeadline(delivery), ...formatDropLines(delivery.latestDrop)];
}

function analyticsHeadline(delivery: DeliveryHealth): string[] {
  if (delivery.status === 'healthy') {
    return [`Analytics: ${chalk.green('healthy')}`];
  }
  if (delivery.status === 'unhealthy') {
    const entry = delivery.reason ? DELIVERY_REASONS[delivery.reason] : undefined;
    return [
      `Analytics: ${chalk.yellow(`unhealthy${entry ? ` (${entry.label})` : ''}`)}`,
      ...(entry?.run ? [`  Run: ${entry.run}`] : []),
    ];
  }
  return [`Analytics: ${chalk.dim(`unknown (${unknownHint(delivery)})`)}`];
}

export interface DesktopCollection {
  connected: true;
  collecting: boolean;
  reason?: string;
  remedy?: string;
}

/**
 * Whether the daemon collects what Claude Desktop sends, when Desktop is pointed at a local proxy: collecting once
 * the daemon has noticed Desktop connected to it (`desktopConnectedSince`); null when Desktop has no CodeMie
 * gateway, or the daemon is one of an older CLI (its state has no `version`).
 */
export async function collectDesktopCollection(state: DaemonState): Promise<DesktopCollection | null> {
  if (!state.version) return null;
  const gateway = await readDesktopGateway();
  return gateway ? describeDesktopCollection(state, gateway.port) : null;
}

function describeDesktopCollection(state: DaemonState, gatewayPort: number): DesktopCollection {
  if (state.desktopConnectedSince) {
    return { connected: true, collecting: true };
  }
  if (gatewayPort !== state.port) {
    return {
      connected: true,
      collecting: false,
      reason: `Claude Desktop points at port ${gatewayPort}, the proxy listens on ${state.port}`,
      remedy: 'run: codemie proxy connect --claude-desktop',
    };
  }
  return { connected: true, collecting: false, reason: 'Desktop is not connected to this proxy yet' };
}

/** The `Desktop:` line for `proxy status`. */
export function formatDesktopLine(desktop: DesktopCollection): string {
  return desktop.collecting
    ? '  Desktop: collecting'
    : chalk.yellow(`  Desktop: NOT collecting — ${desktop.reason}${desktop.remedy ? `; ${desktop.remedy}` : ''}`);
}

export interface ClientPortMismatch {
  client: string;
  configuredPort: number;
  flag: string;
}

/** A client whose config holds the shared key, or (`refused`) a key the daemon refuses. */
export interface ClientSharedKey {
  client: string;
  flag: string;
  refused?: true;
}

export interface HooksOfAnotherInstall {
  connector: string;
  path: string;
  flag: string;
}

/** What `proxy status` names about the clients' own configs; each list empty when there is nothing to name. */
export interface ClientNotices {
  clientPortMismatch: ClientPortMismatch[];
  clientSharedKey: ClientSharedKey[];
  hooksOfAnotherInstall: HooksOfAnotherInstall[];
  /** Lines in the order they are printed. */
  lines: string[];
}

export interface ClientConfig {
  client: string;
  label: string;
  /** The `proxy connect` flags that write this config. */
  flag: string;
  /** Desktop's port is named by its `Desktop:` line. */
  portNamedElsewhere?: true;
  read: (state: DaemonState) => Promise<ConnectorGateway | null>;
  /**
   * The write that moves the config from the shared key (or, for Desktop, a sealed key) to the client's named key,
   * and what the user does for the application to load it.
   */
  moveToNamedKey?: {
    write: (state: DaemonState) => Promise<'moved' | 'left' | 'unchanged'>;
    hint: string;
  };
  /** `proxy connect`, `proxy start` and `proxy restart` write this config only while the connection record holds an older CLI's client identity. */
  movedOnlyWithLegacyIdentity?: true;
}

async function readDesktopConfigured(state: DaemonState): Promise<ConnectorGateway | null> {
  const gateway = await readDesktopGatewayConfig();
  if (!gateway) return null;
  if (gateway.sealed) return { port: gateway.port };
  const key = gatewayKeyReading(gateway.apiKey === undefined ? undefined : `Bearer ${gateway.apiKey}`, state.gatewayKey);
  return { port: gateway.port, key };
}

/** The clients' configs `proxy status` reads and `proxy connect`, `proxy start` and `proxy restart` move to their named keys. */
export const CLIENT_CONFIGS: readonly ClientConfig[] = [
  {
    client: CLAUDE_DESKTOP,
    label: 'Claude Desktop',
    flag: '--claude-desktop',
    portNamedElsewhere: true,
    read: readDesktopConfigured,
    moveToNamedKey: {
      write: (state) => moveDesktopToNamedKey(state.gatewayKey, state.port),
      hint: 'Restart Claude Desktop to apply changes.',
    },
    movedOnlyWithLegacyIdentity: true,
  },
  {
    client: VSCODE_CLAUDE_CODE,
    label: 'VS Code Claude Code extension',
    flag: '--vscode-claude-code',
    read: (state) => readVsCodeClaudeCodeGateway(state.gatewayKey, false),
    moveToNamedKey: {
      write: (state) => moveVsCodeClaudeCodeToNamedKey(state.gatewayKey, state.port, false),
      hint: 'Reload VS Code to apply changes.',
    },
  },
  {
    client: VSCODE_CLAUDE_CODE,
    label: 'VS Code Insiders Claude Code extension',
    flag: '--vscode-claude-code --insiders',
    read: (state) => readVsCodeClaudeCodeGateway(state.gatewayKey, true),
    moveToNamedKey: {
      write: (state) => moveVsCodeClaudeCodeToNamedKey(state.gatewayKey, state.port, true),
      hint: 'Reload VS Code to apply changes.',
    },
  },
  {
    client: CODEX_DESKTOP,
    label: 'Codex desktop',
    flag: '--codex-desktop',
    read: (state) => readCodexDesktopGateway(state.gatewayKey),
    moveToNamedKey: {
      write: (state) => moveCodexDesktopToNamedKey(state.gatewayKey, state.port),
      hint: 'Quit and reopen the ChatGPT desktop app to apply the change.',
    },
  },
  {
    client: VSCODE_BYOK,
    label: 'VS Code BYOK',
    flag: '--vscode',
    read: (state) => readVsCodeByokGateway(state.port, false),
  },
  {
    client: VSCODE_BYOK,
    label: 'VS Code Insiders BYOK',
    flag: '--vscode --insiders',
    read: (state) => readVsCodeByokGateway(state.port, true),
  },
];

const HOOK_CONNECTORS = [
  { connector: COPILOT_CLI_OTLP_AGENT_NAME, label: 'Copilot CLI hooks', read: readCopilotCliHookInstall },
  { connector: COPILOT_CHAT_OTLP_AGENT_NAME, label: 'Copilot Chat hooks', read: readCopilotChatHookInstall },
  { connector: CLAUDE_CODE_OTLP_AGENT_NAME, label: 'Claude Code hooks', read: readClaudeCodeHookInstall },
] as const;

/**
 * The package directory, resolved, of the install a `codemie` path belongs to — a shim (symlinked into its
 * package), a Windows `codemie.cmd`, or a `bin/codemie.js` script — or null when it cannot be resolved.
 */
async function installDirOf(path: string): Promise<string | null> {
  try {
    const platform = process.platform;
    const found = isWindows(platform) && /\.[cm]?js$/i.test(path)
      ? await findFirstManifest(dirname(await realpath(path)), platform)
      : await resolvePackage(path, platform);
    return found && typeof found !== 'string' ? await realpath(found.dir) : null;
  } catch {
    return null;
  }
}

async function ownInstallDir(): Promise<string | null> {
  try {
    const found = await findFirstManifest(getDirname(import.meta.url), process.platform);
    return found ? await realpath(found.dir) : null;
  } catch {
    return null;
  }
}

async function collectHooksOfAnotherInstall(): Promise<{ entries: HooksOfAnotherInstall[]; lines: string[] }> {
  const entries: HooksOfAnotherInstall[] = [];
  const lines: string[] = [];
  const own = await ownInstallDir();
  if (!own) return { entries, lines };
  for (const { connector, label, read } of HOOK_CONNECTORS) {
    const path = await read();
    const dir = path ? await installDirOf(path) : null;
    if (!path || !dir || isSamePath(dir, own)) continue;
    const flag = `--${connector}`;
    entries.push({ connector, path, flag });
    let remedy = `Run: codemie proxy connect ${flag}`;
    if (connector === CLAUDE_CODE_OTLP_AGENT_NAME) {
      // A connect pins Claude Code's hooks to the first `codemie` on PATH.
      const active = await findActiveCli();
      const activeDir = active.status === 'found' ? await installDirOf(active.active.path) : null;
      if (activeDir && isSamePath(activeDir, dir)) {
        remedy = `put this install first on PATH, then run: codemie proxy connect ${flag}`;
      }
    }
    lines.push(chalk.yellow(`  ${label}: run another install (${path}) — ${remedy}`));
  }
  return { entries, lines };
}

/**
 * The clients `proxy status` names for the daemon of `state`: each set up for another port than the daemon's
 * (Desktop aside: its `Desktop:` line names that), each whose config holds the shared key or a key the daemon
 * does not accept, and the hooks that run another install. A config that cannot be read names nothing. A state
 * without `version` names no key: that daemon accepts the shared key alone, and its remedy is a restart. Only reads.
 */
export async function collectClientNotices(state: DaemonState): Promise<ClientNotices> {
  const clientPortMismatch: ClientPortMismatch[] = [];
  const clientSharedKey: ClientSharedKey[] = [];
  const portLines: string[] = [];
  const keyLines: string[] = [];
  for (const config of CLIENT_CONFIGS) {
    const gateway = await config.read(state);
    if (!gateway) continue;
    const run = `Run: codemie proxy connect ${config.flag}`;
    if (!config.portNamedElsewhere && gateway.port !== state.port) {
      clientPortMismatch.push({ client: config.client, configuredPort: gateway.port, flag: config.flag });
      portLines.push(chalk.yellow(
        `  ${config.label}: points at port ${gateway.port}, the proxy listens on ${state.port} — ${run}`
      ));
    }
    if (state.version && (gateway.key === 'shared' || gateway.key === 'refused')) {
      const refused = gateway.key === 'refused';
      clientSharedKey.push({ client: config.client, flag: config.flag, ...(refused && { refused: true as const }) });
      keyLines.push(chalk.yellow(refused
        ? `  ${config.label}: points at a local gateway with a key this proxy does not accept — if it should use CodeMie, run: codemie proxy connect ${config.flag}`
        : `  ${config.label}: uses the shared key — ${run}`
      ));
    }
  }
  const hooks = await collectHooksOfAnotherInstall();
  return {
    clientPortMismatch,
    clientSharedKey,
    hooksOfAnotherInstall: hooks.entries,
    lines: [...portLines, ...keyLines, ...hooks.lines],
  };
}

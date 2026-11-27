/**
 * The one table of what `codemie proxy connect` can connect: every client and analytics connector, with how to tell
 * whether it is connected, where its config lives and how to disconnect it. `proxy clients`, the doctor client
 * section and `proxy disconnect --all` read it, so they agree on what is connected; `CLIENT_CONFIGS` and the hook
 * readers of `analytics-delivery-lines.ts` are views of it.
 */
import { join } from 'node:path';

import { logger } from '@/utils/logger.js';
import { ClientNotInstalledError, CodeMieError } from '@/utils/errors.js';
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
import { getClaudeSettingsPath } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { DEFAULT_GATEWAY_KEY, readState, type DaemonState } from './daemon-manager.js';
import { ANALYTICS_CONNECTORS, type AnalyticsConnectorId, type ConnectorScopeRead } from './analytics-connectors.js';
import { vendorFlag } from './flag-list.js';
import { getDesktopBaseDir, moveDesktopToNamedKey, readCodeMieDesktopGateway } from './connectors/desktop.js';
import {
  getVsCodeClaudeCodeSettingsPath,
  moveVsCodeClaudeCodeToNamedKey,
  readVsCodeClaudeCodeGateway,
} from './connectors/vscode-claude-code.js';
import { moveCodexDesktopToNamedKey, readCodexDesktopGateway } from './connectors/codex-desktop-named-key.js';
import { getCodexDesktopConfigPath } from './connectors/codex-desktop.js';
import {
  gatewayKeyReading,
  getVsCodeLanguageModelsPath,
  readVsCodeByokGateway,
  type ConnectorGateway,
} from './connectors/vscode.js';
import { getOmpExtensionPath, isOmpExtensionInstalled } from './connectors/omp.js';
import { getCopilotCliHookFilePath, readCopilotCliHookInstall } from './connectors/copilot-cli-otlp.js';
import { getCopilotChatHookFilePath, readCopilotChatHookInstall } from './connectors/copilot-chat-otlp.js';
import { readClaudeCodeHookInstall } from './connectors/claude-code-otlp.js';
import {
  disconnectClaudeCodeOtlp,
  disconnectClaudeDesktop,
  disconnectCodexDesktop,
  disconnectCopilotChatOtlp,
  disconnectCopilotCliOtlp,
  disconnectOmp,
  disconnectVsCodeByok,
  disconnectVsCodeClaudeCode,
} from './disconnect-orchestrator.js';

/** A client config pointed at a local CodeMie gateway: what `proxy status`/`doctor` read and `connect` moves to its named key. */
export interface ClientGatewaySpec {
  /** The proxy client id the config's key names. */
  client: string;
  /** Desktop's port is named by its `Desktop:` line. */
  portNamedElsewhere?: true;
  read: (state: DaemonState) => Promise<ConnectorGateway | null>;
  /**
   * The write that moves the config from the shared key (or, for Desktop, a sealed key) to the client's named key,
   * and what the user does for the application to load it.
   */
  moveToNamedKey?: {
    write: (state: DaemonState) => Promise<'moved' | 'unchanged'>;
    hint: string;
  };
  /** `proxy connect`, `proxy start` and `proxy restart` write this config only while the connection record holds an older CLI's client identity. */
  movedOnlyWithLegacyIdentity?: true;
}

export interface ClientTarget {
  /** Unique id; an analytics connector's id is its agent name. */
  id: string;
  /** The `proxy connect` flags that connect this target. */
  flag: string;
  label: string;
  /** Whether the target is connected now. May throw; {@link readClientTargetStates} turns a throw into an error. */
  isConnected: () => Promise<boolean>;
  /** The config file (or directory) `connect` writes. */
  configLocation: () => string;
  /** Reverses `connect` for this target, reporting on the console; absent when `disconnect` has no remover for it. */
  disconnect?: () => Promise<void>;
  /** Its sessions feed CodeMie analytics. */
  carriesAnalytics: boolean;
  /** An analytics connector's tracking scope, read through its own store. */
  readScope?: () => Promise<ConnectorScopeRead>;
  /** Present for a client config pointed at a local gateway. */
  gateway?: ClientGatewaySpec;
  /** Present for a hook-based connector: the `codemie` its installed hooks run, or null. */
  readHookInstall?: () => Promise<string | null>;
}

/**
 * The daemon a gateway reader is read against when no daemon runs: the last state written, else a placeholder.
 * Only the key classification depends on it, never whether a config points at a local gateway.
 */
export async function probeDaemonState(state: DaemonState | null = null): Promise<DaemonState> {
  return state ?? (await readState()) ?? {
    pid: 0,
    port: 0,
    url: '',
    profile: '',
    gatewayKey: DEFAULT_GATEWAY_KEY,
    startedAt: '',
  };
}

async function readDesktopConfigured(state: DaemonState): Promise<ConnectorGateway | null> {
  const gateway = await readDesktopGatewayConfig();
  if (!gateway) return null;
  if (gateway.sealed) return { port: gateway.port };
  const key = gatewayKeyReading(gateway.apiKey === undefined ? undefined : `Bearer ${gateway.apiKey}`, state.gatewayKey);
  return { port: gateway.port, key };
}

/**
 * Claude Desktop has something for `disconnect` to clean: its applied config points at a local gateway, or its CodeMie
 * entry (`CodeMie Proxy`) points at the local proxy while another config is applied.
 */
async function isDesktopConnected(): Promise<boolean> {
  if ((await readDesktopConfigured(await probeDaemonState())) !== null) return true;
  return (await readCodeMieDesktopGateway()) !== null;
}

function gatewayTarget(
  target: Omit<ClientTarget, 'isConnected'> & { gateway: ClientGatewaySpec; isConnected?: ClientTarget['isConnected'] }
): ClientTarget {
  return {
    ...target,
    isConnected: target.isConnected ?? (async () => (await target.gateway.read(await probeDaemonState())) !== null),
  };
}

function analyticsConnector(id: AnalyticsConnectorId): (typeof ANALYTICS_CONNECTORS)[number] {
  const connector = ANALYTICS_CONNECTORS.find((entry) => entry.id === id);
  if (!connector) throw new CodeMieError(`Unknown analytics connector: ${id}`);
  return connector;
}

function analyticsTarget(
  id: AnalyticsConnectorId,
  label: string,
  configLocation: () => string,
  disconnect: () => Promise<void>,
  readHookInstall: () => Promise<string | null>
): ClientTarget {
  return {
    id,
    // The per-connector flag is deprecated: the vendor flag connects it (`--claude-otlp`, `--copilot-otlp`).
    flag: vendorFlag(`--${id}`),
    label,
    // Claude Code: `hasClaudeCodeOtlpHooks`, its one connected predicate; Copilot: the connector scope is enabled.
    isConnected: () => analyticsConnector(id).isActive(),
    configLocation,
    disconnect,
    carriesAnalytics: true,
    readScope: () => analyticsConnector(id).readScope(),
    readHookInstall,
  };
}

/**
 * Every connectable target, in the order `proxy clients` lists them. Each entry reaches its connector only when called,
 * never while the table is built.
 */
export const CLIENT_TARGETS: readonly ClientTarget[] = [
  gatewayTarget({
    id: 'claude-desktop',
    flag: '--claude-desktop',
    label: 'Claude Desktop',
    configLocation: () => join(getDesktopBaseDir(), 'configLibrary'),
    // `gateway.read` stays on the applied entry (what Desktop uses); connected also counts a non-applied CodeMie entry.
    isConnected: isDesktopConnected,
    disconnect: () => disconnectClaudeDesktop(),
    // Its Cowork sessions go through the same analytics delivery.
    carriesAnalytics: true,
    gateway: {
      client: CLAUDE_DESKTOP,
      portNamedElsewhere: true,
      read: readDesktopConfigured,
      moveToNamedKey: {
        write: (state) => moveDesktopToNamedKey(state.gatewayKey, state.port),
        hint: 'Restart Claude Desktop to apply changes.',
      },
      movedOnlyWithLegacyIdentity: true,
    },
  }),
  gatewayTarget({
    id: 'vscode-claude-code',
    flag: '--vscode-claude-code',
    label: 'VS Code Claude Code extension',
    configLocation: () => getVsCodeClaudeCodeSettingsPath(false),
    disconnect: () => disconnectVsCodeClaudeCode(false),
    carriesAnalytics: false,
    gateway: {
      client: VSCODE_CLAUDE_CODE,
      read: (state) => readVsCodeClaudeCodeGateway(state.gatewayKey, false),
      moveToNamedKey: {
        write: (state) => moveVsCodeClaudeCodeToNamedKey(state.gatewayKey, state.port, false),
        hint: 'Reload VS Code to apply changes.',
      },
    },
  }),
  gatewayTarget({
    id: 'vscode-claude-code-insiders',
    flag: '--vscode-claude-code --insiders',
    label: 'VS Code Insiders Claude Code extension',
    configLocation: () => getVsCodeClaudeCodeSettingsPath(true),
    disconnect: () => disconnectVsCodeClaudeCode(true),
    carriesAnalytics: false,
    gateway: {
      client: VSCODE_CLAUDE_CODE,
      read: (state) => readVsCodeClaudeCodeGateway(state.gatewayKey, true),
      moveToNamedKey: {
        write: (state) => moveVsCodeClaudeCodeToNamedKey(state.gatewayKey, state.port, true),
        hint: 'Reload VS Code to apply changes.',
      },
    },
  }),
  gatewayTarget({
    id: 'codex-desktop',
    flag: '--codex-desktop',
    label: 'Codex desktop',
    configLocation: () => getCodexDesktopConfigPath(),
    disconnect: () => disconnectCodexDesktop(),
    carriesAnalytics: false,
    gateway: {
      client: CODEX_DESKTOP,
      read: (state) => readCodexDesktopGateway(state.gatewayKey),
      moveToNamedKey: {
        write: (state) => moveCodexDesktopToNamedKey(state.gatewayKey, state.port),
        hint: 'Quit and reopen the ChatGPT desktop app to apply the change.',
      },
    },
  }),
  gatewayTarget({
    id: 'vscode',
    flag: '--vscode',
    label: 'VS Code BYOK',
    configLocation: () => getVsCodeLanguageModelsPath(false),
    disconnect: () => disconnectVsCodeByok(false),
    carriesAnalytics: false,
    gateway: { client: VSCODE_BYOK, read: (state) => readVsCodeByokGateway(state.port, false) },
  }),
  gatewayTarget({
    id: 'vscode-insiders',
    flag: '--vscode --insiders',
    label: 'VS Code Insiders BYOK',
    configLocation: () => getVsCodeLanguageModelsPath(true),
    disconnect: () => disconnectVsCodeByok(true),
    carriesAnalytics: false,
    gateway: { client: VSCODE_BYOK, read: (state) => readVsCodeByokGateway(state.port, true) },
  }),
  {
    id: 'omp',
    flag: '--omp',
    label: 'oh-my-pi',
    isConnected: async () => isOmpExtensionInstalled(),
    configLocation: () => getOmpExtensionPath(),
    disconnect: () => disconnectOmp(),
    carriesAnalytics: false,
  },
  analyticsTarget(
    CLAUDE_CODE_OTLP_AGENT_NAME,
    'Claude Code',
    () => getClaudeSettingsPath(),
    () => disconnectClaudeCodeOtlp('user'),
    () => readClaudeCodeHookInstall()
  ),
  analyticsTarget(
    COPILOT_CLI_OTLP_AGENT_NAME,
    'Copilot CLI',
    () => getCopilotCliHookFilePath(),
    () => disconnectCopilotCliOtlp('user'),
    () => readCopilotCliHookInstall()
  ),
  analyticsTarget(
    COPILOT_CHAT_OTLP_AGENT_NAME,
    'Copilot Chat',
    () => getCopilotChatHookFilePath(),
    () => disconnectCopilotChatOtlp('user'),
    () => readCopilotChatHookInstall()
  ),
];

export interface ClientTargetState {
  target: ClientTarget;
  connected: boolean;
  /** The connected check failed; `connected` is then false. */
  error?: string;
}

/** Every target with whether it is connected, in table order. Never throws. */
export async function readClientTargetStates(): Promise<ClientTargetState[]> {
  return Promise.all(CLIENT_TARGETS.map(async (target): Promise<ClientTargetState> => {
    try {
      return { target, connected: await target.isConnected() };
    } catch (error) {
      logger.debug(`[client-targets] ${target.id} connected check failed:`, error);
      return { target, connected: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

/** The connected targets, in table order: the set `proxy disconnect --all` acts on. Never throws. */
export async function listConnectedClientTargets(): Promise<ClientTarget[]> {
  return (await readClientTargetStates()).filter((state) => state.connected).map((state) => state.target);
}

/**
 * The location of a target's config, or why it has none: `not installed` when the application is not on this machine,
 * `unavailable on this platform` when the location cannot be resolved on this OS at all. Never throws.
 */
export function describeConfigLocation(target: ClientTarget): string {
  try {
    return target.configLocation();
  } catch (error) {
    logger.debug(`[client-targets] ${target.id} config location unavailable:`, error);
    return error instanceof ClientNotInstalledError ? 'not installed' : 'unavailable on this platform';
  }
}

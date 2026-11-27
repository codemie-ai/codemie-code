import chalk from 'chalk';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DaemonState } from './daemon-manager.js';
import type { DoctorRemedies } from './doctor/plan.js';
import { readDesktopGateway } from './connectors/desktop.js';
import { CLIENT_TARGETS, type ClientGatewaySpec } from './client-targets.js';
import { CLAUDE_OTLP_FLAG } from './flag-list.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { getClaudeAnalyticsPreferencesPath } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import { readClaudeAnalyticsSwitch } from '@/telemetry/runtime/analytics-switch.js';
import { findActiveCli, findFirstManifest, resolvePackage } from '@/utils/active-cli.js';
import { getDirname, isSamePath } from '@/utils/paths.js';
import { isWindows } from '@/utils/platform.js';

export interface DesktopCollection {
  connected: true;
  collecting: boolean;
  reason?: string;
  remedy?: string;
  /** Not collecting because analytics were switched off (`proxy analytics disable`): a choice, not a fault. */
  analyticsDisabled?: true;
}

/**
 * Whether the daemon collects what Claude Desktop sends, when Desktop is pointed at a local proxy: collecting once
 * the daemon has noticed Desktop connected to it (`desktopConnectedSince`) and analytics are on; null when Desktop has
 * no CodeMie gateway, or the daemon is one of an older CLI (its state has no `version`).
 */
export async function collectDesktopCollection(state: DaemonState, remedies: DoctorRemedies): Promise<DesktopCollection | null> {
  if (!state.version) return null;
  const gateway = await readDesktopGateway();
  return gateway ? describeDesktopCollection(state, gateway.port, remedies) : null;
}

async function describeDesktopCollection(state: DaemonState, gatewayPort: number, remedies: DoctorRemedies): Promise<DesktopCollection> {
  if (state.desktopConnectedSince) {
    const analytics = await readClaudeAnalyticsSwitch();
    if (analytics === 'off') {
      return {
        connected: true,
        collecting: false,
        analyticsDisabled: true,
        reason: 'analytics are disabled',
        remedy: `run: codemie proxy analytics enable ${CLAUDE_OTLP_FLAG}`,
      };
    }
    if (analytics === 'corrupt') {
      return {
        connected: true,
        collecting: false,
        reason: `the analytics preferences file is unreadable (fix or delete ${getClaudeAnalyticsPreferencesPath()})`,
      };
    }
    return { connected: true, collecting: true };
  }
  if (gatewayPort !== state.port) {
    return {
      connected: true,
      collecting: false,
      reason: `Claude Desktop points at port ${gatewayPort}, the proxy listens on ${state.port}`,
      remedy: `run: ${remedies.connect('--claude-desktop')}`,
    };
  }
  return { connected: true, collecting: false, reason: 'Desktop is not connected to this proxy yet' };
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

export interface ClientConfig extends ClientGatewaySpec {
  label: string;
  /** The `proxy connect` flags that write this config. */
  flag: string;
}

/**
 * The clients' configs `proxy status` reads and `proxy connect`, `proxy start` and `proxy restart` move to their named
 * keys: the gateway clients of {@link CLIENT_TARGETS}, in table order.
 */
export const CLIENT_CONFIGS: readonly ClientConfig[] = CLIENT_TARGETS.flatMap((target) =>
  target.gateway ? [{ ...target.gateway, label: target.label, flag: target.flag }] : []
);

/** The hook-based connectors of {@link CLIENT_TARGETS}: whose installed hooks may run another `codemie` install. */
const HOOK_CONNECTORS = CLIENT_TARGETS.flatMap((target) =>
  target.readHookInstall
    ? [{ connector: target.id, label: `${target.label} hooks`, flag: target.flag, read: target.readHookInstall }]
    : []
);

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

async function collectHooksOfAnotherInstall(remedies: DoctorRemedies): Promise<{ entries: HooksOfAnotherInstall[]; lines: string[] }> {
  const entries: HooksOfAnotherInstall[] = [];
  const lines: string[] = [];
  const own = await ownInstallDir();
  if (!own) return { entries, lines };
  for (const { connector, label, flag, read } of HOOK_CONNECTORS) {
    const path = await read();
    const dir = path ? await installDirOf(path) : null;
    if (!path || !dir || isSamePath(dir, own)) continue;
    entries.push({ connector, path, flag });
    let remedy = `run: ${remedies.connect(flag)}`;
    if (connector === CLAUDE_CODE_OTLP_AGENT_NAME) {
      // A connect pins Claude Code's hooks to the first `codemie` on PATH.
      const active = await findActiveCli();
      const activeDir = active.status === 'found' ? await installDirOf(active.active.path) : null;
      if (activeDir && isSamePath(activeDir, dir)) {
        remedy = `put this install first on PATH, then run: ${remedies.connect(flag)}`;
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
export async function collectClientNotices(state: DaemonState, remedies: DoctorRemedies): Promise<ClientNotices> {
  const clientPortMismatch: ClientPortMismatch[] = [];
  const clientSharedKey: ClientSharedKey[] = [];
  const portLines: string[] = [];
  const keyLines: string[] = [];
  for (const config of CLIENT_CONFIGS) {
    const gateway = await config.read(state);
    if (!gateway) continue;
    const run = `run: ${remedies.connect(config.flag)}`;
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
        ? `  ${config.label}: points at a local gateway with a key this proxy does not accept — if it should use CodeMie, run: ${remedies.connect(config.flag)}`
        : `  ${config.label}: uses the shared key — ${run}`
      ));
    }
  }
  const hooks = await collectHooksOfAnotherInstall(remedies);
  return {
    clientPortMismatch,
    clientSharedKey,
    hooksOfAnotherInstall: hooks.entries,
    lines: [...portLines, ...keyLines, ...hooks.lines],
  };
}

/**
 * How each Claude client is configured today, and the route decision `connect --claude-otlp` takes from it: analytics
 * is installed for every Claude client, but a client's model requests are moved to the gateway only when the client
 * is not configured yet. Whatever cannot be read counts as configured, so `--claude-otlp` never overwrites a
 * configuration it did not write.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appliedConfigId,
  isDesktopPointedAtLocalProxy,
  readDesktopGatewayState,
} from '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js';
import {
  getClaudeDesktopBaseDir,
  getClaudeDesktopFirstPartyDir,
} from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { exec } from '@/utils/exec.js';
import { logger } from '@/utils/logger.js';
import { resolveHomeDir } from '@/utils/paths.js';
import { getCommandPath } from '@/utils/processes.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { DEFAULT_GATEWAY_KEY, readState } from './daemon-manager.js';
import { readVsCodeClaudeCodeRouteState } from './connectors/vscode-claude-code.js';

export type ClaudeLoginState = 'logged-out' | 'configured';
export type VsCodeRouteDecision = 'route' | 'refresh' | 'skip' | 'skip-other-gateway';
export type DesktopRouteDecision = 'route' | 'refresh' | 'skip-other-gateway' | 'skip-1p';

export interface ClaudeClientConfigSeams {
  exec?: typeof exec;
  /** The `claude` binary: on PATH, else the newest one bundled with the VS Code extension. */
  resolveClaudeBinary?: () => Promise<string | null>;
  /** Default `~/.claude.json`. */
  claudeJsonPath?: string;
  desktop3pDir?: string;
  desktop1pDir?: string;
  /** The gateway key of the daemon whose route counts as ours; default: the recorded daemon's, else the shared default. */
  gatewayKey?: string;
}

const AUTH_STATUS_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareVersionDirs(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

async function newestExtensionBinary(extensionsDir: string): Promise<string | null> {
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  let entries: string[];
  try {
    entries = await readdir(extensionsDir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter(name => name.startsWith('anthropic.claude-code-'))
    .sort(compareVersionDirs)
    .reverse();
  for (const name of candidates) {
    const binary = join(extensionsDir, name, 'resources', 'native-binary', binaryName);
    if (existsSync(binary)) return binary;
  }
  return null;
}

/** `claude` on PATH, else the newest binary under `~/.vscode{,-insiders}/extensions/anthropic.claude-code-*`. */
export async function resolveClaudeBinary(): Promise<string | null> {
  try {
    const onPath = await getCommandPath('claude', AUTH_STATUS_TIMEOUT_MS);
    if (onPath) return onPath;
  } catch (error) {
    logger.debug('[proxy] claude lookup on PATH failed', ...sanitizeLogArgs({ error: String(error) }));
  }
  for (const dir of ['.vscode', '.vscode-insiders']) {
    const found = await newestExtensionBinary(resolveHomeDir(join(dir, 'extensions')));
    if (found) return found;
  }
  return null;
}

async function loginFromClaudeJson(claudeJsonPath: string): Promise<ClaudeLoginState> {
  if (!existsSync(claudeJsonPath)) return 'logged-out';
  try {
    const parsed: unknown = JSON.parse(await readFile(claudeJsonPath, 'utf-8'));
    return isRecord(parsed) && 'oauthAccount' in parsed ? 'configured' : 'logged-out';
  } catch (error) {
    logger.debug('[proxy] ~/.claude.json not readable; counting Claude as configured', ...sanitizeLogArgs({ error: String(error) }));
    return 'configured';
  }
}

/**
 * The `ANTHROPIC_*` variables `claude auth status` runs without: every one, except `ANTHROPIC_API_KEY` when no
 * `ANTHROPIC_BASE_URL` is set. Alone, that key is the user's own first-party key and counts as configured. Beside
 * a base URL it is a gateway's key, and a gateway in this shell does not hide the stored login.
 */
function routingVariablesToStrip(): string[] {
  const names = Object.keys(process.env).filter(key => key.startsWith('ANTHROPIC_'));
  return hasOwnApiKeyInShell() ? names.filter(name => name !== 'ANTHROPIC_API_KEY') : names;
}

function hasOwnApiKeyInShell(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && !process.env.ANTHROPIC_BASE_URL;
}

/**
 * Whether the user has a Claude login or key of their own: `claude auth status --json` run with the routing
 * variables of this shell stripped (see {@link routingVariablesToStrip}), so they do not hide the stored login. `authMethod: "none"` is
 * `logged-out` (the command exits 1 then, so the exit code is ignored); any other method, a timed-out run or output that does not parse is `configured`. Without a
 * `claude` binary the answer comes from the shell's own `ANTHROPIC_API_KEY`, else `~/.claude.json` (an `oauthAccount` key
 * means configured).
 */
export async function detectClaudeLogin(seams: ClaudeClientConfigSeams = {}): Promise<ClaudeLoginState> {
  const run = seams.exec ?? exec;
  const binary = await (seams.resolveClaudeBinary ?? resolveClaudeBinary)();
  if (!binary) {
    if (hasOwnApiKeyInShell()) return 'configured';
    return loginFromClaudeJson(seams.claudeJsonPath ?? resolveHomeDir('.claude.json'));
  }

  try {
    const result = await run(binary, ['auth', 'status', '--json'], {
      timeout: AUTH_STATUS_TIMEOUT_MS,
      unsetEnv: routingVariablesToStrip(),
    });
    // `claude auth status` exits 1 when nobody is logged in, and still prints the JSON; the output decides, not the code.
    const parsed: unknown = JSON.parse(result.stdout);
    return isRecord(parsed) && parsed.authMethod === 'none' ? 'logged-out' : 'configured';
  } catch (error) {
    logger.debug('[proxy] claude auth status not usable; counting Claude as configured', ...sanitizeLogArgs({ error: String(error) }));
    return 'configured';
  }
}

/**
 * What `--claude-otlp` does to the VS Code extension's model route: our own route (a loopback gateway with the daemon's
 * key) is refreshed, another route or key in the extension's settings (a loopback gateway with another key included)
 * is left alone as `skip-other-gateway`, a Claude login or key of the user's own is left alone as `skip`, and a route
 * is written only for a user with neither.
 */
export async function decideVsCodeRoute(insiders: boolean, seams: ClaudeClientConfigSeams = {}): Promise<VsCodeRouteDecision> {
  const key = seams.gatewayKey ?? (await readState())?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
  const state = await readVsCodeClaudeCodeRouteState(key, insiders);
  if (state === 'ours') return 'refresh';
  if (state === 'foreign') return 'skip-other-gateway';
  return (await detectClaudeLogin(seams)) === 'logged-out' ? 'route' : 'skip';
}

async function hasAppliedConfig(desktop3pDir: string): Promise<boolean> {
  try {
    const meta: unknown = JSON.parse(await readFile(join(desktop3pDir, 'configLibrary', '_meta.json'), 'utf-8'));
    return appliedConfigId(meta) !== undefined || (isRecord(meta) && meta.appliedId !== undefined);
  } catch {
    return false;
  }
}

/**
 * What `--claude-otlp` does to Claude Desktop's model route: a config that points at the local proxy with the daemon's
 * key is refreshed, another applied config (a loopback gateway with another key included) is left alone, and with
 * none applied Desktop is routed only when it has no first-party data directory. With no applied config Desktop
 * cannot run on a gateway, so a first-party directory means its own Claude account. `deploymentMode` in
 * `Claude-3p/claude_desktop_config.json` is not read: Desktop writes it while it runs on a gateway and keeps it after
 * the user goes back to their own account.
 */
export async function decideDesktopRoute(seams: ClaudeClientConfigSeams = {}): Promise<DesktopRouteDecision> {
  const desktop3pDir = seams.desktop3pDir ?? getClaudeDesktopBaseDir();
  const state = await readDesktopGatewayState(desktop3pDir);
  if (state.gateway) {
    const key = seams.gatewayKey ?? (await readState())?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
    return isDesktopPointedAtLocalProxy(state.gateway, key) ? 'refresh' : 'skip-other-gateway';
  }
  if (state.namesGateway || (await hasAppliedConfig(desktop3pDir))) return 'skip-other-gateway';

  const desktop1pDir = seams.desktop1pDir ?? getClaudeDesktopFirstPartyDir();
  return existsSync(desktop1pDir) ? 'skip-1p' : 'route';
}

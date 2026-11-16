/**
 * Orchestrates `codemie proxy connect` across one or more targets over a single
 * daemon lifecycle. The unified `connect` command and the two deprecated aliases
 * (`desktop`, `vscode`) are thin wrappers that build a target set and delegate here.
 *
 * Config writers (`connectors/desktop.ts`, `connectors/vscode.ts`,
 * `connectors/vscode-claude-code.ts`) are composed unchanged.
 */
import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';
import { resolveLoginUrl, resolveProfileCodeMieUrl } from '../../../providers/core/login-url.js';
import { ProviderRegistry } from '../../../providers/index.js';
import { displaySetupInstructions } from '../../../providers/integration/setup-ui.js';
import {
  ClientNotInstalledError,
  ConfigurationError,
  createErrorContext,
  formatErrorForUser,
} from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { syncRegisteredSkills } from '../skills/setup/sync.js';
import { syncPluginSkills } from '../skills/setup/sync-plugin.js';
import {
  checkStatus,
  clearLegacyClientIdentity,
  hasLegacyClientIdentity,
  isOlderDaemon,
  readConnectionRecord,
  readState,
  spawnDaemon,
  stopDaemon,
  writeConnectionRecord,
  type DaemonState,
} from './daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, DaemonLockError, withDaemonLock } from './daemon-lock.js';
import { reportDaemonProfileIdentity } from '../../../agents/core/launch-identity.js';
import { describeProjectBinding, sanitizeDisplayText, type ProjectBindingState } from '../../../utils/project-binding.js';
import {
  writeDesktopConfig,
  getDesktopBaseDir,
  readDesktopGateway,
  mapCanonicalToDesktop,
  describeManagedSettingsOverride,
  summarizeManagedOauthShapes,
} from './connectors/desktop.js';
import { fetchManagedMcpServers } from './connectors/managed-mcp-remote.js';
import { writeVsCodeClaudeCodeConfig } from './connectors/vscode-claude-code.js';
import { writeVsCodeLanguageModelsConfig, type ConnectorGateway } from './connectors/vscode.js';
import { checkProxyHealth } from './health-check.js';
import { readConfiguredOtlpPort } from './connectors/claude-code-otlp-endpoint.js';
import {
  discoverCodexModels,
  findCodexDesktopApp,
  getCodexDesktopAppCandidates,
  getCodexDesktopConfigPath,
  getCodexDesktopStatePath,
  selectCodexModel,
  writeCodexDesktopConfig,
} from './connectors/codex-desktop.js';
import { confirmClaudeCodeOtlp, runClaudeCodeOtlp, type ClaudeCodeOtlpDisplay } from './claude-code-otlp-flow.js';
import { writeCopilotChatOtlpConfig } from './connectors/copilot-chat-otlp.js';
import { writeCopilotCliOtlpConfig } from './connectors/copilot-cli-otlp.js';
import { isOmpExtensionInstalled, writeOmpExtension } from './connectors/omp.js';
import { CLIENT_CONFIGS, type ClientConfig } from './analytics-delivery-lines.js';
import {
  aggregateConnectExamples,
  aggregateFlagOf,
  aggregateListRows,
  failAggregateInvalidProjectList,
  failDesktopWithoutCodeMieUrl,
  memberFlag,
  membersNotFound,
  membersOf,
  notInstalledLine,
  type AnalyticsMember,
  withAggregateFlags,
  type AggregateId,
} from './analytics-clients.js';
import { CLAUDE_OTLP_FLAG, formatFlagRows, vendorFlags } from './flag-list.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import type { AllowlistScope } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { isNonInteractiveEnvironment } from '@/utils/interactive.js';
import { verifyActiveCli } from '@/utils/active-cli.js';
import { getCurrentCliVersion } from '@/utils/cli-updater.js';
import {
  CLAUDE_DESKTOP,
  VSCODE_BYOK,
} from '@/providers/plugins/sso/proxy/proxy-clients.js';
import { renderHint } from '@/utils/hint.js';
import {
  ANALYTICS_TARGETS,
  confirmScopeDrops,
  runIfScopeUnchanged,
  warnIgnoredAnalyticsFlags,
  type AnalyticsTargetKey,
  type ScopeBaselines,
} from './connect-scope-preflight.js';

export const DEFAULT_DAEMON_PORT = 4001;

// ── Target model ─────────────────────────────────────────────────────────────

/** The orthogonal targets a single `connect` invocation may configure. */
export interface ConnectTargets {
  claudeDesktop?: boolean;
  claudeCodeOtlp?: boolean;
  copilotChatOtlp?: boolean;
  copilotCliOtlp?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
  codexDesktop?: boolean;
  omp?: boolean;
}

/** Options for a unified `connect` run (built by the command/alias wrappers). */
export interface ConnectOptions {
  targets: ConnectTargets;
  profile?: string;
  insiders?: boolean;
  /** Replace a running daemon even when it matches and is healthy: the deprecated `--force` only. */
  restartDaemon?: boolean;
  /** Replace client config CodeMie did not write (`--overwrite`). */
  overwrite?: boolean;
  verbose?: boolean;
  /** Pin a specific model for the Codex desktop target. */
  model?: string;
  /**
   * Analytics connector tracking scope. Settings always live in ~/.claude/settings.json.
   * Left undefined when `--scope` is omitted, so the omission stays detectable; connect
   * coalesces it to Global (`user`) after its checks, identical to `--scope user`, except that an
   * analytics member set by an aggregate (`--claude-otlp` / `--copilot-otlp`) keeps its stored project list.
   */
  scope?: AllowlistScope;
  /**
   * Skip the confirmation prompts (`--yes`). The only bypass, and the only
   * non-interactive success path for the Claude Code analytics target.
   */
  yes?: boolean;
  /** The analytics aggregates given; absent is none. */
  aggregates?: readonly AggregateId[];
}

/**
 * The port a start asks for, read before any status check or stop of the same command (both can delete the
 * state file): the port recorded with the clients' connection; for a record without one (an older CLI's), the
 * last daemon's port, live or not, else the port Claude Code's OTLP endpoint is set to, else Claude Desktop's
 * gateway port, else the default.
 */
export async function requestedDaemonPort(): Promise<number> {
  return (await readConnectionRecord())?.port ??
    (await readState())?.port ??
    (await readConfiguredOtlpPort()) ??
    (await readDesktopGateway())?.port ??
    DEFAULT_DAEMON_PORT;
}

// ── Daemon matching (shared strict path, spec §3.2) ──────────────────────────

export interface RequestedDaemonConfig {
  profile: string;
  port: number;
  project?: string;
  /** Binding state of `project`, recorded in the daemon state (not part of matching). */
  projectBinding?: ProjectBindingState;
  provider?: string;
  targetUrl?: string;
  /** Normalized profile model that drives the daemon lifecycle (see `normalizeDaemonModel`). */
  model?: string;
}

/**
 * Canonical form of a profile model for daemon lifecycle comparison. Trims
 * surrounding whitespace and treats an empty/blank value as "unset" so the
 * recorded `state.model` and the requested `config.model` compare apples-to-apples.
 */
export function normalizeDaemonModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Strict daemon match — the single reconciled matcher used for every target (spec §3.2): profile, port and
 * project, and provider, target URL and model when requested. The daemon serves every client, so no client
 * type is compared.
 */
export function daemonMatchesRequest(
  state: NonNullable<Awaited<ReturnType<typeof readState>>>,
  requested: RequestedDaemonConfig
): boolean {
  return state.profile === requested.profile &&
    state.port === requested.port &&
    state.project === requested.project &&
    (!requested.provider || state.provider === requested.provider) &&
    (!requested.targetUrl || state.targetUrl === requested.targetUrl) &&
    (!normalizeDaemonModel(requested.model) ||
      normalizeDaemonModel(state.model) === normalizeDaemonModel(requested.model));
}

// ── Config resolution + credential/error helpers ─────────────────────────────

/**
 * Resolve an SSO-backed CodeMie profile for the proxy. `commandExample` is the
 * base command echoed back in remediation messages (e.g.
 * `codemie proxy connect --claude-desktop`).
 */
export async function resolveSsoProxyConfig(
  profileName: string | undefined,
  clientLabel: string,
  commandExample: string
): Promise<{
  config: Awaited<ReturnType<typeof ConfigLoader.load>>;
  profileSource: 'explicit' | 'active';
}> {
  const listCodeMieProfiles = async (): Promise<string[]> => {
    const profiles = await ConfigLoader.listProfiles(process.cwd());
    return profiles
      .filter(({ profile }) => {
        const provider = ProviderRegistry.getProvider(profile.provider ?? '');
        return provider?.authType === 'sso';
      })
      .map(({ name }) => name);
  };

  if (profileName) {
    const explicitConfig = await ConfigLoader.load(process.cwd(), { name: profileName });
    const explicitProvider = ProviderRegistry.getProvider(explicitConfig.provider ?? '');

    if (explicitProvider?.authType !== 'sso') {
      const available = await listCodeMieProfiles();
      const details = available.length > 0
        ? `Profiles to try:\n- ${available.join('\n- ')}`
        : renderHint({ reason: 'No SSO-backed CodeMie profiles were found', command: 'codemie setup' });

      throw new ConfigurationError(
        `Profile "${profileName}" cannot be used for ${clientLabel} proxy because it is not SSO-backed.\n\n` +
        `${renderHint({ reason: 'Use an SSO-backed profile', command: `${commandExample} --profile <name>` })}\n\n` +
        `${details}`
      );
    }

    return {
      config: explicitConfig,
      profileSource: 'explicit'
    };
  }

  // Resolve the active profile by name first so ConfigLoader.load()'s
  // profile-protection branch engages - otherwise env vars like
  // CODEMIE_BASE_URL silently clobber the profile's baseUrl below.
  const activeProfileName = await ConfigLoader.getActiveProfileName(process.cwd());
  const activeConfig = await ConfigLoader.load(
    process.cwd(),
    activeProfileName ? { name: activeProfileName } : undefined
  );
  const activeProvider = ProviderRegistry.getProvider(activeConfig.provider ?? '');
  if (activeProvider?.authType === 'sso') {
    return { config: activeConfig, profileSource: 'active' };
  }

  const available = await listCodeMieProfiles();
  const providerName = activeConfig.provider ?? 'unknown';
  const details = available.length > 0
    ? `${renderHint({ reason: 'Switch to an SSO-backed profile', command: `codemie profile switch <codemie-profile> && ${commandExample}` })}\n\n` +
    `Or run once with a specific profile:\n` +
    `  ${commandExample} --profile <codemie-profile>\n\n` +
    `Profiles to try:\n- ${available.join('\n- ')}`
    : `No SSO-backed CodeMie profiles were found.\n\n` +
    renderHint({ reason: 'Set up a profile', command: 'codemie setup' });

  throw new ConfigurationError(
    `${clientLabel} proxy needs an SSO-backed CodeMie profile.\n` +
    `Current active profile: "${activeProfileName ?? 'unknown'}" (provider: ${providerName})\n\n` +
    `${details}`
  );
}

/**
 * Throwing, non-exiting credential check: safe on hook paths (no console, no process.exit).
 * Expired credentials read as missing.
 */
export async function assertSsoCredentials(
  baseUrl: string,
  profileName: string,
  codeMieUrl?: string,
  provider?: string
): Promise<void> {
  let loginUrl: string | null = null;
  try {
    const { getStoredPlatformCredentials } = await import('../../../providers/core/codemie-auth-helpers.js');
    const creds = await getStoredPlatformCredentials({ provider: provider ?? 'ai-run-sso', baseUrl, codeMieUrl });
    if (!creds) {
      // Bare `profile login` targets the active profile; any other profile needs its own host.
      const activeProfileName = await resolveActiveProfileName();
      loginUrl = activeProfileName === profileName ? '' : ` --url ${resolveLoginUrl(baseUrl, codeMieUrl)}`;
    }
  } catch (err) {
    throw new ConfigurationError(`Failed to verify credentials: ${(err as Error).message}`);
  }
  // Thrown outside the try so the missing-login error is never re-wrapped.
  if (loginUrl !== null) {
    throw new ConfigurationError(
      `No active CodeMie session for profile '${profileName}'.\n` +
      `  ${renderHint({ reason: 'Sign in first', command: `codemie profile login${loginUrl}` })}`
    );
  }
}

/** Prints the credential error and exits 1; `beforeExit` runs first, before the error lines. */
export async function verifySsoCredentials(
  baseUrl: string,
  profileName: string,
  codeMieUrl?: string,
  provider?: string,
  beforeExit?: () => void
): Promise<void> {
  try {
    await assertSsoCredentials(baseUrl, profileName, codeMieUrl, provider);
  } catch (err) {
    beforeExit?.();
    const [firstLine, ...rest] = (err as Error).message.split('\n');
    console.error(chalk.red(`✗ ${firstLine}`));
    for (const line of rest) {
      console.error(line);
    }
    process.exit(1);
  }
}

async function resolveActiveProfileName(): Promise<string | null> {
  try {
    return await ConfigLoader.getActiveProfileName(process.cwd());
  } catch {
    return null;
  }
}

export function printProxyError(error: unknown, label: string): never {
  const context = createErrorContext(error);
  logger.error(label, error);

  if (error instanceof ConfigurationError) {
    console.error(chalk.red(`✗ ${error.message}`));
  } else {
    console.error(formatErrorForUser(context, { showSystem: false }));
  }

  process.exit(1);
}

// ── Unified connect orchestrator ─────────────────────────────────────────────

/** The bare `proxy connect` target list; every description starts at one column, computed from the longest flag. */
export const CONNECT_TARGET_LIST = [
  'Select at least one target to configure:',
  '',
  ...formatFlagRows([
    ['--claude-desktop', 'Claude Desktop app (MCP servers)'],
    ['--vscode', 'VS Code Copilot Chat models (BYOK)'],
    ['--vscode-claude-code', 'VS Code Claude Code extension'],
    ['--codex-desktop', 'Codex desktop app (writes ~/.codex/config.toml)'],
    ['--omp', 'oh-my-pi (installs a live CodeMie model catalog extension)'],
    ...aggregateListRows((a) => a.connectListLine),
  ]),
  '',
  `  Note: ${CLAUDE_OTLP_FLAG} also routes Claude Desktop and the VS Code extension through the proxy; ` +
    `disconnect ${CLAUDE_OTLP_FLAG} removes that route.`,
  '',
  'Examples:',
  '  codemie proxy connect --claude-desktop',
  '  codemie proxy connect --codex-desktop',
  '  codemie proxy connect --omp',
  '  codemie proxy connect --vscode --vscode-claude-code',
  '  codemie proxy connect --claude-desktop --vscode --insiders',
  ...aggregateConnectExamples(),
  '',
  "Run 'codemie proxy connect --help' for all options.",
].join('\n');

function hasAnyTarget(t: ConnectTargets): boolean {
  return Boolean(
    t.claudeDesktop || t.claudeCodeOtlp || t.copilotChatOtlp || t.copilotCliOtlp ||
    t.vscode || t.vscodeClaudeCode || t.codexDesktop || t.omp
  );
}

/**
 * A human label and the base command to echo in remediation messages; the flags of the aggregates given stand in for
 * their members' flags.
 */
function describeTargets(t: ConnectTargets, aggregates: readonly AggregateId[]): { label: string; commandExample: string } {
  const flags: string[] = [];
  const labels: string[] = [];
  if (t.claudeDesktop) { flags.push('--claude-desktop'); labels.push('Claude Desktop'); }
  if (t.claudeCodeOtlp) { flags.push(`--${CLAUDE_CODE_OTLP_AGENT_NAME}`); labels.push('Claude Code OTLP'); }
  if (t.copilotChatOtlp) { flags.push(`--${COPILOT_CHAT_OTLP_AGENT_NAME}`); labels.push('Copilot Chat OTLP'); }
  if (t.copilotCliOtlp) { flags.push(`--${COPILOT_CLI_OTLP_AGENT_NAME}`); labels.push('Copilot CLI OTLP'); }
  if (t.vscode) { flags.push('--vscode'); labels.push('VS Code'); }
  if (t.vscodeClaudeCode) { flags.push('--vscode-claude-code'); labels.push('VS Code Claude Code'); }
  if (t.codexDesktop) { flags.push('--codex-desktop'); labels.push('Codex Desktop'); }
  if (t.omp) { flags.push('--omp'); labels.push('oh-my-pi'); }
  const label = labels.length === 1 ? labels[0] : 'CodeMie';
  return { label, commandExample: `codemie proxy connect ${vendorFlags(withAggregateFlags(flags, aggregates)).join(' ')}` };
}

async function rollbackDaemon(): Promise<void> {
  try {
    await stopDaemon();
    logger.info('[proxy] Proxy startup rolled back after configuration failure');
  } catch (stopError) {
    logger.warn(
      '[proxy] Failed to stop proxy after configuration failure',
      ...sanitizeLogArgs({
        error: stopError instanceof Error ? stopError.message : String(stopError),
      })
    );
  }
}

/**
 * Stops the daemon this run started once every target failed, under the daemon lock, and only while the state
 * still names it: another run may have replaced it meanwhile. A lock that stays held leaves the daemon running.
 */
async function rollbackOwnDaemon(pid: number): Promise<void> {
  try {
    await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
      if ((await readState())?.pid === pid) {
        await rollbackDaemon();
      }
    });
  } catch (error) {
    if (!(error instanceof DaemonLockError)) throw error;
    console.log(chalk.yellow(`Warning: ${error.message} The proxy started by this run was left running.`));
  }
}

/**
 * Ensure a single daemon matching `requested` is running and healthy, spawning
 * or restarting it as needed (the reconciled strict-match lifecycle, spec §3.2).
 * A running daemon that differs, was started by an older CLI, fails the deep
 * check, or `restartDaemon` is replaced; `adoptLive` takes any running daemon as it is.
 * `writeRecord: false` writes nothing into the connection record. Called under
 * the daemon lock.
 */
export async function ensureDaemon(
  requested: RequestedDaemonConfig,
  config: Awaited<ReturnType<typeof ConfigLoader.load>>,
  restartDaemon?: boolean,
  verbose?: boolean,
  writeRecord = true,
  adoptLive = false
): Promise<{ state: DaemonState; startedInThisRun: boolean }> {
  let { running, state } = await checkStatus();
  if (adoptLive && running && state) {
    return { state, startedInThisRun: false };
  }
  // Connect has no explicit port option: preserve a matching daemon's actual fallback port.
  if (running && state && daemonMatchesRequest(state, { ...requested, port: state.port })) {
    requested = { ...requested, port: state.port };
  }
  const matches = Boolean(running && state && daemonMatchesRequest(state, requested));
  const older = Boolean(running && state && (await isOlderDaemon(state)));

  let unhealthy = false;
  if (running && state && matches && !older && !restartDaemon) {
    const health = await checkProxyHealth({
      port: state.port,
      gatewayKey: state.gatewayKey,
      deep: true,
    });
    unhealthy = !health.healthy;
    if (unhealthy) {
      logger.status(
        chalk.yellow(`Existing proxy is unhealthy (${health.reason ?? 'unknown'}). Restarting...`)
      );
    }
  }

  if (running && (!matches || older || unhealthy || restartDaemon)) {
    if (restartDaemon) {
      logger.status('Restarting the proxy...');
    } else if (older) {
      logger.status('Restarting proxy: it was started by an older CodeMie CLI...');
    } else if (!matches) {
      logger.status('Restarting proxy to match the requested profile, port, project, provider, target URL and model...');
    }
    await stopDaemon();
    running = false;
    state = null;
  }

  let startedInThisRun = false;
  if (!running || !state) {
    logger.status(`Starting proxy (profile: ${config.name ?? 'default'})...`);
    state = await spawnDaemon({
      targetUrl: config.baseUrl as string,
      provider: config.provider ?? 'ai-run-sso',
      profile: config.name ?? 'default',
      ...(normalizeDaemonModel(config.model) ? { model: normalizeDaemonModel(config.model) } : {}),
      port: requested.port,
      project: config.codeMieProject,
      ...(requested.projectBinding ? { projectBinding: requested.projectBinding } : {}),
      syncApiUrl: config.ssoConfig?.apiUrl,
      syncCodeMieUrl: config.codeMieUrl,
      writeRecord,
      recordPort: writeRecord,
    });
    startedInThisRun = true;
    logger.success(verbose ? `Proxy started at ${state.url}` : 'Proxy started');
  }

  return { state, startedInThisRun };
}

export type LoadedConfig = Awaited<ReturnType<typeof ConfigLoader.load>>;

export function buildRequestedConfig(
  profile: string,
  config: LoadedConfig,
  projectBinding: ProjectBindingState | undefined,
  port: number
): RequestedDaemonConfig {
  return {
    profile,
    port,
    project: config.codeMieProject,
    projectBinding,
    provider: config.provider ?? 'ai-run-sso',
    targetUrl: config.baseUrl,
    model: normalizeDaemonModel(config.model),
  };
}

/** An older CodeMie install that is first on `PATH`: its path and version. */
export interface OlderCliOnPath {
  path: string;
  version: string;
}

/**
 * The first `codemie` on `PATH` when it is an older install than this CLI, else null (the same or a newer one, a
 * lookup that answers nothing, this CLI's own version unreadable). Spawns no `codemie`; never throws.
 */
export async function findOlderCliOnPath(): Promise<OlderCliOnPath | null> {
  const ownVersion = await getCurrentCliVersion();
  if (!ownVersion) return null;
  const verdict = await verifyActiveCli(ownVersion);
  return verdict.status === 'stale' ? { path: verdict.active.path, version: verdict.active.version } : null;
}

export function formatOlderCliWarning(older: OlderCliOnPath): string {
  return `Warning: an older CodeMie CLI is first on PATH: ${older.path} (${older.version}). ` +
    'Its hooks start an older proxy, which can refuse the keys of the connected clients.';
}

/** One per-target write outcome, collected to report failures and set the exit code (spec §3.4). */
export interface TargetResult {
  label: string;
  ok: boolean;
  error?: string;
  /**
   * Set under a vendor flag when the client's host application is not installed at all, so its writer could not run
   * (`ClientNotInstalledError`): the client was skipped with its own line, which neither fails the run nor counts as
   * configured.
   */
  skipped?: true;
}

/**
 * The outcome of a vendor-flag member whose writer threw `ClientNotInstalledError`: one `skipped` line naming the host
 * application and the command to re-run once it is installed.
 */
function skippedResult(label: string, host: string, rerun: string): TargetResult {
  console.log(chalk.yellow(`${label}: skipped — ${host} not installed; re-run \`${rerun}\` after installing`));
  return { label, ok: false, skipped: true };
}

function printFailures(results: TargetResult[]): void {
  for (const r of results) {
    if (!r.ok && !r.skipped) {
      console.log(chalk.red(`✗ ${r.label} — ${r.error ?? 'failed'}`));
    }
  }
}

async function runClaudeDesktop(state: DaemonState, verbose: boolean): Promise<TargetResult> {
  try {
    const canonical = state.syncCodeMieUrl
      ? await fetchManagedMcpServers('claude-desktop', state.syncCodeMieUrl)
      : null;
    const orgMcpServers = canonical ? mapCanonicalToDesktop(canonical) : null;
    const oauthShapes = summarizeManagedOauthShapes(orgMcpServers);
    logger.info(
      '[proxy] Resolved managed MCP servers for Claude Desktop',
      ...sanitizeLogArgs({
        codeMieUrl: state.syncCodeMieUrl,
        fetchSucceeded: canonical !== null,
        canonicalCount: canonical?.length ?? 0,
        mappedCount: orgMcpServers?.length ?? 0,
        mappedNames: orgMcpServers?.map((s) => s.name) ?? [],
        oauthConfiguredCount: oauthShapes.oauthConfigured,
        oauthFlaggedCount: oauthShapes.oauthFlagged,
        noAuthCount: oauthShapes.noAuth,
      })
    );
    const configPath = await writeDesktopConfig(
      state.url,
      state.gatewayKey,
      getDesktopBaseDir(),
      orgMcpServers,
      undefined, // default managed-MCP state path
      state.project
    );
    logger.info(
      '[proxy] Claude Desktop proxy configuration written',
      ...sanitizeLogArgs({
        configPath,
        gatewayUrl: state.url,
        profile: state.profile,
        inferenceGatewayApiKey: `${state.gatewayKey}.${CLAUDE_DESKTOP}`,
      })
    );
    console.log(chalk.green('✓ Claude Desktop configured'));
    const managedSettingsWarning = describeManagedSettingsOverride();
    if (managedSettingsWarning) {
      console.log(chalk.yellow(`⚠ ${managedSettingsWarning}`));
      logger.warn(
        '[proxy] Claude Desktop managed settings source present',
        ...sanitizeLogArgs({ managedSettingsWarning })
      );
    }
    if (verbose) {
      console.log(`  Config:  ${configPath}`);
      console.log(`  Gateway: ${state.url}`);
      console.log(chalk.dim('  Telemetry: metrics and conversations will sync as claude-desktop.'));
    }
    console.log(chalk.yellow('  Restart Claude Desktop to apply changes.'));
    return { label: 'Claude Desktop', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Failed to configure Claude Desktop', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.yellow(`  Could not configure Claude Desktop: ${message}`));
    return { label: 'Claude Desktop', ok: false, error: message };
  }
}

/** `Project:` text for connect output: the project with its binding (shared fallback marked). */
function projectDisplay(binding: ProjectBindingState | undefined, project: string | undefined): string {
  return describeProjectBinding(binding, project) ?? (project ? sanitizeDisplayText(project) : '(not configured)');
}

async function runVscodeByok(
  state: DaemonState,
  insiders: boolean,
  config: Awaited<ReturnType<typeof ConfigLoader.load>>,
  verbose: boolean,
  projectBinding?: ProjectBindingState
): Promise<TargetResult> {
  try {
    const result = await writeVsCodeLanguageModelsConfig(state.url, state.gatewayKey, insiders, state.project);
    logger.info(
      '[proxy] VS Code BYOK configuration written',
      ...sanitizeLogArgs({
        configPath: result.configPath,
        gatewayUrl: state.url,
        profile: state.profile,
        project: state.project,
        modelCount: result.modelCount,
        requiresSecretConfiguration: result.requiresSecretConfiguration,
      })
    );
    console.log(chalk.green(`✓ ${insiders ? 'VS Code Insiders' : 'VS Code'} configured`));
    if (verbose) {
      console.log(`  Config:  ${result.configPath}`);
      console.log(`  Gateway: ${state.url}`);
      console.log(`  Models:  ${result.modelCount}`);
      console.log(`  Project: ${projectDisplay(projectBinding, config.codeMieProject)}`);
    }

    // VS Code keeps the key in its secret storage; BYOK's named key is typed there by the user.
    const byokKey = `${state.gatewayKey}.${VSCODE_BYOK}`;
    if (result.requiresSecretConfiguration) {
      displaySetupInstructions({
        setupInstructions: [
          'One-time VS Code secret setup required:\n',
          '1. Open VS Code and Press ⇧⌘P (macOS) or Ctrl+Shift+P (Windows/Linux).',
          '2. Find Chat: Manage Language Models',
          '3. In opened dialog Right-click any CodeMie model → Update API Key',
          `4. Enter API key: ${byokKey}\n`,
          'Reload VS Code, then select a CodeMie model from the model picker.',
        ].join('\n'),
      });
    } else {
      // A shared key typed by an older connect still works and raises no error, so the update is always asked.
      console.log(
        chalk.yellow(
          `  Update the key VS Code holds: open Chat: Manage Language Models, ` +
          `then right-click any CodeMie model → Update API Key and enter ${byokKey}.`
        )
      );
    }
    return { label: 'VS Code (Copilot models)', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Failed to configure VS Code BYOK', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.yellow(`  Could not configure VS Code Copilot models: ${message}`));
    return { label: 'VS Code (Copilot models)', ok: false, error: message };
  }
}

/**
 * `skipRerun`, given when a vendor flag set the extension, is the command to re-run: a missing VS Code then skips the
 * extension instead of failing it. Under `--vscode-claude-code` itself a missing VS Code stays a failure.
 */
async function runVscodeClaudeCode(state: DaemonState, insiders: boolean, skipRerun?: string): Promise<TargetResult> {
  try {
    const vsCodeResult = await writeVsCodeClaudeCodeConfig(state.url, state.gatewayKey, insiders);
    console.log(chalk.green(`✓ VS Code Claude Code extension configured (${vsCodeResult.path})`));
    console.log(chalk.yellow('  Reload VS Code to apply changes.'));
    return { label: 'VS Code Claude Code extension', ok: true };
  } catch (error) {
    if (skipRerun && error instanceof ClientNotInstalledError) {
      logger.debug('[proxy] VS Code Claude Code extension skipped: VS Code is not installed', ...sanitizeLogArgs({ insiders }));
      return skippedResult('VS Code Claude Code extension', insiders ? 'VS Code Insiders' : 'VS Code', skipRerun);
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      '[proxy] Failed to configure VS Code Claude Code extension',
      ...sanitizeLogArgs({ error: message, insiders })
    );
    console.log(chalk.yellow(`  Could not configure the VS Code Claude Code extension: ${message}`));
    return { label: 'VS Code Claude Code extension', ok: false, error: message };
  }
}

interface CodexDesktopRunOptions {
  overwrite?: boolean;
  model?: string;
  profileModel?: string;
  verbose?: boolean;
}

async function runCodexDesktop(
  state: DaemonState,
  options: CodexDesktopRunOptions
): Promise<TargetResult> {
  const label = 'Codex Desktop';
  try {
    const candidates = getCodexDesktopAppCandidates();
    if (!options.overwrite && !(await findCodexDesktopApp(candidates))) {
      throw new ConfigurationError(
        candidates.length === 0
          ? renderHint({
            reason: `The Codex desktop app is not supported on ${process.platform} (macOS and Windows only)`,
            action: 're-run with --overwrite to write the config anyway',
          })
          : renderHint({
            reason: 'Could not find the ChatGPT desktop app (which ships Codex). Looked in: ' +
              candidates.join(', ') +
              (process.platform === 'win32' ? '. Also queried the current user\'s OpenAI.Codex MSIX package' : ''),
            action: 'install it, or re-run with --overwrite to write the config anyway',
          })
      );
    }

    // Printed unconditionally: this command edits a file the user's own Codex CLI
    // also reads, so which file was touched is not a debugging detail.
    const configPath = getCodexDesktopConfigPath();
    console.log(chalk.cyan(`Codex config: ${configPath}`));

    const discovered = await discoverCodexModels(state.url, state.gatewayKey, state.project);
    const model = selectCodexModel(discovered, options.model, options.profileModel);

    await writeCodexDesktopConfig({
      configPath,
      statePath: getCodexDesktopStatePath(),
      proxyUrl: state.url,
      baseUrl: new URL('/v1', state.url).toString(),
      gatewayKey: state.gatewayKey,
      model,
      overwrite: options.overwrite,
    });

    console.log(chalk.green(`\u2713 Codex Desktop configured (model: ${model})`));
    console.log(chalk.yellow('\u26a0 Quit and reopen the ChatGPT desktop app to apply the change.'));
    console.log(chalk.dim('  Switching models in the app\'s picker is supported \u2014 the proxy'));
    console.log(chalk.dim('  maps its model names onto CodeMie deployments.'));
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Codex Desktop configuration failed', ...sanitizeLogArgs({ error: message }));
    return { label, ok: false, error: message };
  }
}

/** Test seam \u2014 the runner is otherwise only reachable through `connectTargets`. */
export const runCodexDesktopForTest = runCodexDesktop;

interface CopilotOtlpRunOptions {
  scope?: 'user' | 'project';
  /** With no `scope`: keep a stored list of named projects (a member set by an aggregate). */
  keepProjectList?: boolean;
}

async function runCopilotChatOtlp(options: CopilotOtlpRunOptions): Promise<TargetResult> {
  const label = 'Copilot Chat Analytics';
  try {
    const result = await writeCopilotChatOtlpConfig({ scope: options.scope, keepProjectList: options.keepProjectList });
    console.log(chalk.green('✓ Copilot Chat analytics configured (hooks-only, no OTel)'));
    console.log(chalk.dim(`  ${result.hookEvents} event(s) wired to codemie hook --agent ${COPILOT_CHAT_OTLP_AGENT_NAME}`));
    console.log(chalk.dim(`  Hook file:     ${result.hookFilePath}`));
    console.log(chalk.dim(`  Settings:      ${result.settingsPath}`));
    if (result.allowlist.length > 0) {
      console.log(chalk.dim('  Tracked projects:'));
      for (const projectPath of result.allowlist) {
        console.log(chalk.dim(`    - ${projectPath}`));
      }
    } else {
      console.log(chalk.dim('  Tracked projects: all projects'));
    }
    console.log(chalk.dim('  Token usage is unavailable in v1 (no native OTel export is configured).'));
    console.log(chalk.yellow('  Restart VS Code to apply changes.'));
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Failed to configure Copilot Chat analytics', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.yellow(`  Could not configure Copilot Chat analytics: ${message}`));
    return { label, ok: false, error: message };
  }
}

async function runCopilotCliOtlp(options: CopilotOtlpRunOptions): Promise<TargetResult> {
  const label = 'Copilot CLI Analytics';
  try {
    const result = await writeCopilotCliOtlpConfig({ scope: options.scope, keepProjectList: options.keepProjectList });
    console.log(chalk.green('✓ Copilot CLI analytics configured (hooks-only, no OTel)'));
    console.log(chalk.dim(`  ${result.hookEvents} event(s) wired to codemie hook --agent ${COPILOT_CLI_OTLP_AGENT_NAME}`));
    console.log(chalk.dim(`  Hook file: ${result.hookFilePath}`));
    if (result.allowlist.length > 0) {
      console.log(chalk.dim('  Tracked projects:'));
      for (const projectPath of result.allowlist) {
        console.log(chalk.dim(`    - ${projectPath}`));
      }
    } else {
      console.log(chalk.dim('  Tracked projects: all projects'));
    }
    console.log(chalk.dim('  Both native `copilot` and managed `codemie-copilot` launches are tracked.'));
    console.log(chalk.yellow('  Restart the Copilot CLI to apply changes (hooks load only at CLI start).'));
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Failed to configure Copilot CLI analytics', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.yellow(`  Could not configure Copilot CLI analytics: ${message}`));
    return { label, ok: false, error: message };
  }
}

async function runOmp(overwrite: boolean): Promise<TargetResult> {
  const label = 'oh-my-pi';
  try {
    const result = await writeOmpExtension({ overwrite });
    console.log(chalk.green(
      result.changed
        ? `\u2713 oh-my-pi extension installed (${result.path})`
        : `\u2713 oh-my-pi extension already up to date (${result.path})`
    ));
    console.log(chalk.dim('  Providers codemie (OpenAI wire) and codemie-claude (Anthropic wire) list the'));
    console.log(chalk.dim('  same catalog as `codemie models list`, with cost and context limits.'));
    console.log(chalk.dim('  Set CODEMIE_OMP_BASE_URL to send inference through another local proxy hop.'));
    console.log(chalk.yellow('  Restart omp, or run `omp models refresh`, to load the catalog.'));
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] oh-my-pi configuration failed', ...sanitizeLogArgs({ error: message }));
    return { label, ok: false, error: message };
  }
}

/**
 * Moves every client config of {@link CLIENT_CONFIGS} that has a key-only write and is not one `targetFlags` names to
 * that client's named key; a row written only while the record holds an older CLI's client identity is skipped without
 * it. One line per client moved or failed. Never throws and never touches the exit code.
 */
async function moveOtherClientsToNamedKeys(state: DaemonState, targetFlags: ReadonlySet<string>): Promise<void> {
  const legacyIdentity = await hasLegacyClientIdentity();
  for (const config of CLIENT_CONFIGS) {
    if (!config.moveToNamedKey || targetFlags.has(config.flag)) continue;
    if (config.movedOnlyWithLegacyIdentity && !legacyIdentity) continue;
    try {
      const outcome = await config.moveToNamedKey.write(state);
      if (outcome === 'moved') {
        console.log(chalk.green(`✓ ${config.label} moved to its own key — ${config.moveToNamedKey.hint}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[proxy] Failed to move a client to its named key', ...sanitizeLogArgs({ client: config.label, error: message }));
      console.log(chalk.yellow(`Warning: could not move ${config.label} to its own key: ${message}`));
    }
  }
}

/**
 * Whether a client config that is no succeeded target may still send the shared key, as read after the pass:
 * Desktop's loopback gateway when its key is sealed or reads as the shared key; a config with a key-only write when it
 * reads the shared key; any other (BYOK) config pointing at a local proxy.
 */
function mayHoldSharedKey(config: ClientConfig, gateway: ConnectorGateway | null): boolean {
  if (config.client === CLAUDE_DESKTOP) return gateway !== null && (gateway.key === undefined || gateway.key === 'shared');
  return config.moveToNamedKey ? gateway?.key === 'shared' : gateway !== null;
}

/**
 * Removes the older CLI's client identity from the connection record, whichever client it names and also when it
 * names none, once no client holds or may hold the shared key: every client of {@link CLIENT_CONFIGS} is a target in
 * `targetOk` that succeeded, or its config, read after the pass, cannot send the shared key; an installed oh-my-pi
 * extension that is no succeeded target keeps it. The running daemon keeps the default client it started with.
 */
async function clearLegacyIdentityWhenUnused(state: DaemonState, targetOk: ReadonlyMap<string, boolean>): Promise<void> {
  if (!(await hasLegacyClientIdentity())) return;
  const succeeded = (flag: string): boolean => targetOk.get(flag) === true;
  for (const config of CLIENT_CONFIGS) {
    if (succeeded(config.flag)) continue;
    if (mayHoldSharedKey(config, await config.read(state))) return;
  }
  if (!succeeded('--omp') && isOmpExtensionInstalled()) return;
  await clearLegacyClientIdentity();
}

/**
 * The move a command a person types makes once the daemon of `state` runs: the clients that are no target in
 * `targetOk` (every client for `proxy start` / `proxy restart`, whose map is empty) move to their named keys, then
 * the record loses the older CLI's client identity once no client holds or may hold the shared key. Prints the
 * pass's own lines; never throws and never touches the exit code. Run outside the daemon lock.
 */
export async function moveClientsToNamedKeys(state: DaemonState, targetOk: ReadonlyMap<string, boolean>): Promise<void> {
  await moveOtherClientsToNamedKeys(state, new Set(targetOk.keys()));
  await clearLegacyIdentityWhenUnused(state, targetOk);
}

/**
 * Configure every requested target over a single daemon lifecycle. Bare invocation
 * (no target flag) prints the target list and returns without side effects. A member of an aggregate given whose
 * application is not found is dropped before any check made for it; when none is left, one line and nothing else. Claude
 * Desktop set by an aggregate under a profile with no CodeMie URL does not run and is a failed target. Each
 * target's writer runs independently; failed targets are listed and the
 * process exit code is set to 1 when any requested target fails (spec §3.4).
 * Once a target succeeded, the configs of the other clients that hold the shared key as text move to their named
 * keys, and so does Claude Desktop's on this daemon's port while the record holds an older CLI's client identity;
 * the record loses that identity once no client holds or may hold the shared key any more.
 */
export async function connectTargets(opts: ConnectOptions): Promise<void> {
  const { targets } = opts;
  const aggregates = opts.aggregates ?? [];

  if (!hasAnyTarget(targets)) {
    console.log(CONNECT_TARGET_LIST);
    process.exitCode = 1;
    return;
  }

  const verbose = Boolean(opts.verbose);
  const insiders = Boolean(opts.insiders);

  if (insiders && !targets.vscode && !targets.vscodeClaudeCode) {
    console.log(
      chalk.yellow('Note: --insiders has no effect without a VS Code target (--vscode / --vscode-claude-code).')
    );
  }

  if (opts.model && !targets.codexDesktop) {
    console.log(chalk.yellow('Note: --model has no effect without --codex-desktop.'));
  }

  warnIgnoredAnalyticsFlags(targets, opts.scope, Boolean(opts.yes));
  // Coalesced only after the ignored-flag checks above, which need to see an omitted --scope.
  const scope: AllowlistScope = opts.scope ?? 'user';

  // An aggregate wires every member, found or not; one whose application is not found is named after the run.
  const activeTargets: ConnectTargets = { ...targets };
  const notFound = await membersNotFound(targets, aggregates, { insiders });
  const members = membersOf(aggregates);
  // A member an aggregate set keeps its stored project list when --scope is omitted.
  const keptLists = new Set<AnalyticsTargetKey>(
    opts.scope === undefined ? ANALYTICS_TARGETS.map((t) => t.key).filter((key) => members.has(key)) : []
  );

  const { label, commandExample } = describeTargets(activeTargets, aggregates);
  // Every target's outcome; a target that fails before the dispatch lands here first.
  const results: TargetResult[] = [];
  const failBeforeDispatch = (): void => {
    printFailures(results);
    if (results.length > 0) process.exitCode = 1;
  };

  let startedInThisRun = false;
  let state: DaemonState;
  let config: Awaited<ReturnType<typeof ConfigLoader.load>>;
  let profile: string;
  let otlpDisplay: ClaudeCodeOtlpDisplay | undefined;
  let projectBinding: ProjectBindingState | undefined;
  let scopeBaselines: ScopeBaselines;
  try {
    // Pre-lock phase: the scope confirmation runs before SSO, the daemon or any config is touched,
    // and sees the raw (possibly omitted) --scope.
    const baselines = await confirmScopeDrops(activeTargets, opts.scope, Boolean(opts.yes), keptLists);
    if (!baselines || !hasAnyTarget(activeTargets)) return;
    scopeBaselines = baselines;

    // Without a TTY the confirmation cannot be shown; --yes is the only
    // non-interactive path. Fail before SSO, the daemon or settings.json are touched.
    if (activeTargets.claudeCodeOtlp && !opts.yes && isNonInteractiveEnvironment()) {
      throw new ConfigurationError(renderHint({
        reason: 'Claude Code analytics requires confirmation, but no interactive terminal is available',
        command: `codemie proxy connect ${memberFlag('claudeCodeOtlp', members)} --yes`,
      }));
    }

    const resolved = await resolveSsoProxyConfig(opts.profile, label, commandExample);
    config = resolved.config;
    if (!config.baseUrl) {
      throw new ConfigurationError(renderHint({ reason: 'No API URL configured', command: 'codemie setup' }));
    }
    // The Claude Desktop target fetches org-managed MCP servers via codeMieUrl. Set by an aggregate, it fails alone.
    if (failDesktopWithoutCodeMieUrl(activeTargets, members, config.codeMieUrl, results) && !hasAnyTarget(activeTargets)) {
      return failBeforeDispatch();
    }

    profile = config.name ?? 'default';
    projectBinding = await reportDaemonProfileIdentity(config, 'proxy');
    // Resolved here because the confirmation header needs the profile and the effective URL.
    otlpDisplay = activeTargets.claudeCodeOtlp
      ? {
          profile,
          codeMieUrl: config.codeMieUrl
            ? resolveProfileCodeMieUrl(config.baseUrl, config.codeMieUrl)
            : undefined,
        }
      : undefined;
    const printProfileLine = () => console.log(verbose
      ? chalk.cyan(
        `Using profile: ${profile} ` +
        `(source: ${resolved.profileSource === 'explicit' ? '--profile' : 'active profile'})`
      )
      : chalk.cyan(`Using profile: ${profile}`));
    // The confirmation prompt opens with its own `Using profile:` summary line, so this
    // one is skipped when that prompt will be shown to avoid printing it twice. The
    // non-interactive-without-`--yes` case already threw above.
    const confirmationWillBeShown = Boolean(activeTargets.claudeCodeOtlp) && !opts.yes;
    if (!confirmationWillBeShown) printProfileLine();

    await verifySsoCredentials(
      config.baseUrl,
      profile,
      config.codeMieUrl,
      config.provider,
      () => printFailures(results)
    );
    if (activeTargets.claudeCodeOtlp && otlpDisplay) {
      const confirmed = await confirmClaudeCodeOtlp(
        scope,
        Boolean(opts.overwrite),
        Boolean(opts.yes),
        otlpDisplay,
      ).catch((error: unknown) => failAggregateInvalidProjectList(error, members, results, () => {
        // The list is checked before the prompt opens, so the prompt never named the profile.
        if (confirmationWillBeShown) printProfileLine();
      }));
      if (!confirmed) {
        activeTargets.claudeCodeOtlp = false;
        if (confirmed === false) console.log(chalk.yellow('Claude Code analytics was not enabled.'));
        if (!hasAnyTarget(activeTargets)) return failBeforeDispatch();
      }
    }

    const cwd = process.cwd();
    await Promise.allSettled([
      syncRegisteredSkills(profile, cwd),
      syncPluginSkills(),
    ]);

    // The record is written after wiring succeeds (below), not at spawn time; the lock is
    // released before the targets are written.
    const ensured = await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => ensureDaemon(
      buildRequestedConfig(profile, config, projectBinding, await requestedDaemonPort()),
      config,
      Boolean(opts.restartDaemon),
      verbose,
      false
    ));
    state = ensured.state;
    startedInThisRun = ensured.startedInThisRun;
  } catch (error) {
    if (startedInThisRun) {
      await rollbackDaemon();
    }
    printFailures(results);
    printProxyError(error, 'Failed to connect proxy');
    // printProxyError calls process.exit and never returns; this explicit return
    // guarantees control can never fall through to the dispatch below with
    // `state`/`config` unassigned, independent of process.exit behavior.
    return;
  }

  // Per-target dispatch (spec §3.4) — each writer runs independently.
  // The `proxy connect` flags of the client configs this run wrote, and whether each write succeeded.
  const targetOk = new Map<string, boolean>();
  /** Whether each analytics member's writer succeeded, for the `configured (not installed yet)` lines. */
  const memberOk = new Map<AnalyticsMember, boolean>();
  const runClient = async (flag: string, result: Promise<TargetResult>, member?: AnalyticsMember): Promise<void> => {
    const r = await result;
    results.push(r);
    targetOk.set(flag, r.ok);
    if (member) memberOk.set(member, r.ok);
  };
  const editionFlag = (flag: string): string => (insiders ? `${flag} --insiders` : flag);
  if (activeTargets.claudeDesktop) {
    await runClient('--claude-desktop', runClaudeDesktop(state, verbose), 'claudeDesktop');
  }
  if (activeTargets.vscode) {
    await runClient(editionFlag('--vscode'), runVscodeByok(state, insiders, config, verbose, projectBinding));
  }
  if (activeTargets.vscodeClaudeCode) {
    const skipRerun = members.has('vscodeClaudeCode')
      ? `codemie proxy connect ${editionFlag(aggregateFlagOf('vscodeClaudeCode'))}`
      : undefined;
    await runClient(editionFlag('--vscode-claude-code'), runVscodeClaudeCode(state, insiders, skipRerun), 'vscodeClaudeCode');
  }
  if (activeTargets.codexDesktop) {
    await runClient('--codex-desktop', runCodexDesktop(state, {
      overwrite: Boolean(opts.overwrite),
      model: opts.model,
      profileModel: config.model,
      verbose,
    }));
  }
  const writerScope = (key: AnalyticsTargetKey): { scope?: AllowlistScope; keepProjectList?: boolean } =>
    keptLists.has(key) ? { keepProjectList: true } : { scope };
  const analyticsWriters: Record<AnalyticsTargetKey, () => Promise<TargetResult>> = {
    claudeCodeOtlp: () => runClaudeCodeOtlp({ overwrite: Boolean(opts.overwrite), ...writerScope('claudeCodeOtlp') }),
    copilotChatOtlp: () => runCopilotChatOtlp(writerScope('copilotChatOtlp')),
    copilotCliOtlp: () => runCopilotCliOtlp(writerScope('copilotCliOtlp')),
  };
  for (const target of ANALYTICS_TARGETS.filter((entry) => activeTargets[entry.key])) {
    const r = await runIfScopeUnchanged(target, scopeBaselines, analyticsWriters[target.key]);
    results.push(r);
    memberOk.set(target.key, r.ok);
  }
  for (const member of notFound) {
    if (memberOk.get(member)) console.log(chalk.yellow(notInstalledLine(member)));
  }
  if (activeTargets.omp) {
    await runClient('--omp', runOmp(Boolean(opts.overwrite)));
  }

  const anyFailed = results.some((r) => !r.ok && !r.skipped);
  const allFailed = results.every((r) => !r.ok);

  // Record the connection only once something was actually wired, so a connect that
  // configured nothing never redirects hook cold starts. A refused write only warns.
  // Only such a connect moves the other clients off the shared key, as `proxy start` and `proxy restart` do.
  if (results.some((r) => r.ok)) {
    await writeConnectionRecord(state, profile, { port: state.port });
    await moveClientsToNamedKeys(state, targetOk);
  }

  // Spec §3.4: after all requested targets run, list the ones that failed; successes
  // already printed their own line.
  printFailures(results);
  if (anyFailed) {
    process.exitCode = 1;
  }
  const olderCli = await findOlderCliOnPath();
  if (olderCli) {
    console.log(chalk.yellow(formatOlderCliWarning(olderCli)));
  }
  if (allFailed && startedInThisRun) {
    await rollbackOwnDaemon(state.pid);
  }
}

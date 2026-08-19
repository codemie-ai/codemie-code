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
import { ProviderRegistry } from '../../../providers/index.js';
import { displaySetupInstructions } from '../../../providers/integration/setup-ui.js';
import {
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
  readState,
  spawnDaemon,
  stopDaemon,
  type DaemonState,
} from './daemon-manager.js';
import {
  writeDesktopConfig,
  getDesktopBaseDir,
  mapCanonicalToDesktop,
  describeManagedSettingsOverride,
  summarizeManagedOauthShapes,
} from './connectors/desktop.js';
import { fetchManagedMcpServers } from './connectors/managed-mcp-remote.js';
import { writeVsCodeClaudeCodeConfig } from './connectors/vscode-claude-code.js';
import { writeVsCodeLanguageModelsConfig } from './connectors/vscode.js';
import { VS_CODE_SUPPORTED_MODELS } from './connectors/vscode-models.js';
import { checkProxyHealth } from './health-check.js';
import {
  discoverCodexModels,
  findCodexDesktopApp,
  getCodexDesktopAppCandidates,
  getCodexDesktopConfigPath,
  getCodexDesktopStatePath,
  selectCodexModel,
  writeCodexDesktopConfig,
} from './connectors/codex-desktop.js';

export const DEFAULT_DAEMON_PORT = 4001;

// ── Target model ─────────────────────────────────────────────────────────────

/** The orthogonal targets a single `connect` invocation may configure. */
export interface ConnectTargets {
  claudeDesktop?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
  codexDesktop?: boolean;
}

/** Options for a unified `connect` run (built by the command/alias wrappers). */
export interface ConnectOptions {
  targets: ConnectTargets;
  profile?: string;
  insiders?: boolean;
  force?: boolean;
  verbose?: boolean;
  /** Pin a specific model for the Codex desktop target. */
  model?: string;
}

/** Effective client type used by `daemonMatchesRequest`. */
export type EffectiveClientType = 'claude-desktop' | 'vscode-byok' | 'codex-desktop';

/**
 * The daemon identity for a target set. `spawnOptions` is byte-identical to the
 * per-command spawn calls that existed before unification: the Anthropic-gateway
 * targets (Claude Desktop app, Claude Code extension) spawn with
 * `telemetryMode: 'claude-desktop'`; the BYOK models target spawns with
 * `clientType: 'vscode-byok'` and no telemetry mode.
 */
export interface DaemonIdentity {
  clientType: EffectiveClientType;
  spawnOptions:
    | { telemetryMode: 'claude-desktop' }
    | { clientType: 'vscode-byok' }
    | { clientType: 'codex-desktop' };
}

/**
 * Derive the single daemon identity for a target set (spec §3.3 — primary by
 * priority: `claude-desktop` > `vscode-claude-code` > `vscode-byok`). The two
 * Anthropic-gateway targets share the `claude-desktop` identity, so the priority
 * collapses onto exactly the two existing identities — no new telemetry value.
 */
export function deriveDaemonIdentity(targets: ConnectTargets): DaemonIdentity {
  if (targets.claudeDesktop || targets.vscodeClaudeCode) {
    return { clientType: 'claude-desktop', spawnOptions: { telemetryMode: 'claude-desktop' } };
  }
  if (targets.codexDesktop) {
    return { clientType: 'codex-desktop', spawnOptions: { clientType: 'codex-desktop' } };
  }
  return { clientType: 'vscode-byok', spawnOptions: { clientType: 'vscode-byok' } };
}

// ── Daemon matching (shared strict path, spec §3.2) ──────────────────────────

export interface RequestedDaemonConfig {
  profile: string;
  port: number;
  project?: string;
  clientType: string;
  provider?: string;
  targetUrl?: string;
}

export function getEffectiveClientType(
  state: NonNullable<Awaited<ReturnType<typeof readState>>>
): string {
  return state.clientType ?? (state.telemetryMode === 'claude-desktop'
    ? 'claude-desktop'
    : 'codemie-daemon');
}

/**
 * Strict daemon match — the single reconciled matcher used for every target
 * (spec §3.2). Replaces the pre-unification loose desktop gate
 * (`telemetryMode !== 'claude-desktop'`).
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
    getEffectiveClientType(state) === requested.clientType;
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
        : 'No SSO-backed CodeMie profiles were found. Run: codemie setup';

      throw new ConfigurationError(
        `Profile "${profileName}" cannot be used for ${clientLabel} proxy because it is not SSO-backed.\n\n` +
        `Next step:\n` +
        `  ${commandExample} --profile <name>\n\n` +
        `${details}`
      );
    }

    return {
      config: explicitConfig,
      profileSource: 'explicit'
    };
  }

  const activeConfig = await ConfigLoader.load(process.cwd());
  const activeProvider = ProviderRegistry.getProvider(activeConfig.provider ?? '');
  if (activeProvider?.authType === 'sso') {
    return { config: activeConfig, profileSource: 'active' };
  }

  const activeProfileName = await ConfigLoader.getActiveProfileName(process.cwd());
  const available = await listCodeMieProfiles();
  const providerName = activeConfig.provider ?? 'unknown';
  const details = available.length > 0
    ? `Next step:\n` +
      `  codemie profile switch <codemie-profile>\n` +
      `  ${commandExample}\n\n` +
      `Or run once with a specific profile:\n` +
      `  ${commandExample} --profile <codemie-profile>\n\n` +
      `Profiles to try:\n- ${available.join('\n- ')}`
    : `No SSO-backed CodeMie profiles were found.\n\n` +
      `Next step:\n` +
      `  codemie setup`;

  throw new ConfigurationError(
    `${clientLabel} proxy needs an SSO-backed CodeMie profile.\n` +
    `Current active profile: "${activeProfileName ?? 'unknown'}" (provider: ${providerName})\n\n` +
    `${details}`
  );
}

export async function verifySsoCredentials(baseUrl: string, profileName: string): Promise<void> {
  try {
    const { CodeMieSSO } = await import('../../../providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const creds = await sso.getStoredCredentials(baseUrl);
    if (!creds) {
      console.error(chalk.red(`✗ No SSO credentials found for profile '${profileName}'.`));
      console.error(`  Run: codemie profile login --url ${baseUrl}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(chalk.red(`✗ Failed to verify credentials: ${(err as Error).message}`));
    process.exit(1);
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

const TARGET_LIST = [
  'Select at least one target to configure:',
  '',
  '  --claude-desktop       Claude Desktop app (MCP servers)',
  '  --vscode               VS Code Copilot Chat models (BYOK)',
  '  --vscode-claude-code   VS Code Claude Code extension',
  '  --codex-desktop        Codex desktop app (writes ~/.codex/config.toml)',
  '',
  'Examples:',
  '  codemie proxy connect --claude-desktop',
  '  codemie proxy connect --vscode --vscode-claude-code',
  '  codemie proxy connect --claude-desktop --vscode --insiders',
  '',
  "Run 'codemie proxy connect --help' for all options.",
].join('\n');

function hasAnyTarget(t: ConnectTargets): boolean {
  return Boolean(t.claudeDesktop || t.vscode || t.vscodeClaudeCode || t.codexDesktop);
}

/** A human label and the base command to echo in remediation messages. */
function describeTargets(t: ConnectTargets): { label: string; commandExample: string } {
  const flags: string[] = [];
  const labels: string[] = [];
  if (t.claudeDesktop) { flags.push('--claude-desktop'); labels.push('Claude Desktop'); }
  if (t.vscode) { flags.push('--vscode'); labels.push('VS Code'); }
  if (t.vscodeClaudeCode) { flags.push('--vscode-claude-code'); labels.push('VS Code Claude Code'); }
  if (t.codexDesktop) { flags.push('--codex-desktop'); labels.push('Codex Desktop'); }
  const label = labels.length === 1 ? labels[0] : 'CodeMie';
  return { label, commandExample: `codemie proxy connect ${flags.join(' ')}` };
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
 * Ensure a single daemon matching `requested` is running and healthy, spawning
 * or restarting it as needed (the reconciled strict-match lifecycle, spec §3.2).
 */
async function ensureDaemon(
  requested: RequestedDaemonConfig,
  identity: DaemonIdentity,
  config: Awaited<ReturnType<typeof ConfigLoader.load>>,
  force: boolean,
  verbose: boolean
): Promise<{ state: DaemonState; startedInThisRun: boolean }> {
  let { running, state } = await checkStatus();
  const matches = Boolean(running && state && daemonMatchesRequest(state, requested));

  let unhealthy = false;
  if (running && state && matches && !force) {
    const health = await checkProxyHealth({
      port: state.port,
      gatewayKey: state.gatewayKey,
      deep: true,
    });
    unhealthy = !health.healthy;
    if (unhealthy) {
      console.log(
        chalk.yellow(`Existing proxy is unhealthy (${health.reason ?? 'unknown'}). Restarting...`)
      );
    }
  }

  if (running && (!matches || unhealthy || force)) {
    if (force) {
      console.log('Forcing a fresh proxy restart...');
    } else if (!matches) {
      console.log('Restarting proxy to match the requested client...');
    }
    await stopDaemon();
    running = false;
    state = null;
  }

  let startedInThisRun = false;
  if (!running || !state) {
    console.log('Starting proxy...');
    state = await spawnDaemon({
      targetUrl: config.baseUrl as string,
      provider: config.provider ?? 'ai-run-sso',
      profile: config.name ?? 'default',
      port: DEFAULT_DAEMON_PORT,
      project: config.codeMieProject,
      ...identity.spawnOptions,
      syncApiUrl: config.ssoConfig?.apiUrl,
      syncCodeMieUrl: config.codeMieUrl,
    });
    startedInThisRun = true;
    console.log(verbose
      ? chalk.green(`✓ Proxy started at ${state.url}`)
      : chalk.green('✓ Proxy started'));
  }

  return { state, startedInThisRun };
}

/** One per-target write outcome, collected for the summary (spec §3.4). */
interface TargetResult {
  label: string;
  ok: boolean;
  error?: string;
}

function printSummary(results: TargetResult[]): void {
  console.log(chalk.bold('\nTargets configured:'));
  for (const r of results) {
    if (r.ok) {
      console.log(chalk.green(`  ✓ ${r.label}`));
    } else {
      console.log(chalk.red(`  ✗ ${r.label}  — ${r.error ?? 'failed'}`));
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
      orgMcpServers
    );
    logger.info(
      '[proxy] Claude Desktop proxy configuration written',
      ...sanitizeLogArgs({
        configPath,
        gatewayUrl: state.url,
        telemetryMode: state.telemetryMode,
        profile: state.profile,
        inferenceGatewayApiKey: state.gatewayKey,
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

async function runVscodeByok(
  state: DaemonState,
  insiders: boolean,
  config: Awaited<ReturnType<typeof ConfigLoader.load>>,
  verbose: boolean
): Promise<TargetResult> {
  try {
    const result = await writeVsCodeLanguageModelsConfig(state.url, insiders);
    logger.info(
      '[proxy] VS Code BYOK configuration written',
      ...sanitizeLogArgs({
        configPath: result.configPath,
        gatewayUrl: state.url,
        profile: state.profile,
        project: state.project,
        modelCount: VS_CODE_SUPPORTED_MODELS.length,
        clientType: state.clientType,
        requiresSecretConfiguration: result.requiresSecretConfiguration,
      })
    );
    console.log(chalk.green(`✓ ${insiders ? 'VS Code Insiders' : 'VS Code'} configured`));
    if (verbose) {
      console.log(`  Config:  ${result.configPath}`);
      console.log(`  Gateway: ${state.url}`);
      console.log(`  Models:  ${VS_CODE_SUPPORTED_MODELS.length}`);
      console.log(`  Project: ${config.codeMieProject || '(not configured)'}`);
    }

    if (result.requiresSecretConfiguration) {
      displaySetupInstructions({
        setupInstructions: [
          'One-time VS Code secret setup required:\n',
          '1. Open VS Code and Press ⇧⌘P (macOS) or Ctrl+Shift+P (Windows/Linux).',
          '2. Find Chat: Manage Language Models',
          '3. In opened dialog Right-click any CodeMie model → Update API Key',
          `4. Enter API key: ${state.gatewayKey}\n`,
          'Reload VS Code, then select a CodeMie model from the model picker.',
        ].join('\n'),
      });
    } else {
      console.log(
        chalk.dim(
          `  If VS Code reports a missing or invalid key, open Chat: Manage Language Models, ` +
          `then right-click any CodeMie model → Update API Key and enter ${state.gatewayKey}.`
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

async function runVscodeClaudeCode(state: DaemonState, insiders: boolean): Promise<TargetResult> {
  try {
    const vsCodeResult = await writeVsCodeClaudeCodeConfig(state.url, state.gatewayKey, insiders);
    console.log(chalk.green(`✓ VS Code Claude Code extension configured (${vsCodeResult.path})`));
    console.log(chalk.yellow('  Reload VS Code to apply changes.'));
    return { label: 'VS Code Claude Code extension', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      '[proxy] Failed to configure VS Code Claude Code extension',
      ...sanitizeLogArgs({ error: message, insiders })
    );
    console.log(chalk.yellow(`  Could not configure the VS Code Claude Code extension: ${message}`));
    return { label: 'VS Code Claude Code extension', ok: false, error: message };
  }
}

/**
 * Configure every requested target over a single daemon lifecycle. Bare invocation
 * (no target flag) prints the target list and returns without side effects. Each
 * target's writer runs independently; a per-target summary is printed and the
 * process exit code is set to 1 when any requested target fails (spec §3.4).
 */
interface CodexDesktopRunOptions {
  force?: boolean;
  model?: string;
  verbose?: boolean;
}

async function runCodexDesktop(
  state: DaemonState,
  options: CodexDesktopRunOptions
): Promise<TargetResult> {
  const label = 'Codex Desktop';
  try {
    if (!findCodexDesktopApp() && !options.force) {
      throw new ConfigurationError(
        'Could not find the ChatGPT desktop app (which ships Codex). Looked in: ' +
        `${getCodexDesktopAppCandidates().join(', ')}. ` +
        'Install it, or re-run with --force to write the config anyway.'
      );
    }

    const configPath = getCodexDesktopConfigPath();
    if (options.verbose) {
      console.log(chalk.cyan(`Codex config: ${configPath}`));
    }

    const discovered = await discoverCodexModels(state.url, state.gatewayKey);
    const model = selectCodexModel(discovered, options.model);

    await writeCodexDesktopConfig({
      configPath,
      statePath: getCodexDesktopStatePath(),
      proxyUrl: state.url,
      baseUrl: new URL('/v1', state.url).toString(),
      gatewayKey: state.gatewayKey,
      model,
      force: options.force,
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

export async function connectTargets(opts: ConnectOptions): Promise<void> {
  const { targets } = opts;
  if (!hasAnyTarget(targets)) {
    console.log(TARGET_LIST);
    return;
  }

  const verbose = Boolean(opts.verbose);
  const insiders = Boolean(opts.insiders);

  if (insiders && !targets.vscode && !targets.vscodeClaudeCode) {
    console.log(
      chalk.yellow('Note: --insiders has no effect without a VS Code target (--vscode / --vscode-claude-code).')
    );
  }

  const { label, commandExample } = describeTargets(targets);

  let startedInThisRun = false;
  let state: DaemonState;
  let config: Awaited<ReturnType<typeof ConfigLoader.load>>;
  try {
    const resolved = await resolveSsoProxyConfig(opts.profile, label, commandExample);
    config = resolved.config;
    if (!config.baseUrl) {
      throw new ConfigurationError('No API URL configured. Run: codemie setup');
    }
    // The Claude Desktop target fetches org-managed MCP servers via codeMieUrl.
    if (targets.claudeDesktop && !config.codeMieUrl) {
      throw new ConfigurationError(
        'Selected profile is missing CodeMie URL.\n' +
        'Run: codemie setup or codemie profile login'
      );
    }

    const profile = config.name ?? 'default';
    console.log(verbose
      ? chalk.cyan(
          `Using profile: ${profile} ` +
          `(source: ${resolved.profileSource === 'explicit' ? '--profile' : 'active profile'})`
        )
      : chalk.cyan(`Using profile: ${profile}`));

    await verifySsoCredentials(config.baseUrl, profile);
    const cwd = process.cwd();
    await Promise.allSettled([
      syncRegisteredSkills(profile, cwd),
      syncPluginSkills(),
    ]);

    const identity = deriveDaemonIdentity(targets);
    const requested: RequestedDaemonConfig = {
      profile,
      port: DEFAULT_DAEMON_PORT,
      project: config.codeMieProject,
      clientType: identity.clientType,
      provider: config.provider ?? 'ai-run-sso',
      targetUrl: config.baseUrl,
    };

    const ensured = await ensureDaemon(requested, identity, config, Boolean(opts.force), verbose);
    state = ensured.state;
    startedInThisRun = ensured.startedInThisRun;
  } catch (error) {
    if (startedInThisRun) {
      await rollbackDaemon();
    }
    printProxyError(error, 'Failed to connect proxy');
    // printProxyError calls process.exit and never returns; this explicit return
    // guarantees control can never fall through to the dispatch below with
    // `state`/`config` unassigned, independent of process.exit behavior.
    return;
  }

  // Per-target dispatch (spec §3.4) — each writer runs independently.
  const results: TargetResult[] = [];
  if (targets.claudeDesktop) results.push(await runClaudeDesktop(state, verbose));
  if (targets.vscode) results.push(await runVscodeByok(state, insiders, config, verbose));
  if (targets.vscodeClaudeCode) results.push(await runVscodeClaudeCode(state, insiders));
  if (targets.codexDesktop) {
    results.push(await runCodexDesktop(state, {
      force: Boolean(opts.force),
      model: opts.model,
      verbose,
    }));
  }

  const anyFailed = results.some((r) => !r.ok);
  const allFailed = results.every((r) => !r.ok);

  // Spec §3.4: print the per-target summary after all requested targets run,
  // unconditionally — a single-target success gets the summary block too.
  printSummary(results);
  if (anyFailed) {
    process.exitCode = 1;
  }
  if (allFailed && startedInThisRun) {
    await rollbackDaemon();
  }
}

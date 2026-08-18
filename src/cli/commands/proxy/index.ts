import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { syncRegisteredSkills } from '../skills/setup/sync.js';
import { syncPluginSkills } from '../skills/setup/sync-plugin.js';
import {
  checkStatus,
  readState,
  spawnDaemon,
  stopDaemon,
} from './daemon-manager.js';
import { disconnectTargets } from './disconnect-orchestrator.js';
import { checkProxyHealth } from './health-check.js';
import { printDesktopInspection } from './inspect-desktop.js';
import {
  DEFAULT_DAEMON_PORT,
  daemonMatchesRequest,
  verifySsoCredentials,
  printProxyError,
  connectTargets,
  type RequestedDaemonConfig,
} from './connect-orchestrator.js';

const DEFAULT_DESKTOP_INSPECT_LIMIT = 5;

interface ProxyStartOptions {
  port?: string;
  profile?: string;
}

interface UnifiedConnectOptions {
  claudeDesktop?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
  codexDesktop?: boolean;
  profile?: string;
  force?: boolean;
  verbose?: boolean;
  insiders?: boolean;
  model?: string;
}

interface AliasConnectOptions {
  profile?: string;
  insiders?: boolean;
  verbose?: boolean;
  force?: boolean;
}

/** Print the highlighted deprecation notice for a legacy `connect` subcommand. */
function printConnectDeprecation(oldSubcommand: 'desktop' | 'vscode', newFlag: string): void {
  console.log(
    chalk.bold.yellow(
      `⚠ 'codemie proxy connect ${oldSubcommand}' is deprecated — ` +
      `use 'codemie proxy connect ${newFlag}' instead.`
    )
  );
}

/**
 * Resolve a deprecated alias's options, merging the parent `connect` command's
 * options with the alias leaf's own (leaf wins on conflict).
 *
 * The unified `connect` command declares the same option names (`--profile`,
 * `--verbose`, `--force`, `--insiders`) as its `desktop`/`vscode` subcommands.
 * Under the real CLI nesting (`program → proxy → connect → <alias>`) Commander
 * captures those shared flags on the intermediate `connect` command rather than
 * the alias leaf — so an alias action reading only its own opts silently drops
 * them. Merging the parent's opts makes the aliases forward every flag regardless
 * of how positional-option parsing resolves at each level.
 */
function resolveAliasOptions(opts: AliasConnectOptions, command: Command): AliasConnectOptions {
  const parentOpts = (command.parent?.opts() ?? {}) as AliasConnectOptions;
  return { ...parentOpts, ...opts };
}

function parsePortOption(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`Invalid port value: ${value}`);
  }

  return parsed;
}

function formatDaemonConflict(
  state: NonNullable<Awaited<ReturnType<typeof readState>>>
): string {
  const details = [
    'A proxy is already running with different settings:',
    `  profile: ${state.profile}`,
    `  port: ${state.port}`,
  ];

  if (state.clientType) details.push(`  client: ${state.clientType}`);
  if (state.project) details.push(`  project: ${state.project}`);

  details.push('', 'Stop it first:', '  codemie proxy stop');
  return details.join('\n');
}

export function createProxyCommand(): Command {
  const proxy = new Command('proxy');
  proxy
    .description('Manage the CodeMie local gateway proxy daemon')
    // Required so nested subcommands (e.g. `connect vscode`) can reuse option
    // names their parent also defines; the parent has no options of its own.
    .enablePositionalOptions();

  // ── proxy start ─────────────────────────────────────────────────────────────
  proxy
    .command('start')
    .description('Start the background proxy daemon')
    .option('--port <port>', `Fixed port to listen on (default: ${DEFAULT_DAEMON_PORT})`)
    .option('--profile <name>', 'Profile whose credentials to use')
    .action(async (opts: ProxyStartOptions) => {
      try {
        const requestedPort = parsePortOption(opts.port, DEFAULT_DAEMON_PORT);
        const config = await ConfigLoader.load(
          process.cwd(),
          opts.profile ? { name: opts.profile } : undefined
        );
        const profile = config.name ?? 'default';

        const requestedDaemon: RequestedDaemonConfig = {
          profile,
          port: requestedPort,
          project: config.codeMieProject,
          clientType: 'codemie-daemon',
          provider: config.provider ?? 'ai-run-sso',
          targetUrl: config.baseUrl,
        };
        const { running, state } = await checkStatus();
        if (running && state) {
          if (daemonMatchesRequest(state, requestedDaemon)) {
            console.log(chalk.green(`✓ Proxy already running at ${state.url}  (profile: ${state.profile})`));
            return;
          }
          throw new ConfigurationError(formatDaemonConflict(state));
        }

        if (!config.baseUrl) {
          throw new ConfigurationError('No API URL configured for this profile.\nRun: codemie setup');
        }

        await verifySsoCredentials(config.baseUrl, profile);

        const cwd = process.cwd();
        await Promise.allSettled([
          syncRegisteredSkills(profile, cwd),
          syncPluginSkills(),
        ]);

        console.log('Starting proxy daemon...');
        const daemonState = await spawnDaemon({
          targetUrl: config.baseUrl,
          provider: config.provider ?? 'ai-run-sso',
          profile,
          port: requestedPort,
          project: config.codeMieProject,
          syncApiUrl: config.ssoConfig?.apiUrl,
          syncCodeMieUrl: config.codeMieUrl,
        });

        console.log(chalk.green(`✓ Proxy running at ${daemonState.url}  (profile: ${daemonState.profile})`));
      } catch (error) {
        printProxyError(error, 'Failed to start proxy');
      }
    });

  // ── proxy stop ──────────────────────────────────────────────────────────────
  proxy
    .command('stop')
    .description('Stop the background proxy daemon')
    .action(async () => {
      const { running } = await checkStatus();
      if (!running) {
        console.log('Proxy is not running.');
        return;
      }
      await stopDaemon();
      console.log(chalk.green('✓ Proxy stopped'));
    });

  // ── proxy status ─────────────────────────────────────────────────────────────
  proxy
    .command('status')
    .description('Show proxy daemon status')
    .option('--deep', 'Also verify upstream/auth reachability (slower)')
    .action(async (opts) => {
      const { running, state } = await checkStatus();
      if (!running || !state) {
        console.log('Status: stopped');
        return;
      }

      const uptimeSec = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      const uptime = uptimeSec < 60
        ? `${uptimeSec}s`
        : uptimeSec < 3600
          ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
          : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

      const health = await checkProxyHealth({
        port: state.port,
        gatewayKey: state.gatewayKey,
        deep: Boolean(opts.deep),
      });

      if (health.healthy) {
        const label = health.level === 'deep' ? 'running, healthy (upstream OK)' : 'running, healthy';
        console.log(`Status:  ${chalk.green(label)}`);
      } else {
        console.log(`Status:  ${chalk.yellow('running but UNHEALTHY')}`);
        console.log(`  Reason:  ${health.reason ?? state.healthReason ?? 'unknown'}`);
      }

      console.log(`  URL:     ${state.url}`);
      console.log(`  Port:    ${state.port}`);
      console.log(`  Profile: ${state.profile}`);
      if (state.clientType) {
        console.log(`  Client:  ${state.clientType}`);
      }
      if (state.project) {
        console.log(`  Project: ${state.project}`);
      }
      console.log(`  Uptime:  ${uptime}`);

      // Surface a recorded give-up reason even when a fresh ping happens to pass.
      if (state.health === 'unhealthy' && state.healthReason && health.healthy) {
        console.log(chalk.yellow(`  Note:    last recorded issue — ${state.healthReason}`));
      }
    });

  // ── proxy connect ────────────────────────────────────────────────────────────
  const connect = new Command('connect');
  connect
    .description('Configure clients to use the local CodeMie proxy')
    // Let the deprecated `desktop`/`vscode` subcommands reuse option names (e.g.
    // --profile) that the unified command also defines, instead of the parent
    // swallowing them.
    .enablePositionalOptions();

  connect
    .option('--claude-desktop', 'Configure the Claude Desktop app (writes MCP servers config)')
    .option('--vscode', 'Configure VS Code Copilot Chat models — BYOK (writes chatLanguageModels.json)')
    .option('--vscode-claude-code', 'Configure the VS Code Claude Code extension (writes settings.json: ANTHROPIC_BASE_URL/token)')
    .option('--codex-desktop', 'Configure the Codex desktop app (writes ~/.codex/config.toml)')
    .option('--model <slug>', 'Pin a specific model for --codex-desktop (default: best available)')
    .option('--profile <name>', 'Profile whose credentials to use')
    .option('--force', 'Stop any existing proxy and start a fresh one, even if it looks healthy')
    .option('--verbose', 'Show detailed connection info (URLs, config paths) for debugging')
    .option('--insiders', 'Target VS Code Insiders (applies to --vscode / --vscode-claude-code)')
    .action(async (opts: UnifiedConnectOptions) => {
      await connectTargets({
        targets: {
          claudeDesktop: Boolean(opts.claudeDesktop),
          vscode: Boolean(opts.vscode),
          vscodeClaudeCode: Boolean(opts.vscodeClaudeCode),
          codexDesktop: Boolean(opts.codexDesktop),
        },
        profile: opts.profile,
        insiders: Boolean(opts.insiders),
        force: Boolean(opts.force),
        verbose: Boolean(opts.verbose),
        model: opts.model,
      });
    });

  proxy
    .command('disconnect')
    .description('Remove CodeMie proxy configuration from a client')
    .option('--codex-desktop', 'Remove the CodeMie block from ~/.codex/config.toml')
    .action(async (opts: { codexDesktop?: boolean }) => {
      await disconnectTargets({ targets: { codexDesktop: Boolean(opts.codexDesktop) } });
    });

  // Deprecated aliases — kept working, mapped onto the unified target flags.
  connect
    .command('desktop')
    .description("[deprecated] use 'codemie proxy connect --claude-desktop'")
    .option('--profile <name>', 'Profile whose credentials to use for Claude Desktop proxy')
    .option('--verbose', 'Show detailed connection info (URLs, config paths) for debugging')
    .option('--force', 'Stop any existing proxy and start a fresh one, even if it looks healthy')
    .option('--insiders', 'Configure VS Code Insiders instead of stable VS Code')
    .action(async (opts: AliasConnectOptions, command: Command) => {
      const resolved = resolveAliasOptions(opts, command);
      printConnectDeprecation('desktop', '--claude-desktop');
      await connectTargets({
        targets: { claudeDesktop: true },
        profile: resolved.profile,
        insiders: Boolean(resolved.insiders),
        force: Boolean(resolved.force),
        verbose: Boolean(resolved.verbose),
      });
    });

  connect
    .command('vscode')
    .description("[deprecated] use 'codemie proxy connect --vscode'")
    .option('--profile <name>', 'Profile whose URL, credentials, and project to use')
    .option('--insiders', 'Configure VS Code Insiders instead of stable VS Code')
    .option('--verbose', 'Show detailed connection info (URLs, config paths) for debugging')
    .option('--force', 'Stop any existing proxy and start a fresh one, even if it looks healthy')
    .action(async (opts: AliasConnectOptions, command: Command) => {
      const resolved = resolveAliasOptions(opts, command);
      printConnectDeprecation('vscode', '--vscode');
      await connectTargets({
        targets: { vscode: true },
        profile: resolved.profile,
        insiders: Boolean(resolved.insiders),
        force: Boolean(resolved.force),
        verbose: Boolean(resolved.verbose),
      });
    });

  const inspect = new Command('inspect');
  inspect.description('Inspect proxy integrations and telemetry state');

  inspect
    .command('desktop')
    .description('Inspect Claude Desktop proxy telemetry readiness')
    .option('--limit <count>', 'Maximum number of recent sessions to inspect', String(DEFAULT_DESKTOP_INSPECT_LIMIT))
    .action(async (opts) => {
      const { running, state } = await checkStatus();
      const persistedState = state ?? await readState();
      const limit = Number.parseInt(opts.limit, 10);
      await printDesktopInspection(running, persistedState, {
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
      });
    });

  proxy.addCommand(connect);
  proxy.addCommand(inspect);

  return proxy;
}

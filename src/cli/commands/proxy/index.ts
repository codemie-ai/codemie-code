import { Command, Option } from 'commander';
import chalk from 'chalk';
import {
  checkStatus,
  readDaemonStatus,
  readState,
  stopDaemon,
} from './daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, withDaemonLock } from './daemon-lock.js';
import { printNext } from '../../related-commands.js';
import { startProxy, type ProxyStartOptions } from './start.js';
import { restartProxy } from './restart.js';
import { disconnectTargets } from './disconnect-orchestrator.js';
import { createProxyAnalyticsCommand } from './analytics-command.js';
import { createProxyDoctorCommand } from './doctor/command.js';
import { composeProxyDoctor } from './doctor/compose.js';
import { printDesktopInspection } from './inspect-desktop.js';
import {
  DEFAULT_DAEMON_PORT,
  printProxyError,
  connectTargets,
} from './connect-orchestrator.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import type { AllowlistScope } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { renderHint } from '@/utils/hint.js';
import {
  DEPRECATION_REMOVE_ON,
  deprecate,
  deprecatedCommand,
  deprecatedOption,
  type DeprecationEntry,
} from '../../deprecation.js';

const DEFAULT_DESKTOP_INSPECT_LIMIT = 5;

/** How `proxy status` prints the gateway key unless `--show-key` is given (output hygiene, not a secret). */
const MASKED_KEY = '****';

const STATUS_DEEP_DEPRECATION: DeprecationEntry = {
  kind: 'deprecated',
  old: 'codemie proxy status --deep',
  replacement: 'codemie proxy doctor',
  removeOn: DEPRECATION_REMOVE_ON,
};

const INSPECT_DESKTOP_DEPRECATION: DeprecationEntry = {
  kind: 'deprecated',
  old: 'codemie proxy inspect desktop',
  replacement: 'codemie proxy doctor --verbose',
  removeOn: DEPRECATION_REMOVE_ON,
};

interface StatusOptions {
  json?: boolean;
  showKey?: boolean;
  deep?: boolean;
}

function formatUptime(uptimeSec: number): string {
  if (uptimeSec < 60) return `${uptimeSec}s`;
  if (uptimeSec < 3600) return `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;
  return `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
}

interface UnifiedConnectOptions {
  claudeCodeOtlp?: boolean;
  copilotChatOtlp?: boolean;
  copilotCliOtlp?: boolean;
  claudeDesktop?: boolean;
  codexDesktop?: boolean;
  force?: boolean;
  insiders?: boolean;
  model?: string;
  omp?: boolean;
  profile?: string;
  scope?: AllowlistScope;
  silent?: boolean;
  verbose?: boolean;
  vscode?: boolean;
  vscodeClaudeCode?: boolean;
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
    .option('--port <port>', `Fixed port to listen on (default: the port the clients were connected with, else ${DEFAULT_DAEMON_PORT})`)
    .option('--profile <name>', 'Profile whose credentials to use')
    .action(async (opts: ProxyStartOptions) => {
      try {
        await startProxy(opts);
        printNext('proxy start');
      } catch (error) {
        printProxyError(error, 'Failed to start proxy');
      }
    });

  // ── proxy stop ──────────────────────────────────────────────────────────────
  proxy
    .command('stop')
    .description('Stop the background proxy daemon')
    .action(async () => {
      try {
        const stopped = await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
          const { running } = await checkStatus();
          if (running) await stopDaemon();
          return running;
        });
        console.log(stopped ? chalk.green('✓ Proxy stopped') : 'Proxy is not running.');
        printNext('proxy stop');
      } catch (error) {
        printProxyError(error, 'Failed to stop proxy');
      }
    });

  // ── proxy restart ───────────────────────────────────────────────────────────
  proxy
    .command('restart')
    .description('Restart the background proxy daemon, preserving its identity')
    .option('--profile <name>', 'Profile whose credentials to use (default: the running daemon\'s)')
    .action(async (opts: { profile?: string }) => {
      try {
        await restartProxy(opts);
        printNext('proxy restart');
      } catch (error) {
        printProxyError(error, 'Failed to restart proxy');
      }
    });

  // ── proxy status ─────────────────────────────────────────────────────────────
  proxy
    .command('status')
    .description('Show proxy daemon status')
    .option('--json', 'Emit status as JSON instead of formatted output')
    .option('--show-key', 'Show the gateway key in full instead of masked')
    .addOption(deprecatedOption(STATUS_DEEP_DEPRECATION, '--deep', 'Also verify upstream/auth reachability (slower)'))
    .action(async (opts: StatusOptions) => {
      if (opts.deep) {
        deprecate(STATUS_DEEP_DEPRECATION, { json: opts.json });
      }
      const { running, state } = await readDaemonStatus();
      if (!running || !state) {
        if (opts.json) {
          console.log(JSON.stringify({ status: 'stopped' }, null, 2));
        } else {
          console.log('Status: stopped');
        }
        printNext('proxy status', 'stopped', { json: opts.json });
        return;
      }

      const uptimeSec = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      const deep = Boolean(opts.deep);
      // `--deep` keeps its old meaning during the deprecation: the composition runs the authenticated check.
      const report = await composeProxyDoctor({ authProbe: deep, verbose: false });
      const failed = (ids: string[]): boolean =>
        report.sections.some((section) => ids.includes(section.id) && section.status === 'error');
      const healthy = !failed(['daemon']) && !(deep && failed(['auth', 'upstream']));
      const issues = report.sections.some((section) => section.status === 'warn' || section.status === 'error');
      const key = opts.showKey ? state.gatewayKey : MASKED_KEY;

      if (opts.json) {
        const payload: Record<string, unknown> = {
          status: healthy ? 'healthy' : 'unhealthy',
          apiKey: key,
          url: state.url,
          port: state.port,
          profile: state.profile,
          ...(state.project && { project: state.project }),
          version: state.version ?? null,
          uptimeSec,
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      const upstreamOk = report.sections.some((section) => section.id === 'upstream' && section.status === 'ok');
      console.log(healthy
        ? `Status:  ${chalk.green(deep && upstreamOk ? 'running, healthy (upstream OK)' : 'running, healthy')}`
        : `Status:  ${chalk.yellow('running but UNHEALTHY')}`);
      console.log(`  URL:     ${state.url}`);
      console.log(`  Port:    ${state.port}`);
      console.log(`  API Key: ${key}`);
      console.log(`  Client keys: ${key}.<client> — written by codemie proxy connect`);
      console.log(`  Profile: ${state.profile}`);
      if (state.project) {
        console.log(`  Project: ${state.project}`);
      }
      console.log(`  Version: ${state.version ?? 'older CLI'}`);
      console.log(`  Uptime:  ${formatUptime(uptimeSec)}`);
      if (issues) {
        console.log(chalk.yellow(renderHint({ reason: 'Issues found', command: 'codemie proxy doctor' })));
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
    .option('--omp', 'Configure oh-my-pi with the live CodeMie model catalog (installs ~/.omp/agent/extensions/codemie-models.js)')
    .option('--profile <name>', 'Profile whose credentials to use')
    .option('--force', 'Stop any existing proxy and start a fresh one, even if it looks healthy')
    .option('--verbose', 'Show detailed connection info (URLs, config paths) for debugging')
    .option('--insiders', 'Target VS Code Insiders (applies to --vscode / --vscode-claude-code)')
    .option(`--${CLAUDE_CODE_OTLP_AGENT_NAME}`, 'Configure Claude Code analytics hooks and OTLP settings')
    .option(`--${COPILOT_CHAT_OTLP_AGENT_NAME}`, 'Configure VS Code Copilot Chat analytics (hooks-only, no OTel; Stable/default profile)')
    .option(`--${COPILOT_CLI_OTLP_AGENT_NAME}`, 'Configure native GitHub Copilot CLI analytics (hooks-only, no OTel)')
    .addOption(
      new Option(
        '--scope <scope>',
        `Tracking scope for --${CLAUDE_CODE_OTLP_AGENT_NAME} / --${COPILOT_CHAT_OTLP_AGENT_NAME} / --${COPILOT_CLI_OTLP_AGENT_NAME}: "user" (default) tracks all projects and resets the project list; "project" adds the current project and preserves others`,
      )
      .default('user')
      .choices(['user', 'project']),
    )
    .option(
      '--silent',
      `Skip the confirmation prompt (required when non-interactive; applies to --${CLAUDE_CODE_OTLP_AGENT_NAME})`,
    )
    .action(async (opts: UnifiedConnectOptions) => {
      await connectTargets({
        targets: {
          claudeCodeOtlp: Boolean(opts.claudeCodeOtlp),
          copilotChatOtlp: Boolean(opts.copilotChatOtlp),
          copilotCliOtlp: Boolean(opts.copilotCliOtlp),
          claudeDesktop: Boolean(opts.claudeDesktop),
          vscode: Boolean(opts.vscode),
          vscodeClaudeCode: Boolean(opts.vscodeClaudeCode),
          codexDesktop: Boolean(opts.codexDesktop),
          omp: Boolean(opts.omp),
        },
        profile: opts.profile,
        insiders: Boolean(opts.insiders),
        force: Boolean(opts.force),
        verbose: Boolean(opts.verbose),
        model: opts.model,
        scope: opts.scope,
        silent: Boolean(opts.silent),
      });
      printNext('proxy connect');
    });

  proxy
    .command('disconnect')
    .description('Remove CodeMie proxy configuration from a client')
    .option('--claude-desktop', 'Remove the CodeMie gateway config and managed MCP servers from Claude Desktop')
    .option('--vscode-claude-code', 'Remove the CodeMie ANTHROPIC_BASE_URL/token from the VS Code Claude Code extension settings.json')
    .option('--insiders', 'Target VS Code Insiders (applies to --vscode-claude-code)')
    .option('--codex-desktop', 'Remove the CodeMie block from ~/.codex/config.toml')
    .option('--omp', 'Remove the CodeMie model catalog extension from oh-my-pi')
    .option(`--${CLAUDE_CODE_OTLP_AGENT_NAME}`, 'Remove Claude Code analytics hooks, OTLP settings and project allowlist')
    .option(`--${COPILOT_CHAT_OTLP_AGENT_NAME}`, 'Remove Copilot Chat analytics hook file, settings entry and project scope')
    .option(`--${COPILOT_CLI_OTLP_AGENT_NAME}`, 'Remove Copilot CLI analytics hook file and project scope')
    .addOption(
      new Option(
        '--scope <scope>',
        `Tracking scope for --${CLAUDE_CODE_OTLP_AGENT_NAME} / --${COPILOT_CHAT_OTLP_AGENT_NAME} / --${COPILOT_CLI_OTLP_AGENT_NAME}: "user" (default) removes all CodeMie wiring; "project" removes only the current project from the tracked list`,
      )
      .default('user')
      .choices(['user', 'project']),
    )
    .action(async (opts: {
      claudeCodeOtlp?: boolean;
      copilotChatOtlp?: boolean;
      copilotCliOtlp?: boolean;
      claudeDesktop?: boolean;
      vscodeClaudeCode?: boolean;
      codexDesktop?: boolean;
      omp?: boolean;
      insiders?: boolean;
      scope?: 'user' | 'project';
    }) => {
      await disconnectTargets({
        targets: {
          claudeCodeOtlp: Boolean(opts.claudeCodeOtlp),
          copilotChatOtlp: Boolean(opts.copilotChatOtlp),
          copilotCliOtlp: Boolean(opts.copilotCliOtlp),
          claudeDesktop: Boolean(opts.claudeDesktop),
          vscodeClaudeCode: Boolean(opts.vscodeClaudeCode),
          codexDesktop: Boolean(opts.codexDesktop),
          omp: Boolean(opts.omp),
        },
        scope: opts.scope,
        insiders: Boolean(opts.insiders),
      });
      printNext('proxy disconnect');
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

  inspect.addCommand(deprecatedCommand(INSPECT_DESKTOP_DEPRECATION, 'desktop')
    .description('Inspect Claude Desktop proxy telemetry readiness')
    .option('--limit <count>', 'Maximum number of recent sessions to inspect', String(DEFAULT_DESKTOP_INSPECT_LIMIT))
    .action(async (opts) => {
      const status = await readDaemonStatus();
      // A daemon that is not running leaves its state file; the inspection still shows what it last ran with.
      const state = status.running ? status.state : await readState();
      const limit = Number.parseInt(opts.limit, 10);
      await printDesktopInspection(status.running, state, {
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
      });
    }));

  proxy.addCommand(connect);
  // Its only subcommand is deprecated: the group is hidden with it.
  proxy.addCommand(inspect, { hidden: true });
  proxy.addCommand(createProxyAnalyticsCommand());
  proxy.addCommand(createProxyDoctorCommand());

  return proxy;
}

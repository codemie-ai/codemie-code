import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/index.js';
import {
  ConfigurationError,
  createErrorContext,
  formatErrorForUser,
} from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import {
  checkStatus,
  readState,
  spawnDaemon,
  stopDaemon,
} from './daemon-manager.js';
import { writeDesktopConfig } from './connectors/desktop.js';
import { printDesktopInspection } from './inspect-desktop.js';

const DEFAULT_DAEMON_PORT = 4001;
const DEFAULT_DESKTOP_INSPECT_LIMIT = 5;

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

async function resolveDesktopProxyConfig(profileName?: string): Promise<{
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
        `Profile "${profileName}" cannot be used for Claude Desktop proxy because it is not SSO-backed.\n\n` +
        `Next step:\n` +
        `  codemie proxy connect desktop --profile <name>\n\n` +
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
      `  codemie proxy connect desktop\n\n` +
      `Or run once with a specific profile:\n` +
      `  codemie proxy connect desktop --profile <codemie-profile>\n\n` +
      `Profiles to try:\n- ${available.join('\n- ')}`
    : `No SSO-backed CodeMie profiles were found.\n\n` +
      `Next step:\n` +
      `  codemie setup`;

  throw new ConfigurationError(
    `Claude Desktop proxy needs an SSO-backed CodeMie profile.\n` +
    `Current active profile: "${activeProfileName ?? 'unknown'}" (provider: ${providerName})\n\n` +
    `${details}`
  );
}

async function verifySsoCredentials(baseUrl: string, profileName: string): Promise<void> {
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

function printProxyError(error: unknown, label: string): never {
  const context = createErrorContext(error);
  logger.error(label, error);

  if (error instanceof ConfigurationError) {
    console.error(chalk.red(`✗ ${error.message}`));
  } else {
    console.error(formatErrorForUser(context, { showSystem: false }));
  }

  process.exit(1);
}

export function createProxyCommand(): Command {
  const proxy = new Command('proxy');
  proxy.description('Manage the CodeMie local gateway proxy daemon');

  // ── proxy start ─────────────────────────────────────────────────────────────
  proxy
    .command('start')
    .description('Start the background proxy daemon')
    .option('--port <port>', `Fixed port to listen on (default: ${DEFAULT_DAEMON_PORT})`)
    .option('--profile <name>', 'Profile whose credentials to use')
    .action(async (opts) => {
      const { running, state } = await checkStatus();
      if (running && state) {
        console.log(chalk.green(`✓ Proxy already running at ${state.url}  (profile: ${state.profile})`));
        return;
      }

      const config = await ConfigLoader.load(
        process.cwd(),
        opts.profile ? { name: opts.profile } : undefined
      );

      if (!config.baseUrl) {
        console.error(chalk.red('✗ No API URL configured for this profile.'));
        console.error('  Run: codemie setup');
        process.exit(1);
      }

      await verifySsoCredentials(config.baseUrl, config.name ?? 'default');

      console.log('Starting proxy daemon...');
      const daemonState = await spawnDaemon({
        targetUrl: config.baseUrl,
        provider: config.provider ?? 'ai-run-sso',
        profile: config.name ?? 'default',
        port: parsePortOption(opts.port, DEFAULT_DAEMON_PORT),
        syncApiUrl: config.ssoConfig?.apiUrl,
        syncCodeMieUrl: config.codeMieUrl,
      });

      console.log(chalk.green(`✓ Proxy running at ${daemonState.url}  (profile: ${daemonState.profile})`));
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
    .action(async () => {
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

      console.log(`Status:  ${chalk.green('running')}`);
      console.log(`  URL:     ${state.url}`);
      console.log(`  Port:    ${state.port}`);
      console.log(`  Profile: ${state.profile}`);
      console.log(`  Uptime:  ${uptime}`);
    });

  // ── proxy connect ────────────────────────────────────────────────────────────
  const connect = new Command('connect');
  connect.description('Configure a client to use the local proxy');

  connect
    .command('desktop')
    .description('Configure Claude Desktop (3P) to use the local proxy')
    .option('--profile <name>', 'Profile whose credentials to use for Claude Desktop proxy')
    .option('--verbose', 'Show detailed connection info (URLs, config paths) for debugging')
    .action(async (opts) => {
      const verbose: boolean = Boolean(opts.verbose);
      try {
        let { running, state } = await checkStatus();

        if (running && state?.telemetryMode !== 'claude-desktop') {
          console.log('Restarting proxy in Claude Desktop mode...');
          await stopDaemon();
          running = false;
          state = null;
        }

        if (!running) {
          console.log('Starting proxy...');
          const { config, profileSource } = await resolveDesktopProxyConfig(opts.profile);
          if (!config.baseUrl) {
            throw new ConfigurationError('No API URL configured. Run: codemie setup');
          }
          const provider = ProviderRegistry.getProvider(config.provider ?? '');
          if (provider?.authType !== 'sso') {
            throw new ConfigurationError(
              `Claude Desktop proxy needs an SSO-backed profile.\n` +
              `Selected provider: ${config.provider ?? 'unknown'}\n\n` +
              `Next step:\n` +
              `  codemie proxy connect desktop --profile <your-ai-run-sso-profile>`
            );
          }
          if (!config.codeMieUrl) {
            throw new ConfigurationError(
              'Selected profile is missing CodeMie URL.\n' +
              'Run: codemie setup or codemie profile login'
            );
          }
          const profileLabel = config.name ?? 'default';
          if (verbose) {
            console.log(
              chalk.cyan(
                `Using profile: ${profileLabel} ` +
                `(source: ${profileSource === 'explicit' ? '--profile' : 'active profile'})`
              )
            );
          } else {
            console.log(chalk.cyan(`Using profile: ${profileLabel}`));
          }
          await verifySsoCredentials(config.baseUrl, config.name ?? 'default');
          state = await spawnDaemon({
            targetUrl: config.baseUrl,
            provider: config.provider ?? 'ai-run-sso',
            profile: config.name ?? 'default',
            port: DEFAULT_DAEMON_PORT,
            telemetryMode: 'claude-desktop',
            syncApiUrl: config.ssoConfig?.apiUrl,
            syncCodeMieUrl: config.codeMieUrl,
          });
          if (verbose) {
            console.log(chalk.green(`✓ Proxy started at ${state.url}`));
          } else {
            console.log(chalk.green('✓ Proxy started'));
          }
        }

        const configPath = await writeDesktopConfig(state!.url, state!.gatewayKey);
        console.log(chalk.green('✓ Claude Desktop configured'));
        if (verbose) {
          console.log(`  Config:  ${configPath}`);
          console.log(`  Gateway: ${state!.url}`);
          console.log(chalk.dim('  Telemetry: metrics and conversations will sync as claude-desktop.'));
        }
        console.log(chalk.yellow('  Restart Claude Desktop to apply changes.'));
      } catch (error) {
        printProxyError(error, 'Failed to connect Claude Desktop proxy');
      }
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

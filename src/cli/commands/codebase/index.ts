import { Command } from 'commander';
import chalk from 'chalk';
import { openUrlInBrowser } from '../../../utils/browser.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { CodebaseMemoryPlugin } from '../../../frameworks/plugins/codebase-memory.plugin.js';
import {
  checkCodebaseUiStatus,
  spawnCodebaseUi,
  stopCodebaseUi,
} from './daemon-manager.js';

const DEFAULT_CODEBASE_UI_PORT = 9749;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`Invalid port value: ${value}`);
  }

  return parsed;
}

function formatUptime(startedAt: string): string {
  const uptimeSec = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (uptimeSec < 60) {
    return `${uptimeSec}s`;
  }
  if (uptimeSec < 3600) {
    return `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;
  }
  return `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
}

async function ensureCodebaseMemoryUiInstalled(): Promise<boolean> {
  const plugin = new CodebaseMemoryPlugin();
  if (!(await plugin.isInstalled())) {
    console.error(chalk.red('✗ Codebase Memory MCP graph UI is not installed.'));
    console.error('  Run: codemie install codebase-memory');
    process.exitCode = 1;
    return false;
  }

  return true;
}

export function createCodebaseCommand(): Command {
  const codebase = new Command('codebase');
  codebase.description('Manage Codebase Memory MCP and graph visualization UI');

  codebase
    .command('start')
    .description('Start the Codebase Memory graph UI in the background')
    .option('--port <port>', `Fixed port to listen on (default: ${DEFAULT_CODEBASE_UI_PORT})`)
    .action(async (opts) => {
      if (!(await ensureCodebaseMemoryUiInstalled())) {
        return;
      }
      const port = parsePort(opts.port, DEFAULT_CODEBASE_UI_PORT);
      const { running } = await checkCodebaseUiStatus();
      if (running) {
        console.log('Restarting Codebase Memory graph UI...');
        await stopCodebaseUi();
      }

      console.log('Starting Codebase Memory graph UI...');
      try {
        const daemonState = await spawnCodebaseUi({
          port,
        });
        console.log(chalk.green(`✓ Codebase Memory UI running at ${daemonState.url}`));
      } catch (error) {
        console.error(chalk.red(`✗ ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
      }
    });

  codebase
    .command('stop')
    .description('Stop the Codebase Memory graph UI')
    .action(async () => {
      const { running } = await checkCodebaseUiStatus();
      if (!running) {
        console.log('Codebase Memory UI is not running.');
        return;
      }

      await stopCodebaseUi();
      console.log(chalk.green('✓ Codebase Memory UI stopped'));
    });

  codebase
    .command('status')
    .description('Show Codebase Memory graph UI status')
    .action(async () => {
      const { running, state } = await checkCodebaseUiStatus();
      if (!running || !state) {
        console.log('Status: stopped');
        return;
      }

      console.log(`Status:  ${chalk.green('running')}`);
      console.log(`  URL:     ${state.url}`);
      console.log(`  Port:    ${state.port}`);
      console.log(`  Uptime:  ${formatUptime(state.startedAt)}`);
    });

  codebase
    .command('ui')
    .description('Open the Codebase Memory graph UI, starting it if needed')
    .option('--port <port>', `Fixed port to listen on when starting (default: ${DEFAULT_CODEBASE_UI_PORT})`)
    .action(async (opts) => {
      if (!(await ensureCodebaseMemoryUiInstalled())) {
        return;
      }
      let { running, state } = await checkCodebaseUiStatus();
      if (!running || !state) {
        const port = parsePort(opts.port, DEFAULT_CODEBASE_UI_PORT);
        console.log('Starting Codebase Memory graph UI...');
        try {
          state = await spawnCodebaseUi({
            port,
          });
        } catch (error) {
          console.error(chalk.red(`✗ ${error instanceof Error ? error.message : String(error)}`));
          process.exitCode = 1;
          return;
        }
      }

      await openUrlInBrowser(state.url);
      console.log(chalk.green(`✓ Opened ${state.url}`));
    });

  codebase
    .command('open')
    .description('Open the Codebase Memory graph UI URL in the browser')
    .option('--url <url>', `URL to open (default: http://localhost:${DEFAULT_CODEBASE_UI_PORT})`)
    .action(async (opts) => {
      const url = opts.url ?? `http://localhost:${DEFAULT_CODEBASE_UI_PORT}`;
      await openUrlInBrowser(url);
      console.log(chalk.green(`✓ Opened ${url}`));
    });

  return codebase;
}

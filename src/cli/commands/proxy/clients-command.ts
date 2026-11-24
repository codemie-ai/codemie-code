/**
 * `codemie proxy clients`: every client and analytics connector of the client-target table, whether it is connected,
 * where its config lives and, for a connected analytics connector, its tracking scope. An analytics client that is
 * not connected (Claude Code, the VS Code Claude Code extension, Claude Desktop, Copilot Chat, Copilot CLI) carries
 * the command that connects it — its vendor flag, whether or not the client is found on this machine.
 * Tracked and excluded project lists are left to `proxy analytics status`. Only reads.
 */
import { Command } from 'commander';
import chalk from 'chalk';

import { printNext } from '../../related-commands.js';
import { logger } from '@/utils/logger.js';
import { readDaemonStatus } from './daemon-manager.js';
import {
  ANALYTICS_CLIENT_TARGET_IDS,
  analyticsClientHint,
  collectAnalyticsClients,
} from './analytics-clients.js';
import {
  describeConfigLocation,
  readClientTargetStates,
  type ClientTargetState,
} from './client-targets.js';

export type ClientScope = 'user' | 'project' | 'invalid';

export interface ClientRow {
  id: string;
  /** An analytics connector (hooks, with a tracking scope) or a client routed through the proxy. */
  kind: 'client' | 'analytics-connector';
  label: string;
  /** The `proxy connect` flags that connect it. */
  flag: string;
  connected: boolean;
  configLocation: string;
  /** Its sessions feed CodeMie analytics. */
  analytics: boolean;
  /** A connected analytics connector's tracking scope; never the project list. */
  scope?: ClientScope;
  /** The connected check failed. */
  error?: string;
  /** An analytics client: whether its application is on this machine. */
  found?: boolean;
  /** An analytics client that is not connected: its state and the command that connects it. */
  hint?: string;
  /** A connected row routed through CodeMie: what it costs and the command that undoes it. */
  note?: string;
}

interface AnalyticsClientInfo {
  found: boolean;
  /** The hint shown while the row is not connected. */
  hint?: string;
  /** Shown beside a connected row. */
  note?: string;
}

/**
 * The analytics clients by client-target id, read against the running daemon (none when it is stopped). A daemon of
 * an older CLI names no command for a found client: its restart comes first. Never throws.
 */
async function readAnalyticsClientInfo(): Promise<Map<string, AnalyticsClientInfo>> {
  try {
    const { running, state } = await readDaemonStatus();
    const daemon = running ? state : null;
    const commands = daemon === null || Boolean(daemon.version);
    const rows = await collectAnalyticsClients(daemon);
    return new Map(rows.map((row) => {
      // The extension's analytics ride on hooks, apart from the route this table row is about; others judge the row's own state.
      const extension = row.client === 'vscode-claude-code';
      return [
        ANALYTICS_CLIENT_TARGET_IDS[row.client],
        {
          found: row.found,
          hint: analyticsClientHint(extension ? row : { ...row, connected: false }, commands),
          ...(extension && row.routed && { note: analyticsClientHint({ ...row, connected: true }, commands) }),
        },
      ];
    }));
  } catch (error) {
    logger.debug('[proxy clients] analytics client lookup failed:', error);
    return new Map();
  }
}

async function scopeOf(state: ClientTargetState): Promise<ClientScope | undefined> {
  const { target, connected } = state;
  if (!connected || !target.readScope) return undefined;
  try {
    const scope = await target.readScope();
    return 'invalid' in scope ? 'invalid' : scope.scope;
  } catch {
    return 'invalid';
  }
}

/** One row per target, in table order. Never throws. */
export async function collectClientRows(): Promise<ClientRow[]> {
  const [states, analytics] = await Promise.all([readClientTargetStates(), readAnalyticsClientInfo()]);
  return Promise.all(states.map(async (state): Promise<ClientRow> => {
    const scope = await scopeOf(state);
    const info = analytics.get(state.target.id);
    const hint = info && !state.connected && state.error === undefined ? info.hint : undefined;
    return {
      id: state.target.id,
      kind: state.target.readScope ? 'analytics-connector' : 'client',
      label: state.target.label,
      flag: state.target.flag,
      connected: state.connected,
      configLocation: describeConfigLocation(state.target),
      analytics: state.target.carriesAnalytics,
      ...(scope && { scope }),
      ...(state.error !== undefined && { error: state.error }),
      ...(info && { found: info.found || state.connected }),
      ...(hint && { hint }),
      ...(info?.note && state.connected && { note: info.note }),
    };
  }));
}

const SCOPE_TEXT: Record<ClientScope, string> = {
  user: 'scope user (all projects)',
  project: 'scope project',
  invalid: 'scope unreadable',
};

function stateText(row: ClientRow): string {
  if (row.error !== undefined) return chalk.yellow(`check failed: ${row.error}`);
  if (!row.connected) return chalk.dim(row.hint ?? 'not connected');
  return chalk.green('connected') + (row.scope ? `, ${SCOPE_TEXT[row.scope]}` : '') +
    (row.note ? chalk.dim(` — ${row.note}`) : '');
}

function formatRows(rows: ClientRow[]): string[] {
  const width = Math.max(...rows.map((row) => row.label.length));
  const section = (title: string, list: ClientRow[]): string[] => [
    chalk.bold(`${title}:`),
    ...list.map((row) => `  ${row.label.padEnd(width)}  ${stateText(row)}\n  ${' '.repeat(width)}  ${chalk.dim(row.configLocation)}`),
  ];
  return [
    ...section('Clients', rows.filter((row) => row.kind === 'client')),
    '',
    ...section('Analytics connectors', rows.filter((row) => row.kind === 'analytics-connector')),
  ];
}

export function createProxyClientsCommand(): Command {
  return new Command('clients')
    .description('List the clients and analytics connectors the proxy can connect, which are connected, and how to connect the rest')
    .option('--json', 'Emit the list as one JSON document')
    .action(async (opts: { json?: boolean }) => {
      const rows = await collectClientRows();
      if (opts.json) {
        console.log(JSON.stringify({ clients: rows }, null, 2));
        return;
      }
      console.log(formatRows(rows).join('\n'));
      printNext('proxy clients');
    });
}

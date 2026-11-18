/**
 * `codemie proxy clients`: every client and analytics connector of the client-target table, whether it is connected,
 * where its config lives and, for a connected analytics connector, its tracking scope. Tracked and excluded project
 * lists are left to `proxy analytics status`. Only reads.
 */
import { Command } from 'commander';
import chalk from 'chalk';

import { printNext } from '../../related-commands.js';
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
  const states = await readClientTargetStates();
  return Promise.all(states.map(async (state): Promise<ClientRow> => {
    const scope = await scopeOf(state);
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
  if (!row.connected) return chalk.dim('not connected');
  return chalk.green('connected') + (row.scope ? `, ${SCOPE_TEXT[row.scope]}` : '');
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
    .description('List the clients and analytics connectors the proxy can connect, and which are connected')
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

import type { Command } from 'commander';
import { getInvocationContext } from '../utils/invocation-context.js';

export interface RelatedCommand {
  /** Full runnable command, e.g. `codemie proxy status`. */
  path: string;
  purpose: string;
}

export interface RelatedEntry {
  related: RelatedCommand[];
  next: { default?: string; byOutcome?: Record<string, string> };
}

const STATUS: RelatedCommand = { path: 'codemie proxy status', purpose: 'Show proxy daemon status' };
const CONNECT: RelatedCommand = { path: 'codemie proxy connect', purpose: 'Route a client through the proxy' };
const DISCONNECT: RelatedCommand = { path: 'codemie proxy disconnect', purpose: 'Remove proxy configuration from a client' };
const A_STATUS: RelatedCommand = { path: 'codemie proxy analytics status', purpose: 'Show the effective analytics configuration' };
const A_ENABLE: RelatedCommand = { path: 'codemie proxy analytics enable', purpose: 'Resume analytics collection' };
const A_DISABLE: RelatedCommand = { path: 'codemie proxy analytics disable', purpose: 'Stop analytics collection' };
const DOCTOR: RelatedCommand = { path: 'codemie proxy doctor', purpose: 'Diagnose the proxy, clients and analytics delivery' };
const CLIENTS: RelatedCommand = { path: 'codemie proxy clients', purpose: 'List clients and analytics connectors, which are connected, and how to connect the rest' };
const SYNC_STATUS: RelatedCommand = { path: 'codemie analytics sync status', purpose: 'Show analytics sync status' };

/**
 * Keyed by the space-separated command path without the root binary.
 * Hidden (deprecated/removed) nodes need no entry and must never be referenced.
 */
export const RELATED: Record<string, RelatedEntry> = {
  proxy: { related: [STATUS, DOCTOR, CONNECT, CLIENTS, A_STATUS], next: {} },
  'proxy start': {
    related: [STATUS, { path: 'codemie proxy stop', purpose: 'Stop the proxy daemon' }, CONNECT],
    next: { default: 'codemie proxy status' },
  },
  'proxy stop': {
    related: [{ path: 'codemie proxy start', purpose: 'Start the proxy daemon' }, STATUS],
    next: { default: 'codemie proxy start' },
  },
  'proxy restart': {
    related: [STATUS, { path: 'codemie proxy stop', purpose: 'Stop the proxy daemon' }],
    next: { default: 'codemie proxy status' },
  },
  'proxy status': {
    related: [
      { path: 'codemie proxy start', purpose: 'Start the proxy daemon' },
      { path: 'codemie proxy restart', purpose: 'Restart the proxy daemon' },
      DOCTOR,
      A_STATUS,
    ],
    next: { byOutcome: { stopped: 'codemie proxy start' } },
  },
  'proxy doctor': { related: [STATUS, CONNECT, CLIENTS, A_STATUS], next: {} },
  'proxy clients': { related: [CONNECT, DISCONNECT, DOCTOR, A_STATUS], next: {} },
  'proxy connect': {
    related: [DISCONNECT, CLIENTS, STATUS, A_STATUS],
    // `analytics`: an analytics connector was connected; `claude-desktop`: Desktop collects through the proxy.
    next: { default: 'codemie proxy status', byOutcome: { analytics: 'codemie proxy doctor', 'claude-desktop': 'codemie proxy doctor' } },
  },
  'proxy disconnect': {
    related: [CONNECT, CLIENTS, STATUS],
    // `all`: `--all` ran; what is left is the client list.
    next: { default: 'codemie proxy status', byOutcome: { all: 'codemie proxy clients' } },
  },
  // No `next`: the command prints its own restart and Reconnect steps.
  'proxy reset-mcp-auth': { related: [CONNECT, DISCONNECT, CLIENTS], next: {} },
  'proxy analytics': { related: [A_STATUS, A_ENABLE, A_DISABLE], next: {} },
  'proxy analytics status': { related: [A_ENABLE, A_DISABLE, SYNC_STATUS], next: {} },
  'proxy analytics enable': { related: [A_STATUS, A_DISABLE], next: { default: 'codemie proxy analytics status' } },
  'proxy analytics disable': { related: [A_STATUS, A_ENABLE], next: { default: 'codemie proxy analytics status' } },
  'proxy analytics exclude': {
    related: [{ path: 'codemie proxy analytics include', purpose: 'Re-include a project' }, A_STATUS],
    next: {},
  },
  'proxy analytics include': {
    related: [{ path: 'codemie proxy analytics exclude', purpose: 'Exclude a project' }, A_STATUS],
    next: {},
  },
  'proxy analytics consent': {
    related: [
      { path: 'codemie proxy analytics consent grant', purpose: 'Authorize a work project' },
      { path: 'codemie proxy analytics consent list', purpose: 'List authorized folders' },
      A_STATUS
    ],
    next: {},
  },
  'proxy analytics consent grant': {
    related: [{ path: 'codemie proxy analytics consent revoke', purpose: 'Withdraw work-project authorization' }, { path: 'codemie proxy analytics consent list', purpose: 'List authorized folders' }, A_STATUS],
    next: {},
  },
  'proxy analytics consent revoke': {
    related: [{ path: 'codemie proxy analytics consent grant', purpose: 'Authorize a work project' }, { path: 'codemie proxy analytics consent list', purpose: 'List authorized folders' }, A_STATUS],
    next: {},
  },
  'proxy analytics consent list': {
    related: [{ path: 'codemie proxy analytics consent grant', purpose: 'Authorize a work project' }, { path: 'codemie proxy analytics consent revoke', purpose: 'Withdraw work-project authorization' }, A_STATUS],
    next: {},
  },
  analytics: {
    related: [
      { path: 'codemie analytics sync', purpose: 'Manage analytics sync' },
      { path: 'codemie analytics otel', purpose: 'Analyze OTEL data' },
      A_STATUS,
    ],
    next: {},
  },
  'analytics otel': { related: [{ path: 'codemie analytics', purpose: 'Show session analytics' }, SYNC_STATUS], next: {} },
  'analytics view': { related: [{ path: 'codemie analytics --export <format>', purpose: 'Write the JSON export (--export json) that view reads' }], next: {} },
  'analytics sync': {
    related: [
      SYNC_STATUS,
      { path: 'codemie analytics sync run', purpose: 'Run one sync now' },
      { path: 'codemie analytics sync install', purpose: 'Install the scheduled sync' },
    ],
    next: {},
  },
  'analytics sync bootstrap': { related: [SYNC_STATUS, { path: 'codemie analytics sync install', purpose: 'Install the scheduled sync' }], next: {} },
  'analytics sync install': { related: [SYNC_STATUS, { path: 'codemie analytics sync uninstall', purpose: 'Remove the scheduled sync' }], next: {} },
  'analytics sync status': { related: [{ path: 'codemie analytics sync run', purpose: 'Run one sync now' }, { path: 'codemie analytics sync install', purpose: 'Install the scheduled sync' }], next: {} },
  'analytics sync run': { related: [SYNC_STATUS], next: {} },
  'analytics sync uninstall': { related: [SYNC_STATUS, { path: 'codemie analytics sync install', purpose: 'Install the scheduled sync' }], next: {} },
};

function isHidden(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

function render(entry: RelatedEntry): string {
  return `\nRelated commands:\n${entry.related.map((r) => `  ${r.path}  ${r.purpose}`).join('\n')}\n`;
}

/** Append a "Related commands" block to every visible proxy/analytics command's help. */
export function applyRelatedHelp(root: Command): void {
  const walk = (cmd: Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      if (isHidden(sub)) continue;
      const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
      const entry = RELATED[path];
      if (entry) sub.addHelpText('after', render(entry));
      walk(sub, path);
    }
  };
  walk(root, '');
}

/**
 * Print one `Next: <command>` line after a successful command; only on a TTY, never for --json, hooks or the
 * scheduled run, and never once the command has set a non-zero exit code.
 */
export function printNext(path: string, outcome?: string, ctx: { json?: boolean } = {}): void {
  if (process.exitCode !== undefined && Number(process.exitCode) !== 0) return;
  if (!process.stdout.isTTY) return;
  const { json, silent } = getInvocationContext({ json: ctx.json });
  if (json || silent) return;
  const next = RELATED[path]?.next;
  const command = (outcome !== undefined ? next?.byOutcome?.[outcome] : undefined) ?? next?.default;
  if (command) process.stdout.write(`Next: ${command}\n`);
}

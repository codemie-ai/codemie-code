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
const SYNC_STATUS: RelatedCommand = { path: 'codemie analytics sync status', purpose: 'Show analytics sync status' };

/**
 * Keyed by the space-separated command path without the root binary.
 * Hidden (deprecated/removed) nodes need no entry and must never be referenced.
 */
export const RELATED: Record<string, RelatedEntry> = {
  proxy: { related: [STATUS, CONNECT, A_STATUS], next: {} },
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
      { path: 'codemie proxy inspect desktop', purpose: 'Inspect Claude Desktop proxy state' },
      A_STATUS,
    ],
    next: { byOutcome: { stopped: 'codemie proxy start' } },
  },
  'proxy connect': { related: [DISCONNECT, STATUS, A_STATUS], next: { default: 'codemie proxy status' } },
  'proxy connect desktop': { related: [CONNECT, DISCONNECT, STATUS], next: { default: 'codemie proxy status' } },
  'proxy connect vscode': { related: [CONNECT, DISCONNECT, STATUS], next: { default: 'codemie proxy status' } },
  'proxy disconnect': { related: [CONNECT, STATUS], next: { default: 'codemie proxy status' } },
  'proxy inspect': { related: [{ path: 'codemie proxy inspect desktop', purpose: 'Inspect Claude Desktop proxy state' }, STATUS], next: {} },
  'proxy inspect desktop': { related: [STATUS, CONNECT], next: {} },
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
  'proxy analytics connect-folder': {
    related: [{ path: 'codemie proxy analytics disconnect-folder', purpose: 'Withdraw work-project authorization' }, A_STATUS],
    next: {},
  },
  'proxy analytics disconnect-folder': {
    related: [{ path: 'codemie proxy analytics connect-folder', purpose: 'Authorize a work project' }, A_STATUS],
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

/** Print one `Next: <command>` line; only on a TTY, never for --json, hooks or the scheduled run. */
export function printNext(path: string, outcome?: string, ctx: { json?: boolean } = {}): void {
  if (!process.stdout.isTTY) return;
  const { json, silent } = getInvocationContext({ json: ctx.json });
  if (json || silent) return;
  const next = RELATED[path]?.next;
  const command = (outcome !== undefined ? next?.byOutcome?.[outcome] : undefined) ?? next?.default;
  if (command) process.stdout.write(`Next: ${command}\n`);
}

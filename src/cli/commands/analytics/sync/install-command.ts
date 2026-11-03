/**
 * Builds the `codemie analytics sync install …` shell command for a given set of install
 * flags. Pure, no I/O — not wired into the CLI yet; a future `bootstrap` command
 * (EPMCDME-16487) reuses it to print or run the equivalent install invocation.
 *
 * Flags map 1:1 onto the options registered by `createSyncInstallCommand` in
 * `src/cli/commands/analytics/index.ts`. A flag whose value is `undefined` is omitted.
 * Every value is wrapped in single quotes, POSIX-escaped (`'` becomes `'\''`), so the
 * resulting command is safe to pass to a shell as-is.
 */

import { SyncConfigError } from '@/utils/errors.js';

import type { IncludeExternalPolicy } from './types.js';

/** Flags accepted by `buildInstallCommand`, mirroring `codemie analytics sync install`'s
 * CLI options. At least one of `webhook` / `gitRepo` must be given. */
export interface InstallCommandOptions {
  webhook?: string;
  gitRepo?: string;
  gitBranch?: string;
  gitPath?: string;
  at?: string;
  lookbackDays?: number;
  includeExternal?: IncludeExternalPolicy;
}

/** Wraps `value` in single quotes, POSIX-escaping any `'` it contains. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Builds a single `--flag 'value'` token, or `undefined` when `value` is absent. */
function flag(name: string, value: string | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return `${name} ${quote(String(value))}`;
}

/**
 * Builds the `codemie analytics sync install …` command line for `opts`. Throws
 * `SyncConfigError` when neither `webhook` nor `gitRepo` is given, naming both flags the way
 * `SyncTargetMissingError` does.
 */
export function buildInstallCommand(opts: InstallCommandOptions): string {
  if (opts.webhook === undefined && opts.gitRepo === undefined) {
    throw new SyncConfigError('At least one sync target is required: --webhook <url> or --git-repo <url>');
  }

  const tokens = [
    flag('--webhook', opts.webhook),
    flag('--git-repo', opts.gitRepo),
    flag('--git-branch', opts.gitBranch),
    flag('--git-path', opts.gitPath),
    flag('--at', opts.at),
    flag('--lookback-days', opts.lookbackDays),
    flag('--include-external', opts.includeExternal)
  ].filter((token): token is string => token !== undefined);

  return ['codemie analytics sync install', ...tokens].join(' ');
}

/**
 * Builds the `codemie analytics sync install …` shell command for a given set of install
 * flags. Pure, no I/O — not wired into the CLI yet; a future `bootstrap` command
 * (EPMCDME-16487) reuses it to print or run the equivalent install invocation.
 *
 * A flag whose value is `undefined` is omitted. Every other value must pass the
 * printable-value rule (see `assertPrintableValue`); it is then wrapped in double quotes,
 * unescaped. The resulting command is safe to pass to a shell as-is, because the
 * printable-value rule already excludes every character that double quotes do not
 * neutralize (`"`, `$`, a backtick, `!`, a bare `%`, control characters and non-ASCII
 * characters).
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

/** Characters that are never safe to print inside a double-quoted shell token. */
const FORBIDDEN_CHARACTERS = /["$`!]/;

/** A `%` that does not start a `%XX` hex escape (cmd.exe `%name%` expansion risk). */
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

/**
 * Throws `SyncConfigError` naming `flag` when `value` is not safe to print as a
 * double-quoted shell token. A value fails the rule when it contains any of:
 * - `"`, `$`, a backtick or `!`
 * - a control character
 * - a non-ASCII character (this also covers typographic quotes such as U+2018-U+201F)
 * - a `%` that does not start a `%XX` hex escape
 */
export function assertPrintableValue(flag: string, value: string): void {
  if (FORBIDDEN_CHARACTERS.test(value)) {
    throw new SyncConfigError(`${flag} contains a character that is not safe to print: one of " $ \` !`);
  }
  if (INVALID_PERCENT_ESCAPE.test(value)) {
    throw new SyncConfigError(`${flag} contains a "%" that is not a %XX escape`);
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new SyncConfigError(`${flag} contains a control character that is not safe to print`);
    }
    if (code > 0x7e) {
      throw new SyncConfigError(`${flag} contains a non-ASCII character that is not safe to print`);
    }
  }
}

/** Wraps `value` in double quotes. Callers must validate it with `assertPrintableValue` first. */
function quote(value: string): string {
  return `"${value}"`;
}

/** Builds a single `--flag "value"` token, or `undefined` when `value` is absent. */
function flag(name: string, value: string | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const str = String(value);
  assertPrintableValue(name, str);
  return `${name} ${quote(str)}`;
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

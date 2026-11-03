/**
 * Status runner for `codemie analytics sync status`.
 *
 * Reports whether the daily job is installed and actually registered/enabled with the OS
 * scheduler, the current settings (lookback, include-external policy), and a per-target
 * block for each configured delivery target (webhook host only / git repository, redacted)
 * with that target's own last run (or last failure, for git) parsed from the shared run log
 * and its own last successful send/push (its own marker). A run-log line with no
 * ` target=<id>` suffix — written by the previous single-target version, or a setup failure
 * resolved before any target was chosen — is treated as the webhook's. Every side effect is
 * injected via {@link StatusDeps} so tests run without touching the real scheduler,
 * filesystem or marker.
 *
 * `runStatus` never throws and never calls `process.exit`. "Not installed" and "disabled"
 * are reported, not failures — both exit 0. Only an unreadable/invalid settings file
 * (`SyncConfigError` from `loadSyncSettings`) is a failure: its redacted message is printed
 * and the exit code is non-zero.
 */

import { readFile } from 'fs/promises';

import { getCodemiePath } from '@/utils/paths.js';
import { SyncTargetMissingError } from '@/utils/errors.js';

import { loadSyncSettings } from './config-store.js';
import { lookbackText, webhookHost } from './format.js';
import { readMarker } from './marker.js';
import { errorMessage, redactSecrets } from './redact.js';
import type { TargetId } from './run-sync.js';
import { createRealSchedulerDeps, createScheduler } from './scheduler/index.js';
import { gitMarkerPath } from './targets/git-target.js';
import type { SyncSettings } from './types.js';

/** Every side effect `runStatus` needs, injected so tests run without a real scheduler, fs
 * or clock. `createRealStatusDeps()` below wires the real ones. */
export interface StatusDeps {
  /** Throws on an unreadable/invalid settings file; `null` means "not installed" (no
   * settings file at all). */
  loadSettings(): Promise<SyncSettings | null>;
  query(): Promise<'enabled' | 'disabled'>;
  /** The run log's full contents, or `null` when the file does not exist (or cannot be
   * read) — status never fails over a missing/unreadable log; it just reports "never". */
  readLog(): Promise<string | null>;
  readMarker(target: TargetId, now: Date): Promise<Date | null>;
  now(): Date;
  print(line: string): void;
}

/** One parsed outcome line from the run log. */
export interface LastRun {
  at: string;
  outcome: string;
}

// Matches a run-log line's `<ISO> <outcome> ...` prefix (see `run-sync.ts#formatLogLine`):
// `ok sent <name> <bytes>` | `skip <reason>` | `fail <category> <detail>`, with an optional
// trailing ` target=<id>` (single leading space, very end of line). Lines that don't start
// this way (legacy collector lines, stack traces) are ignored.
const LAST_RUN_LINE = /^(\S+) ((?:ok sent|skip|fail \w+).*)$/;

// Strips a trailing ` target=<id>` from an already-matched outcome so it never leaks into
// displayed text.
const TARGET_SUFFIX = / target=(webhook|git)$/;

interface ParsedLine extends LastRun {
  target: TargetId;
}

/** A line with no ` target=<id>` suffix is a legacy (pre-multi-target) line, or a setup
 * failure resolved before any target was chosen — both count as the webhook's, per the
 * run log's own contract (`run-sync.ts`). */
function parseLine(rawLine: string): ParsedLine | null {
  const match = LAST_RUN_LINE.exec(rawLine.trim());
  if (!match) {
    return null;
  }

  const at = match[1];
  const rest = match[2].trim();
  const suffixMatch = TARGET_SUFFIX.exec(rest);

  if (suffixMatch === null) {
    return { at, outcome: rest, target: 'webhook' };
  }

  return { at, outcome: rest.slice(0, suffixMatch.index).trim(), target: suffixMatch[1] as TargetId };
}

/**
 * Find the last line in `log` belonging to `target`, scanning top to bottom so the latest
 * run wins. Returns `null` when no line matches.
 */
export function parseLastRun(log: string, target: TargetId): LastRun | null {
  let last: LastRun | null = null;

  for (const rawLine of log.split('\n')) {
    const parsed = parseLine(rawLine);
    if (parsed !== null && parsed.target === target) {
      last = { at: parsed.at, outcome: parsed.outcome };
    }
  }

  return last;
}

/**
 * Find the last `fail ...` line in `log` belonging to `target`, scanning top to bottom.
 * Returns `null` when no failure matches.
 */
export function parseLastFailure(log: string, target: TargetId): LastRun | null {
  let last: LastRun | null = null;

  for (const rawLine of log.split('\n')) {
    const parsed = parseLine(rawLine);
    if (parsed !== null && parsed.target === target && parsed.outcome.startsWith('fail')) {
      last = { at: parsed.at, outcome: parsed.outcome };
    }
  }

  return last;
}

/** Turn a parsed outcome (`ok sent ...` | `skip ...` | `fail <category> ...`) into the
 * human text status prints: "sent / skipped / failed", each with its detail. */
function describeOutcome(outcome: string): string {
  if (outcome.startsWith('ok sent')) {
    return `sent (${outcome.slice('ok sent'.length).trim()})`;
  }
  if (outcome.startsWith('skip')) {
    return `skipped (${outcome.slice('skip'.length).trim()})`;
  }
  if (outcome.startsWith('fail')) {
    return `failed (${outcome.slice('fail'.length).trim()})`;
  }
  return outcome;
}

function lastRunText(lastRun: LastRun | null): string {
  return lastRun === null ? 'never' : `${lastRun.at} — ${describeOutcome(lastRun.outcome)}`;
}

/** The "Last successful send"/"Last successful push" value for `target`: the marker time,
 * `never`, or — when the marker cannot be read (EACCES, EISDIR) —
 * `unknown (<redacted reason>)`, so status reports instead of rejecting. */
async function lastMarkerText(deps: StatusDeps, target: TargetId, now: Date): Promise<string> {
  try {
    const marker = await deps.readMarker(target, now);
    return marker === null ? 'never' : marker.toISOString();
  } catch (err) {
    return `unknown (${errorMessage(err)})`;
  }
}

/** `path` is a normalised posix-relative path within the repo; `undefined` means the repo
 * root, printed as `(repository root)`. */
function gitPathText(path: string | undefined): string {
  return path ?? '(repository root)';
}

export async function runStatus(deps: StatusDeps): Promise<number> {
  let settings: SyncSettings | null;
  try {
    settings = await deps.loadSettings();
  } catch (err) {
    deps.print(`Status failed: ${errorMessage(err)}`);
    return 1;
  }

  if (settings === null) {
    deps.print('Analytics sync is not installed.');
    deps.print(`  ${new SyncTargetMissingError().message}`);
    return 0;
  }

  const enabled = await deps.query();
  const now = deps.now();
  const log = await deps.readLog();

  deps.print(`Analytics sync: ${enabled}`);
  if (enabled === 'disabled') {
    deps.print('  The OS job is missing or disabled outside the CLI. Run install again:');
    deps.print('  codemie analytics sync install --webhook <url> | --git-repo <url>');
  }
  deps.print(`  Run time:              ${settings.at} local`);
  deps.print(`  Lookback window:       ${lookbackText(settings)}`);
  deps.print(`  Include external:      ${settings.includeExternal}`);

  if (settings.webhookUrl !== undefined) {
    const lastRun = log === null ? null : parseLastRun(log, 'webhook');
    const lastSend = await lastMarkerText(deps, 'webhook', now);
    deps.print(`  Webhook:               ${webhookHost(settings.webhookUrl)}`);
    deps.print(`  Last run:              ${lastRunText(lastRun)}`);
    deps.print(`  Last successful send:  ${lastSend}`);
  }

  if (settings.git !== undefined) {
    const lastFailure = log === null ? null : parseLastFailure(log, 'git');
    const lastPush = await lastMarkerText(deps, 'git', now);
    deps.print(`  Repository:            ${redactSecrets(settings.git.repoUrl)}`);
    deps.print(`  Branch:                ${settings.git.branch ?? 'default'}`);
    deps.print(`  Path:                  ${gitPathText(settings.git.path)}`);
    deps.print(`  Last successful push:  ${lastPush}`);
    deps.print(`  Last failure:          ${lastRunText(lastFailure)}`);
  }

  return 0;
}

async function readSyncLog(): Promise<string | null> {
  try {
    return await readFile(getCodemiePath('logs', 'analytics-sync.log'), 'utf-8');
  } catch {
    // Missing or unreadable log -> "never"; status is best-effort and never fails over it.
    return null;
  }
}

/** Real dependencies for `runStatus`: the real settings store, scheduler query, run log read
 * and marker read, and `console.log`. */
export function createRealStatusDeps(): StatusDeps {
  const scheduler = createScheduler(createRealSchedulerDeps());

  return {
    loadSettings: () => loadSyncSettings(),
    query: () => scheduler.query(),
    readLog: readSyncLog,
    readMarker: (target: TargetId, now: Date) => readMarker(now, target === 'git' ? gitMarkerPath() : undefined),
    now: () => new Date(),
    print: (line: string): void => {
      console.log(line);
    }
  };
}

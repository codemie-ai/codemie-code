/**
 * Status runner for `codemie analytics sync status`.
 *
 * Reports whether the daily job is installed and actually registered/enabled with the OS
 * scheduler, the current settings (lookback, include-external policy, webhook host only),
 * the outcome of the last run (parsed from the run log) and the time of the last successful
 * send (the marker). Every side effect is injected via {@link StatusDeps} so tests run
 * without touching the real scheduler, filesystem or marker.
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
import { errorMessage } from './redact.js';
import { createRealSchedulerDeps, createScheduler } from './scheduler/index.js';
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
  readMarker(now: Date): Promise<Date | null>;
  now(): Date;
  print(line: string): void;
}

/** One parsed outcome line from the run log. */
export interface LastRun {
  at: string;
  outcome: string;
}

// Matches a run-log line's `<ISO> <outcome> ...` prefix (see `run-sync.ts#formatLogLine`):
// `ok sent <name> <bytes>` | `skip <reason>` | `fail <category> <detail>`. Lines that don't
// start this way (legacy collector lines, stack traces) are ignored.
const LAST_RUN_LINE = /^(\S+) ((?:ok sent|skip|fail \w+).*)$/;

/**
 * Find the last line in `log` matching the run-log format, scanning top to bottom so the
 * latest run wins. Returns `null` when no line matches.
 */
export function parseLastRun(log: string): LastRun | null {
  let last: LastRun | null = null;

  for (const rawLine of log.split('\n')) {
    const line = rawLine.trim();
    const match = LAST_RUN_LINE.exec(line);
    if (match) {
      last = { at: match[1], outcome: match[2].trim() };
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

/** The "Last successful send" value: the marker time, `never`, or — when the marker cannot be
 * read (EACCES, EISDIR) — `unknown (<redacted reason>)`, so status reports instead of rejecting. */
async function lastSendText(deps: StatusDeps, now: Date): Promise<string> {
  try {
    const marker = await deps.readMarker(now);
    return marker === null ? 'never' : marker.toISOString();
  } catch (err) {
    return `unknown (${errorMessage(err)})`;
  }
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
  const [log, lastSend] = await Promise.all([deps.readLog(), lastSendText(deps, now)]);
  const lastRun = log === null ? null : parseLastRun(log);

  deps.print(`Analytics sync: ${enabled}`);
  if (enabled === 'disabled') {
    deps.print('  The OS job is missing or disabled outside the CLI. Run install again:');
    deps.print('  codemie analytics sync install --webhook <url>');
  }
  deps.print(`  Run time:              ${settings.at} local`);
  deps.print(`  Lookback window:       ${lookbackText(settings)}`);
  deps.print(`  Include external:      ${settings.includeExternal}`);
  deps.print(`  Webhook:               ${webhookHost(settings.webhookUrl)}`);
  deps.print(`  Last run:              ${lastRunText(lastRun)}`);
  deps.print(`  Last successful send:  ${lastSend}`);

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
    readMarker: (now: Date) => readMarker(now),
    now: () => new Date(),
    print: (line: string): void => {
      console.log(line);
    }
  };
}

/**
 * Sync runner for `codemie analytics sync run` — single-webhook, unattended.
 *
 * Ties together settings, identity, the daily window, the in-process report builder and
 * webhook delivery into one run. Every side effect (clock, settings, identity, marker, fs,
 * delivery, output) is injected via {@link SyncDeps} so tests run without network or real
 * files.
 *
 * `runSync` never throws and never calls `process.exit`. Every outcome — success, a skipped
 * empty window, or any failure — prints and appends exactly one line via {@link formatLogLine}:
 *   `<ISO> ok sent <name> <bytes>`
 *   `<ISO> skip <reason>`
 *   `<ISO> fail <setup|export|send> <redacted detail>`
 * and returns 0 for `ok`/`skip`, 1 for `fail`. Category mapping: missing/invalid settings, no
 * resolvable identity, and any other precondition error -> `setup`; a report-build failure or
 * an `ExportTooLargeError` (its message carries the byte count) -> `export`; any other webhook
 * delivery failure -> `send`. The marker only moves (to the run's `now()`) after delivery
 * resolves — never on `skip` or `fail`. A marker write that fails after delivery keeps the
 * `ok sent` outcome (exit 0) with a warning suffix; a run-log append that fails is ignored.
 */
import { appendFile, chmod, mkdir } from 'fs/promises';
import { dirname } from 'path';

import { getCodemiePath } from '@/utils/paths.js';
import { ExportTooLargeError, SyncTargetMissingError } from '@/utils/errors.js';

import { DEFAULT_LOOKBACK_DAYS, loadSyncSettings } from './config-store.js';
import { realIdentityDeps, resolveSyncIdentity } from './identity.js';
import { readMarker, writeMarker } from './marker.js';
import { includeExternalFor } from './policy.js';
import { errorMessage, redactSecrets } from './redact.js';
import { buildSyncReport } from './report-builder.js';
import { sendWebhook } from './targets/webhook-target.js';
import type { SyncReport, SyncSettings } from './types.js';
import { dailyWindow } from './window.js';
import { SessionsSource } from '../sources/sessions-source.js';
import type { AnalyticsSource } from '../sources/types.js';

/** Every side effect `runSync` needs, injected so tests run without network or real files. */
export interface SyncDeps {
  now(): Date;
  loadSettings(): Promise<SyncSettings | null>;
  resolveIdentity(): Promise<string>;
  buildReport: typeof buildSyncReport;
  send(url: string, report: SyncReport): Promise<void>;
  readMarker(now: Date): Promise<Date | null>;
  writeMarker(at: Date): Promise<void>;
  appendLog(line: string): Promise<void>;
  print(line: string): void;
  platform: NodeJS.Platform;
  /** The analytics data source `buildReport` loads sessions from. */
  source: AnalyticsSource;
}

type Outcome = 'ok' | 'skip' | 'fail';

/** Format one log/print line: `<ISO> <outcome> <rest>`, with any webhook signature redacted. */
export function formatLogLine(at: Date, outcome: Outcome, rest: string): string {
  return redactSecrets(`${at.toISOString()} ${outcome} ${rest}`);
}

async function emit(deps: SyncDeps, now: Date, outcome: Outcome, rest: string): Promise<void> {
  const line = formatLogLine(now, outcome, rest);
  deps.print(line);
  // Best-effort: an unwritable log (permissions, full disk) must not turn the run into a
  // rejection — the printed line still carries the outcome and the exit code is unchanged.
  await deps.appendLog(line).catch(() => undefined);
}

/** Move the marker after a delivered report. A failure here does not undo the delivery, so it
 * becomes a warning on the `ok sent` line (the next run re-sends this window) rather than a
 * `fail setup`. Returns that warning suffix, or `''` when the marker was saved. */
async function moveMarker(deps: SyncDeps, now: Date): Promise<string> {
  try {
    await deps.writeMarker(now);
    return '';
  } catch (err) {
    return ` (warning: last-sent marker not saved, the next run re-sends this window: ${errorMessage(err)})`;
  }
}

async function run(deps: SyncDeps, now: Date): Promise<number> {
  const settings = await deps.loadSettings();

  if (settings === null) {
    await emit(deps, now, 'fail', `setup ${errorMessage(new SyncTargetMissingError())}`);
    return 1;
  }

  // Identity, the window and the include-external policy are all preconditions resolved
  // before the report is built; any failure here (including an unexpected throw) is a `setup`
  // failure, caught by `runSync`'s outer handler below.
  const email = await deps.resolveIdentity();
  const lastSent = await deps.readMarker(now);
  const lookbackDays = settings.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const window = dailyWindow(now, lastSent, lookbackDays);
  const includeExternal = includeExternalFor(settings.includeExternal, deps.platform);

  let report: SyncReport | null;
  try {
    report = await deps.buildReport({ source: deps.source, window, email, includeExternal, now });
  } catch (err) {
    await emit(deps, now, 'fail', `export ${errorMessage(err)}`);
    return 1;
  }

  if (report === null) {
    await emit(deps, now, 'skip', `no sessions in window ${window.label}`);
    return 0;
  }

  try {
    await deps.send(settings.webhookUrl, report);
  } catch (err) {
    const category = err instanceof ExportTooLargeError ? 'export' : 'send';
    await emit(deps, now, 'fail', `${category} ${errorMessage(err)}`);
    return 1;
  }

  const markerWarning = await moveMarker(deps, now);
  await emit(deps, now, 'ok', `sent ${report.fileName} ${report.bytes.length}${markerWarning}`);
  return 0;
}

export async function runSync(deps: SyncDeps): Promise<number> {
  const now = deps.now();

  try {
    return await run(deps, now);
  } catch (err) {
    await emit(deps, now, 'fail', `setup ${errorMessage(err)}`);
    return 1;
  }
}

const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

/** Append `line` to `~/.codemie/logs/analytics-sync.log` (dir 0700, file 0600). */
async function appendSyncLog(line: string): Promise<void> {
  const logPath = getCodemiePath('logs', 'analytics-sync.log');
  const logDir = dirname(logPath);
  await mkdir(logDir, { recursive: true, mode: LOG_DIR_MODE });
  await chmod(logDir, LOG_DIR_MODE);
  await appendFile(logPath, `${line}\n`, { mode: LOG_FILE_MODE });
  await chmod(logPath, LOG_FILE_MODE);
}

/** Real dependencies for `runSync`: real clock, settings, identity, marker, fs and network. */
export function realSyncDeps(): SyncDeps {
  return {
    now: () => new Date(),
    loadSettings: () => loadSyncSettings(),
    resolveIdentity: () => resolveSyncIdentity(realIdentityDeps),
    buildReport: buildSyncReport,
    send: (url: string, report: SyncReport) => sendWebhook(url, report),
    readMarker: (now: Date) => readMarker(now),
    writeMarker: (at: Date) => writeMarker(at),
    appendLog: appendSyncLog,
    print: (line: string): void => {
      console.log(line);
    },
    platform: process.platform,
    source: new SessionsSource(),
  };
}

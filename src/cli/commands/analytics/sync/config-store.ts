/**
 * Settings store for `codemie analytics sync`.
 *
 * Reads and writes `SyncSettings` at `getSyncSettingsPath()` — the collector-compatible
 * `~/.codemie/analytics-sync.json`. The webhook URL is a secret-bearing value, so the file
 * is always written mode `0o600` and re-chmod'd after every write. `install` always
 * overwrites the file wholesale (even a pre-existing collector settings file with a
 * different shape), so there is no merge-with-existing-file path here.
 */

import { chmod, mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { getCodemiePath } from '@/utils/paths.js';
import { SyncConfigError } from '@/utils/errors.js';

import { redactSecrets } from './redact.js';
import type { IncludeExternalPolicy, InstallOptions, SyncSettings } from './types.js';

export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_AT = '03:00';
const DEFAULT_INCLUDE_EXTERNAL: IncludeExternalPolicy = 'windows';

const SETTINGS_FILE_MODE = 0o600;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 30;

const INCLUDE_EXTERNAL_VALUES: readonly IncludeExternalPolicy[] = ['windows', 'always', 'never'];
const INTEGER_PATTERN = /^\d+$/;
const AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Absolute path to the sync settings file. */
export function getSyncSettingsPath(): string {
  return getCodemiePath('analytics-sync.json');
}

function validateWebhookUrl(webhook: string | undefined): string {
  if (webhook === undefined || webhook.trim() === '') {
    throw new SyncConfigError('--webhook is required: pass the https:// URL the daily report is delivered to.');
  }

  let parsed: URL;
  try {
    parsed = new URL(webhook);
  } catch {
    throw new SyncConfigError(`Invalid --webhook URL: ${redactSecrets(webhook)}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new SyncConfigError(`--webhook must use https: ${redactSecrets(webhook)}`);
  }

  return webhook;
}

function validateAt(at: string | undefined): string {
  if (at === undefined) {
    return DEFAULT_AT;
  }

  if (!AT_PATTERN.test(at)) {
    throw new SyncConfigError(`Invalid --at "${at}". Expected 24-hour HH:MM, e.g. "03:00".`);
  }

  return at;
}

function validateIncludeExternal(includeExternal: string | undefined): IncludeExternalPolicy {
  if (includeExternal === undefined) {
    return DEFAULT_INCLUDE_EXTERNAL;
  }

  if (!INCLUDE_EXTERNAL_VALUES.includes(includeExternal as IncludeExternalPolicy)) {
    throw new SyncConfigError(
      `Invalid --include-external "${includeExternal}". Expected one of: ${INCLUDE_EXTERNAL_VALUES.join(', ')}.`
    );
  }

  return includeExternal as IncludeExternalPolicy;
}

function validateLookbackDays(lookbackDays: string | undefined): number | undefined {
  if (lookbackDays === undefined) {
    return undefined;
  }

  if (!INTEGER_PATTERN.test(lookbackDays)) {
    throw new SyncConfigError(`Invalid --lookback-days "${lookbackDays}". Expected an integer 1-30.`);
  }

  const parsed = Number(lookbackDays);
  if (parsed < MIN_LOOKBACK_DAYS || parsed > MAX_LOOKBACK_DAYS) {
    throw new SyncConfigError(`--lookback-days "${lookbackDays}" is out of range. Expected 1-30.`);
  }

  return parsed;
}

/**
 * Validate raw `install` CLI flags into a `SyncSettings`. Performs no I/O. Throws
 * `SyncConfigError` naming the offending flag on the first invalid value.
 *
 * `lookbackDays` is included on the result only when `--lookback-days` was given, so the
 * default ({@link DEFAULT_LOOKBACK_DAYS}) is applied at read time rather than persisted —
 * a later default change then applies to settings written without the flag.
 */
export function validateInstallOptions(options: InstallOptions): SyncSettings {
  const webhookUrl = validateWebhookUrl(options.webhook);
  const at = validateAt(options.at);
  const includeExternal = validateIncludeExternal(options.includeExternal);
  const lookbackDays = validateLookbackDays(options.lookbackDays);

  return {
    webhookUrl,
    includeExternal,
    at,
    ...(lookbackDays !== undefined && { lookbackDays })
  };
}

/**
 * Load sync settings from `path` (defaults to `getSyncSettingsPath()`).
 *
 * A missing file returns `null`. Malformed JSON, JSON that is not an object, or JSON
 * missing a usable `webhookUrl` throws `SyncConfigError`. Never reads any `ANALYTICS_*`
 * environment variable.
 */
export async function loadSyncSettings(path: string = getSyncSettingsPath()): Promise<SyncSettings | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new SyncConfigError(
      `Failed to read sync settings at ${path}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncConfigError(`Sync settings at ${path} is not valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyncConfigError(`Sync settings at ${path} must be a JSON object.`);
  }

  const stored = parsed as Partial<SyncSettings>;
  if (typeof stored.webhookUrl !== 'string' || stored.webhookUrl.trim() === '') {
    throw new SyncConfigError(`Sync settings at ${path} is missing a webhookUrl.`);
  }

  const settings: SyncSettings = {
    webhookUrl: stored.webhookUrl,
    includeExternal: stored.includeExternal ?? DEFAULT_INCLUDE_EXTERNAL,
    at: stored.at ?? DEFAULT_AT
  };

  if (typeof stored.lookbackDays === 'number') {
    settings.lookbackDays = stored.lookbackDays;
  }

  return settings;
}

/**
 * Write `settings` to `path` (defaults to `getSyncSettingsPath()`), mode `0o600`.
 *
 * Always a whole-file overwrite: a pre-existing file at `path` — including one written by
 * the standalone collector, with a different shape — is replaced entirely.
 */
export async function writeSyncSettings(settings: SyncSettings, path: string = getSyncSettingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2), { mode: SETTINGS_FILE_MODE });
  await chmod(path, SETTINGS_FILE_MODE);
}

/**
 * Delete the sync settings file at `path` (defaults to `getSyncSettingsPath()`).
 *
 * Returns `false` when the file does not exist (nothing to remove), `true` once the file
 * is deleted.
 */
export async function deleteSyncSettings(path: string = getSyncSettingsPath()): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

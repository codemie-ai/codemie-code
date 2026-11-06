/**
 * Settings store for `codemie analytics sync`.
 *
 * Reads and writes `SyncSettings` at `getSyncSettingsPath()` — the collector-compatible
 * `~/.codemie/analytics-sync.json`. The webhook URL is a secret-bearing value, so the file
 * is always written mode `0o600` and re-chmod'd after every write. `install` always
 * overwrites the file wholesale (even a pre-existing collector settings file with a
 * different shape), so there is no merge-with-existing-file path here.
 */

import { readFile, unlink } from 'fs/promises';
import { posix as posixPath } from 'path';

import { getCodemiePath } from '@/utils/paths.js';
import { SyncConfigError } from '@/utils/errors.js';

import { writePrivateJson } from './private-file.js';
import { decodeWebhook } from './webhook-encoding.js';
import { redactSecrets } from './redact.js';
import type { GitSettings, IncludeExternalPolicy, InstallOptions, SyncSettings } from './types.js';

export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_AT = '03:00';
/** `never`: CodeMie-owned sessions only, on every platform. Windows used to default to
 * including external sessions because ownership detection missed CodeMie's own sessions
 * there; today those come from CodeMie's session records, so including external sessions
 * only adds non-CodeMie ones (and double-counts a session whose transcript path differs in
 * case from the recorded one). */
const DEFAULT_INCLUDE_EXTERNAL: IncludeExternalPolicy = 'never';

const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 30;

const INCLUDE_EXTERNAL_VALUES: readonly IncludeExternalPolicy[] = ['windows', 'always', 'never'];
const INTEGER_PATTERN = /^\d+$/;
const AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const SYNC_FORMAT = 'json' as const;

/** Absolute path to the sync settings file. */
export function getSyncSettingsPath(): string {
  return getCodemiePath('analytics-sync.json');
}

/** `undefined`/blank -> no webhook target given (not an error by itself — at least one of
 * webhook/git is required overall, checked by the caller). Otherwise validates the URL is
 * `https:`. */
export function validateWebhookUrl(webhook: string | undefined): string | undefined {
  if (webhook === undefined || webhook.trim() === '') {
    return undefined;
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

/** Whether `rawUrl` embeds credentials in its userinfo. On an `http(s)://` URL any userinfo
 * counts — `https://<token>@host/r` is the common personal-access-token form. On an
 * `ssh://` or scp-style URL (`git@host:org/r.git`, which has no `://`) a bare username is
 * the normal ssh login and is allowed; only `user:pass@` is flagged. */
function hasEmbeddedCredentials(rawUrl: string): boolean {
  const match = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?([^@/]+)@/.exec(rawUrl);
  if (match === null) {
    return false;
  }

  const scheme = match[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    return true;
  }

  return match[2].includes(':');
}

/** `undefined`/blank -> no git repo URL given. Otherwise rejects a value git would parse as
 * an option, and embedded credentials. The rejection never echoes the value, so a
 * password or token in it never reaches the terminal or a log. */
function validateGitRepoUrl(gitRepo: string | undefined): string | undefined {
  if (gitRepo === undefined || gitRepo.trim() === '') {
    return undefined;
  }

  if (gitRepo.startsWith('-')) {
    throw new SyncConfigError('--git-repo must be a repository URL, not a value starting with "-".');
  }

  if (hasEmbeddedCredentials(gitRepo)) {
    throw new SyncConfigError(
      '--git-repo must not embed credentials: use an SSH key or a git credential helper instead.'
    );
  }

  return gitRepo;
}

// Characters git forbids in a ref name (`git check-ref-format`), plus whitespace/control.
// eslint-disable-next-line no-control-regex
const INVALID_BRANCH_CHARS = /[\x00-\x20\x7f~^:?*[\\]/;

/** Whether `branch` is a ref name git accepts for `--branch` — a subset of
 * `git check-ref-format --branch` rules that also rules out option injection. */
function isValidBranchName(branch: string): boolean {
  return !(
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch === '@' ||
    INVALID_BRANCH_CHARS.test(branch) ||
    branch.split('/').some((segment) => segment.startsWith('.'))
  );
}

/** `undefined`/blank -> remote default branch. Otherwise trims and requires a valid,
 * non-empty branch name. */
function validateGitBranch(gitBranch: string | undefined): string | undefined {
  if (gitBranch === undefined) {
    return undefined;
  }

  const trimmed = gitBranch.trim();
  if (trimmed === '') {
    throw new SyncConfigError('--git-branch must not be empty.');
  }

  if (!isValidBranchName(trimmed)) {
    throw new SyncConfigError(`--git-branch is not a valid branch name: ${trimmed}`);
  }

  return trimmed;
}

/** `undefined`/blank -> repo root. Rejects an absolute posix path, a Windows drive/UNC
 * path, anything that escapes the repo once normalised, and any `.git` segment (the
 * repository's own metadata). Returns a normalised
 * posix-relative path, or `undefined` when it normalises to the repo root. */
function validateGitPath(gitPath: string | undefined): string | undefined {
  if (gitPath === undefined) {
    return undefined;
  }

  const trimmed = gitPath.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.includes('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new SyncConfigError(`--git-path must be a posix-relative path, not a Windows path: ${trimmed}`);
  }

  if (posixPath.isAbsolute(trimmed)) {
    throw new SyncConfigError(`--git-path must be relative, not absolute: ${trimmed}`);
  }

  // `normalize` keeps a trailing slash (e.g. "a/" -> "a/", "./" -> "./"); strip it so the
  // stored path is a plain relative segment.
  const normalized = posixPath.normalize(trimmed).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') {
    return undefined;
  }

  if (normalized === '..' || normalized.startsWith('../') || posixPath.isAbsolute(normalized)) {
    throw new SyncConfigError(`--git-path escapes the repository: ${trimmed}`);
  }

  if (normalized.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    throw new SyncConfigError(`--git-path must not point inside .git: ${trimmed}`);
  }

  return normalized;
}

/** `undefined` -> no git target given. Otherwise the fully-validated `GitSettings`. */
function validateGitSettings(options: InstallOptions): GitSettings | undefined {
  const repoUrl = validateGitRepoUrl(options.gitRepo);
  const branch = validateGitBranch(options.gitBranch);
  const path = validateGitPath(options.gitPath);

  if (repoUrl === undefined) {
    return undefined;
  }

  return {
    repoUrl,
    ...(branch !== undefined && { branch }),
    ...(path !== undefined && { path })
  };
}

/** Defaults to `'json'`; any other value throws, naming `--format`. */
function validateFormat(format: string | undefined): 'json' {
  if (format === undefined) {
    return SYNC_FORMAT;
  }

  if (format !== SYNC_FORMAT) {
    throw new SyncConfigError(`Invalid --format "${format}". Expected: ${SYNC_FORMAT}.`);
  }

  return SYNC_FORMAT;
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

export function validateIncludeExternal(includeExternal: string | undefined): IncludeExternalPolicy {
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

export function validateLookbackDays(lookbackDays: string | undefined): number | undefined {
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

/** The raw webhook from `--webhook` or the decoded `--webhook-b64`; giving both throws. */
function resolveWebhookOption(options: InstallOptions): string | undefined {
  if (options.webhookB64 === undefined) {
    return options.webhook;
  }
  if (options.webhook !== undefined) {
    throw new SyncConfigError('Pass either --webhook or --webhook-b64, not both.');
  }
  return decodeWebhook(options.webhookB64);
}

/**
 * Validate raw `install` CLI flags into a `SyncSettings`. Performs no I/O. Throws
 * `SyncConfigError` naming the offending flag on the first invalid value. At least one of
 * `--webhook`/`--git-repo` is required; neither given throws naming both flags.
 *
 * `lookbackDays` is included on the result only when `--lookback-days` was given, so the
 * default ({@link DEFAULT_LOOKBACK_DAYS}) is applied at read time rather than persisted —
 * a later default change then applies to settings written without the flag.
 */
export function validateInstallOptions(options: InstallOptions): SyncSettings {
  const webhookUrl = validateWebhookUrl(resolveWebhookOption(options));
  const git = validateGitSettings(options);

  if (webhookUrl === undefined && git === undefined) {
    throw new SyncConfigError(
      'At least one sync target is required: pass --webhook <url> or --git-repo <url>.'
    );
  }

  const format = validateFormat(options.format);
  const at = validateAt(options.at);
  const includeExternal = validateIncludeExternal(options.includeExternal);
  const lookbackDays = validateLookbackDays(options.lookbackDays);

  return {
    ...(webhookUrl !== undefined && { webhookUrl }),
    ...(git !== undefined && { git }),
    format,
    includeExternal,
    at,
    ...(lookbackDays !== undefined && { lookbackDays })
  };
}

/** Reads the stored git target out of an unknown value: `undefined` when there is no
 * usable `git.repoUrl`. The stored `repoUrl`, `branch` and `path` go through the same
 * validation as `install`, so a hand-edited settings file cannot inject a git option or
 * write outside the working copy; an invalid value throws `SyncConfigError`. */
function readStoredGit(storedGit: unknown, path: string): GitSettings | undefined {
  if (typeof storedGit !== 'object' || storedGit === null) {
    return undefined;
  }

  const candidate = storedGit as Partial<GitSettings>;
  if (typeof candidate.repoUrl !== 'string' || candidate.repoUrl.trim() === '') {
    return undefined;
  }

  try {
    return validateGitSettings({
      gitRepo: candidate.repoUrl,
      gitBranch: typeof candidate.branch === 'string' && candidate.branch.trim() !== '' ? candidate.branch : undefined,
      gitPath: typeof candidate.path === 'string' ? candidate.path : undefined
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SyncConfigError(`Sync settings at ${path} has an invalid git target: ${reason}`);
  }
}

/**
 * Load sync settings from `path` (defaults to `getSyncSettingsPath()`).
 *
 * A missing file returns `null`. Malformed JSON, or JSON that is not an object, throws
 * `SyncConfigError`. JSON with neither a usable `webhookUrl` nor a usable `git.repoUrl`
 * returns `null` (no delivery target configured). A legacy webhook-only file written before
 * `format`/`git` existed loads unchanged, with `format` defaulted to `'json'`. Never reads
 * any `ANALYTICS_*` environment variable.
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
  const webhookUrl =
    typeof stored.webhookUrl === 'string' && stored.webhookUrl.trim() !== '' ? stored.webhookUrl : undefined;
  const git = readStoredGit(stored.git, path);

  if (webhookUrl === undefined && git === undefined) {
    return null;
  }

  const settings: SyncSettings = {
    ...(webhookUrl !== undefined && { webhookUrl }),
    ...(git !== undefined && { git }),
    format: SYNC_FORMAT,
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
  await writePrivateJson(path, settings);
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

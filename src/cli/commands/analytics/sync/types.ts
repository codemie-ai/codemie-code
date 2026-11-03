/**
 * Shared types for `codemie analytics sync`.
 */

export interface SyncReport {
  fileName: string;
  bytes: Buffer;
}

export type IncludeExternalPolicy = 'windows' | 'always' | 'never';

/** A team git repository as a sync delivery target. `branch` unset means the remote's
 * default branch. `path` is a normalised posix-relative path within the repo (unset means
 * the repo root). */
export interface GitSettings {
  repoUrl: string;
  branch?: string;
  path?: string;
}

/**
 * Persisted sync settings, `getSyncSettingsPath()` (collector-compatible
 * `~/.codemie/analytics-sync.json`). At least one of `webhookUrl` / `git` is present.
 * `lookbackDays` is present only when the install command was given `--lookback-days`
 * explicitly, so the default (7) tracks CLI updates instead of being baked into the file.
 */
export interface SyncSettings {
  webhookUrl?: string;
  git?: GitSettings;
  /** Export format for every target. Only `'json'` is accepted for now. */
  format: 'json';
  includeExternal: IncludeExternalPolicy;
  at: string;
  lookbackDays?: number;
}

/** Raw flags accepted by `codemie analytics sync install`. */
export interface InstallOptions {
  webhook?: string;
  gitRepo?: string;
  gitBranch?: string;
  gitPath?: string;
  format?: string;
  at?: string;
  lookbackDays?: string;
  includeExternal?: string;
}

export type SyncStatus = 'ok' | 'skip' | 'fail';

export interface SyncResult {
  status: SyncStatus;
  category: string;
  detail: string;
}

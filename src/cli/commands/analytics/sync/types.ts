/**
 * Shared types for `codemie analytics sync`.
 */

export interface SyncReport {
  fileName: string;
  bytes: Buffer;
}

export type IncludeExternalPolicy = 'windows' | 'always' | 'never';

/**
 * Persisted sync settings, `getSyncSettingsPath()` (collector-compatible
 * `~/.codemie/analytics-sync.json`). `lookbackDays` is present only when the install
 * command was given `--lookback-days` explicitly, so the default (7) tracks CLI updates
 * instead of being baked into the file.
 */
export interface SyncSettings {
  webhookUrl: string;
  includeExternal: IncludeExternalPolicy;
  at: string;
  lookbackDays?: number;
}

/** Raw flags accepted by `codemie analytics sync install`. */
export interface InstallOptions {
  webhook?: string;
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

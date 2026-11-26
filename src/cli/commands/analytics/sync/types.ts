/**
 * Shared types for `codemie analytics sync`.
 */

import type { SyncWindow } from './window.js';

export interface SyncReport {
  fileName: string;
  bytes: Buffer;
  /** Media type of `bytes`, as a target labels the delivered file. */
  contentType: string;
}

/**
 * The files of one run in delivery order. `warning` names a part of the run not built for a reason that may pass — the
 * marker stays; `leftOut` names sessions no run can build — they are named on the run's line and do not hold the marker.
 */
export type SyncFiles = SyncReport[] & { warning?: string; leftOut?: string };

/** What one `sync` run delivers for one window: its files in delivery order, or `null` when there is nothing to send. */
export interface ExportSource {
  build(input: { window: SyncWindow; email: string; includeExternal: boolean; now: Date }): Promise<SyncFiles | null>;
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
  /** Full scheduler task name, stored only when it differs from the platform default. */
  taskName?: string;
  /** The machine collects its analytics locally, with no CodeMie backend. */
  local?: true;
  /** The node binary and CLI entry the local mode's job was installed with. */
  localJob?: { node: string; entry: string };
}

/** Raw flags accepted by `codemie analytics sync install`. */
export interface InstallOptions {
  webhook?: string;
  /** `--webhook-b64`: the webhook URL as base64url, as printed by `bootstrap`. */
  webhookB64?: string;
  gitRepo?: string;
  gitBranch?: string;
  gitPath?: string;
  format?: string;
  at?: string;
  lookbackDays?: string;
  includeExternal?: string;
  /** `--task-name`: full scheduler task name, used as-is on every platform. */
  taskName?: string;
  /** `--force`: overwrite an existing scheduler task that this tool does not own. */
  force?: boolean;
}

export type SyncStatus = 'ok' | 'skip' | 'fail';

export interface SyncResult {
  status: SyncStatus;
  category: string;
  detail: string;
}

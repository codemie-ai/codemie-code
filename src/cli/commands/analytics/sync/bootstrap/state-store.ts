/**
 * The lead's resumable wizard state: `~/.codemie/analytics-sync-bootstrap.json`, mode
 * `0o600`. Saved after every step so an interrupted run resumes with the earlier answers
 * as defaults (spec.md "Start logic"). This is a distinct file from the standalone
 * collector's `analytics-setup.json`, which is never read.
 *
 * `checkReuse` and `toInstallCommandOptions` are the state-to-install-command mapping:
 * together they decide whether a saved run can jump straight to printing the install
 * command (step 8) and, when it can, what flags that command carries.
 */

import { readFile } from 'fs/promises';

import { getCodemiePath } from '@/utils/paths.js';

import { validateIncludeExternal, validateLookbackDays } from '../config-store.js';
import { validateTriggerUrl } from '../trigger-url.js';
import type { InstallCommandOptions } from '../install-command.js';
import type { IncludeExternalPolicy } from '../types.js';
import { webhookHost } from '../format.js';
import { writePrivateJson } from '../private-file.js';

/**
 * The bootstrap wizard's saved answers. Every field but `version` is optional: a fresh
 * state has none of them, and each step sets only the fields it owns. `webhookTest` is set
 * only on a 2xx test-send response or an explicit Skip (AR-1) — never merely because
 * `webhookUrl` is present.
 */
export interface BootstrapState {
  version: 1;
  channelLink?: string;
  teamId?: string;
  channelId?: string;
  channelName?: string;
  siteUrl?: string;
  folderPath?: string;
  timeZone?: string;
  flowImported?: boolean;
  /** Set when the lead answered "already imported the flow?" with yes, so steps 1-4 were
   * never asked. `firstUnansweredStep` then starts its check at step 5. */
  skippedSetup?: boolean;
  webhookUrl?: string;
  webhookTest?: 'passed' | 'skipped';
  includeExternal?: IncludeExternalPolicy;
  lookbackDays?: number | 'default';
}

/** Whether `checkReuse` found the saved state fit to reuse. `ok: true` carries the install
 * options built from it (jump to step 8); `ok: false` carries the step to resume at. */
export type ReuseCheck = { ok: true; options: InstallCommandOptions } | { ok: false; resumeAt: number };

/** Absolute path to the lead's bootstrap state file. */
export function getBootstrapStatePath(): string {
  return getCodemiePath('analytics-sync-bootstrap.json');
}

/** `value` is a `BootstrapState` if it is a non-null, non-array object carrying
 * `version: 1`. No deeper per-field check: downstream functions (`firstUnansweredStep`,
 * `checkReuse`) already treat every field as optional and re-validate the ones that
 * matter, so a field of the wrong type behaves the same as a missing one. */
function isBootstrapStateShape(value: unknown): value is BootstrapState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as { version?: unknown }).version === 1;
}

/**
 * Load the saved bootstrap state from `path` (defaults to {@link getBootstrapStatePath}).
 *
 * A missing file returns `{ state: null }` with no notice — there is nothing to report,
 * this is just a first run. A file that cannot be read, is not JSON, or does not have the
 * `{ version: 1, ... }` shape is treated the same as absent (`{ state: null }`) but carries
 * a `notice` naming `path`, so the wizard can tell the lead their saved answers were
 * discarded instead of silently starting over. This function never throws.
 */
export async function loadBootstrapState(
  path: string = getBootstrapStatePath()
): Promise<{ state: BootstrapState | null; notice?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: null };
    }
    return { state: null, notice: `Could not read saved bootstrap state at ${path}; starting fresh.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: null, notice: `Saved bootstrap state at ${path} is not valid JSON; starting fresh.` };
  }

  if (!isBootstrapStateShape(parsed)) {
    return { state: null, notice: `Saved bootstrap state at ${path} has an unexpected shape; starting fresh.` };
  }

  return { state: parsed };
}

/** Save `state` to `path` (defaults to {@link getBootstrapStatePath}), mode `0o600`. Called
 * after every step so an interrupted run resumes with the earlier answers as defaults. */
export async function saveBootstrapState(state: BootstrapState, path: string = getBootstrapStatePath()): Promise<void> {
  await writePrivateJson(path, state);
}

/**
 * The first (1-based) step whose answer is missing from `state`:
 * 1 needs `teamId` + `channelId`; 2 needs `siteUrl` + `folderPath`; 3 needs `timeZone`;
 * 4 needs `flowImported === true`; 5 needs `webhookUrl` + `webhookTest`; 6 needs
 * `includeExternal`; 7 needs `lookbackDays`. `8` when every earlier step is answered.
 * Steps 1-4 are not checked when `skippedSetup` is set: the lead imported the flow
 * outside this wizard.
 */
export function firstUnansweredStep(state: BootstrapState): number {
  return state.skippedSetup === true ? firstUnansweredLateStep(state) : firstUnansweredSetupStep(state);
}

/** Steps 1-4 of {@link firstUnansweredStep}, falling through to steps 5-8. */
function firstUnansweredSetupStep(state: BootstrapState): number {
  if (state.teamId === undefined || state.channelId === undefined) {
    return 1;
  }
  if (state.siteUrl === undefined || state.folderPath === undefined) {
    return 2;
  }
  if (state.timeZone === undefined) {
    return 3;
  }
  if (state.flowImported !== true) {
    return 4;
  }
  return firstUnansweredLateStep(state);
}

/** Steps 5-8 of {@link firstUnansweredStep}. */
function firstUnansweredLateStep(state: BootstrapState): number {
  if (state.webhookUrl === undefined || state.webhookTest === undefined) {
    return 5;
  }
  if (state.includeExternal === undefined) {
    return 6;
  }
  if (state.lookbackDays === undefined) {
    return 7;
  }
  return 8;
}

/**
 * Whether `state` can be reused to jump straight to step 8 without re-asking anything.
 *
 * `firstUnansweredStep` only checks presence, so a step it considers "answered" can still
 * carry a value that no longer validates (a revoked webhook, a lookback saved outside
 * 1-30, a policy name an older build allowed). This re-validates each of steps 5-7 that
 * `firstUnansweredStep` found present, in step order, and returns the earliest one that
 * fails — so a state with several bad fields resumes at the earliest bad step. When
 * nothing is present-but-invalid, the result is whatever `firstUnansweredStep` already
 * found missing. `ok: true` only when `webhookUrl`, `webhookTest`, `includeExternal` and
 * `lookbackDays` are all present and every one of them still validates.
 */
export function checkReuse(state: BootstrapState): ReuseCheck {
  const base = firstUnansweredStep(state);

  if (base > 5 && state.webhookUrl !== undefined) {
    try {
      validateTriggerUrl(state.webhookUrl, 'guided');
    } catch {
      return { ok: false, resumeAt: 5 };
    }
  }

  if (base > 6 && state.includeExternal !== undefined) {
    try {
      validateIncludeExternal(state.includeExternal);
    } catch {
      return { ok: false, resumeAt: 6 };
    }
  }

  if (base > 7 && state.lookbackDays !== undefined && state.lookbackDays !== 'default') {
    try {
      validateLookbackDays(String(state.lookbackDays));
    } catch {
      return { ok: false, resumeAt: 7 };
    }
  }

  if (base < 8) {
    return { ok: false, resumeAt: base };
  }

  return { ok: true, options: toInstallCommandOptions(state) };
}

/**
 * Maps a saved `state` onto the flags `buildInstallCommand` needs. Always sets
 * `includeExternal` (defaulted the same way `validateIncludeExternal` defaults a missing
 * `--include-external`), sets `lookbackDays` only when it is a fixed number (a saved
 * `'default'`, like an absent value, means "let the installed default track CLI
 * updates"), and never sets `at` — bootstrap never schedules on the lead's machine.
 */
export function toInstallCommandOptions(state: BootstrapState): InstallCommandOptions {
  return {
    ...(state.webhookUrl !== undefined && { webhook: state.webhookUrl }),
    includeExternal: validateIncludeExternal(state.includeExternal),
    ...(typeof state.lookbackDays === 'number' && { lookbackDays: state.lookbackDays })
  };
}

/** Human-readable lines summarizing `state` for the "already have saved answers" prompt.
 * The webhook is masked to its host (never its `sig` query value); the last test result,
 * when known, is shown as-is. */
export function summarizeState(state: BootstrapState): string[] {
  const lines: string[] = [];

  if (state.channelName !== undefined) {
    lines.push(`Teams channel: ${state.channelName}`);
  }
  if (state.siteUrl !== undefined && state.folderPath !== undefined) {
    lines.push(`SharePoint folder: ${state.siteUrl} / ${state.folderPath}`);
  }
  if (state.timeZone !== undefined) {
    lines.push(`Time zone: ${state.timeZone}`);
  }
  if (state.flowImported === true || state.skippedSetup === true) {
    lines.push('Flow: imported');
  }
  if (state.webhookUrl !== undefined) {
    lines.push(`Trigger URL: https://${webhookHost(state.webhookUrl)}/… (signature hidden)`);
  }
  if (state.webhookTest !== undefined) {
    lines.push(`Webhook test: ${state.webhookTest}`);
  }
  if (state.includeExternal !== undefined) {
    lines.push(`External sessions: ${state.includeExternal}`);
  }
  if (state.lookbackDays !== undefined) {
    lines.push(`Lookback: ${state.lookbackDays === 'default' ? 'default' : `${state.lookbackDays} days`}`);
  }

  return lines;
}

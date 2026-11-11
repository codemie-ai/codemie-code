/**
 * The lead's resumable wizard state: `~/.codemie/analytics-sync-bootstrap.json`, mode
 * `0o600`. Saved after every step so an interrupted run resumes with the earlier answers
 * as defaults (spec.md "Start logic"). This is a distinct file from the standalone
 * collector's `analytics-setup.json`, which is never read.
 *
 * `checkReuse` and `toInstallCommandOptions` are the state-to-install-command mapping:
 * together they decide whether a saved run can jump straight to printing the install
 * command (the last step, `'developers'`) and, when it can, what flags that command
 * carries.
 *
 * Step logic is id-based and descriptor-driven (`stepsFor`/`StepDescriptor` from
 * `./step-model.js`), not the fixed 1-8 numbering of the webhook-only v1 wizard: which
 * steps exist, and in what order, now depends on `state.targets` (webhook, git, or both).
 */

import { readFile } from 'fs/promises';

import { getCodemiePath } from '@/utils/paths.js';
import { validateGitRepoUrl, validateIncludeExternal, validateLookbackDays } from '../config-store.js';
import { validateTriggerUrl } from '../trigger-url.js';
import type { InstallCommandOptions } from '../install-command.js';
import type { IncludeExternalPolicy } from '../types.js';
import { webhookHost } from '../format.js';
import { redactSecrets } from '../redact.js';
import { writePrivateJson } from '../private-file.js';

import { stepsFor, type TargetSelection } from './step-model.js';

/**
 * The bootstrap wizard's saved answers (v2). Every field but `version` and `targets` is
 * optional: a fresh state has none of them, and each step sets only the fields it owns.
 * `webhookTest`/`gitTest` are set only on a successful test (a 2xx webhook test-send, or a
 * git-repo reachability check) or an explicit Skip (AR-1) — never merely because
 * `webhookUrl`/`gitRepoUrl` is present.
 */
export interface BootstrapState {
  version: 2;
  /** Which delivery targets the lead chose (step `'target'`). Drives `stepsFor` — which of
   * the fields below are ever asked for, and in what order. */
  targets: TargetSelection;
  channelLink?: string;
  teamId?: string;
  channelId?: string;
  channelName?: string;
  siteUrl?: string;
  folderPath?: string;
  timeZone?: string;
  flowImported?: boolean;
  /** Set when the lead answered "already imported the flow?" with yes, so the webhook
   * setup steps (`'channel'`, `'folder'`, `'timezone'`, `'flow'`) were never asked. */
  skippedSetup?: boolean;
  webhookUrl?: string;
  webhookTest?: 'passed' | 'skipped';
  gitRepoUrl?: string;
  gitBranch?: string;
  gitPath?: string;
  gitTest?: 'passed' | 'skipped';
  includeExternal?: IncludeExternalPolicy;
  lookbackDays?: number | 'default';
}

/** The pre-Task-2 saved-state shape: no `targets` field at all. Read-compat only —
 * `loadBootstrapState` upgrades this to v2 in memory, defaulting `targets` to
 * `{ webhook: true, git: false }` (the only target v1 ever supported); it is never written
 * back in this v1 shape, only as whichever `BootstrapState` the caller next saves. */
interface BootstrapStateV1 {
  version: 1;
  channelLink?: string;
  teamId?: string;
  channelId?: string;
  channelName?: string;
  siteUrl?: string;
  folderPath?: string;
  timeZone?: string;
  flowImported?: boolean;
  skippedSetup?: boolean;
  webhookUrl?: string;
  webhookTest?: 'passed' | 'skipped';
  includeExternal?: IncludeExternalPolicy;
  lookbackDays?: number | 'default';
}

/** The target `targets` defaults to when an old v1 file (no `targets` field) is loaded —
 * v1 only ever supported the webhook flow. */
const V1_DEFAULT_TARGETS: TargetSelection = { webhook: true, git: false };

/** Whether `checkReuse` found the saved state fit to reuse. `ok: true` carries the install
 * options built from it (jump straight to printing the install command); `ok: false`
 * carries the step id to resume at. */
export type ReuseCheck = { ok: true; options: InstallCommandOptions } | { ok: false; resumeAt: string };

/** Absolute path to the lead's bootstrap state file. */
export function getBootstrapStatePath(): string {
  return getCodemiePath('analytics-sync-bootstrap.json');
}

/** `value` is a `BootstrapStateV1` or `BootstrapState` if it is a non-null, non-array object
 * carrying `version: 1` (no further check — v1 never had a `targets` field) or `version: 2`
 * with a `targets` object. No deeper per-field check: downstream functions
 * (`firstUnansweredStep`, `checkReuse`) already treat every other field as optional and
 * re-validate the ones that matter, so a field of the wrong type behaves the same as a
 * missing one. */
function isBootstrapStateShape(value: unknown): value is BootstrapStateV1 | BootstrapState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const version = (value as { version?: unknown }).version;
  if (version === 1) {
    return true;
  }

  if (version === 2) {
    const targets = (value as { targets?: unknown }).targets;
    return typeof targets === 'object' && targets !== null && !Array.isArray(targets);
  }

  return false;
}

/**
 * Load the saved bootstrap state from `path` (defaults to {@link getBootstrapStatePath}).
 *
 * A missing file returns `{ state: null }` with no notice — there is nothing to report,
 * this is just a first run. A file that cannot be read, is not JSON, or does not have the
 * `{ version: 1, ... }` / `{ version: 2, targets: {...}, ... }` shape is treated the same as
 * absent (`{ state: null }`) but carries a `notice` naming `path`, so the wizard can tell the
 * lead their saved answers were discarded instead of silently starting over. A `version: 1`
 * file loads as v2 with `targets` defaulted to `{ webhook: true, git: false }` — that default
 * is never written back to `path` by this function, only by whatever the caller next saves.
 * This function never throws.
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

  if (parsed.version === 1) {
    return { state: { ...parsed, version: 2, targets: V1_DEFAULT_TARGETS } };
  }

  return { state: parsed };
}

/** Save `state` to `path` (defaults to {@link getBootstrapStatePath}), mode `0o600`. Called
 * after every step so an interrupted run resumes with the earlier answers as defaults. */
export async function saveBootstrapState(state: BootstrapState, path: string = getBootstrapStatePath()): Promise<void> {
  await writePrivateJson(path, state);
}

/** Whether `state` has an answer for the step `id`, per `stepsFor(state.targets)`'s
 * filtered list. `'target'` is always answered — by the time a `BootstrapState` exists its
 * `targets` selection has already been made. `'developers'` has no field of its own yet (a
 * later task adds one), so it is always considered answered too; once every other step is
 * answered, reaching the end of the filtered list without finding anything unanswered makes
 * `firstUnansweredStep` land on `'developers'` — the same role the v1 numeric model gave
 * step 8 once everything else was answered. `'channel'` through `'flow'` are always
 * answered when `skippedSetup` is set: the lead said the flow was already imported outside
 * this wizard, so those steps were never asked. */
function isStepAnswered(state: BootstrapState, id: string): boolean {
  if (state.skippedSetup === true && (id === 'channel' || id === 'folder' || id === 'timezone' || id === 'flow')) {
    return true;
  }

  switch (id) {
    case 'target':
    case 'developers':
      return true;
    case 'channel':
      return state.teamId !== undefined && state.channelId !== undefined;
    case 'folder':
      return state.siteUrl !== undefined && state.folderPath !== undefined;
    case 'timezone':
      return state.timeZone !== undefined;
    case 'flow':
      return state.flowImported === true;
    case 'trigger-url':
      return state.webhookUrl !== undefined && state.webhookTest !== undefined;
    case 'git-repo':
      return state.gitRepoUrl !== undefined && state.gitTest !== undefined;
    case 'external':
      return state.includeExternal !== undefined;
    case 'lookback':
      return state.lookbackDays !== undefined;
    default:
      return false;
  }
}

/**
 * The id of the first step (per `stepsFor(state.targets)`, in order) whose answer is
 * missing from `state`. Returns the filtered list's last step id (`'developers'`, unless
 * the lead chose neither target) once every earlier step is answered — the signal that the
 * wizard is done and ready to print the install command.
 */
export function firstUnansweredStep(state: BootstrapState): string {
  const steps = stepsFor(state.targets);

  for (const step of steps) {
    if (!isStepAnswered(state, step.id)) {
      return step.id;
    }
  }

  return steps[steps.length - 1].id;
}

/** Re-validators for the steps whose "present" field can still turn out invalid once
 * resumed into — a step with no entry here is only checked for presence, by
 * `firstUnansweredStep`. `'git-repo'` re-runs `install`'s own `validateGitRepoUrl`, so a
 * saved repository URL embedding credentials (or starting with `-`) is never reused. */
const REVALIDATORS: Partial<Record<string, (state: BootstrapState) => void>> = {
  'trigger-url': (state) => {
    if (state.webhookUrl !== undefined) {
      validateTriggerUrl(state.webhookUrl, 'guided');
    }
  },
  'git-repo': (state) => {
    validateGitRepoUrl(state.gitRepoUrl);
  },
  external: (state) => {
    if (state.includeExternal !== undefined) {
      validateIncludeExternal(state.includeExternal);
    }
  },
  lookback: (state) => {
    if (state.lookbackDays !== undefined && state.lookbackDays !== 'default') {
      validateLookbackDays(String(state.lookbackDays));
    }
  }
};

/**
 * Whether `state` can be reused to jump straight to the install command without re-asking
 * anything.
 *
 * `firstUnansweredStep` only checks presence, so a step it considers "answered" can still
 * carry a value that no longer validates (a revoked webhook, a git URL with embedded
 * credentials, a lookback saved outside 1-30, a policy name an older build allowed). This
 * re-validates every already-answered step that has a re-validator ({@link REVALIDATORS}),
 * in step order, and returns the earliest one that fails — so a state with several bad
 * fields resumes at the earliest bad step. When nothing already-answered is invalid, the
 * result is whatever `firstUnansweredStep` already found missing. `ok: true` only when
 * `firstUnansweredStep` lands on the filtered list's last step (everything earlier answered)
 * and every re-validated field still validates.
 */
export function checkReuse(state: BootstrapState): ReuseCheck {
  const steps = stepsFor(state.targets);
  const base = firstUnansweredStep(state);
  const baseIndex = steps.findIndex((step) => step.id === base);

  for (const [index, step] of steps.entries()) {
    if (index >= baseIndex) {
      break;
    }

    const reValidate = REVALIDATORS[step.id];
    if (reValidate === undefined) {
      continue;
    }

    try {
      reValidate(state);
    } catch {
      return { ok: false, resumeAt: step.id };
    }
  }

  if (baseIndex < steps.length - 1) {
    return { ok: false, resumeAt: base };
  }

  return { ok: true, options: toInstallCommandOptions(state) };
}

/**
 * Maps a saved `state` onto the flags `buildInstallCommand` needs. Always sets
 * `includeExternal` (defaulted the same way `validateIncludeExternal` defaults a missing
 * `--include-external`), sets `lookbackDays` only when it is a fixed number (a saved
 * `'default'`, like an absent value, means "let the installed default track CLI
 * updates"), emits `webhook` only when `targets.webhook` is true and
 * `gitRepo`/`gitBranch`/`gitPath` only when `targets.git` is true — an off target's fields
 * stay saved for a later re-enable but are never printed — and
 * never sets `at` — bootstrap never schedules on the lead's machine.
 */
export function toInstallCommandOptions(state: BootstrapState): InstallCommandOptions {
  return {
    ...(state.targets.webhook && state.webhookUrl !== undefined && { webhook: state.webhookUrl }),
    ...(state.targets.git && state.gitRepoUrl !== undefined && { gitRepo: state.gitRepoUrl }),
    ...(state.targets.git && state.gitBranch !== undefined && { gitBranch: state.gitBranch }),
    ...(state.targets.git && state.gitPath !== undefined && { gitPath: state.gitPath }),
    includeExternal: validateIncludeExternal(state.includeExternal),
    ...(typeof state.lookbackDays === 'number' && { lookbackDays: state.lookbackDays })
  };
}

/** The host of a git repository URL — `https://`/`ssh://` via `URL` (userinfo dropped), or
 * the host of an scp-style `[user[:pass]@]host:path` (anything without `://`, which `URL`
 * would misread as a `user:` scheme) — the same host-only masking {@link
 * webhookHost} applies to the webhook, falling back to the redacted value when neither
 * form parses. */
function gitRepoHost(gitRepoUrl: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(gitRepoUrl)) {
    try {
      return new URL(gitRepoUrl).host;
    } catch {
      return redactSecrets(gitRepoUrl);
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/@]+):/.exec(gitRepoUrl);
  return scp !== null ? scp[1] : redactSecrets(gitRepoUrl);
}

/** Human-readable lines summarizing `state` for the saved-setup prompt: which delivery
 * targets are on and which are off, then the details of each target that is on. The
 * webhook is masked to its host (never its `sig` query value) and the git repository to
 * its host (never its path or any userinfo); the last test result, when known, is shown
 * as-is. An off target's saved details are not shown. */
export function summarizeState(state: BootstrapState): string[] {
  const onOff = (on: boolean): string => (on ? 'on' : 'off');
  const lines: string[] = [
    `Delivery targets: webhook ${onOff(state.targets.webhook)}, git ${onOff(state.targets.git)}`
  ];

  if (state.targets.webhook) {
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
  }

  if (state.targets.git) {
    if (state.gitRepoUrl !== undefined) {
      lines.push(`Git repository: ${gitRepoHost(state.gitRepoUrl)}/… (path hidden)`);
    }
    if (state.gitBranch !== undefined) {
      lines.push(`Git branch: ${state.gitBranch}`);
    }
    if (state.gitPath !== undefined) {
      lines.push(`Git folder: ${state.gitPath}`);
    }
    if (state.gitTest !== undefined) {
      lines.push(`Git test: ${state.gitTest}`);
    }
  }

  if (state.includeExternal !== undefined) {
    lines.push(`External sessions: ${state.includeExternal}`);
  }
  if (state.lookbackDays !== undefined) {
    lines.push(`Lookback: ${state.lookbackDays === 'default' ? 'default' : `${state.lookbackDays} days`}`);
  }

  return lines;
}

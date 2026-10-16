/**
 * Writes/merges (`connect`) and strips/removes (`disconnect`) codemie's
 * OTel wiring in `.claude/settings.json`: the hook surface (8 events) pointed
 * at `codemie hook --agent claude-code-otlp`, and the OTel environment
 * variables pointing Claude Code's telemetry at the local proxy daemon.
 */

import { existsSync } from 'node:fs';
import type { HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { readState } from '../daemon-manager.js';
import { writeAtomically } from './vscode.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import {
  CODEMIE_ANALYTICS_PROJECT_FILTER_ENV,
  addProjectPath,
  canonicalizePath,
  getClaudeSettingsPath,
  parseAllowlist,
  removeProjectPath,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';

interface WriteClaudeCodeOtlpOptions {
  force?: boolean;
  scope?: 'user' | 'project';
}

interface WriteClaudeCodeOtlpResult {
  written: boolean;
  path: string;
  backupPath: string | null;
  hookEvents: number;
  envVars: number;
  /** Tracked project roots; empty means all projects. */
  allowlist: string[];
}

interface RemoveClaudeCodeOtlpOptions {
  scope?: 'user' | 'project';
}

interface RemoveClaudeCodeOtlpResult {
  removed: boolean;
  path: string | null;
  /** 'entry-removed': only this project's allowlist entry was dropped; 'full': all codemie wiring removed. */
  mode: 'entry-removed' | 'full' | 'noop';
  /** Human-readable reason when `removed` is false. */
  reason?: string;
  /** Remaining tracked project roots after an 'entry-removed' operation. */
  allowlist?: string[];
}

interface HookEntry {
  type: string;
  command: string;
  async?: boolean;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  // Parsed from user-edited JSON, so an event's value is not guaranteed to be an array.
  hooks?: Record<string, unknown>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

// CODEMIE_ANALYTICS_PROJECT_FILTER_ENV is deliberately not listed here: its value is managed per scope, not fixed.
export const CODEMIE_ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_LOG_TOOL_DETAILS',
] as const;

// Every CODEMIE_ENV_KEYS member except the two daemon-derived ones (their
// value embeds the live proxy URL/gateway key, so it can't be a fixed literal).
type FixedCodemieEnvKey = Exclude<
  (typeof CODEMIE_ENV_KEYS)[number],
  'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_EXPORTER_OTLP_HEADERS'
>;

// Fixed values for every non-daemon-derived key — lets disconnect recognize
// "codemie's own value" without a live daemon.
//
// A full Record, not Partial + `as` cast: a future key missing its value
// here is now a compile error, not a silent runtime gap.
const CODEMIE_ENV_FIXED_VALUES: Record<FixedCodemieEnvKey, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_LOG_TOOL_DETAILS: '1',
};

/**
 * True if `value` is (still) codemie's own value for `key`, without a live
 * daemon — matched by fixed suffix/prefix for the two daemon-derived keys,
 * by fixed literal for the rest. `value` is `unknown` since settings are
 * user-edited JSON.
 *
 * ENDPOINT and HEADERS each require the OTHER to also look like codemie's
 * own (via `env`) — neither half alone is distinctive enough. `env` must
 * be a pre-mutation snapshot or the pairing check breaks mid-pass.
 */
function isCodemieOwnedEnvValue(
  key: (typeof CODEMIE_ENV_KEYS)[number],
  value: unknown,
  env: Record<string, unknown>
): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (key === 'OTEL_EXPORTER_OTLP_ENDPOINT') {
    if (!value.endsWith('/v1/analytics/otlp')) {
      return false;
    }
    const headers = env.OTEL_EXPORTER_OTLP_HEADERS;
    return typeof headers === 'string' && headers.startsWith('Authorization=Bearer ');
  }
  if (key === 'OTEL_EXPORTER_OTLP_HEADERS') {
    if (!value.startsWith('Authorization=Bearer ')) {
      return false;
    }
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    return typeof endpoint === 'string' && endpoint.endsWith('/v1/analytics/otlp');
  }
  return CODEMIE_ENV_FIXED_VALUES[key] === value;
}

/**
 * Puts a value a `--force` connect once displaced into `backupEnv` back
 * into `baseEnv`, for any key `baseEnv` doesn't hold — only while `liveEnv`
 * still carries codemie's OWN value right now (AC3: a user edit since then
 * leaves `baseEnv` untouched).
 *
 * Shared by connect-side refresh and disconnect-side restore. Returns
 * `undefined` (never `{}`) when empty, so callers can `delete` the key.
 */
function withDisplacedEnvValues(
  baseEnv: Record<string, string> | undefined,
  backupEnv: Record<string, string> | undefined,
  liveEnv: Record<string, string>
): Record<string, string> | undefined {
  if (!backupEnv) {
    return baseEnv;
  }
  const merged: Record<string, string> = { ...(baseEnv ?? {}) };
  for (const key of CODEMIE_ENV_KEYS) {
    if (merged[key] !== undefined) {
      continue;
    }
    const backupValue = backupEnv[key];
    const liveValue = liveEnv[key];
    if (backupValue !== undefined && liveValue !== undefined && isCodemieOwnedEnvValue(key, liveValue, liveEnv)) {
      merged[key] = backupValue;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Hook-events counterpart to `withDisplacedEnvValues` — same contract, but
 * a hook event can only be displaced by DROPPING a malformed (non-array)
 * value outright (a well-formed array is always merged into, never
 * replaced). Restores it only while `liveHooks` still holds codemie's own
 * command right now (same AC3 guarantee).
 */
function withDisplacedHooks(
  baseHooks: Record<string, unknown> | undefined,
  backupHooks: Record<string, unknown> | undefined,
  liveHooks: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!backupHooks) {
    return baseHooks;
  }
  const merged: Record<string, unknown> = { ...(baseHooks ?? {}) };
  for (const [eventName, backupValue] of Object.entries(backupHooks)) {
    if (merged[eventName] !== undefined || Array.isArray(backupValue)) {
      continue;
    }
    const liveValue = liveHooks[eventName];
    if (Array.isArray(liveValue) && liveValue.some(groupContainsCodemieCommand)) {
      merged[eventName] = backupValue;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export const HOOK_EVENTS = [
  'SessionStart',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
  'PostModelSwitch',
  'ConfigChange',
] as const satisfies readonly HookEvent[];

export const SETTINGS_BACKUP_SUFFIX = '.codemie-backup';
export const CODEMIE_COMMAND_MARKER = `hook --agent ${CLAUDE_CODE_OTLP_AGENT_NAME}`;
export const CODEMIE_HOOK_TIMEOUT_SECONDS = 30;

/**
 * `PostCompact` alone gets `async: true` plus a longer `timeout`: `openPostCompactPass`
 * (`transcript/orchestrator.ts`) waits up to a minute, lock-free, for a still-landing
 * `compact_boundary` line (`POST_COMPACT_WAIT_BUDGET_MS`). `async` keeps Claude Code — and the
 * user's own turn — from ever waiting on that; the larger `timeout` here is what keeps Claude
 * Code itself from killing the subprocess before that wait, plus the lock-held merge/send/commit
 * afterward, can finish. Every other event keeps the default `CODEMIE_HOOK_TIMEOUT_SECONDS`
 * (synchronous — e.g. `UserPromptSubmit`'s SSO re-auth gate depends on Claude Code waiting for
 * its block decision, so it can never be async).
 */
export const CODEMIE_POST_COMPACT_HOOK_TIMEOUT_SECONDS = 90;

async function readSettingsFile(settingsPath: string): Promise<ClaudeSettings> {
  if (!existsSync(settingsPath)) {
    return {};
  }

  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read Claude Code settings at ${settingsPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigurationError(`Claude Code settings must be a JSON object: ${settingsPath}`);
    }
    return parsed as ClaudeSettings;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(
      `Claude Code settings at ${settingsPath} is not valid JSON and was not changed.`
    );
  }
}

/**
 * True if a single hook entry is one codemie itself would write (matched
 * by the command marker). Deliberately the finest granularity checked for
 * destructive ops — a hook GROUP may mix our command with the user's own.
 */
function isHookEntry(h: unknown): h is HookEntry {
  return typeof h === 'object' && h !== null && typeof (h as HookEntry).command === 'string';
}

function isHookGroup(group: unknown): group is HookGroup {
  return typeof group === 'object' && group !== null && Array.isArray((group as HookGroup).hooks);
}

function isCodemieCommand(h: unknown): boolean {
  return isHookEntry(h) && h.command.includes(CODEMIE_COMMAND_MARKER);
}

/**
 * True if a hook GROUP contains at least one codemie-owned command. Used only
 * for the "have we already touched this file before" backup heuristic in the
 * connect path — safe at group granularity since it's purely informational
 * (whether to snapshot a backup), never destructive.
 */
function groupContainsCodemieCommand(group: unknown): boolean {
  return isHookGroup(group) && group.hooks.some(isCodemieCommand);
}

/**
 * Strips our own command(s) out of each hook group for one event: a group
 * left with foreign commands keeps them (plus matcher/extra fields); a
 * group that was ours only is dropped; malformed entries pass through.
 * Shared by the connect and disconnect paths.
 */
function stripCodemieCommandsFromGroups(existingGroups: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const group of existingGroups) {
    if (!isHookGroup(group)) {
      result.push(group);
      continue;
    }
    const remainingCommands = group.hooks.filter((h) => !isCodemieCommand(h));
    if (remainingCommands.length > 0) {
      result.push({ ...group, hooks: remainingCommands });
    }
  }
  return result;
}

interface StripCodemieManagedContentResult {
  stripped: ClaudeSettings;
  removedHookCommands: boolean;
  removedEnvKeys: boolean;
}

/**
 * Returns `existing` with every codemie-owned hook command and env key
 * removed, leaving only what the user owns. Rebuilds a missing backup
 * without re-copying our own writes, and computes what disconnect writes back.
 *
 * No live-daemon exact-match fallback for env values: the daemon's default
 * gateway key is a fixed, non-secret string, so an exact match alone could
 * misclassify a collector reusing it. The structural pairing check in
 * isCodemieOwnedEnvValue is rotation-invariant and already covers every
 * case codemie itself can produce.
 */
function stripCodemieManagedContent(existing: ClaudeSettings): StripCodemieManagedContentResult {
  let removedHookCommands = false;
  const hooks: Record<string, unknown> = {};
  for (const [eventName, entries] of Object.entries(existing.hooks ?? {})) {
    if (!Array.isArray(entries)) {
      hooks[eventName] = entries;
      continue;
    }
    if (entries.some(groupContainsCodemieCommand)) {
      removedHookCommands = true;
    }
    const remainingGroups = stripCodemieCommandsFromGroups(entries);
    if (remainingGroups.length > 0) {
      hooks[eventName] = remainingGroups;
    }
  }

  const env: Record<string, string> = { ...(existing.env ?? {}) };
  // A snapshot taken BEFORE the loop below starts deleting keys from `env`.
  // isCodemieOwnedEnvValue's HEADERS check reads its sibling ENDPOINT key —
  // if we instead read the mutating `env`, ENDPOINT (checked earlier in
  // CODEMIE_ENV_KEYS order) could already be deleted by the time HEADERS is
  // checked, breaking the pairing check depending on iteration order.
  const originalEnv = existing.env ?? {};
  let removedEnvKeys = false;
  // Only strip a CODEMIE_ENV_KEYS entry whose VALUE is actually ours — a
  // foreign value that merely reuses one of our keys (e.g. the user's own
  // OTEL_EXPORTER_OTLP_ENDPOINT, or a coincidentally-matching
  // CLAUDE_CODE_ENABLE_TELEMETRY='1') must survive both the backup snapshot
  // and the disconnect result. Key-presence alone is not ownership.
  for (const key of CODEMIE_ENV_KEYS) {
    if (key in env && isCodemieOwnedEnvValue(key, env[key], originalEnv)) {
      removedEnvKeys = true;
      delete env[key];
    }
  }
  // No fixed literal to compare (value is a per-scope list), so gate on it
  // being a well-formed allowlist instead of presence alone — same
  // ownership-by-value principle as CODEMIE_ENV_KEYS above.
  if (CODEMIE_ANALYTICS_PROJECT_FILTER_ENV in env && parseAllowlist(env[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]).kind !== 'invalid') {
    removedEnvKeys = true;
    delete env[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV];
  }

  const stripped: ClaudeSettings = { ...existing };
  if (Object.keys(hooks).length > 0) {
    stripped.hooks = hooks;
  } else {
    delete stripped.hooks;
  }
  if (Object.keys(env).length > 0) {
    stripped.env = env;
  } else {
    delete stripped.env;
  }

  return { stripped, removedHookCommands, removedEnvKeys };
}

/**
 * Best-effort read of the backup file; never throws — missing, unreadable
 * or corrupt just means nothing to restore from.
 *
 * No age/cycle check: a long-displaced value is as recoverable as a recent
 * one; withDisplacedEnvValues/withDisplacedHooks already gate on the LIVE
 * file, which is the real staleness guard.
 *
 * Sanitizes `env`: drops non-string values a hand-edited backup could hold.
 */
async function readBackupSettings(backupPath: string): Promise<ClaudeSettings | null> {
  if (!existsSync(backupPath)) {
    return null;
  }
  try {
    const raw = await readFile(backupPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const settings = parsed as ClaudeSettings;
    if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
      const sanitizedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings.env)) {
        if (typeof value === 'string') {
          sanitizedEnv[key] = value;
        }
      }
      settings.env = sanitizedEnv;
    }
    return settings;
  } catch {
    // Corrupt/unreadable backup — nothing to restore, but the caller must still proceed.
  }
  return null;
}

export async function writeClaudeCodeOtlpConfig(
  opts: WriteClaudeCodeOtlpOptions = {}
): Promise<WriteClaudeCodeOtlpResult> {
  const state = await readState();
  if (!state) {
    throw new ConfigurationError('No live proxy daemon. Run: codemie proxy start');
  }

  // Always user-level: the allowlist (not the settings location) decides which projects are tracked.
  const settingsPath = getClaudeSettingsPath();

  const existing = await readSettingsFile(settingsPath);
  const existingHooksBlock = existing.hooks ?? {};

  const codemieEnv: Record<(typeof CODEMIE_ENV_KEYS)[number], string> = {
    ...CODEMIE_ENV_FIXED_VALUES,
    OTEL_EXPORTER_OTLP_ENDPOINT: `${state.url}/v1/analytics/otlp`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${state.gatewayKey}`,
  };

  // --- Conflict detection: env values AND malformed (non-array) hooks entries ---
  const existingEnv = existing.env ?? {};
  const envConflicts: string[] = [];
  for (const key of CODEMIE_ENV_KEYS) {
    const currentVal = existingEnv[key];
    const desiredVal = codemieEnv[key];
    if (currentVal !== undefined && currentVal !== desiredVal) {
      envConflicts.push(key);
    }
  }

  // A non-array value under ANY existing hooks event key (not just the ones we
  // currently manage) can't be safely merged with — silently discarding it
  // would be the same class of data loss this fix is about, just rarer.
  const malformedHookEvents: string[] = [];
  for (const [eventName, value] of Object.entries(existingHooksBlock)) {
    if (!Array.isArray(value)) {
      malformedHookEvents.push(eventName);
    }
  }

  if ((envConflicts.length > 0 || malformedHookEvents.length > 0) && !opts.force) {
    const parts: string[] = [];
    if (envConflicts.length > 0) {
      parts.push(`conflicting env values for: ${envConflicts.join(', ')}`);
    }
    if (malformedHookEvents.length > 0) {
      parts.push(`non-array hooks entries for: ${malformedHookEvents.join(', ')}`);
    }
    throw new ConfigurationError(
      `Claude Code settings already contain ${parts.join('; ')}. Re-run with --force to overwrite.`
    );
  }

  // --- Allowlist pre-check (before anything is written) ---
  const rawAllowlist: unknown = existingEnv[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV];
  const existingAllowlist = parseAllowlist(rawAllowlist);
  if (existingAllowlist.kind === 'invalid' && !opts.force) {
    throw new ConfigurationError(
      `Claude Code settings contain an invalid ${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} value: ${JSON.stringify(rawAllowlist)}. ` +
      `Fix it manually (expected a JSON array of absolute paths, e.g. '["/path/to/project"]') or re-run with --force to discard it.`
    );
  }

  let allowlist: string[] = [];
  if (opts.scope === 'project') {
    const current = existingAllowlist.kind === 'valid' ? existingAllowlist.paths : [];
    allowlist = await addProjectPath(current, resolveProjectRoot());
  }

  // --- Backup, keyed on whether CodeMie already owns part of the file (not on
  // whether a backup file happens to exist) ---
  let backupPath: string | null = null;
  if (existsSync(settingsPath)) {
    const backupPathCandidate = settingsPath + SETTINGS_BACKUP_SUFFIX;
    const alreadyManaged = Object.values(existingHooksBlock).some(
      (entries) => Array.isArray(entries) && entries.some(groupContainsCodemieCommand)
    ) || CODEMIE_ENV_KEYS.some((key) =>
      // Structural ownership check (same as stripCodemieManagedContent), not an
      // exact match against the live daemon state: the daemon's gateway key
      // defaults to a fixed, non-secret string, so exact match alone could be
      // fooled by an unrelated collector reusing it. Rotation-invariant too, so
      // it loses nothing exact match would have caught.
      isCodemieOwnedEnvValue(key, existingEnv[key], existingEnv)
    );
    if (alreadyManaged) {
      // Already managed: always refresh (AC1 — a later connect still modifies
      // the live file, so the backup must reflect THAT pre-connect state).
      // Rebuilt by stripping, not copying as-is, so our own writes (including
      // the bearer token) are never enshrined as the "original".
      const { stripped } = stripCodemieManagedContent(existing);

      // Carry forward a value a PRIOR --force connect displaced into the
      // existing backup: it is no longer present in `existing` itself
      // (codemie's own write replaced it), so stripping `existing` alone
      // would silently drop it from the refreshed backup.
      const oldBackup = await readBackupSettings(backupPathCandidate);
      const mergedEnv = withDisplacedEnvValues(stripped.env, oldBackup?.env, existingEnv);
      if (mergedEnv) {
        stripped.env = mergedEnv;
      } else {
        delete stripped.env;
      }

      // Same carry-forward for a hook event a PRIOR --force connect displaced
      // (dropped a malformed value) — otherwise it would be silently lost
      // from the refreshed backup before an eventual disconnect ever restores it.
      const mergedHooks = withDisplacedHooks(stripped.hooks, oldBackup?.hooks, existingHooksBlock);
      if (mergedHooks) {
        stripped.hooks = mergedHooks;
      } else {
        delete stripped.hooks;
      }

      // Zero foreign keys left (e.g. a fresh install) means nothing to
      // protect — drop any stale backup from an earlier cycle instead.
      if (Object.keys(stripped).length > 0) {
        await writeAtomically(backupPathCandidate, JSON.stringify(stripped, null, 2) + '\n');
        backupPath = backupPathCandidate;
      } else if (existsSync(backupPathCandidate)) {
        // Best-effort (see disconnect's backup unlink below): a failure here
        // (e.g. EPERM) must not fail the whole connect — just leaves a stale
        // backup for the next cycle to clean up.
        try {
          await unlink(backupPathCandidate);
        } catch (error) {
          logger.warn(
            '[proxy] Could not remove the now-unneeded stale backup file',
            ...sanitizeLogArgs({ backupPath: backupPathCandidate, error: error instanceof Error ? error.message : String(error) })
          );
        }
      }
    } else {
      // Not yet managed: always (re)snapshot, overwriting any stale previous backup.
      await copyFile(settingsPath, backupPathCandidate);
      backupPath = backupPathCandidate;
    }
  }

  // --- Merge hooks block ---
  // `PostCompact` alone is async with a longer timeout — see `CODEMIE_POST_COMPACT_HOOK_TIMEOUT_SECONDS`.
  const buildCodemieEntry = (eventName: string): HookGroup => {
    const isPostCompact = eventName === 'PostCompact';
    const hook: HookEntry = {
      type: 'command',
      command: `codemie ${CODEMIE_COMMAND_MARKER}`,
      timeout: isPostCompact ? CODEMIE_POST_COMPACT_HOOK_TIMEOUT_SECONDS : CODEMIE_HOOK_TIMEOUT_SECONDS,
      ...(isPostCompact ? { async: true } : {}),
    };
    return { matcher: '', hooks: [hook] };
  };

  // Phase 1: strip our own command from EVERY existing event key, not just the
  // ones we currently manage. This prevents orphaned commands if HOOK_EVENTS
  // ever shrinks between versions — an event this tool no longer manages
  // would otherwise keep a stale codemie command in it forever.
  const hooks: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(existingHooksBlock)) {
    if (!Array.isArray(entries)) {
      // Only reachable here when `force` is set (validated above) — an
      // explicit, consented overwrite. Drop the malformed value rather than
      // propagate it further.
      continue;
    }
    const strippedGroups = stripCodemieCommandsFromGroups(entries);
    if (strippedGroups.length > 0) {
      hooks[eventName] = strippedGroups;
    }
    // else: this event had ONLY our command(s) — drop the now-empty key
    // (this is also what cleans up orphans from a shrunk HOOK_EVENTS list).
  }

  // Phase 2: (re-)add our dedicated entry for every event we currently manage.
  for (const eventName of HOOK_EVENTS) {
    hooks[eventName] = [...(hooks[eventName] ?? []), buildCodemieEntry(eventName)];
  }

  // --- Merge env block ---
  const mergedEnv: Record<string, string> = {
    ...(existing.env ?? {}),
    ...codemieEnv,
    [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: JSON.stringify(allowlist),
  };

  const merged: ClaudeSettings = {
    ...existing,
    hooks,
    env: mergedEnv,
  };

  // `writeAtomically` creates the parent (`.claude`) directory itself.
  await writeAtomically(settingsPath, JSON.stringify(merged, null, 2) + '\n');

  const hookEventsCount = HOOK_EVENTS.length;
  const envVarsCount = CODEMIE_ENV_KEYS.length;

  logger.info(
    '[proxy] Configured Claude Code analytics',
    ...sanitizeLogArgs({ settingsPath, backupPath, hookEvents: hookEventsCount, envVars: envVarsCount, allowlist })
  );

  return {
    written: true,
    path: settingsPath,
    backupPath,
    hookEvents: hookEventsCount,
    envVars: envVarsCount,
    allowlist,
  };
}

export async function removeClaudeCodeOtlpConfig(
  opts: RemoveClaudeCodeOtlpOptions = {}
): Promise<RemoveClaudeCodeOtlpResult> {
  const settingsPath = getClaudeSettingsPath();

  if (!existsSync(settingsPath)) {
    return { removed: false, path: null, mode: 'noop', reason: 'no Claude Code settings file found' };
  }

  const existing = await readSettingsFile(settingsPath);

  if (opts.scope === 'project') {
    const allowlist = parseAllowlist(existing.env?.[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]);
    if (allowlist.kind !== 'valid' || allowlist.paths.length === 0) {
      let reason: string;
      if (allowlist.kind === 'invalid') {
        reason = `${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} is invalid; fix it manually or run disconnect without --scope project`;
      } else if (allowlist.kind === 'absent') {
        reason = `${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} is not set`;
      } else {
        reason = 'all projects are tracked (no per-project entries)';
      }
      return { removed: false, path: settingsPath, mode: 'noop', reason };
    }

    const projectRoot = resolveProjectRoot();
    const remaining = await removeProjectPath(allowlist.paths, projectRoot);
    if (remaining.length === allowlist.paths.length) {
      return {
        removed: false,
        path: settingsPath,
        mode: 'noop',
        reason: `project ${await canonicalizePath(projectRoot)} is not in the allowlist`,
      };
    }

    if (remaining.length > 0) {
      const env = { ...(existing.env ?? {}), [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: JSON.stringify(remaining) };
      await writeAtomically(settingsPath, JSON.stringify({ ...existing, env }, null, 2) + '\n');
      logger.info('[proxy] Removed project from Claude Code analytics allowlist', ...sanitizeLogArgs({ settingsPath, remaining }));
      return { removed: true, path: settingsPath, mode: 'entry-removed', allowlist: remaining };
    }
    // Last entry removed: fall through to the full removal below
  }

  const { stripped, removedHookCommands, removedEnvKeys } = stripCodemieManagedContent(existing);

  if (!removedHookCommands && !removedEnvKeys) {
    return { removed: false, path: settingsPath, mode: 'noop', reason: 'no CodeMie entries found' };
  }

  const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
  const backupSettings = await readBackupSettings(backupPath);

  // Put back a value a `--force` connect displaced into the backup (preserves
  // AC3 — never resurrects a value the user changed after connect; see
  // `withDisplacedEnvValues`).
  const restoredEnv = withDisplacedEnvValues(stripped.env, backupSettings?.env, existing.env ?? {});
  if (restoredEnv) {
    stripped.env = restoredEnv;
  } else {
    delete stripped.env;
  }

  // Same restore for a hook event a `--force` connect displaced (dropped a
  // malformed value) — see `withDisplacedHooks` for the AC3 guard.
  const restoredHooks = withDisplacedHooks(stripped.hooks, backupSettings?.hooks, existing.hooks ?? {});
  if (restoredHooks) {
    stripped.hooks = restoredHooks;
  } else {
    delete stripped.hooks;
  }

  const isEmpty = Object.keys(stripped).length === 0;

  // Always derive the result from the CURRENT live content, never raw backup
  // bytes — a backup can hold a value the user changed/removed since connect.
  // The one exception: a value `--force` displaced, restored above only
  // while codemie still owns it right now.
  if (isEmpty) {
    await unlink(settingsPath);
  } else {
    await writeAtomically(settingsPath, JSON.stringify(stripped, null, 2) + '\n');
  }
  if (existsSync(backupPath)) {
    // Best-effort: settings.json is already correctly updated by this point,
    // so a failure here (e.g. EPERM) must not surface as "disconnect failed".
    try {
      await unlink(backupPath);
    } catch (error) {
      logger.warn(
        '[proxy] Disconnected successfully but could not remove the stale backup file',
        ...sanitizeLogArgs({ backupPath, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  logger.info(
    '[proxy] Removed Claude Code analytics entries from settings',
    ...sanitizeLogArgs({ settingsPath, deleted: isEmpty })
  );
  return { removed: true, path: settingsPath, mode: 'full' };
}

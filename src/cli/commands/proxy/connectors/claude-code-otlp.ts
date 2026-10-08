/**
 * Writes/merges (`connect`) and strips/removes (`disconnect`) codemie's
 * OTel wiring in `.claude/settings.json`: the hook surface (8 events) pointed
 * at `codemie hook --agent claude-code-otlp`, and the OTel environment
 * variables pointing Claude Code's telemetry at the local proxy daemon.
 */

import { existsSync } from 'node:fs';
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
  usedBackup: boolean;
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

export const HOOK_EVENTS = [
  'SessionStart',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification',
] as const;

export const SETTINGS_BACKUP_SUFFIX = '.codemie-backup';
export const CODEMIE_COMMAND_MARKER = `hook --agent ${CLAUDE_CODE_OTLP_AGENT_NAME}`;

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
 * True if a single hook entry (`{ type: 'command', command: '...' }`) is one
 * that codemie itself would write, identified by the command marker.
 *
 * This is intentionally the finest granularity we ever check at for
 * destructive operations (add/replace/remove) — never classify a whole hook
 * GROUP as "ours" for that purpose, since a group's `hooks[]` array may mix
 * our command with a user's own command(s).
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
 * Given an existing array of hook groups for one event, returns a new array
 * with our own command(s) stripped out at the COMMAND level:
 *  - a group that still has foreign command(s) left is kept, with our
 *    command(s) removed and everything else (matcher, extra fields) intact;
 *  - a group that contained ONLY our command(s) is dropped entirely;
 *  - malformed/unrecognized entries are preserved as-is.
 *
 * Shared by both the connect (write) and disconnect (remove) paths.
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
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: `${state.url}/v1/analytics/otlp`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${state.gatewayKey}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_LOG_TOOL_DETAILS: '1',
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

  // --- Backup on first modification (no existing codemie entry, no existing backup) ---
  let backupPath: string | null = null;
  if (existsSync(settingsPath)) {
    const backupPathCandidate = settingsPath + SETTINGS_BACKUP_SUFFIX;
    const backupCandidateExists = existsSync(backupPathCandidate);
    const alreadyManaged = Object.values(existingHooksBlock).some(
      (entries) => Array.isArray(entries) && entries.some(groupContainsCodemieCommand)
    );
    if (!alreadyManaged && !backupCandidateExists) {
      await copyFile(settingsPath, backupPathCandidate);
      backupPath = backupPathCandidate;
    } else if (backupCandidateExists) {
      backupPath = backupPathCandidate;
    }
  }

  // --- Merge hooks block ---
  const codemieEntry: HookGroup = {
    matcher: '',
    hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }],
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
    hooks[eventName] = [...(hooks[eventName] ?? []), codemieEntry];
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
    return { removed: false, usedBackup: false, path: null, mode: 'noop', reason: 'no Claude Code settings file found' };
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
      return { removed: false, usedBackup: false, path: settingsPath, mode: 'noop', reason };
    }

    const projectRoot = resolveProjectRoot();
    const remaining = await removeProjectPath(allowlist.paths, projectRoot);
    if (remaining.length === allowlist.paths.length) {
      return {
        removed: false,
        usedBackup: false,
        path: settingsPath,
        mode: 'noop',
        reason: `project ${await canonicalizePath(projectRoot)} is not in the allowlist`,
      };
    }

    if (remaining.length > 0) {
      const env = { ...(existing.env ?? {}), [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: JSON.stringify(remaining) };
      await writeAtomically(settingsPath, JSON.stringify({ ...existing, env }, null, 2) + '\n');
      logger.info('[proxy] Removed project from Claude Code analytics allowlist', ...sanitizeLogArgs({ settingsPath, remaining }));
      return { removed: true, usedBackup: false, path: settingsPath, mode: 'entry-removed', allowlist: remaining };
    }
    // Last entry removed: fall through to the full removal below
  }

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
  let removedEnvKeys = false;
  for (const key of [...CODEMIE_ENV_KEYS, CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]) {
    if (key in env) {
      removedEnvKeys = true;
      delete env[key];
    }
  }

  if (!removedHookCommands && !removedEnvKeys) {
    return { removed: false, usedBackup: false, path: settingsPath, mode: 'noop', reason: 'no CodeMie entries found' };
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

  const isEmpty = Object.keys(stripped).length === 0;
  const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;

  if (isEmpty) {
    if (existsSync(backupPath)) {
      const backupContent = await readFile(backupPath, 'utf-8');
      await writeAtomically(settingsPath, backupContent);
      await unlink(backupPath);
      logger.info('[proxy] Removed Claude Code analytics config (restored backup)', ...sanitizeLogArgs({ settingsPath }));
      return { removed: true, usedBackup: true, path: settingsPath, mode: 'full' };
    } else {
      await unlink(settingsPath);
      logger.info('[proxy] Removed Claude Code analytics config (deleted settings)', ...sanitizeLogArgs({ settingsPath }));
      return { removed: true, usedBackup: false, path: settingsPath, mode: 'full' };
    }
  }

  await writeAtomically(settingsPath, JSON.stringify(stripped, null, 2) + '\n');
  logger.info('[proxy] Removed Claude Code analytics entries from settings', ...sanitizeLogArgs({ settingsPath }));
  return { removed: true, usedBackup: false, path: settingsPath, mode: 'full' };
}

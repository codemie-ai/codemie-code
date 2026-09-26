/**
 * Writes and merges `.claude/settings.json` at the project root, wiring
 * Claude Code's hook surface (8 events) onto `codemie hook --agent claude-code --analytics`
 * and setting OTel environment variables that point Claude Code's telemetry at
 * the local proxy daemon.
 *
 * Mirrors the read-merge-write-atomically shape of `cursor-ide.ts`.
 * Unlike the cursor-ide connector this targets `.claude/settings.json`, not
 * `.cursor/hooks.json`, so the merge shape follows Claude Code's hooks format.
 */

import { existsSync } from 'node:fs';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { resolveHomeDir } from '@/utils/paths.js';
import { readState } from '../../daemon-manager.js';
import { writeAtomically } from '../vscode.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';

const CODEMIE_COMMAND_MARKER = `hook --agent ${CLAUDE_CODE_OTLP_AGENT_NAME} --analytics`;
const SETTINGS_BACKUP_SUFFIX = '.codemie-backup';

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
] as const;

const CODEMIE_ENV_KEYS = [
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

interface HookEntry {
  type: string;
  command: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Record<string, unknown[]>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface WriteClaudeCodeAnalyticsOptions {
  force?: boolean;
  scope?: "user" | "project";
}

interface WriteClaudeCodeAnalyticsResult {
  written: boolean;
  path: string;
  backupPath: string | null;
  hookEvents: number;
  envVars: number;
}

interface RemoveClaudeCodeAnalyticsOptions {
  scope?: 'user' | 'project';
}

interface RemoveClaudeCodeAnalyticsResult {
  removed: boolean;
  usedBackup: boolean;
  path: string | null;
}

function isCodemieEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }

  const obj = entry as Record<string, unknown>;
  return (obj.hooks as unknown[]).some(
    (h) =>
      typeof h === 'object' &&
      h !== null &&
      typeof (h as HookEntry).command === 'string' &&
      (h as HookEntry).command.includes(CODEMIE_COMMAND_MARKER)
  );
}

async function readSettingsFile(settingsPath: string): Promise<ClaudeSettings> {
  if (!existsSync(settingsPath)) return {};
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read Claude Code settings at ${settingsPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigurationError(`Claude Code settings must be a JSON object: ${settingsPath}`);
    }
    return parsed as ClaudeSettings;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `Claude Code settings at ${settingsPath} is not valid JSON and was not changed.`
    );
  }
}

/**
 * Write the Claude Code analytics config at an explicit path (test seam).
 */
export async function writeClaudeCodeAnalyticsConfig(
  opts: WriteClaudeCodeAnalyticsOptions = {}
): Promise<WriteClaudeCodeAnalyticsResult> {
  const state = await readState();
  if (!state) {
    throw new ConfigurationError('No live proxy daemon. Run: codemie proxy start');
  }

  const basePath = opts.scope === 'project' ? resolveProjectRoot() : resolveHomeDir();

  const settingsPath = join(
    basePath,
    '.claude',
    'settings.json'
  );

  const existing = await readSettingsFile(settingsPath);

  // Inline conflict-detection: check if env block already contains any of the
  // env keys with a different (non-codemie-authored) value.
  const codemieEnv: Record<string, string> = {
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

  const existingEnv = existing.env ?? {};
  const conflicts: string[] = [];
  for (const key of CODEMIE_ENV_KEYS) {
    const currentVal = existingEnv[key];
    const desiredVal = codemieEnv[key];
    // Conflict: key exists with a different value that doesn't look like we wrote it
    if (currentVal !== undefined && currentVal !== desiredVal) {
      const isOurValue = CODEMIE_ENV_KEYS.includes(key as typeof CODEMIE_ENV_KEYS[number]) &&
        currentVal === desiredVal;
      if (!isOurValue) {
        conflicts.push(key);
      }
    }
  }
  if (conflicts.length > 0 && !opts.force) {
    throw new ConfigurationError(
      `Claude Code settings already contain conflicting values for: ${conflicts.join(', ')}. ` +
      `Re-run with --force to overwrite.`
    );
  }

  // Backup on first modification (no existing codemie entry, no existing backup)
  let backupPath: string | null = null;
  if (existsSync(settingsPath)) {
    const backupPathCandidate = settingsPath + SETTINGS_BACKUP_SUFFIX;
    const hooks = existing.hooks ?? {};
    const alreadyManaged = Object.values(hooks).some(
      (entries) => Array.isArray(entries) && entries.some(isCodemieEntry)
    );
    if (!alreadyManaged && !existsSync(backupPathCandidate)) {
      await copyFile(settingsPath, backupPathCandidate);
      backupPath = backupPathCandidate;
    } else if (existsSync(backupPathCandidate)) {
      backupPath = backupPathCandidate;
    }
  }

  // Merge hooks block
  const hooks: Record<string, unknown[]> = { ...(existing.hooks ?? {}) };
  for (const eventName of HOOK_EVENTS) {
    const existingEntries: unknown[] = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
    const foreignEntries = existingEntries.filter((e) => !isCodemieEntry(e));
    const codemieEntry: HookGroup = {
      matcher: '',
      hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }],
    };
    hooks[eventName] = [...foreignEntries, codemieEntry];
  }

  // Merge env block
  const mergedEnv: Record<string, string> = { ...(existing.env ?? {}), ...codemieEnv };

  const merged: ClaudeSettings = {
    ...existing,
    hooks,
    env: mergedEnv,
  };

  // Ensure .claude directory exists
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(basePath, '.claude'), { recursive: true });

  await writeAtomically(settingsPath, JSON.stringify(merged, null, 2) + '\n');

  logger.info(
    '[proxy] Configured Claude Code analytics',
    ...sanitizeLogArgs({ settingsPath, backupPath, hookEvents: HOOK_EVENTS.length, envVars: CODEMIE_ENV_KEYS.length })
  );

  return {
    written: true,
    path: settingsPath,
    backupPath,
    hookEvents: HOOK_EVENTS.length,
    envVars: CODEMIE_ENV_KEYS.length,
  };
}

/**
 * Remove CodeMie-authored analytics hooks and env entries from
 * `.claude/settings.json` at the given project root.
 */
export async function removeClaudeCodeAnalyticsConfig(
  opts: RemoveClaudeCodeAnalyticsOptions = {}
): Promise<RemoveClaudeCodeAnalyticsResult> {
  const basePath = opts.scope === 'project' ? resolveProjectRoot() : resolveHomeDir();
  const settingsPath = join(basePath, '.claude', 'settings.json');

  if (!existsSync(settingsPath)) {
    return { removed: false, usedBackup: false, path: null };
  }

  const existing = await readSettingsFile(settingsPath);

  // Strip codemie hook entries
  const hooks: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(existing.hooks ?? {})) {
    if (!Array.isArray(entries)) {
      hooks[eventName] = entries as unknown[];
      continue;
    }
    const remaining = entries.filter((e) => !isCodemieEntry(e));
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    }
  }

  // Remove codemie env keys
  const env: Record<string, string> = { ...(existing.env ?? {}) };
  for (const key of CODEMIE_ENV_KEYS) {
    delete env[key];
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
      return { removed: true, usedBackup: true, path: settingsPath };
    } else {
      await unlink(settingsPath);
      logger.info('[proxy] Removed Claude Code analytics config (deleted settings)', ...sanitizeLogArgs({ settingsPath }));
      return { removed: true, usedBackup: false, path: settingsPath };
    }
  }

  await writeAtomically(settingsPath, JSON.stringify(stripped, null, 2) + '\n');
  logger.info('[proxy] Removed Claude Code analytics entries from settings', ...sanitizeLogArgs({ settingsPath }));
  return { removed: true, usedBackup: false, path: settingsPath };
}

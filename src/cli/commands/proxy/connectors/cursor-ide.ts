/**
 * Writes and merges `.cursor/hooks.json` at the project root, wiring Cursor's
 * full native hook surface (21 events) onto `codemie hook --agent cursor-ide`.
 *
 * Mirrors the read-merge-write-atomically shape of `vscode-claude-code.ts`
 * (`{written, path}` result, a `...AtPath` test seam) and the backup-on-first-
 * modification shape of `codex-desktop.ts`. Unlike those two, `.cursor/hooks.json`
 * is merged additively by Cursor from every config source, so this connector
 * must upsert - never clobber a user's existing file or foreign hook entries.
 */

import { existsSync } from 'node:fs';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { resolveCodemieBinary, resolveCodemieBinaryFromPackage } from '@/utils/hook-command.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { writeAtomically } from './vscode.js';

export const CURSOR_IDE_HOOKS_BACKUP_SUFFIX = '.codemie-backup';

/**
 * Cursor's full native hook surface (21 events). This list is used to wire
 * all events into `.cursor/hooks.json` pointing to `codemie hook --agent cursor-ide`.
 */
export const CURSOR_IDE_HOOK_EVENTS: readonly string[] = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'stop',
  'preCompact',
  'subagentStart',
  'subagentStop',
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeReadFile',
  'beforeTabFileRead',
  'postToolUse',
  'afterShellExecution',
  'afterMCPExecution',
  'afterFileEdit',
  'afterTabFileEdit',
  'postToolUseFailure',
  'afterAgentResponse',
  'afterAgentThought',
  'workspaceOpen',
];

// Identifies a CodeMie-authored entry so re-runs are idempotent even after
// the resolved binary path changes (absolute paths vary by machine/install).
const CODEMIE_COMMAND_MARKER = 'hook --agent cursor-ide';

interface CursorHookEntry {
  [key: string]: unknown;
  command?: unknown;
  timeout?: unknown;
  failClosed?: unknown;
}

interface CursorHooksConfig {
  [key: string]: unknown;
  version?: unknown;
  hooks?: Record<string, unknown>;
}

export interface WriteCursorIdeHooksResult {
  written: boolean;
  path: string;
  backupPath: string | null;
  events: string[];
}

function isCodemieEntry(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as CursorHookEntry).command === 'string' &&
    (entry as CursorHookEntry).command!.toString().includes(CODEMIE_COMMAND_MARKER)
  );
}

async function readHooksConfig(configPath: string): Promise<CursorHooksConfig> {
  if (!existsSync(configPath)) return {};

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read Cursor hooks config at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (raw.trim().length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigurationError(`Cursor hooks config must contain a JSON object: ${configPath}`);
    }
    return parsed as CursorHooksConfig;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `Cursor hooks config at ${configPath} is not valid JSON and was not changed.`
    );
  }
}

/**
 * Backup on first modification only - keyed on whether a codemie entry is
 * already present, mirroring `codex-desktop.ts`'s `backupIfUnmanaged`. A
 * config that already carries our entries has its true pre-CodeMie state in
 * the existing backup (if any); a fresh backup at that point would enshrine
 * our own entries as "the original".
 */
async function backupIfUnmanaged(configPath: string, config: CursorHooksConfig): Promise<string | null> {
  if (!existsSync(configPath)) return null;

  const backupPath = `${configPath}${CURSOR_IDE_HOOKS_BACKUP_SUFFIX}`;
  const hooks = config.hooks ?? {};
  const alreadyManaged = Object.values(hooks).some((entries) =>
    Array.isArray(entries) && entries.some(isCodemieEntry)
  );

  if (alreadyManaged) {
    if (existsSync(backupPath)) {
      return backupPath;
    }
    // Managed but the backup is gone - nothing safe to reconstruct here
    // (unlike Codex's TOML, we cannot cheaply strip just our entries out of
    // an arbitrary hooks.json without already having done the merge), so
    // skip rather than risk enshrining our own entries as the "original".
    return null;
  }

  await copyFile(configPath, backupPath);
  return backupPath;
}

/**
 * Upsert exactly one CodeMie entry per event key, preserving every foreign
 * entry and every foreign top-level key. Never deletes a user entry.
 */
function mergeHooksConfig(
  existing: CursorHooksConfig,
  command: string
): { config: CursorHooksConfig; events: string[] } {
  const hooks: Record<string, unknown> = { ...(existing.hooks ?? {}) };
  const events: string[] = [];

  for (const eventName of CURSOR_IDE_HOOK_EVENTS) {
    const existingEntries: unknown[] = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
    const foreignEntries = existingEntries.filter((entry) => !isCodemieEntry(entry));
    const codemieEntry: CursorHookEntry = {
      command,
      timeout: 10,
      failClosed: false,
    };
    hooks[eventName] = [...foreignEntries, codemieEntry];
    events.push(eventName);
  }

  return {
    config: {
      ...existing,
      version: existing.version ?? 1,
      hooks,
    },
    events,
  };
}

/**
 * Write/merge `.cursor/hooks.json` at an explicit path. Test seam mirroring
 * `writeVsCodeClaudeCodeConfigAtPath` - the resolving wrapper below is the
 * one every real caller uses.
 */
export async function writeCursorIdeHooksConfigAtPath(
  configPath: string
): Promise<WriteCursorIdeHooksResult> {
  const existing = await readHooksConfig(configPath);
  const backupPath = await backupIfUnmanaged(configPath, existing);

  const binary = resolveCodemieBinaryFromPackage() ?? (await resolveCodemieBinary());
  const command = `${binary} hook --agent cursor-ide`;
  const { config: merged, events } = mergeHooksConfig(existing, command);

  try {
    await writeAtomically(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (error) {
    throw new ConfigurationError(
      `Failed to write Cursor hooks config at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  logger.info(
    '[proxy] Configured Cursor IDE hooks',
    ...sanitizeLogArgs({ configPath, backupPath, eventCount: events.length })
  );

  return { written: true, path: configPath, backupPath, events };
}

export interface WriteCursorIdeHooksOptions {
  /** Project root to resolve `.cursor/hooks.json` under. Defaults to `resolveProjectRoot()`. */
  projectRoot?: string;
  /**
   * Accepted for signature parity with the other connectors' `{force}` option
   * (e.g. `writeCodexDesktopConfig`) and with `connectTargets`'s per-target
   * dispatch, which passes `opts.force` uniformly. The merge here is always
   * additive/idempotent and never refuses to write, so this is currently a
   * no-op - there is no unsafe state for `--force` to override.
   */
  force?: boolean;
}

/**
 * Write/merge `.cursor/hooks.json` at `<projectRoot>/.cursor/hooks.json`,
 * where `projectRoot` resolves via the same shared `resolveProjectRoot()`
 * Task 6's event log uses, so the two locations can never drift apart.
 */
export async function writeCursorIdeHooksConfig(
  options: WriteCursorIdeHooksOptions = {}
): Promise<WriteCursorIdeHooksResult> {
  const projectRoot = options.projectRoot ?? resolveProjectRoot();
  const configPath = join(projectRoot, '.cursor', 'hooks.json');
  return writeCursorIdeHooksConfigAtPath(configPath);
}

export interface RemoveCursorIdeHooksResult {
  removed: boolean;
  usedBackup: boolean;
  path: string | null;
}

/**
 * Everything that remains once codemie's own entries are gone. `hooks` is
 * "empty" once every event key it held has been dropped, and the config is
 * empty once no foreign top-level key survives either - `version` doesn't
 * count, since `mergeHooksConfig` sets it unconditionally (defaulting to 1)
 * even for a file we created from scratch.
 */
function isConfigEmpty(config: CursorHooksConfig): boolean {
  const hooks = config.hooks ?? {};
  const hasRemainingHookEntries = Object.values(hooks).some(
    (entries) => Array.isArray(entries) && entries.length > 0
  );
  if (hasRemainingHookEntries) return false;

  const otherKeys = Object.keys(config).filter((key) => key !== 'version' && key !== 'hooks');
  return otherKeys.length === 0;
}

/**
 * Remove only codemie-authored entries at an explicit path - the disconnect
 * counterpart to `writeCursorIdeHooksConfigAtPath`. Test seam mirroring the
 * write side; the resolving wrapper below is the one every real caller uses.
 */
export async function removeCursorIdeHooksConfigAtPath(
  configPath: string
): Promise<RemoveCursorIdeHooksResult> {
  if (!existsSync(configPath)) {
    return { removed: false, usedBackup: false, path: null };
  }

  const existing = await readHooksConfig(configPath);
  const hooks = existing.hooks ?? {};
  const hadCodemieEntry = Object.values(hooks).some(
    (entries) => Array.isArray(entries) && entries.some(isCodemieEntry)
  );

  if (!hadCodemieEntry) {
    return { removed: false, usedBackup: false, path: configPath };
  }

  // Strip our entries, dropping an event key entirely once its list is empty
  // rather than leaving `"eventName": []` behind.
  const nextHooks: Record<string, unknown> = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      nextHooks[eventName] = entries;
      continue;
    }
    const remaining = entries.filter((entry) => !isCodemieEntry(entry));
    if (remaining.length > 0) {
      nextHooks[eventName] = remaining;
    }
  }

  const stripped: CursorHooksConfig = { ...existing, hooks: nextHooks };
  const backupPath = `${configPath}${CURSOR_IDE_HOOKS_BACKUP_SUFFIX}`;
  let usedBackup = false;

  if (isConfigEmpty(stripped)) {
    if (existsSync(backupPath)) {
      // Codemie's entries were the file's only content - restore the true
      // pre-connect original rather than writing a near-empty shell.
      const backupContent = await readFile(backupPath, 'utf-8');
      await writeAtomically(configPath, backupContent);
      usedBackup = true;
    } else {
      // No pre-connect backup exists, so we created this file ourselves;
      // nothing else to preserve, so remove it entirely.
      await unlink(configPath);
    }
  } else {
    await writeAtomically(configPath, `${JSON.stringify(stripped, null, 2)}\n`);
  }

  logger.info(
    '[proxy] Removed Cursor IDE hooks',
    ...sanitizeLogArgs({ configPath, usedBackup })
  );

  return { removed: true, usedBackup, path: configPath };
}

/**
 * Remove/merge `.cursor/hooks.json` at `<projectRoot>/.cursor/hooks.json`,
 * resolved the same way `writeCursorIdeHooksConfig` does.
 */
export async function removeCursorIdeHooksConfig(
  projectRoot: string = resolveProjectRoot()
): Promise<RemoveCursorIdeHooksResult> {
  const configPath = join(projectRoot, '.cursor', 'hooks.json');
  return removeCursorIdeHooksConfigAtPath(configPath);
}

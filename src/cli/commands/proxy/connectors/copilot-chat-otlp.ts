/**
 * Writes/removes CodeMie's hooks-only wiring for VS Code Copilot Chat (Local harness):
 * a CodeMie-owned hook-definitions file plus a `chat.hookFilesLocations` entry in VS Code's
 * `settings.json`, and this connector's project scope record (`copilot-connector-scope.ts`).
 *
 * v1 scope: hooks-only, Stable/default profile only (no `--insiders`), no OTel settings, no new
 * route. The hook-file JSON shape below (event name -> array of `{matcher, hooks}` groups,
 * mirroring Claude's `.claude/settings.json` hooks block) follows the "field names mirror Claude
 * Code's hook input" convention.
 */

import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { getCodemiePath, getDirname } from '@/utils/paths.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import {
  isCopilotProjectTracked,
  readCopilotConnectorScope,
  writeCopilotConnectorScope,
  type CopilotConnectorScope,
} from '@/agents/core/copilot-connector-scope.js';
import { addProjectPath, removeProjectPath } from '@/agents/core/project-allowlist.js';
import { CHAT_HOOK_EVENT_NAMES } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.types.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { getVsCodeProductDir, writeAtomically } from './vscode.js';

const HOOK_FILE_LOCATIONS_KEY = 'chat.hookFilesLocations';
const USE_HOOKS_KEY = 'chat.useHooks';
export const CHAT_HOOK_TIMEOUT_SECONDS = 30;

export interface WriteCopilotChatOtlpOptions {
  scope?: 'user' | 'project';
}

export interface WriteCopilotChatOtlpResult {
  settingsPath: string;
  hookFilePath: string;
  hookEvents: number;
  /** Tracked project roots; empty means all projects. */
  allowlist: string[];
}

export interface RemoveCopilotChatOtlpOptions {
  scope?: 'user' | 'project';
}

export interface RemoveCopilotChatOtlpResult {
  removed: boolean;
  mode: 'entry-removed' | 'full' | 'noop';
  settingsPath: string;
  reason?: string;
  allowlist?: string[];
}

/** Stable/default-profile Local `settings.json` — v1 scope excludes Insiders and other profiles. */
export function getVsCodeChatSettingsPath(): string {
  return join(getVsCodeProductDir(false), 'User', 'settings.json');
}

export function getCopilotChatHookFilePath(): string {
  return getCodemiePath('hooks', 'copilot-chat-hooks.json');
}

interface SettingsReadResult {
  settings: Record<string, unknown>;
  raw: string;
}

async function readSettings(configPath: string): Promise<SettingsReadResult> {
  if (!existsSync(configPath)) return { settings: {}, raw: '' };

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read VS Code settings at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (raw.trim().length === 0) return { settings: {}, raw: '' };

  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ConfigurationError(
      `VS Code settings at ${configPath} could not be read: ` +
      `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}. The file was not changed.`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError(`VS Code settings must contain a JSON object: ${configPath}`);
  }
  return { settings: parsed as Record<string, unknown>, raw };
}

function detectFormattingOptions(raw: string): FormattingOptions {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = raw.match(/\r?\n([ \t]+)\S/);
  const indent = indentMatch?.[1] ?? '  ';
  const insertSpaces = !indent.startsWith('\t');
  return { insertSpaces, tabSize: insertSpaces ? indent.length : 4, eol };
}

/** Returns the existing `chat.hookFilesLocations` list; refuses any non-array value rather than overwriting it. */
function readHookFileLocations(existing: unknown): string[] {
  if (existing === undefined) return [];
  if (!Array.isArray(existing)) {
    throw new ConfigurationError(
      `VS Code setting "${HOOK_FILE_LOCATIONS_KEY}" is not an array and was not changed. ` +
      'Convert it to an array of paths (or remove it) and retry.'
    );
  }
  return existing.filter((v): v is string => typeof v === 'string');
}

/** Adds `entry` to an existing `chat.hookFilesLocations` array, deduped. */
function upsertHookFileLocation(existing: unknown, entry: string): string[] {
  const current = readHookFileLocations(existing);
  if (current.includes(entry)) {
    return current;
  }
  return [...current, entry];
}

function removeHookFileLocation(existing: unknown, entry: string): string[] {
  return readHookFileLocations(existing).filter((v) => v !== entry);
}

function buildHookFileContent(hookCommand: string): Record<string, unknown> {
  const file: Record<string, unknown> = {};
  for (const eventName of CHAT_HOOK_EVENT_NAMES) {
    file[eventName] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: hookCommand, timeout: CHAT_HOOK_TIMEOUT_SECONDS }],
      },
    ];
  }
  return file;
}

/** `codemie hook --agent copilot-chat-otlp`, as an absolute command — VS Code's hook
 * execution environment may not inherit the shell PATH. */
function resolveAbsoluteHookCommand(): string {
  // dist/cli/commands/proxy/connectors/copilot-chat-otlp.js -> ../../../../../bin/codemie.js (repo root's bin/)
  const cliEntry = join(getDirname(import.meta.url), '../../../../../bin/codemie.js');
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry)} hook --agent ${COPILOT_CHAT_OTLP_AGENT_NAME}`;
}

async function resolveScope(opts: { scope?: 'user' | 'project' }): Promise<CopilotConnectorScope> {
  if (opts.scope !== 'project') {
    return { enabled: true, scope: 'user' };
  }
  const existing = await readCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME);
  const currentPaths = existing.kind === 'ok' && existing.value.enabled && existing.value.scope === 'project'
    ? existing.value.paths
    : [];
  const paths = await addProjectPath(currentPaths, resolveProjectRoot());
  return { enabled: true, scope: 'project', paths };
}

export async function writeCopilotChatOtlpConfig(
  opts: WriteCopilotChatOtlpOptions = {}
): Promise<WriteCopilotChatOtlpResult> {
  const settingsPath = getVsCodeChatSettingsPath();
  const hookFilePath = getCopilotChatHookFilePath();

  const { settings, raw } = await readSettings(settingsPath);
  if (settings[USE_HOOKS_KEY] === false) {
    throw new ConfigurationError(
      `VS Code setting "${USE_HOOKS_KEY}" is disabled in ${settingsPath}. ` +
      'Enable it manually before connecting Copilot Chat analytics; CodeMie will not change this setting.'
    );
  }
  const hookFileLocations = upsertHookFileLocation(settings[HOOK_FILE_LOCATIONS_KEY], hookFilePath);

  await writeAtomically(hookFilePath, `${JSON.stringify(buildHookFileContent(resolveAbsoluteHookCommand()), null, 2)}\n`);

  let nextText: string;
  if (raw.trim().length === 0) {
    nextText = `${JSON.stringify(
      { ...settings, [HOOK_FILE_LOCATIONS_KEY]: hookFileLocations },
      null,
      '\t'
    )}\n`;
  } else {
    const formattingOptions = detectFormattingOptions(raw);
    nextText = applyEdits(raw, modify(raw, [HOOK_FILE_LOCATIONS_KEY], hookFileLocations, { formattingOptions }));
  }

  try {
    await writeAtomically(settingsPath, nextText);
  } catch (error) {
    throw new ConfigurationError(
      `Failed to update VS Code settings at ${settingsPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  const scope = await resolveScope(opts);
  await writeCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME, scope);

  const allowlist = scope.enabled && scope.scope === 'project' ? scope.paths : [];
  logger.info(
    '[proxy] Configured Copilot Chat hooks-only analytics',
    ...sanitizeLogArgs({ settingsPath, hookFilePath, hookEvents: CHAT_HOOK_EVENT_NAMES.length, allowlist })
  );

  return { settingsPath, hookFilePath, hookEvents: CHAT_HOOK_EVENT_NAMES.length, allowlist };
}

export async function removeCopilotChatOtlpConfig(
  opts: RemoveCopilotChatOtlpOptions = {}
): Promise<RemoveCopilotChatOtlpResult> {
  const settingsPath = getVsCodeChatSettingsPath();
  const hookFilePath = getCopilotChatHookFilePath();

  if (opts.scope === 'project') {
    const existing = await readCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME);
    if (existing.kind !== 'ok' || !existing.value.enabled || existing.value.scope !== 'project') {
      return {
        removed: false,
        mode: 'noop',
        settingsPath,
        reason: existing.kind === 'corrupt'
          ? 'connector scope config is corrupt; fix it manually or disconnect without --scope project'
          : 'connector is not scoped to specific projects',
      };
    }
    const projectRoot = resolveProjectRoot();
    const remaining = await removeProjectPath(existing.value.paths, projectRoot);
    if (remaining.length === existing.value.paths.length) {
      return { removed: false, mode: 'noop', settingsPath, reason: 'current project is not tracked' };
    }
    if (remaining.length > 0) {
      await writeCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME, {
        enabled: true,
        scope: 'project',
        paths: remaining,
      });
      logger.info(
        '[proxy] Removed project from Copilot Chat analytics scope',
        ...sanitizeLogArgs({ remaining })
      );
      return { removed: true, mode: 'entry-removed', settingsPath, allowlist: remaining };
    }
    // Last tracked project removed: fall through to full removal below.
  }

  if (!existsSync(settingsPath)) {
    await writeCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME, { enabled: false });
    return { removed: false, mode: 'noop', settingsPath, reason: 'no VS Code settings file found' };
  }

  const { settings, raw } = await readSettings(settingsPath);
  const currentLocations = readHookFileLocations(settings[HOOK_FILE_LOCATIONS_KEY]);
  const hadEntry = currentLocations.includes(hookFilePath);

  if (!hadEntry) {
    await writeCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME, { enabled: false });
    return { removed: false, mode: 'noop', settingsPath, reason: 'no CodeMie entries found' };
  }

  const remainingLocations = removeHookFileLocation(settings[HOOK_FILE_LOCATIONS_KEY], hookFilePath);
  const formattingOptions = detectFormattingOptions(raw);
  const nextText = remainingLocations.length > 0
    ? applyEdits(raw, modify(raw, [HOOK_FILE_LOCATIONS_KEY], remainingLocations, { formattingOptions }))
    : applyEdits(raw, modify(raw, [HOOK_FILE_LOCATIONS_KEY], undefined, { formattingOptions }));

  await writeAtomically(settingsPath, nextText);

  if (existsSync(hookFilePath)) {
    await unlink(hookFilePath);
  }
  await writeCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME, { enabled: false });

  logger.info('[proxy] Removed Copilot Chat analytics hooks', ...sanitizeLogArgs({ settingsPath, hookFilePath }));
  return { removed: true, mode: 'full', settingsPath };
}

/** Allowlist read used by `codemie proxy status`. */
export async function describeCopilotChatScope(): Promise<string> {
  const scope = await readCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME);
  if (scope.kind === 'corrupt') return 'corrupt (fix manually or reconnect)';
  if (!scope.value.enabled) return 'disabled';
  if (scope.value.scope === 'user') return 'all projects';
  return scope.value.paths.join(', ') || 'no projects tracked';
}

/** Exposed for tests / `isTracked()` parity checks only; not part of the write path above. */
export async function isCopilotChatCwdTracked(cwd: string | undefined): Promise<boolean> {
  return isCopilotProjectTracked(cwd, await readCopilotConnectorScope(COPILOT_CHAT_OTLP_AGENT_NAME));
}

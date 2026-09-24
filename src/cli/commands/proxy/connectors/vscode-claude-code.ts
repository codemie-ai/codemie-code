import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
import { getVsCodeProductDir, writeAtomically } from './vscode.js';

const ANTHROPIC_BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const ANTHROPIC_AUTH_TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN';
const MANAGED_ENV_VAR_NAMES = new Set([ANTHROPIC_BASE_URL_KEY, ANTHROPIC_AUTH_TOKEN_KEY]);

export interface WriteVsCodeClaudeCodeConfigResult {
  written: boolean;
  path: string;
}

interface ClaudeCodeEnvVar {
  [key: string]: unknown;
  name?: string;
  value?: string;
}

/**
 * Resolve the VS Code Claude Code extension's `settings.json` path for the given
 * VS Code edition, mirroring `vscode.ts`'s `getVsCodeLanguageModelsPath` — including its
 * throw when the product's user-data directory doesn't exist, so a missing edition fails
 * loudly instead of silently writing into a directory tree nothing will ever read.
 */
export function getVsCodeClaudeCodeSettingsPath(insiders = false): string {
  const productDir = getVsCodeProductDir(insiders);
  if (!existsSync(productDir)) {
    const edition = insiders ? 'VS Code Insiders' : 'VS Code';
    const alternative = insiders
      ? 'Remove --insiders to configure stable VS Code.'
      : 'Use --insiders if only VS Code Insiders is installed.';
    throw new ConfigurationError(
      `${edition} user data directory was not found at ${productDir}.\n${alternative}`
    );
  }
  return join(productDir, 'User', 'settings.json');
}

interface SettingsReadResult {
  settings: Record<string, unknown>;
  /** Raw file text, `''` when the file is absent or empty. Preserved so the write
   * path can apply targeted edits instead of re-serializing the whole object,
   * keeping comments and formatting the user already had. */
  raw: string;
}

/**
 * Read `settings.json` tolerating the comments and trailing commas VS Code
 * itself writes and accepts (JSONC), instead of the strict `JSON.parse` that
 * previously rejected any hand-edited settings file on its first `//` line.
 */
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
    throw new ConfigurationError(
      `VS Code settings must contain a JSON object: ${configPath}`
    );
  }
  return { settings: parsed as Record<string, unknown>, raw };
}

function isEnvVarEntry(value: unknown): value is ClaudeCodeEnvVar {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detect the indentation and line ending an existing `settings.json` already
 * uses, so `modify()` edits match it instead of jsonc-parser's own default —
 * passing `{}` as `ModificationOptions` leaves `formattingOptions` undefined,
 * which per jsonc-parser's contract inserts the edit completely unformatted
 * (no newline, no indent) rather than falling back to a 4-space/tab default.
 */
function detectFormattingOptions(raw: string): FormattingOptions {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = raw.match(/\r?\n([ \t]+)\S/);
  const indent = indentMatch?.[1] ?? '  ';
  const insertSpaces = !indent.startsWith('\t');
  return { insertSpaces, tabSize: insertSpaces ? indent.length : 4, eol };
}

/**
 * Upsert the two CodeMie-managed entries into an existing `claudeCode.environmentVariables`
 * value, tolerating a malformed existing value instead of crashing or silently discarding data:
 * - A non-array `existing` is treated as empty (logged, not silently dropped).
 * - Non-object array entries (e.g. `null`, from a manual edit) are dropped (logged, not silently).
 * - Entries are de-duplicated by `name`, keeping only the latest occurrence, so a pre-existing
 *   duplicate managed entry (e.g. from an older buggy write) never leaves a stale copy behind.
 */
function upsertManagedEnvVars(
  existing: unknown,
  gatewayUrl: string,
  gatewayKey: string
): ClaudeCodeEnvVar[] {
  if (existing !== undefined && !Array.isArray(existing)) {
    logger.warn(
      '[proxy] Ignoring malformed claudeCode.environmentVariables (expected an array); replacing it',
      ...sanitizeLogArgs({ existingType: typeof existing })
    );
  }

  const sourceEntries: unknown[] = Array.isArray(existing) ? existing : [];
  const droppedCount = sourceEntries.filter(entry => !isEnvVarEntry(entry)).length;
  if (droppedCount > 0) {
    logger.warn(
      '[proxy] Dropping malformed claudeCode.environmentVariables entries',
      ...sanitizeLogArgs({ droppedCount })
    );
  }

  const unnamed: ClaudeCodeEnvVar[] = [];
  const byName = new Map<string, ClaudeCodeEnvVar>();
  for (const entry of sourceEntries) {
    if (!isEnvVarEntry(entry)) continue;
    if (typeof entry.name === 'string') {
      byName.set(entry.name, entry);
    } else {
      unnamed.push(entry);
    }
  }

  const managedValues: Record<string, string> = {
    [ANTHROPIC_BASE_URL_KEY]: gatewayUrl,
    [ANTHROPIC_AUTH_TOKEN_KEY]: gatewayKey,
  };
  for (const [name, value] of Object.entries(managedValues)) {
    byName.set(name, { ...byName.get(name), name, value });
  }

  return [...unnamed, ...byName.values()];
}

/**
 * Write CodeMie's managed `claudeCode.*` keys into the VS Code Claude Code extension's
 * `settings.json` at an explicit path. Preserves every unrelated top-level key and every
 * unrelated `claudeCode.environmentVariables` entry (e.g. keys the user set manually) —
 * only `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` entries and `disableLoginPrompt` are
 * CodeMie-managed and get overwritten.
 */
export async function writeVsCodeClaudeCodeConfigAtPath(
  configPath: string,
  gatewayUrl: string,
  gatewayKey: string
): Promise<WriteVsCodeClaudeCodeConfigResult> {
  const { settings, raw } = await readSettings(configPath);
  const envVars = upsertManagedEnvVars(
    settings['claudeCode.environmentVariables'],
    gatewayUrl,
    gatewayKey
  );

  // An absent/empty file has no formatting worth preserving — fall back to the
  // plain re-serialization path. Otherwise apply targeted edits against the
  // ORIGINAL text so comments and trailing commas the user already had survive.
  let nextText: string;
  if (raw.trim().length === 0) {
    nextText = `${JSON.stringify(
      {
        ...settings,
        'claudeCode.disableLoginPrompt': true,
        'claudeCode.environmentVariables': envVars,
      },
      null,
      '\t'
    )}\n`;
  } else {
    const formattingOptions = detectFormattingOptions(raw);
    const afterFirst = applyEdits(
      raw,
      modify(raw, ['claudeCode.disableLoginPrompt'], true, { formattingOptions })
    );
    nextText = applyEdits(
      afterFirst,
      modify(afterFirst, ['claudeCode.environmentVariables'], envVars, { formattingOptions })
    );
  }

  try {
    await writeAtomically(configPath, nextText);
  } catch (error) {
    throw new ConfigurationError(
      `Failed to update VS Code Claude Code settings at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  logger.info(
    '[proxy] Configured VS Code Claude Code extension',
    ...sanitizeLogArgs({
      configPath,
      anthropicBaseUrl: gatewayUrl,
      anthropicAuthToken: gatewayKey,
      managedEnvVarNames: [...MANAGED_ENV_VAR_NAMES],
    })
  );

  return { written: true, path: configPath };
}

/**
 * Write CodeMie's managed `claudeCode.*` keys into the current user's VS Code (or VS Code
 * Insiders) `settings.json`, so the bundled Claude Code extension routes through the local
 * gateway daemon without a Claude.ai OAuth login prompt.
 */
export async function writeVsCodeClaudeCodeConfig(
  gatewayUrl: string,
  gatewayKey: string,
  insiders = false
): Promise<WriteVsCodeClaudeCodeConfigResult> {
  return writeVsCodeClaudeCodeConfigAtPath(
    getVsCodeClaudeCodeSettingsPath(insiders),
    gatewayUrl,
    gatewayKey
  );
}

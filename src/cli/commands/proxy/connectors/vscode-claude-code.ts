import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function readSettings(configPath: string): Promise<Record<string, unknown>> {
  if (!existsSync(configPath)) return {};

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read VS Code settings at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (raw.trim().length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigurationError(
        `VS Code settings must contain a JSON object: ${configPath}`
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `VS Code settings at ${configPath} are not valid JSON and were not changed.`
    );
  }
}

function isEnvVarEntry(value: unknown): value is ClaudeCodeEnvVar {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const settings = await readSettings(configPath);

  const updatedSettings: Record<string, unknown> = {
    ...settings,
    'claudeCode.disableLoginPrompt': true,
    'claudeCode.environmentVariables': upsertManagedEnvVars(
      settings['claudeCode.environmentVariables'],
      gatewayUrl,
      gatewayKey
    ),
  };

  try {
    await writeAtomically(configPath, `${JSON.stringify(updatedSettings, null, '\t')}\n`);
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

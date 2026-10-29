/**
 * Per-connector project scope for the Copilot Chat and Copilot CLI OTLP adapters.
 *
 * Unlike Claude's allowlist (`claude-code-otlp.allowlist.ts`), where an absent setting means
 * "track every project" (that connector has existed and defaulted on for a while), a Copilot
 * connector that has never been connected, or whose config is corrupt or unreadable, must do
 * NO work at all — no hook forwarding, no SSO check, nothing. "Absent/disabled/corrupt" are
 * therefore all collapsed to "not tracked" here; only an explicit `enabled: true` record ever
 * turns collection on. Both connectors share one CodeMie-owned config file, keyed by connector
 * id, so `codemie proxy connect`/`disconnect` and `status` have one place to read.
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/utils/logger.js';
import { ConfigurationError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';
import { canonicalizePath, isPathInside } from './project-allowlist.js';

const CONFIG_VERSION = 1;

export type CopilotConnectorScope =
  | { enabled: false }
  | { enabled: true; scope: 'user' }
  | { enabled: true; scope: 'project'; paths: string[] };

const DISABLED: CopilotConnectorScope = { enabled: false };

interface CopilotConnectorsFile {
  version: number;
  connectors: Record<string, CopilotConnectorScope>;
}

export function getCopilotConnectorsConfigPath(): string {
  return getCodemiePath('copilot-connectors.json');
}

function isValidScope(value: unknown): value is CopilotConnectorScope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.enabled === false) {
    return true;
  }
  if (v.enabled !== true) {
    return false;
  }
  if (v.scope === 'user') {
    return true;
  }
  if (v.scope === 'project') {
    return Array.isArray(v.paths) && v.paths.every((p) => typeof p === 'string' && p.length > 0);
  }
  return false;
}

/**
 * Reads one connector's scope record. Never throws.
 *
 * - File absent, or connector key absent -> disabled (no work).
 * - File present but unparsable, wrong shape, or the specific connector's record is malformed
 *   -> `'corrupt'`. The caller must treat this the same as disabled for collection purposes
 *   (fail closed), but may surface it as a distinct diagnostic (`codemie proxy status`).
 */
export async function readCopilotConnectorScope(
  connectorId: string
): Promise<{ kind: 'ok'; value: CopilotConnectorScope } | { kind: 'corrupt' }> {
  let raw: string;
  try {
    raw = await readFile(getCopilotConnectorsConfigPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', value: DISABLED };
    }
    logger.debug('[copilot-connector-scope] Failed to read config, treating as corrupt');
    return { kind: 'corrupt' };
  }

  if (raw.trim().length === 0) {
    return { kind: 'ok', value: DISABLED };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'corrupt' };
  }
  const file = parsed as Partial<CopilotConnectorsFile>;
  if (typeof file.version !== 'number' || typeof file.connectors !== 'object' || file.connectors === null) {
    return { kind: 'corrupt' };
  }

  const record = (file.connectors as Record<string, unknown>)[connectorId];
  if (record === undefined) {
    return { kind: 'ok', value: DISABLED };
  }
  if (!isValidScope(record)) {
    return { kind: 'corrupt' };
  }
  return { kind: 'ok', value: record };
}

/**
 * Merge-writes one connector's scope record; other connectors' records are preserved.
 * Refuses to overwrite an existing file that is unreadable or corrupt, so another connector's
 * record is never silently dropped. The write is atomic (temp file + rename) so a concurrent
 * hook never reads a truncated file.
 */
export async function writeCopilotConnectorScope(connectorId: string, scope: CopilotConnectorScope): Promise<void> {
  const path = getCopilotConnectorsConfigPath();
  let file: CopilotConnectorsFile = { version: CONFIG_VERSION, connectors: {} };
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigurationError(`Cannot read Copilot connector config, it was not changed: ${path}`);
    }
  }

  if (raw !== undefined && raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const candidate = parsed as Partial<CopilotConnectorsFile> | undefined;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof candidate.connectors !== 'object' ||
      candidate.connectors === null
    ) {
      throw new ConfigurationError(
        `Copilot connector config is corrupt and was not changed: ${path}. Fix or delete it, then retry.`
      );
    }
    file = { version: CONFIG_VERSION, connectors: { ...candidate.connectors } };
  }

  file.connectors[connectorId] = scope;
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(file, null, 2), 'utf-8');
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Allowlist gate for a Copilot adapter's `isTracked()`. `'corrupt'` and `enabled: false` both
 * resolve to not-tracked (fail closed); `cwd` must be a non-empty string for `'project'` scope.
 */
export async function isCopilotProjectTracked(
  cwd: string | undefined,
  scope: { kind: 'ok'; value: CopilotConnectorScope } | { kind: 'corrupt' }
): Promise<boolean> {
  if (scope.kind === 'corrupt' || !scope.value.enabled) {
    return false;
  }
  if (scope.value.scope === 'user') {
    return true;
  }
  if (!cwd) {
    return false;
  }
  const canonicalCwd = await canonicalizePath(cwd);
  for (const entry of scope.value.paths) {
    if (isPathInside(canonicalCwd, await canonicalizePath(entry))) {
      return true;
    }
  }
  return false;
}

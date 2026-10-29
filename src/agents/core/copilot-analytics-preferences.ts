/**
 * CodeMie-owned preferences for Copilot CLI / Copilot Chat analytics collection, keyed by
 * connector id (mirrors `copilot-connectors.json`'s keying in `copilot-connector-scope.ts`).
 *
 * Deliberately a separate file/module from `copilot-connectors.json` (`CopilotConnectorScope`):
 * `resolveScope()` in `src/cli/commands/proxy/connectors/copilot-*-otlp.ts` returns a fresh
 * `{enabled:true, scope:'user'}` literal on every plain `connect`, discarding any other field —
 * storing exclusions there would silently wipe them on the next connect. Absent record = fully
 * enabled, nothing excluded; this file only ever narrows, never on its own.
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { canonicalizePath, isPathInside } from '@/agents/core/project-allowlist.js';

const CONFIG_VERSION = 1;

export interface CopilotAnalyticsRecord {
  enabled: boolean;
  excludedProjects: string[];
}

export const DEFAULT_COPILOT_ANALYTICS_RECORD: CopilotAnalyticsRecord = {
  enabled: true,
  excludedProjects: [],
};

export type CopilotAnalyticsRecordState = { kind: 'ok'; value: CopilotAnalyticsRecord } | { kind: 'corrupt' };

interface CopilotAnalyticsFile {
  version: number;
  connectors: Record<string, CopilotAnalyticsRecord>;
}

export function getCopilotAnalyticsPreferencesPath(): string {
  return getCodemiePath('copilot-analytics.json');
}

/** The one file-shape rule shared by read and update, so the writer never accepts what the reader fails closed on. */
function isValidFile(value: unknown): value is { version: number; connectors: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'number' &&
    typeof v.connectors === 'object' &&
    v.connectors !== null &&
    !Array.isArray(v.connectors)
  );
}

function isValidRecord(value: unknown): value is Partial<CopilotAnalyticsRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') {
    return false;
  }
  if (v.excludedProjects !== undefined) {
    if (!Array.isArray(v.excludedProjects)) {
      return false;
    }
    if (!v.excludedProjects.every((p) => typeof p === 'string' && p.length > 0 && isAbsolute(p))) {
      return false;
    }
  }
  return true;
}

/**
 * Reads one connector's analytics record. Never throws.
 *
 * - File absent, empty, or the connector key absent -> defaults (fully enabled, nothing excluded).
 * - File present but unparsable, wrong shape, or the specific connector's record malformed ->
 *   `'corrupt'`. The hook-side caller must fail closed (not tracked); a CLI write must refuse to
 *   overwrite it.
 */
export async function readCopilotAnalyticsPreferences(connectorId: string): Promise<CopilotAnalyticsRecordState> {
  let raw: string;
  try {
    raw = await readFile(getCopilotAnalyticsPreferencesPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', value: DEFAULT_COPILOT_ANALYTICS_RECORD };
    }
    logger.debug('[copilot-analytics-preferences] Failed to read preferences, treating as corrupt');
    return { kind: 'corrupt' };
  }

  if (raw.trim().length === 0) {
    return { kind: 'ok', value: DEFAULT_COPILOT_ANALYTICS_RECORD };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }

  if (!isValidFile(parsed)) {
    return { kind: 'corrupt' };
  }

  const record = parsed.connectors[connectorId];
  if (record === undefined) {
    return { kind: 'ok', value: DEFAULT_COPILOT_ANALYTICS_RECORD };
  }
  if (!isValidRecord(record)) {
    return { kind: 'corrupt' };
  }

  return {
    kind: 'ok',
    value: {
      enabled: record.enabled ?? DEFAULT_COPILOT_ANALYTICS_RECORD.enabled,
      excludedProjects: record.excludedProjects ?? DEFAULT_COPILOT_ANALYTICS_RECORD.excludedProjects,
    },
  };
}

/**
 * Reads the current record for `connectorId` (defaults if absent), applies `mutate`, and
 * merge-writes the result atomically (temp file + rename), preserving sibling connectors' records.
 * Throws `ConfigurationError` if the existing file is corrupt — the bytes on disk are never
 * touched in that case.
 */
export async function updateCopilotAnalyticsPreferences(
  connectorId: string,
  mutate: (current: CopilotAnalyticsRecord) => CopilotAnalyticsRecord | Promise<CopilotAnalyticsRecord>
): Promise<CopilotAnalyticsRecord> {
  const path = getCopilotAnalyticsPreferencesPath();
  let file: CopilotAnalyticsFile = { version: CONFIG_VERSION, connectors: {} };
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigurationError(`Cannot read Copilot analytics preferences, they were not changed: ${path}`);
    }
  }

  let current: CopilotAnalyticsRecord = DEFAULT_COPILOT_ANALYTICS_RECORD;
  if (raw !== undefined && raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!isValidFile(parsed)) {
      throw new ConfigurationError(
        `Copilot analytics preferences are corrupt and were not changed: ${path}. Fix or delete it, then retry.`
      );
    }
    const existingRecord = parsed.connectors[connectorId];
    if (existingRecord !== undefined && !isValidRecord(existingRecord)) {
      throw new ConfigurationError(
        `Copilot analytics preferences are corrupt and were not changed: ${path}. Fix or delete it, then retry.`
      );
    }
    file = { version: CONFIG_VERSION, connectors: { ...(parsed.connectors as Record<string, CopilotAnalyticsRecord>) } };
    if (existingRecord !== undefined) {
      const r = existingRecord as Partial<CopilotAnalyticsRecord>;
      current = {
        enabled: r.enabled ?? DEFAULT_COPILOT_ANALYTICS_RECORD.enabled,
        excludedProjects: r.excludedProjects ?? DEFAULT_COPILOT_ANALYTICS_RECORD.excludedProjects,
      };
    }
  }

  const next = await mutate(current);
  file.connectors[connectorId] = next;

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(file, null, 2), 'utf-8');
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  return next;
}

/**
 * True if `cwd` is inside (or equal to) any entry in `excludedProjects`. With no usable `cwd` the
 * project is unknown, so it counts as excluded whenever anything is excluded (fail closed).
 */
export async function isCopilotAnalyticsProjectExcluded(
  cwd: string | undefined,
  excludedProjects: string[]
): Promise<boolean> {
  if (!cwd) {
    return excludedProjects.length > 0;
  }
  const canonicalCwd = await canonicalizePath(cwd);
  for (const entry of excludedProjects) {
    if (isPathInside(canonicalCwd, await canonicalizePath(entry))) {
      return true;
    }
  }
  return false;
}

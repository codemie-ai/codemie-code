/**
 * Clears the MCP sign-ins Claude Desktop keeps in its own `<Claude-3p>/config.json`.
 *
 * Every row of the outcome table is a returned result, never a throw, and no
 * result carries parser text or file content: the caller prints and logs
 * results as they are.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonFileAtomic } from '@/utils/atomic-write.js';

export const MCP_OAUTH_KEY = 'custom3pMcpOAuth';

const DESKTOP_CONFIG_FILE_NAME = 'config.json';

export type ResetResult =
  /** `servers` is empty when the removed entry was not an object. */
  | { outcome: 'cleared'; path: string; servers: string[] }
  | { outcome: 'nothing' | 'missing' | 'invalid-json' | 'not-object'; path: string }
  | { outcome: 'unreadable' | 'write-failed'; path: string; code?: string };

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The parser's error is dropped on purpose: its message can quote the input. */
function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function hasNothingToClear(entry: unknown): boolean {
  return entry === undefined || entry === null || (isJsonObject(entry) && Object.keys(entry).length === 0);
}

/**
 * Removes the whole `custom3pMcpOAuth` entry from `<baseDir>/config.json`, leaving every other key as it was.
 * A file without sign-ins is not rewritten.
 */
export async function clearDesktopMcpSignIns(baseDir: string): Promise<ResetResult> {
  const path = join(baseDir, DESKTOP_CONFIG_FILE_NAME);

  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { outcome: 'missing', path } : { outcome: 'unreadable', path, code };
  }

  const parsed = parseJson(text);
  if (!parsed) return { outcome: 'invalid-json', path };

  const config = parsed.value;
  if (!isJsonObject(config)) return { outcome: 'not-object', path };

  const { [MCP_OAUTH_KEY]: entry, ...remaining } = config;
  if (hasNothingToClear(entry)) return { outcome: 'nothing', path };

  try {
    await writeJsonFileAtomic(path, remaining);
  } catch (error) {
    return { outcome: 'write-failed', path, code: errorCode(error) };
  }

  return { outcome: 'cleared', path, servers: isJsonObject(entry) ? Object.keys(entry) : [] };
}

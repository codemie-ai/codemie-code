import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';

const KEY_BYTES = 32;
let memoizedKey: { path: string; key: Buffer } | undefined;
let fallbackKey: Buffer | undefined;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function readKeyFile(path: string): Buffer | null {
  const key = readFileSync(path);
  return key.length === KEY_BYTES ? key : null;
}

/**
 * The local HMAC key (32 random bytes, mode 0600, created on first use, never logged or sent).
 * If it cannot be read or created, a random per-process key is used: a reduced event never falls back
 * to the unkeyed hash, at the cost of ids that are not stable across processes.
 */
function loadEventKey(): Buffer {
  const path = getCodemiePath('analytics-event-key');
  if (memoizedKey?.path === path) return memoizedKey.key;
  try {
    let key: Buffer | null = null;
    try {
      key = readKeyFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!key) {
      mkdirSync(dirname(path), { recursive: true });
      const fresh = randomBytes(KEY_BYTES);
      try {
        writeFileSync(path, fresh, { mode: 0o600, flag: 'wx' });
        key = fresh;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        key = readKeyFile(path);
        if (!key) throw new Error('invalid analytics event key');
      }
    }
    memoizedKey = { path, key };
    return key;
  } catch (error) {
    logger.debug(`[event-id] analytics event key unavailable (${errorName(error)}); using a per-process key`);
    fallbackKey ??= randomBytes(KEY_BYTES);
    return fallbackKey;
  }
}

/** Drops the memoised keys so a test can point `CODEMIE_HOME` elsewhere. */
export function resetEventKeyCache(): void {
  memoizedKey = undefined;
  fallbackKey = undefined;
}

/** HMAC-SHA256 (hex) of `input` under the local analytics event key; shared by every reduced `event_id`. */
export function keyedDigest(input: string): string {
  return createHmac('sha256', loadEventKey()).update(input).digest('hex');
}

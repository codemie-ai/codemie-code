import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';

/*
 * A session that started (startup or /clear) while no owner could be named, e.g. after `codemie profile logout`.
 * It carries no evidence record and nothing is held for it, so its later prompts could not be told apart from a
 * resumed or forked session of unknown scope. This marker records only that the session began without an owner:
 * the gate lets such a session establish its first record once the user signs in. A resumed session leaves no
 * marker, so it stays stopped. Holds a path-free session hash and a timestamp, never an identity.
 */

/** A session that never prompts again leaves its marker behind only this long. */
export const OWNERLESS_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function ownerlessSessionDir(): string {
  return getCodemiePath('analytics', 'state', 'ownerless-sessions');
}

function markerName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`;
}

async function pruneExpired(now: number): Promise<void> {
  const dir = ownerlessSessionDir();
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    if (!file.endsWith('.json')) continue;
    const info = await stat(join(dir, file)).catch(() => undefined);
    if (info && now - info.mtimeMs > OWNERLESS_SESSION_TTL_MS) await unlink(join(dir, file)).catch(() => undefined);
  }
}

/** Notes that this session began without an owner. Durable (tmp + rename). Never throws. */
export async function markOwnerlessSessionStart(sessionId: string, now: number = Date.now()): Promise<void> {
  if (!sessionId) return;
  try {
    const dir = ownerlessSessionDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await pruneExpired(now);
    const target = join(dir, markerName(sessionId));
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: 1, at: now }), { mode: 0o600 });
    try {
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    logger.debug(`[ownerless-session] marker not written: ${error instanceof Error ? error.name : 'error'}`);
  }
}

/**
 * Removes the marker once the session has its record: it admits the session's first record only, so a later change of
 * account or API URL cannot create a second one. Never throws.
 */
export async function clearOwnerlessSessionStart(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await unlink(join(ownerlessSessionDir(), markerName(sessionId))).catch(() => undefined);
}

/** Whether this session began without an owner and the marker has not expired. Never throws. */
export async function hasOwnerlessSessionStart(sessionId: string, now: number = Date.now()): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const info = await stat(join(ownerlessSessionDir(), markerName(sessionId)));
    return now - info.mtimeMs <= OWNERLESS_SESSION_TTL_MS;
  } catch {
    return false;
  }
}

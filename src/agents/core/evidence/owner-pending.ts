import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { EvidenceFields } from './record-store.js';

/*
 * Hook events whose owner could not be resolved yet (transient `/v1/user` failure). Kept on disk, bound to the exact
 * login by fingerprint, until the daemon can replay them under a verified owner or the held-retention window ends.
 * Nothing here is sent anywhere. Replay and expiry live in `otlp-spool/owner-pending-replay.ts`.
 */

/** Total bytes the queue may hold; past it a hook falls back to the evidence-loss report. */
export const OWNER_PENDING_MAX_BYTES = 32 * 1024 * 1024;
const FP_DIR_LEN = 32;

export type PendingFields = Omit<EvidenceFields, 'owner_hash'>;

export interface PendingOwnerEntry {
  v: 1;
  id: string;
  fp: string;
  agentName: string;
  api_identity: string;
  session_id: string;
  first_at: number;
  fields: PendingFields;
  events: Record<string, unknown>[];
}

export function pendingOwnerDir(): string {
  return getCodemiePath('analytics', 'state', 'owner-pending');
}

export function fpDirName(fp: string): string {
  return fp.slice(0, FP_DIR_LEN);
}

/** `first_at` is part of the name so expiry needs no read and survives restarts. */
export function entryFirstAt(fileName: string): number | undefined {
  const m = /^(\d{10,15})-[0-9a-f]{16}\.json$/.exec(fileName);
  return m ? Number(m[1]) : undefined;
}

async function totalBytes(): Promise<number> {
  let total = 0;
  for (const dir of await readdir(pendingOwnerDir()).catch(() => [] as string[])) {
    for (const file of await readdir(join(pendingOwnerDir(), dir)).catch(() => [] as string[])) {
      total += (await stat(join(pendingOwnerDir(), dir, file)).catch(() => undefined))?.size ?? 0;
    }
  }
  return total;
}

/** Whether a hook of this session is still held for its owner (the daemon creates its record at replay). Never throws. */
export async function hasPendingOwnerSession(sessionId: string): Promise<boolean> {
  try {
    for (const dir of await readdir(pendingOwnerDir())) {
      for (const file of await readdir(join(pendingOwnerDir(), dir))) {
        if (!entryFirstAt(file)) continue;
        try {
          const entry = JSON.parse(await readFile(join(pendingOwnerDir(), dir, file), 'utf-8')) as { session_id?: unknown };
          if (entry.session_id === sessionId) return true;
        } catch { /* unreadable entry: not proof */ }
      }
    }
  } catch { /* no queue */ }
  return false;
}

/** Durable (tmp + rename) write. `true` only when the entry is on disk. Never throws. */
export async function enqueuePendingOwner(
  entry: Omit<PendingOwnerEntry, 'v' | 'id' | 'first_at'>,
  now: number = Date.now()
): Promise<boolean> {
  try {
    const id = randomBytes(8).toString('hex');
    const content = JSON.stringify({ v: 1, id, first_at: now, ...entry } satisfies PendingOwnerEntry);
    if ((await totalBytes()) + Buffer.byteLength(content) > OWNER_PENDING_MAX_BYTES) {
      logger.warn('[owner-pending] queue full; hook events not held');
      return false;
    }
    const dir = join(pendingOwnerDir(), fpDirName(entry.fp));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${id}.tmp`);
    await writeFile(tmp, content, { mode: 0o600 });
    try {
      await rename(tmp, join(dir, `${now}-${id}.json`));
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return true;
  } catch (error) {
    logger.debug(`[owner-pending] enqueue failed: ${error instanceof Error ? error.name : 'error'}`);
    return false;
  }
}

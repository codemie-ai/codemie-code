import { readFile, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { resolveEmailFromCredentials } from '@/agents/core/identity-resolver.js';
import { apiIdentity, ownerHash } from '@/agents/core/evidence/api-identity.js';
import { createOrRead, recordKey } from '@/agents/core/evidence/record-store.js';
import {
  entryFirstAt,
  fpDirName,
  pendingOwnerDir,
  type PendingOwnerEntry,
} from '@/agents/core/evidence/owner-pending.js';
import { credentialFingerprint } from '@/providers/core/credential-owner.js';
import { isSSOCredentials, type JWTCredentials, type SSOCredentials } from '@/providers/core/types.js';
import { heldRetentionMs } from './spool-config.js';
import { appendSpool, recordStampLoss } from './spool-io.js';
import { hookEventProjectNames } from './session-project.js';

const STALE_TMP_MS = 60 * 60_000;
const EXPIRED_REASON = 'owner_unresolved_expired';

const list = (dir: string): Promise<string[]> => readdir(dir).catch(() => []);

/** Drops entries past the held-retention window (named loss, byte count), leftovers of finished replays and stale temp files. */
async function sweepPending(now: number): Promise<void> {
  const root = pendingOwnerDir();
  for (const dirName of await list(root)) {
    const dir = join(root, dirName);
    for (const file of await list(dir)) {
      const path = join(dir, file);
      try {
        if (file.endsWith('.done')) {
          await unlink(path); // fully appended before the rename; never replayed again
        } else if (file.endsWith('.tmp')) {
          if (now - (await stat(path)).mtimeMs > STALE_TMP_MS) await unlink(path);
        } else {
          const firstAt = entryFirstAt(file) ?? (await stat(path)).mtimeMs;
          if (now - firstAt < heldRetentionMs()) continue;
          const bytes = (await stat(path)).size;
          let sessionId = '';
          let events = 1;
          try {
            const entry = JSON.parse(await readFile(path, 'utf8')) as Partial<PendingOwnerEntry>;
            sessionId = typeof entry.session_id === 'string' ? entry.session_id : '';
            events = Array.isArray(entry.events) ? Math.max(1, entry.events.length) : 1;
          } catch {
            /* unreadable: still expires */
          }
          await unlink(path);
          logger.warn('[owner-pending] held hook events dropped: owner not resolved within the retention window', ...sanitizeLogArgs({ reason: EXPIRED_REASON, bytes, events }));
          if (sessionId && isSafeSessionId(sessionId)) await recordStampLoss(sessionId, EXPIRED_REASON, events, now);
        }
      } catch (error) {
        logger.debug(`[owner-pending] sweep skipped an entry: ${error instanceof Error ? error.name : 'error'}`);
      }
    }
    await rmdir(dir).catch(() => undefined); // only succeeds when empty
  }
}

async function sessionOf(path: string): Promise<string | undefined> {
  try {
    const id = (JSON.parse(await readFile(path, 'utf8')) as PendingOwnerEntry).session_id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** `true` only when the entry's events are in the spool; `false` leaves it queued (and blocks the session's later entries, keeping order). */
async function replayEntry(path: string, fp: string, api: string, email: string): Promise<boolean> {
  let entry: PendingOwnerEntry;
  try {
    entry = JSON.parse(await readFile(path, 'utf8')) as PendingOwnerEntry;
  } catch {
    return false; // unreadable: left to expire
  }
  if (
    entry.v !== 1 || entry.fp !== fp || entry.api_identity !== api || !isSafeSessionId(entry.session_id) ||
    !Array.isArray(entry.events) || entry.events.length === 0 ||
    // The normal hook path rejects these before the spool (a blank or foreign session id would hold the session's hooks stream until retention).
    typeof entry.agentName !== 'string' || !entry.agentName ||
    !entry.events.every((event) => event !== null && typeof event === 'object' && event['session_id'] === entry.session_id)
  ) {
    return false; // not this login/environment, or malformed: never replayed, left to expire
  }

  const owner = ownerHash(email);
  const key = recordKey(api, owner, entry.session_id);
  const fields = { ...entry.fields, api_identity: api, owner_hash: owner };
  let created = await createOrRead(key, fields);
  if (created.kind === 'evidence_capacity') {
    const { pendingSpoolSessionIds } = await import('./sweep.js');
    created = await createOrRead(key, fields, { pendingSessionIds: await pendingSpoolSessionIds() });
  }
  if (created.kind !== 'created' && created.kind !== 'existing') return false; // retried on a later tick

  // Hook-time facts stay as captured; only identity comes from the verified login (never git/OS/config values).
  const events = entry.events.map((event) => ({ ...event, user_email: email, developer_name: email, identity_source: 'jwt' }));
  const lines = events.map((event) => JSON.stringify({ agentName: entry.agentName, hookEvent: JSON.stringify(event), evidence_v: 1 }));
  const appended = await appendSpool(entry.session_id, 'hooks', lines.join('\n') + '\n', events.flatMap((event) => hookEventProjectNames(event)), entry.first_at);
  if (!appended) return false; // not the head of the pending range, or too many ranges: stays queued with its original age
  await rename(path, path.replace(/\.json$/, '.done'));
  await unlink(path.replace(/\.json$/, '.done')).catch(() => undefined);
  return true;
}

/**
 * Daemon tick step: expire, then replay what belongs to the current login once it carries a verified owner.
 * Entries of any other login/environment are untouched. Never throws.
 */
export async function processPendingOwner(
  credentials: SSOCredentials | JWTCredentials | undefined,
  now: number = Date.now()
): Promise<void> {
  try {
    await sweepPending(now);
    if (!credentials || !isSSOCredentials(credentials)) return;
    const email = resolveEmailFromCredentials(credentials);
    if (!email) return;
    const fp = credentialFingerprint(credentials);
    const dir = join(pendingOwnerDir(), fpDirName(fp));
    const api = apiIdentity(credentials.apiUrl);
    const blocked = new Set<string>(); // a deferred entry blocks later entries of its session (order)
    for (const file of (await list(dir)).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const sid = await sessionOf(join(dir, file));
        if (sid && blocked.has(sid)) continue;
        if (!(await replayEntry(join(dir, file), fp, api, email)) && sid) blocked.add(sid);
      } catch (error) {
        const sid = await sessionOf(join(dir, file));
        if (sid) blocked.add(sid);
        logger.debug(`[owner-pending] replay deferred: ${error instanceof Error ? error.name : 'error'}`);
      }
    }
  } catch (error) {
    logger.debug(`[owner-pending] pass failed: ${error instanceof Error ? error.name : 'error'}`);
  }
}
